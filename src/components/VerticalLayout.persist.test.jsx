import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, screen, fireEvent } from '@testing-library/react';
import VerticalLayout from './VerticalLayout';

// VerticalLayout only reads `isPro` from the entitlement context (for one
// StockColumn affordance) — stub it so the test doesn't need the real
// AuthProvider/EntitlementProvider network plumbing.
vi.mock('../billing/EntitlementProvider', () => ({
    useEntitlement: () => ({ isPro: true }),
}));

const RAW_BUCKET_MINUTES = 0.25; // 15 seconds — matches VerticalLayout.jsx

const todayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

beforeEach(() => {
    // jsdom has no ResizeObserver; StockColumn uses one to size its rows.
    global.ResizeObserver = class {
        observe() { }
        unobserve() { }
        disconnect() { }
    };
});

afterEach(() => {
    vi.useRealTimers();
});

describe('VerticalLayout persistence — symbols hidden by the current plan', () => {
    test('periodic flush preserves a hidden symbol (Free plan) untouched, and keeps its column position', async () => {
        vi.useFakeTimers();
        const monitorId = 7;
        const STORAGE_KEY = `vl_state_v3_m${monitorId}`;
        const ORDER_KEY = `vl_column_order_v1_m${monitorId}`;

        const seeded = {
            day: todayKey(),
            bucketSize: RAW_BUCKET_MINUTES,
            histories: {
                RELIANCE: [{ minute: '09:15', open: 1, high: 1, low: 1, close: 1, delta: 1 }],
                IRCTC: [{ minute: '09:15', open: 500, high: 505, low: 495, close: 500, delta: 10 }],
            },
            snapshots: {
                RELIANCE: { ltp: 2500, vol: 1000 },
                IRCTC: { ltp: 500, vol: 200 },
            },
            flow: {
                RELIANCE: [{ minute: '09:15', timestamp: 1, buyQty: 5, sellQty: 5, buyTurnover: 1, sellTurnover: 1 }],
                IRCTC: [{ minute: '09:15', timestamp: 1, buyQty: 3, sellQty: 2, buyTurnover: 1, sellTurnover: 1 }],
            },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
        // IRCTC saved in the first (leftmost) column position.
        localStorage.setItem(ORDER_KEY, JSON.stringify(['IRCTC', 'RELIANCE']));

        // extraStocks=[] is what App.jsx passes (via eqFreeView) once a Pro
        // user's subscription lapses to Free — STOCK_LIST no longer has IRCTC.
        render(<VerticalLayout monitorId={monitorId} extraStocks={[]} wsStatus="connected" />);

        // Let the 2s flush interval run at least once.
        await act(async () => { vi.advanceTimersByTime(2100); });

        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));

        // Hidden symbol's saved entries survive the flush, untouched.
        expect(raw.histories.IRCTC).toEqual(seeded.histories.IRCTC);
        expect(raw.snapshots.IRCTC).toEqual(seeded.snapshots.IRCTC);
        expect(raw.flow.IRCTC).toEqual(seeded.flow.IRCTC);

        // Known symbol's data is still there (current in-memory state, which
        // in this test — no live packets arrived — equals what was seeded).
        expect(raw.histories.RELIANCE).toEqual(seeded.histories.RELIANCE);
        expect(raw.snapshots.RELIANCE).toEqual(seeded.snapshots.RELIANCE);

        // Column order: IRCTC is not deleted, and keeps its saved position.
        const order = JSON.parse(localStorage.getItem(ORDER_KEY));
        expect(order).toContain('IRCTC');
        expect(order.indexOf('IRCTC')).toBe(0);
        expect(order).toContain('RELIANCE');
    });

    test('same-day / bucket-size reset semantics still apply to the hidden symbol', async () => {
        vi.useFakeTimers();
        const monitorId = 8;
        const STORAGE_KEY = `vl_state_v3_m${monitorId}`;

        // Saved blob is from a PREVIOUS trading day — the existing loader
        // already discards a whole stale-day blob. A hidden symbol's stale
        // data must not be resurrected by the new merge logic either.
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const seeded = {
            day: todayKey(yesterday),
            bucketSize: RAW_BUCKET_MINUTES,
            histories: { IRCTC: [{ minute: '09:15', open: 1, high: 1, low: 1, close: 1, delta: 1 }] },
            snapshots: { IRCTC: { ltp: 1, vol: 1 } },
            flow: { IRCTC: [{ minute: '09:15', timestamp: 1, buyQty: 1, sellQty: 1, buyTurnover: 1, sellTurnover: 1 }] },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));

        render(<VerticalLayout monitorId={monitorId} extraStocks={[]} wsStatus="connected" />);

        await act(async () => { vi.advanceTimersByTime(2100); });

        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
        expect(raw.day).toBe(todayKey());
        // Yesterday's IRCTC data must NOT be carried forward into today's blob.
        expect(raw.histories.IRCTC).toBeUndefined();
        expect(raw.snapshots?.IRCTC).toBeUndefined();
        expect(raw.flow?.IRCTC).toBeUndefined();
    });
});

describe('VerticalLayout persistence — fix round 1', () => {
    // I1: the mount-time extras cache must be day-checked at USE time, not
    // just at capture time — a tab left open across midnight must not carry
    // yesterday's hidden-stock data into today's blob (flush) or into a
    // newly-visible symbol (restore).
    test('I1: cached hidden-stock extras are dropped by the flush after a day rollover', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 8, 29, 23, 59, 0));
        const monitorId = 20;
        const STORAGE_KEY = `vl_state_v3_m${monitorId}`;
        const mountDay = todayKey(new Date(2026, 8, 29, 23, 59, 0));
        const seeded = {
            day: mountDay,
            bucketSize: RAW_BUCKET_MINUTES,
            histories: { IRCTC: [{ minute: '09:15', open: 1, high: 1, low: 1, close: 1, delta: 1 }] },
            snapshots: { IRCTC: { ltp: 1, vol: 1 } },
            flow: { IRCTC: [{ minute: '09:15', timestamp: 1, buyQty: 1, sellQty: 1, buyTurnover: 1, sellTurnover: 1 }] },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));

        render(<VerticalLayout monitorId={monitorId} extraStocks={[]} wsStatus="connected" />);

        // Roll over to the next trading day before the flush fires.
        const nextDay = new Date(2026, 8, 30, 0, 0, 10);
        vi.setSystemTime(nextDay);
        await act(async () => { vi.advanceTimersByTime(2100); });

        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
        expect(raw.day).toBe(todayKey(nextDay));
        expect(raw.histories.IRCTC).toBeUndefined();
        expect(raw.snapshots?.IRCTC).toBeUndefined();
        expect(raw.flow?.IRCTC).toBeUndefined();
    });

    test('I1: cached hidden-stock extras are not restored into a symbol that becomes visible after a day rollover', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 8, 29, 23, 59, 0));
        const monitorId = 21;
        const STORAGE_KEY = `vl_state_v3_m${monitorId}`;
        const mountDay = todayKey(new Date(2026, 8, 29, 23, 59, 0));
        const seeded = {
            day: mountDay,
            bucketSize: RAW_BUCKET_MINUTES,
            histories: { IRCTC: [{ minute: '09:15', open: 1, high: 1, low: 1, close: 1, delta: 1 }] },
            snapshots: { IRCTC: { ltp: 1, vol: 1 } },
            flow: { IRCTC: [{ minute: '09:15', timestamp: 1, buyQty: 1, sellQty: 1, buyTurnover: 1, sellTurnover: 1 }] },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));

        const { rerender } = render(<VerticalLayout monitorId={monitorId} extraStocks={[]} wsStatus="connected" />);

        // Roll over to the next day, THEN the user is upgraded back to Pro
        // mid-session (App.jsx never remounts VerticalLayout on plan change).
        const nextDay = new Date(2026, 8, 30, 0, 0, 10);
        vi.setSystemTime(nextDay);
        await act(async () => {
            rerender(<VerticalLayout monitorId={monitorId} extraStocks={[{ symbol: 'IRCTC' }]} wsStatus="connected" />);
        });
        await act(async () => { vi.advanceTimersByTime(2100); });

        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
        expect(raw.day).toBe(todayKey(nextDay));
        // IRCTC is visible again but must start blank, not with yesterday's data.
        expect(raw.histories.IRCTC).toEqual([]);
    });

    // I2 (controller ruling): Clear All only clears what the user can
    // currently see. Hidden extras (a symbol the current plan doesn't show)
    // must survive Clear All and reappear via the next flush's merge.
    test('I2: Clear All keeps a hidden symbol\'s data; visible symbols are cleared', async () => {
        vi.useFakeTimers();
        const monitorId = 22;
        const STORAGE_KEY = `vl_state_v3_m${monitorId}`;
        const seeded = {
            day: todayKey(),
            bucketSize: RAW_BUCKET_MINUTES,
            histories: {
                RELIANCE: [{ minute: '09:15', open: 1, high: 1, low: 1, close: 1, delta: 1 }],
                IRCTC: [{ minute: '09:15', open: 500, high: 505, low: 495, close: 500, delta: 10 }],
            },
            snapshots: {
                RELIANCE: { ltp: 2500, vol: 1000 },
                IRCTC: { ltp: 500, vol: 200 },
            },
            flow: {
                RELIANCE: [{ minute: '09:15', timestamp: 1, buyQty: 5, sellQty: 5, buyTurnover: 1, sellTurnover: 1 }],
                IRCTC: [{ minute: '09:15', timestamp: 1, buyQty: 3, sellQty: 2, buyTurnover: 1, sellTurnover: 1 }],
            },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));

        render(<VerticalLayout monitorId={monitorId} extraStocks={[]} wsStatus="connected" />);

        // Fire the global "Clear" event VerticalLayout listens for (App.jsx's
        // top-bar Clear button), targeted at this monitor.
        await act(async () => {
            window.dispatchEvent(new CustomEvent('vl-clear', { detail: { monitorId } }));
        });
        await act(async () => { vi.advanceTimersByTime(2100); });

        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
        // Hidden symbol's data survives Clear All (comes back via the merge).
        expect(raw.histories.IRCTC).toEqual(seeded.histories.IRCTC);
        expect(raw.snapshots.IRCTC).toEqual(seeded.snapshots.IRCTC);
        expect(raw.flow.IRCTC).toEqual(seeded.flow.IRCTC);
        // Visible symbol's data is actually cleared.
        expect(raw.histories.RELIANCE).toEqual([]);
    });

    // Minor 1: the restore path (STOCK_LIST grows) must scrub legacy
    // zero-delta rows the same way the mount-time loader does.
    test('Minor 1: restoring a newly-visible symbol scrubs legacy zero-delta rows', async () => {
        vi.useFakeTimers();
        const monitorId = 23;
        const STORAGE_KEY = `vl_state_v3_m${monitorId}`;
        const rows = [
            { minute: '09:15', open: 1, high: 1, low: 1, close: 1, delta: 0 },
            { minute: '09:16', open: 1, high: 1, low: 1, close: 1, delta: 5 },
            { minute: '09:17', open: 1, high: 1, low: 1, close: 1, delta: 0 }, // last row — kept regardless
        ];
        const seeded = {
            day: todayKey(),
            bucketSize: RAW_BUCKET_MINUTES,
            histories: { IRCTC: rows },
            snapshots: { IRCTC: { ltp: 1, vol: 1 } },
            flow: { IRCTC: [] },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));

        const { rerender } = render(<VerticalLayout monitorId={monitorId} extraStocks={[]} wsStatus="connected" />);
        await act(async () => {
            rerender(<VerticalLayout monitorId={monitorId} extraStocks={[{ symbol: 'IRCTC' }]} wsStatus="connected" />);
        });
        await act(async () => { vi.advanceTimersByTime(2100); });

        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
        expect(raw.histories.IRCTC).toEqual([rows[1], rows[2]]);
    });

    // Minor 2: removing an extra stock via the column's Remove button should
    // also prune it from the persisted column order.
    test('Minor 2: handleRemoveStock prunes the removed symbol from columnOrder / ORDER_KEY', async () => {
        vi.useFakeTimers();
        const monitorId = 24;
        const ORDER_KEY = `vl_column_order_v1_m${monitorId}`;
        localStorage.setItem(ORDER_KEY, JSON.stringify(['RELIANCE', 'IRCTC', 'HDFCBANK']));

        render(
            <VerticalLayout
                monitorId={monitorId}
                extraStocks={[{ symbol: 'IRCTC' }]}
                onRemoveExtraStock={() => { }}
                wsStatus="connected"
            />
        );

        const removeBtn = screen.getAllByTitle('Remove Column')[0];
        const beforeOrder = JSON.parse(localStorage.getItem(ORDER_KEY));
        await act(async () => { fireEvent.click(removeBtn); });

        const order = JSON.parse(localStorage.getItem(ORDER_KEY));
        expect(order).not.toContain('IRCTC');
        expect(order).toContain('RELIANCE');
        expect(order).toContain('HDFCBANK');
        expect(order.length).toBe(beforeOrder.length - 1);
    });
});
