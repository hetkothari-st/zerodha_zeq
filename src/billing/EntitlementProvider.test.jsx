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
    it('other errors keep Free and stop loading', async () => {
        apiFetchRef.current = vi.fn(async () => ({ ok: false, status: 503, code: 'auth_unavailable' }));
        render(<EntitlementProvider><Probe /></EntitlementProvider>);
        expect(await screen.findByText('free|false|true')).toBeInTheDocument();
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
});
