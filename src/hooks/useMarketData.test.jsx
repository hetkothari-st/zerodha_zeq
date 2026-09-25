import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMarketData } from './useMarketData';

// ── Fake WebSocket ──────────────────────────────────────────────────────
// Records every instance created (so tests can assert how many sockets were
// opened) and exposes trigger* helpers so tests can simulate the browser
// calling onopen/onmessage/onclose without a real network connection.
class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.binaryType = null;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }

    send(data) {
        this.sent.push(data);
    }

    close() {
        // Real close() is async (fires a later 'close' event); tests drive
        // that explicitly via triggerClose so we don't fire onclose here.
        if (this.readyState !== FakeWebSocket.CLOSED) this.readyState = FakeWebSocket.CLOSING;
    }

    triggerOpen() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    triggerMessage(data) {
        this.onmessage?.({ data });
    }

    triggerClose(code = 1000, reason = '') {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.({ code, reason });
    }
}

beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('useMarketData — connection lifecycle', () => {
    test('unmounting stops reconnects: still exactly 1 socket after 120s', () => {
        const { unmount } = renderHook(() => useMarketData(true, null, null, { accessToken: 'tok' }));
        expect(FakeWebSocket.instances).toHaveLength(1);

        act(() => { FakeWebSocket.instances[0].triggerOpen(); });

        unmount();

        act(() => { vi.advanceTimersByTime(120000); });
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    test('disabling closes the socket and stops reconnects', () => {
        const { rerender } = renderHook(
            ({ enabled }) => useMarketData(enabled, null, null, { accessToken: 'tok' }),
            { initialProps: { enabled: true } },
        );
        expect(FakeWebSocket.instances).toHaveLength(1);
        act(() => { FakeWebSocket.instances[0].triggerOpen(); });

        rerender({ enabled: false });
        act(() => { vi.advanceTimersByTime(120000); });
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    test('mounting with a token opens exactly one socket', () => {
        renderHook(() => useMarketData(true, null, null, { accessToken: 'tok' }));
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    test('a token arriving after mount opens exactly one socket', () => {
        const { rerender } = renderHook(
            ({ accessToken }) => useMarketData(true, null, null, { accessToken }),
            { initialProps: { accessToken: null } },
        );
        expect(FakeWebSocket.instances).toHaveLength(0);

        rerender({ accessToken: 'tok' });
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    test('enabling after being disabled opens exactly one new socket', () => {
        const { rerender } = renderHook(
            ({ enabled }) => useMarketData(enabled, null, null, { accessToken: 'tok' }),
            { initialProps: { enabled: false } },
        );
        expect(FakeWebSocket.instances).toHaveLength(0);

        rerender({ enabled: true });
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    test('connect never opens a second socket while one is CONNECTING or OPEN', () => {
        renderHook(() => useMarketData(true, null, null, { accessToken: 'tok' }));
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CONNECTING);
        // Still connecting — nothing should have opened a second socket.
        expect(FakeWebSocket.instances).toHaveLength(1);

        act(() => { FakeWebSocket.instances[0].triggerOpen(); });
        expect(FakeWebSocket.instances).toHaveLength(1);
    });
});

describe('useMarketData — reconnect backoff', () => {
    test('backs off exponentially across repeated closes with no message in between', () => {
        renderHook(() => useMarketData(true, null, null, { accessToken: 'tok' }));
        expect(FakeWebSocket.instances).toHaveLength(1);

        act(() => { FakeWebSocket.instances[0].triggerOpen(); });
        act(() => { FakeWebSocket.instances[0].triggerClose(4401); });

        act(() => { vi.advanceTimersByTime(2999); });
        expect(FakeWebSocket.instances).toHaveLength(1);
        act(() => { vi.advanceTimersByTime(1); });
        expect(FakeWebSocket.instances).toHaveLength(2);

        act(() => { FakeWebSocket.instances[1].triggerOpen(); });
        act(() => { FakeWebSocket.instances[1].triggerClose(4401); });

        act(() => { vi.advanceTimersByTime(5999); });
        expect(FakeWebSocket.instances).toHaveLength(2);
        act(() => { vi.advanceTimersByTime(1); });
        expect(FakeWebSocket.instances).toHaveLength(3);

        act(() => { FakeWebSocket.instances[2].triggerOpen(); });
        act(() => { FakeWebSocket.instances[2].triggerClose(4401); });

        act(() => { vi.advanceTimersByTime(11999); });
        expect(FakeWebSocket.instances).toHaveLength(3);
        act(() => { vi.advanceTimersByTime(1); });
        expect(FakeWebSocket.instances).toHaveLength(4);
    });

    test('onopen alone does not reset the backoff counter', () => {
        renderHook(() => useMarketData(true, null, null, { accessToken: 'tok' }));
        act(() => { FakeWebSocket.instances[0].triggerOpen(); });
        act(() => { FakeWebSocket.instances[0].triggerClose(4401); }); // attempt 0 -> delay 3000, attempt now 1

        act(() => { vi.advanceTimersByTime(3000); });
        expect(FakeWebSocket.instances).toHaveLength(2);

        // Open again but do NOT send a message before the next close.
        act(() => { FakeWebSocket.instances[1].triggerOpen(); });
        act(() => { FakeWebSocket.instances[1].triggerClose(4401); }); // attempt 1 -> delay 6000, not 3000

        act(() => { vi.advanceTimersByTime(5999); });
        expect(FakeWebSocket.instances).toHaveLength(2);
        act(() => { vi.advanceTimersByTime(1); });
        expect(FakeWebSocket.instances).toHaveLength(3);
    });

    test('a received message resets the backoff counter', () => {
        renderHook(() => useMarketData(true, null, null, { accessToken: 'tok' }));
        act(() => { FakeWebSocket.instances[0].triggerOpen(); });
        act(() => { FakeWebSocket.instances[0].triggerClose(4401); }); // attempt 0 -> delay 3000, attempt now 1

        act(() => { vi.advanceTimersByTime(3000); });
        expect(FakeWebSocket.instances).toHaveLength(2);

        act(() => { FakeWebSocket.instances[1].triggerOpen(); });
        // A message arrives on this connection — resets the attempt counter.
        act(() => { FakeWebSocket.instances[1].triggerMessage(new ArrayBuffer(2)); });
        act(() => { FakeWebSocket.instances[1].triggerClose(4401); });

        // Backs off from 3000 again, not 6000.
        act(() => { vi.advanceTimersByTime(2999); });
        expect(FakeWebSocket.instances).toHaveLength(2);
        act(() => { vi.advanceTimersByTime(1); });
        expect(FakeWebSocket.instances).toHaveLength(3);
    });

    test('a text message also resets the backoff counter', () => {
        renderHook(() => useMarketData(true, null, null, { accessToken: 'tok' }));
        act(() => { FakeWebSocket.instances[0].triggerOpen(); });
        act(() => { FakeWebSocket.instances[0].triggerClose(4401); });
        act(() => { vi.advanceTimersByTime(3000); });
        expect(FakeWebSocket.instances).toHaveLength(2);

        act(() => { FakeWebSocket.instances[1].triggerOpen(); });
        act(() => { FakeWebSocket.instances[1].triggerMessage(JSON.stringify({ type: 'Info', data: {} })); });
        act(() => { FakeWebSocket.instances[1].triggerClose(4401); });

        act(() => { vi.advanceTimersByTime(2999); });
        expect(FakeWebSocket.instances).toHaveLength(2);
        act(() => { vi.advanceTimersByTime(1); });
        expect(FakeWebSocket.instances).toHaveLength(3);
    });

    test('re-enabling resets the backoff counter to 0', () => {
        const { rerender } = renderHook(
            ({ enabled }) => useMarketData(enabled, null, null, { accessToken: 'tok' }),
            { initialProps: { enabled: true } },
        );
        act(() => { FakeWebSocket.instances[0].triggerOpen(); });
        act(() => { FakeWebSocket.instances[0].triggerClose(4401); }); // attempt 0 -> 1, delay 3000 scheduled

        act(() => { vi.advanceTimersByTime(3000); });
        expect(FakeWebSocket.instances).toHaveLength(2);

        act(() => { FakeWebSocket.instances[1].triggerOpen(); });
        act(() => { FakeWebSocket.instances[1].triggerClose(4401); }); // attempt 1 -> 2, delay 6000 scheduled

        // Disable before the 6s timer fires.
        rerender({ enabled: false });
        act(() => { vi.advanceTimersByTime(60000); });
        expect(FakeWebSocket.instances).toHaveLength(2);

        // Re-enable — should reconnect immediately and reset the attempt counter.
        rerender({ enabled: true });
        expect(FakeWebSocket.instances).toHaveLength(3);

        act(() => { FakeWebSocket.instances[2].triggerOpen(); });
        act(() => { FakeWebSocket.instances[2].triggerClose(4401); });

        // Backs off from 3000 again, not 12000.
        act(() => { vi.advanceTimersByTime(2999); });
        expect(FakeWebSocket.instances).toHaveLength(3);
        act(() => { vi.advanceTimersByTime(1); });
        expect(FakeWebSocket.instances).toHaveLength(4);
    });
});

// ── Hub auth + close-code handling (shared by both products) ─────────────
function renderWithAuth(initialProps) {
    return renderHook(
        ({ enabled = true, accessToken, onSignedInElsewhere }) => useMarketData(enabled, null, null, { accessToken, onSignedInElsewhere }),
        { initialProps },
    );
}
const isClosedOrClosing = (sock) => sock.readyState === FakeWebSocket.CLOSING || sock.readyState === FakeWebSocket.CLOSED;

describe('useMarketData — hub auth and close codes', () => {
    test('the socket URL carries the encoded access token', () => {
        renderWithAuth({ accessToken: 'a b/c+d=' });
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(FakeWebSocket.instances[0].url).toContain(`?token=${encodeURIComponent('a b/c+d=')}`);
    });

    test('close 4409 → onSignedInElsewhere, and no new socket after 120 s', () => {
        const onSignedInElsewhere = vi.fn();
        renderWithAuth({ accessToken: 'tok', onSignedInElsewhere });
        act(() => { FakeWebSocket.instances[0].triggerOpen(); });
        act(() => { FakeWebSocket.instances[0].triggerClose(4409); });
        expect(onSignedInElsewhere).toHaveBeenCalledTimes(1);
        act(() => { vi.advanceTimersByTime(120000); });
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    test('a {type:"signed_in_elsewhere"} text message → onSignedInElsewhere', () => {
        const onSignedInElsewhere = vi.fn();
        renderWithAuth({ accessToken: 'tok', onSignedInElsewhere });
        act(() => { FakeWebSocket.instances[0].triggerOpen(); });
        act(() => { FakeWebSocket.instances[0].triggerMessage(JSON.stringify({ type: 'signed_in_elsewhere' })); });
        expect(onSignedInElsewhere).toHaveBeenCalledTimes(1);
    });

    test('close 4403 → status error and no reconnect', () => {
        const { result } = renderWithAuth({ accessToken: 'tok' });
        act(() => { FakeWebSocket.instances[0].triggerOpen(); });
        act(() => { FakeWebSocket.instances[0].triggerClose(4403); });
        expect(result.current.status).toBe('error');
        act(() => { vi.advanceTimersByTime(120000); });
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(result.current.status).toBe('error');
    });

    test('losing the token closes the socket and does not reconnect', () => {
        const { rerender, result } = renderWithAuth({ accessToken: 'tok' });
        act(() => { FakeWebSocket.instances[0].triggerOpen(); });
        act(() => { rerender({ accessToken: null }); });
        expect(isClosedOrClosing(FakeWebSocket.instances[0])).toBe(true);
        expect(result.current.status).toBe('disconnected');
        act(() => { vi.advanceTimersByTime(120000); });
        expect(FakeWebSocket.instances).toHaveLength(1);
    });
});

describe('useMarketData — production hub URL warning', () => {
    afterEach(() => { vi.unstubAllEnvs(); });
    const hubWarnings = (spy) => spy.mock.calls.filter(([m]) => typeof m === 'string' && m.startsWith('[KiteWS] VITE_WS_HUB_URL not set'));

    test('no warning when VITE_WS_HUB_URL is set', () => {
        vi.stubEnv('PROD', true);
        vi.stubEnv('VITE_WS_HUB_URL', 'wss://hub.example');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        renderWithAuth({ accessToken: 'tok' });
        expect(FakeWebSocket.instances[0].url).toContain('wss://hub.example');
        expect(hubWarnings(warn)).toHaveLength(0);
    });

    test('in production without VITE_WS_HUB_URL it warns once about the blocked fallback', () => {
        vi.stubEnv('PROD', true);
        vi.stubEnv('VITE_WS_HUB_URL', '');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { rerender } = renderWithAuth({ accessToken: 'tok' });
        act(() => { rerender({ enabled: false, accessToken: 'tok' }); });
        act(() => { rerender({ enabled: true, accessToken: 'tok' }); });
        expect(FakeWebSocket.instances).toHaveLength(2);
        const w = hubWarnings(warn);
        expect(w).toHaveLength(1);
        expect(w[0][0]).toBe(`[KiteWS] VITE_WS_HUB_URL not set — falling back to ws://${window.location.hostname}:8765, which is blocked in production`);
    });
});
