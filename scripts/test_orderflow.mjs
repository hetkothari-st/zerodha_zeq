// Quick correctness checks for the order-flow engine. Run: node scripts/test_orderflow.mjs
import {
    intervalPriceQty, bvcBuyFraction, normalCDF, stddev, foldFlow,
    emptyFlowBucket, reBucketFlow, computeFlowStats, FLOW_THRESHOLD,
} from '../src/lib/orderFlow.js';

let pass = 0, fail = 0;
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } };

// normalCDF sanity
ok('Φ(0)=0.5', approx(normalCDF(0), 0.5, 1e-6));
ok('Φ(∞)→1', normalCDF(8) > 0.999999);
ok('Φ(−∞)→0', normalCDF(-8) < 1e-6);
ok('Φ symmetric', approx(normalCDF(1) + normalCDF(-1), 1, 1e-6));

// stddev
ok('stddev sample n−1 = √(32/7)', approx(stddev([2,4,4,4,5,5,7,9]), Math.sqrt(32/7), 1e-9));
ok('stddev single = 0', stddev([3]) === 0);

// intervalPriceQty — exact VWAP from ATP*Vol turnover deltas.
// prev: 1000 sh @ avg 100 → turnover 100000. cur: 1100 sh @ avg 100.4545.. so
// new turnover = 110500 → interval 100 sh for 10500 → VWAP 105.
const pq = intervalPriceQty(
    { vol: 1000, atp: 100, ltp: 104 },
    { vol: 1100, atp: 110500 / 1100, ltp: 105 },
);
ok('interval qty = 100', pq && pq.qty === 100);
ok('interval VWAP = 105', pq && approx(pq.vwap, 105, 1e-6));

// No trade → null
ok('no Δvol → null', intervalPriceQty({ vol: 1000, atp: 100, ltp: 100 }, { vol: 1000, atp: 100, ltp: 100 }) === null);
// Day reset (cur.vol < prev.vol) → null
ok('day reset → null', intervalPriceQty({ vol: 9_000_000, atp: 100, ltp: 100 }, { vol: 5000, atp: 100, ltp: 100 }) === null);

// ATP-noise gate: 1 share interval on a big book → falls back to LTP, not garbage
const noisy = intervalPriceQty(
    { vol: 5_000_000, atp: 100.00, ltp: 100 },
    { vol: 5_000_001, atp: 100.01, ltp: 100 },
);
ok('tiny Δvol falls back to LTP', noisy && approx(noisy.vwap, 100, 1e-9));

// BVC: flat history → 0.5; strong up-move vs small vol → >0.5; down-move <0.5
ok('BVC neutral until enough samples', bvcBuyFraction(5, [5]) === 0.5);
const upWin = [0.1, -0.1, 0.05, -0.05, 0.1, -0.1, 0.0, 2.0]; // last Δp big & positive
ok('BVC up-move → buy-heavy', bvcBuyFraction(2.0, upWin) > 0.5);
const dnWin = [0.1, -0.1, 0.05, -0.05, 0.1, -0.1, 0.0, -2.0];
ok('BVC down-move → sell-heavy', bvcBuyFraction(-2.0, dnWin) < 0.5);
ok('BVC flat Δp → ~0.5', approx(bvcBuyFraction(0, [0.1,-0.1,0.1,-0.1,0.1,-0.1,0.1,-0.1]), 0.5, 1e-9));

// foldFlow + reBucketFlow + computeFlowStats end-to-end
let b = emptyFlowBucket('10:00', 1000);
foldFlow(b, { buyQty: 60, sellQty: 40, buyTurnover: 60 * 105, sellTurnover: 40 * 104 });
foldFlow(b, { buyQty: 40, sellQty: 60, buyTurnover: 40 * 106, sellTurnover: 60 * 103 });
ok('fold sums buyQty', b.buyQty === 100);
ok('fold sums sellQty', b.sellQty === 100);
const stats = computeFlowStats(b, 107);
ok('buyVWAP exact', approx(stats.buyVwap, (60*105 + 40*106) / 100, 1e-9));
ok('sellVWAP exact', approx(stats.sellVwap, (40*104 + 60*103) / 100, 1e-9));
ok('buyGap = live − buyVWAP', approx(stats.buyGap, 107 - stats.buyVwap, 1e-9));
ok('sellGap = live − sellVWAP (sold below = +)', stats.sellGap > 0);
ok('net flat when balanced', stats.net === 'flat');

// reBucketFlow merges two raw rows sharing a key
const flow = { S1: [
    { minute: '10:00:00', timestamp: 1000, buyQty: 10, sellQty: 5, buyTurnover: 1000, sellTurnover: 500 },
    { minute: '10:00:15', timestamp: 16000, buyQty: 20, sellQty: 5, buyTurnover: 2000, sellTurnover: 500 },
]};
const reb = reBucketFlow(flow, () => '10:00'); // collapse both into one minute
ok('reBucketFlow merges', reb.S1.length === 1 && reb.S1[0].buyQty === 30 && reb.S1[0].sellQty === 10);

ok('FLOW_THRESHOLD = 1 lakh', FLOW_THRESHOLD === 100000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
