import { describe, it, expect } from 'vitest';
import { eqFreeView, FREE_BUCKET } from './eqFreeView';

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
