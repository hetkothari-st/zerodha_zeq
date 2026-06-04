// ─────────────────────────────────────────────────────────────────────────
// Order-flow approximation engine
// ─────────────────────────────────────────────────────────────────────────
// Zerodha's KiteTicker feed is a SNAPSHOT feed (max ~1 tick/sec/instrument).
// It does NOT expose individual trades, the trade tape, or an aggressor flag.
// True per-trade buy/sell sides require NSE's tick-by-tick (TBT) colo feed.
//
// This module reconstructs an APPROXIMATE buy-side / sell-side split from the
// snapshot stream, squeezing every exact quantity the feed actually carries:
//
//   • Exact traded quantity per interval:  ΔV = Volume_now − Volume_prev
//   • Exact volume-weighted price per interval, from the cumulative
//     turnover that ATP encodes:
//         turnover_t   = ATP_t × Volume_t           (₹ traded since open)
//         intervalVWAP = (turnover_now − turnover_prev) / ΔV
//     This is the TRUE VWAP of every trade in the interval — not a guess.
//   • The buy/sell SPLIT is the only approximate step. We use Bulk Volume
//     Classification (BVC; Easley, López de Prado & O'Hara, 2012), which is
//     built for aggregated bars rather than single trades — exactly our case,
//     since each 1-sec snapshot collapses many trades. BVC assigns a FRACTION
//     of the interval's volume to the buy side:
//         Δp        = intervalVWAP_t − intervalVWAP_{t−1}
//         z         = Δp / σ(Δp)        (σ = rolling std-dev of Δp)
//         buyFrac   = Φ(z)              (standard normal CDF)
//         buyQty    = ΔV × buyFrac,   sellQty = ΔV × (1 − buyFrac)
//     A flat interval (Δp ≈ 0) splits ~50/50; a sharp up-move skews to buy.
//
// Accuracy ceiling on a 1-sec feed is ~85-90% (many trades per interval are
// individually unobservable). BVC approaches that ceiling; it is NOT a literal
// trade tape.
// ─────────────────────────────────────────────────────────────────────────

export const FLOW_THRESHOLD = 100000; // 1 lakh — drill-down trigger

// Rolling window (in intervals) used to estimate Δp volatility for BVC.
// 30 × 15s ≈ 7.5 min of context.
export const DP_WINDOW = 30;
// Neutral 50/50 split until the window holds at least this many samples.
// Also removes any session-open directional bias.
const MIN_SAMPLES = 8;

// Standard normal CDF Φ(z) — Zelen & Severo rational approximation (|err| < 8e-8).
export function normalCDF(z) {
    if (!Number.isFinite(z)) return 0.5;
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp(-z * z / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
        t * (-1.821255978 + t * 1.330274429))));
    return z >= 0 ? 1 - p : p;
}

// Sample standard deviation (n−1). Returns 0 for < 2 samples.
export function stddev(arr) {
    const n = arr.length;
    if (n < 2) return 0;
    let mean = 0;
    for (const x of arr) mean += x;
    mean /= n;
    let s = 0;
    for (const x of arr) s += (x - mean) * (x - mean);
    return Math.sqrt(s / (n - 1));
}

// ATP is rounded to paise, so at tiny interval volume the turnover-delta VWAP
// blows up. Gate on a minimum interval volume and reject implausible drift,
// falling back to the last trade price.
const sanitizeVwap = (vwap, ltp, qty, prevVol) => {
    const ltpOk = Number.isFinite(ltp) && ltp > 0;
    if (!Number.isFinite(vwap) || vwap <= 0) return ltpOk ? ltp : null;
    const minVol = Math.max(50, (prevVol || 0) * 0.0001);
    if (qty < minVol) return ltpOk ? ltp : vwap;            // ATP noise dominates
    if (ltpOk && Math.abs(vwap - ltp) / ltp > 0.05) return ltp; // >5% drift = artifact
    return vwap;
};

// Exact interval quantity + VWAP between two consecutive snapshots.
//   prev / cur: { vol, atp, ltp }
// Returns { qty, vwap } or null when nothing traded / on a day-counter reset.
export function intervalPriceQty(prev, cur) {
    if (!prev || !cur) return null;
    const qty = (cur.vol ?? 0) - (prev.vol ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    const haveAtp = Number.isFinite(cur.atp) && cur.atp > 0 &&
        Number.isFinite(prev.atp) && prev.atp > 0;
    let vwap = haveAtp ? (cur.atp * cur.vol - prev.atp * prev.vol) / qty : cur.ltp;
    vwap = sanitizeVwap(vwap, cur.ltp, qty, prev.vol);
    if (vwap == null) return null;
    return { qty, vwap };
}

// BVC buy-side fraction for one interval. dpWindow holds recent Δp values
// (including the current one). Neutral until the window is populated.
export function bvcBuyFraction(dp, dpWindow) {
    if (dpWindow.length < MIN_SAMPLES) return 0.5;
    const sigma = stddev(dpWindow);
    if (!(sigma > 0)) return 0.5;
    return normalCDF(dp / sigma);
}

export const emptyFlowBucket = (minute, timestamp) => ({
    minute, timestamp,
    buyQty: 0, sellQty: 0, buyTurnover: 0, sellTurnover: 0,
});

// Fold a classified interval { buyQty, sellQty, buyTurnover, sellTurnover }
// into a mutable flow bucket (sums are additive, so per-side VWAP stays exact
// under aggregation).
export function foldFlow(bucket, f) {
    if (!f) return bucket;
    bucket.buyQty += f.buyQty;
    bucket.sellQty += f.sellQty;
    bucket.buyTurnover += f.buyTurnover;
    bucket.sellTurnover += f.sellTurnover;
    return bucket;
}

// Re-aggregate raw flow rows into a larger timeframe. `keyFn(ts)` returns the
// new bucket label (pass the same bucketer the histories use so keys line up).
export function reBucketFlow(flow, keyFn) {
    const result = {};
    for (const [stockId, rows] of Object.entries(flow || {})) {
        if (!Array.isArray(rows) || rows.length === 0) { result[stockId] = []; continue; }
        const grouped = new Map();
        for (const row of rows) {
            const key = keyFn(row.timestamp || 0);
            let g = grouped.get(key);
            if (!g) { g = emptyFlowBucket(key, row.timestamp); grouped.set(key, g); }
            g.buyQty += row.buyQty || 0;
            g.sellQty += row.sellQty || 0;
            g.buyTurnover += row.buyTurnover || 0;
            g.sellTurnover += row.sellTurnover || 0;
            g.timestamp = row.timestamp || g.timestamp;
        }
        const agg = [...grouped.values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        result[stockId] = agg.length > 1500 ? agg.slice(-1500) : agg;
    }
    return result;
}

// Derive display stats for one flow bucket against the live price.
//   sellGap > 0  → sell side filled BELOW the current price (sold into a
//                  relative loss / left money on the table)
//   buyGap  > 0  → buy side filled BELOW the current price (now in profit)
export function computeFlowStats(bucket, liveLtp) {
    if (!bucket) return null;
    const buyQty = bucket.buyQty || 0;
    const sellQty = bucket.sellQty || 0;
    const total = buyQty + sellQty;
    const buyVwap = buyQty > 0 ? bucket.buyTurnover / buyQty : null;
    const sellVwap = sellQty > 0 ? bucket.sellTurnover / sellQty : null;
    const buyPct = total > 0 ? buyQty / total : 0;
    const sellPct = total > 0 ? sellQty / total : 0;
    const net = Math.abs(buyQty - sellQty) < total * 0.02 ? 'flat'
        : (buyQty > sellQty ? 'buy' : 'sell');
    const ltp = Number.isFinite(liveLtp) ? liveLtp : null;
    const sellGap = (sellVwap != null && ltp != null) ? ltp - sellVwap : null;
    const buyGap = (buyVwap != null && ltp != null) ? ltp - buyVwap : null;
    const pct = (gap, base) => (gap != null && base) ? (gap / base) * 100 : null;
    return {
        buyQty, sellQty, total, buyVwap, sellVwap, buyPct, sellPct, net,
        sellGap, buyGap,
        sellGapPct: pct(sellGap, sellVwap),
        buyGapPct: pct(buyGap, buyVwap),
        liveLtp: ltp,
    };
}
