// ─────────────────────────────────────────────────────────────────────────
// mergePersisted — keep saved per-symbol state for symbols the current plan
// hides (e.g. a Pro user's extra stocks after their subscription lapses to
// Free) from being wiped by VerticalLayout's periodic localStorage flush.
// ─────────────────────────────────────────────────────────────────────────
// VerticalLayout only keeps in-memory (`current`) entries for symbols in the
// active STOCK_LIST. Its flush effect used to overwrite the WHOLE persisted
// blob with just those entries every ~2s, silently erasing anything the
// current view doesn't render — a hidden Pro extra stock's history, LTP/vol
// snapshot, and order-flow buckets.
//
// `mergePersisted` folds the last-known-saved map with the live in-memory
// map: entries for symbols NOT in `knownSymbols` are kept from `saved`
// untouched; every entry present in `current` wins (it's always fresher,
// and covers symbols currently known — including ones that were known
// earlier this session and are still resident in memory even if they've
// since dropped out of `knownSymbols`).
//
// Pure & cheap: one shallow pass over each input, no JSON (de)serialisation
// — callers are expected to pass an already-parsed saved blob (e.g. a
// mount-time snapshot) rather than re-reading + re-parsing localStorage on
// every flush.
export function mergePersisted(saved, current, knownSymbols) {
    const known = new Set(knownSymbols || []);
    const merged = {};
    if (saved && typeof saved === 'object') {
        for (const [symbol, value] of Object.entries(saved)) {
            if (!known.has(symbol)) merged[symbol] = value;
        }
    }
    if (current && typeof current === 'object') {
        for (const [symbol, value] of Object.entries(current)) {
            merged[symbol] = value;
        }
    }
    return merged;
}

// Merge all three per-symbol maps a VerticalLayout persisted blob holds in
// one call. `saved` / `current` are each `{ histories, snapshots, flow }`
// (any may be missing/undefined — treated as empty).
export function mergePersistedState(saved, current, knownSymbols) {
    return {
        histories: mergePersisted(saved?.histories, current?.histories, knownSymbols),
        snapshots: mergePersisted(saved?.snapshots, current?.snapshots, knownSymbols),
        flow: mergePersisted(saved?.flow, current?.flow, knownSymbols),
    };
}
