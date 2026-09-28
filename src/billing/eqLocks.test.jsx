import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { eqFreeView, FREE_BUCKET } from './eqFreeView';
import { EntitlementProvider, useEntitlement } from './EntitlementProvider';

const base = {
    monitors: [{ id: 0 }, { id: 2 }], activeMonitorId: 2,
    bucketSizes: { 0: 0.25, 2: 15 }, extraStocks: { 0: [{ symbol: 'IRCTC' }], 2: [{ symbol: 'ZOMATO' }] }, volumeUnit: 'Cr',
};

describe('eqFreeView', () => {
    it('Pro: passes through, bucket defaults to 1', () => {
        const v = eqFreeView({ ...base, isPro: true });
        expect(v.monitors).toHaveLength(2);
        expect(v.activeId).toBe(2);
        expect(v.bucketFor(2)).toBe(15);
        expect(v.bucketFor(9)).toBe(1);
        expect(v.extraFor(0)).toEqual([{ symbol: 'IRCTC' }]);
        expect(v.volumeUnit).toBe('Cr');
    });
    it('Free: first monitor, 5m bucket, no extras, auto unit', () => {
        const v = eqFreeView({ ...base, isPro: false });
        expect(v.monitors).toEqual([{ id: 0 }]);
        expect(v.activeId).toBe(0);
        expect(v.bucketFor(0)).toBe(FREE_BUCKET);
        expect(FREE_BUCKET).toBe(5);
        expect(v.extraFor(0)).toEqual([]);
        expect(v.volumeUnit).toBe('auto');
    });
});

// C1 (Eq check): while entitlement is still unknown (EntitlementProvider hasn't gotten its
// first response), isPro reads true — so eqFreeView must not prune a user's saved extra stocks
// just because the provider is loading. EntitlementProvider.jsx is a shared file with its own
// (shared, byte-identical) test suite that proves isPro is true while loading; this test proves
// the wiring all the way through to eqFreeView, which is Eq-only.
vi.mock('../auth/AuthProvider', () => ({
    useAuth: () => ({ apiFetch: () => new Promise(() => {}), session: { user: { id: 'u1' } } }),
}));

function Probe() {
    const { isPro, loading } = useEntitlement();
    const view = eqFreeView({
        isPro,
        monitors: [{ id: 0 }],
        activeMonitorId: 0,
        bucketSizes: { 0: 1 },
        extraStocks: { 0: [{ symbol: 'IRCTC' }, { symbol: 'ZOMATO' }] },
        volumeUnit: 'Cr',
    });
    return <div>{`loading:${loading}|extras:${view.extraFor(0).map((s) => s.symbol).join(',')}`}</div>;
}

describe('eqFreeView while EntitlementProvider is still loading (isPro from a loading context)', () => {
    it('mounts with the provider loading and extraFor() still returns the saved extras, not []', () => {
        render(<EntitlementProvider><Probe /></EntitlementProvider>);
        expect(screen.getByText('loading:true|extras:IRCTC,ZOMATO')).toBeInTheDocument();
    });
});
