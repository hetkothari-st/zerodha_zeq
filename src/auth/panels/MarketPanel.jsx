import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveMotion } from './useLiveMotion';

const mono = "font-['JetBrains_Mono',monospace]";
const ROW = 36;
const MODES = [
    { key: 'gainers', label: 'Gainers', title: 'leaderboard', color: '#059669', up: true,
      names: [['ADANIENT', 3124.5], ['TATASTEEL', 168.4], ['HINDALCO', 694.2], ['JSWSTEEL', 998.7], ['BPCL', 342.1], ['ONGC', 271.3], ['COALINDIA', 486.9], ['ADANIPORTS', 1432.6], ['GRASIM', 2689.4], ['TECHM', 1654.8]] },
    { key: 'losers', label: 'Losers', title: 'laggards', color: '#dc2626', up: false,
      names: [['HCLTECH', 1788.3], ['WIPRO', 512.8], ['NESTLEIND', 2412.5], ['ASIANPAINT', 2898.1], ['DRREDDY', 1296.4], ['CIPLA', 1532.7], ['BRITANNIA', 5810.2], ['EICHERMOT', 4912.6], ['HEROMOTOCO', 5188.3], ['APOLLOHOSP', 7020.9]] },
    { key: 'volume', label: 'Volume', title: 'volume leaders', color: '#7c3aed', up: true,
      names: [['SUZLON', 71.2], ['YESBANK', 23.4], ['IDEA', 14.8], ['IRFC', 162.5], ['PNB', 118.9], ['TATAPOWER', 434.8], ['NHPC', 96.3], ['BEL', 301.7], ['ZOMATO', 264.1], ['SAIL', 139.6]] },
];

function seeded(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

function rowsFor(mode, rand) {
    return mode.names.map(([name, price]) => ({ name, price, change: 0.5 + rand() * 3.5 }));
}

function rankMap(rows) {
    return Object.fromEntries([...rows].sort((a, b) => b.change - a.change).map((r, i) => [r.name, i]));
}

// Illustrative NSE movers leaderboard for the Funnel Eq auth screens (spec §3.2). Not real market data.
export default function MarketPanel({ compact = false }) {
    const live = useLiveMotion();
    const rand = useMemo(() => seeded(11), []);
    const [modeIdx, setModeIdx] = useState(0);
    const mode = MODES[modeIdx];
    const [board, setBoard] = useState(() => ({ rows: rowsFor(MODES[0], seeded(11)), prevRank: {} }));
    const lastModeIdx = useRef(modeIdx);

    useEffect(() => {
        if (lastModeIdx.current === modeIdx) return; // initial state already matches mode 0; skip redundant mount reset
        lastModeIdx.current = modeIdx;
        setBoard({ rows: rowsFor(mode, rand), prevRank: {} });
    }, [mode, modeIdx, rand]);

    useEffect(() => {
        if (!live) return undefined;
        const tick = setInterval(() => {
            setBoard(({ rows }) => {
                const before = rankMap(rows);
                const nextRows = rows.map((r) => ({ ...r, change: Math.max(0.1, r.change + (rand() - 0.5) * 0.9) }));
                return { rows: nextRows, prevRank: before };
            });
        }, 1800);
        const cycle = setInterval(() => setModeIdx((i) => (i + 1) % MODES.length), 5000);
        return () => { clearInterval(tick); clearInterval(cycle); };
    }, [live, rand]);

    const { rows, prevRank } = board;
    const sorted = [...rows].sort((a, b) => b.change - a.change).slice(0, compact ? 3 : 10);
    const max = sorted[0]?.change || 1;

    return (
        <div className="absolute inset-0 flex flex-col gap-3 bg-[#f7f6f2] px-6 py-5 text-gray-900">
            <div className="flex items-baseline justify-between">
                <span className="font-['Sora',sans-serif] text-xl font-extrabold">Funnel<span className="text-[#059669]">Eq</span></span>
                <div role="tablist" className="flex gap-1 rounded-lg bg-[#ecebe6] p-0.5 text-[11px] font-semibold">
                    {MODES.map((m, i) => (
                        <button key={m.key} type="button" role="tab" aria-selected={i === modeIdx}
                            className={`rounded-md px-2.5 py-1 ${i === modeIdx ? 'bg-white text-gray-900' : 'text-gray-500'}`}
                            onClick={() => setModeIdx(i)}>{m.label}</button>
                    ))}
                </div>
            </div>
            {!compact && (
                <div className="font-['Sora',sans-serif] text-3xl font-extrabold leading-tight tracking-tight">
                    Today's<br /><span style={{ color: mode.color }}>{mode.title}</span> on NSE
                </div>
            )}
            <ol data-testid="eq-board" className="relative" style={{ height: sorted.length * ROW }}>
                {sorted.map((r, i) => {
                    const was = prevRank[r.name];
                    const moved = was === undefined || was === i ? '•' : was > i ? '▲' : '▼';
                    const movedColor = moved === '▲' ? 'text-[#059669]' : moved === '▼' ? 'text-[#dc2626]' : 'text-gray-300';
                    return (
                        <li key={r.name} className="absolute left-0 right-0 flex h-[34px] items-center gap-2 rounded-lg bg-white px-2.5 text-xs transition-[top] duration-700"
                            style={{ top: i * ROW }}>
                            <span className={`${mono} w-4 text-[10px] text-gray-400`}>{i + 1}</span>
                            <span className={`w-3 text-[9px] ${movedColor}`}>{moved}</span>
                            <span className="flex-1 font-bold">{r.name}</span>
                            {!compact && <span className={`${mono} w-20 text-right text-[11px] text-gray-500`}>₹{r.price.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>}
                            <span className="h-1.5 w-14 overflow-hidden rounded bg-gray-100"><i className="block h-full rounded" style={{ width: `${(r.change / max) * 100}%`, background: mode.color }} /></span>
                            <span className={`${mono} w-16 text-right font-bold`} style={{ color: mode.color }}>{mode.up ? '+' : '-'}{r.change.toFixed(2)}%</span>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}
