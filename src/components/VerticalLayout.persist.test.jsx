import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
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
