import { test, expect } from 'vitest';
import { mergePersisted, mergePersistedState } from './mergePersisted';

test('keeps saved entries for symbols not in the known list', () => {
    const saved = { RELIANCE: ['old'], IRCTC: ['irctc-history'] };
    const current = { RELIANCE: ['new'] };
    const knownSymbols = ['RELIANCE']; // IRCTC hidden (Free plan)
    expect(mergePersisted(saved, current, knownSymbols)).toEqual({
        RELIANCE: ['new'],
        IRCTC: ['irctc-history'],
    });
});

test('current always wins for overlapping symbols, even outside knownSymbols', () => {
    // A symbol that was known earlier this session and is still resident in
    // memory should not be clobbered by a stale saved copy.
    const saved = { IRCTC: ['stale'] };
    const current = { IRCTC: ['fresh-in-memory'] };
    expect(mergePersisted(saved, current, [])).toEqual({ IRCTC: ['fresh-in-memory'] });
});

test('handles missing saved / current gracefully', () => {
    expect(mergePersisted(undefined, { A: [1] }, ['A'])).toEqual({ A: [1] });
    expect(mergePersisted({ A: [1] }, undefined, [])).toEqual({ A: [1] });
    expect(mergePersisted(null, null, [])).toEqual({});
});

test('mergePersistedState merges histories/snapshots/flow independently', () => {
    const saved = {
        histories: { IRCTC: [{ minute: '1', close: 100 }] },
        snapshots: { IRCTC: { ltp: 100, vol: 5 } },
        flow: { IRCTC: [{ minute: '1', buyQty: 10, sellQty: 5 }] },
    };
    const current = {
        histories: { RELIANCE: [{ minute: '1', close: 2500 }] },
        snapshots: { RELIANCE: { ltp: 2500, vol: 10 } },
        flow: { RELIANCE: [{ minute: '1', buyQty: 1, sellQty: 1 }] },
    };
    const knownSymbols = ['RELIANCE'];
    const result = mergePersistedState(saved, current, knownSymbols);
    expect(result.histories.IRCTC).toEqual([{ minute: '1', close: 100 }]);
    expect(result.histories.RELIANCE).toEqual([{ minute: '1', close: 2500 }]);
    expect(result.snapshots.IRCTC).toEqual({ ltp: 100, vol: 5 });
    expect(result.flow.IRCTC).toEqual([{ minute: '1', buyQty: 10, sellQty: 5 }]);
});
