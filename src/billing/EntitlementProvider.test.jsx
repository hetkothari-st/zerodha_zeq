import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { EntitlementProvider, useEntitlement } from './EntitlementProvider';

const apiFetchRef = { current: null };
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ apiFetch: (...a) => apiFetchRef.current(...a), profile: { id: 'u1' }, session: { user: { id: 'u1' } } }) }));
vi.mock('./UpgradeModal', () => ({ default: () => <div>upgrade-modal</div> }));

function Probe() {
    const e = useEntitlement();
    return <div>{e.loading ? 'loading' : `${e.plan}|${e.isPro}|${e.billingEnabled}`}<button onClick={e.openUpgrade}>up</button></div>;
}

function ProbeResumable() {
    const e = useEntitlement();
    return <div>{e.loading ? 'loading' : `resumable:${e.resumable}`}</div>;
}

// Unlike Probe, always shows loading + isPro together — needed to assert isPro is true
// *while* loading (Probe collapses to the literal text "loading" in that state).
function ProbeAlways() {
    const e = useEntitlement();
    return <div>{`${e.loading}|${e.isPro}`}</div>;
}

describe('EntitlementProvider', () => {
    it('loads status and exposes isPro', async () => {
        apiFetchRef.current = vi.fn(async () => ({ ok: true, status: 200, data: { plan: 'pro', source: 'subscription', until: null, status: 'active', cancelAtPeriodEnd: false, manageUrl: null, priceLabel: '' } }));
        render(<EntitlementProvider><Probe /></EntitlementProvider>);
        expect(await screen.findByText('pro|true|true')).toBeInTheDocument();
        expect(apiFetchRef.current).toHaveBeenCalledWith('/api/billing/status');
    });
    it('404 status unlocks everything (billing not configured)', async () => {
        apiFetchRef.current = vi.fn(async () => ({ ok: false, status: 404, code: 'not_found' }));
        render(<EntitlementProvider><Probe /></EntitlementProvider>);
        expect(await screen.findByText('pro|true|false')).toBeInTheDocument();
    });
    it('isPro is true before the first response resolves (unknown entitlement acts as Pro)', () => {
        apiFetchRef.current = vi.fn(() => new Promise(() => {})); // never resolves
        render(<EntitlementProvider><ProbeAlways /></EntitlementProvider>);
        expect(screen.getByText('true|true')).toBeInTheDocument();
    });
    it('other errors before the first success keep loading (isPro true) and retry with backoff until one succeeds', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let call = 0;
        apiFetchRef.current = vi.fn(async () => {
            call += 1;
            if (call < 4) return { ok: false, status: 503, code: 'auth_unavailable' };
            return { ok: true, status: 200, data: { plan: 'free' } };
        });
        render(<EntitlementProvider><Probe /></EntitlementProvider>);
        await waitFor(() => expect(apiFetchRef.current).toHaveBeenCalledTimes(1));
        expect(screen.getByText('loading')).toBeInTheDocument();
        await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // 1st retry
        await waitFor(() => expect(apiFetchRef.current).toHaveBeenCalledTimes(2));
        expect(screen.getByText('loading')).toBeInTheDocument();
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); // 2nd retry
        await waitFor(() => expect(apiFetchRef.current).toHaveBeenCalledTimes(3));
        expect(screen.getByText('loading')).toBeInTheDocument();
        await act(async () => { await vi.advanceTimersByTimeAsync(15000); }); // 3rd retry succeeds
        await waitFor(() => expect(apiFetchRef.current).toHaveBeenCalledTimes(4));
        expect(await screen.findByText('free|false|true')).toBeInTheDocument();
        vi.useRealTimers();
    });
    it('clears the retry timer on unmount (no further retries fire)', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        apiFetchRef.current = vi.fn(async () => ({ ok: false, status: 503, code: 'auth_unavailable' }));
        const { unmount } = render(<EntitlementProvider><Probe /></EntitlementProvider>);
        await waitFor(() => expect(apiFetchRef.current).toHaveBeenCalledTimes(1));
        unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
        expect(apiFetchRef.current).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });
    it('after a first success, a later error keeps the last known state (not reverted to loading/unknown)', async () => {
        let call = 0;
        apiFetchRef.current = vi.fn(async () => {
            call += 1;
            if (call === 1) return { ok: true, status: 200, data: { plan: 'pro', source: 'subscription' } };
            return { ok: false, status: 503, code: 'auth_unavailable' };
        });
        render(<EntitlementProvider><Probe /></EntitlementProvider>);
        expect(await screen.findByText('pro|true|true')).toBeInTheDocument();
        act(() => { window.dispatchEvent(new Event('focus')); });
        await waitFor(() => expect(apiFetchRef.current).toHaveBeenCalledTimes(2));
        expect(screen.getByText('pro|true|true')).toBeInTheDocument();
    });
    it('does not schedule a retry (or fetch again) after unmount, even for a request already in flight at unmount time', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let resolveFetch;
        apiFetchRef.current = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
        const { unmount } = render(<EntitlementProvider><Probe /></EntitlementProvider>);
        await waitFor(() => expect(apiFetchRef.current).toHaveBeenCalledTimes(1));
        unmount(); // the first request is still pending (in flight) at this point
        resolveFetch({ ok: false, status: 503, code: 'auth_unavailable' });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        // Post-unmount, this must not have scheduled a retry timer at all.
        await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
        expect(apiFetchRef.current).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });
    it('openUpgrade does not show the modal while loading', () => {
        apiFetchRef.current = vi.fn(() => new Promise(() => {}));
        render(<EntitlementProvider><Probe /></EntitlementProvider>);
        act(() => screen.getByText('up').click());
        expect(screen.queryByText('upgrade-modal')).toBeNull();
    });
    it('re-checks on window focus and on the poll interval', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        apiFetchRef.current = vi.fn(async () => ({ ok: true, status: 200, data: { plan: 'free' } }));
        render(<EntitlementProvider pollMs={1000}><Probe /></EntitlementProvider>);
        await waitFor(() => expect(apiFetchRef.current).toHaveBeenCalledTimes(1));
        act(() => { window.dispatchEvent(new Event('focus')); });
        await waitFor(() => expect(apiFetchRef.current).toHaveBeenCalledTimes(2));
        await act(async () => { vi.advanceTimersByTime(1000); });
        await waitFor(() => expect(apiFetchRef.current).toHaveBeenCalledTimes(3));
        vi.useRealTimers();
    });
    it('openUpgrade shows the modal', async () => {
        apiFetchRef.current = vi.fn(async () => ({ ok: true, status: 200, data: { plan: 'free' } }));
        render(<EntitlementProvider><Probe /></EntitlementProvider>);
        await screen.findByText('free|false|true');
        act(() => screen.getByText('up').click());
        expect(screen.getByText('upgrade-modal')).toBeInTheDocument();
    });
    it('passes resumable through from the status response, defaulting to false', async () => {
        apiFetchRef.current = vi.fn(async () => ({ ok: true, status: 200, data: { plan: 'pro', source: 'subscription', cancelAtPeriodEnd: true, resumable: true } }));
        render(<EntitlementProvider><ProbeResumable /></EntitlementProvider>);
        expect(await screen.findByText('resumable:true')).toBeInTheDocument();
    });
    it('resumable defaults to false when the status response omits it', async () => {
        apiFetchRef.current = vi.fn(async () => ({ ok: true, status: 200, data: { plan: 'free' } }));
        render(<EntitlementProvider><ProbeResumable /></EntitlementProvider>);
        expect(await screen.findByText('resumable:false')).toBeInTheDocument();
    });
});
