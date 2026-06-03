import React, { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, Activity, Plus, Search, X, FlaskConical, LogOut, LogIn } from 'lucide-react';
import { useMarketData } from './hooks/useMarketData';
import MonitorDashboard from './components/MonitorDashboard';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import stocksData from './stocks_nsecm.json';
import contractsData from './contracts_nsefo.json';
import { useAuth, buildWsCredential } from './auth/AuthContext';
import LoginPage from './auth/LoginPage';

function cn(...inputs) {
    return twMerge(clsx(inputs));
}

// Default stocks already shown in the columns. Listed here so the dropdown can
// hide them and only offer truly "extra" symbols.
const DEFAULT_SYMBOLS = new Set([
    'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'BHARTIARTL', 'INFY', 'SBIN',
]);

// NIFTY 50 constituents (NSE symbols). Verified against Wikipedia / Dhan
// (cross-checked Dec 2025 / Apr 2026). The Add-Stock dropdown is restricted
// to these — tokens come from `stocks_nsecm.json` lookup. Update this list
// when the index re-balances.
//
// Recent (post-Oct 2025) ticker renames to be aware of:
//   ZOMATO     → ETERNAL  (parent renamed Eternal Limited)
//   TATAMOTORS → TMPV     (post-demerger; passenger-vehicle entity stays in NIFTY 50)
const NIFTY_50 = [
    'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK',
    'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BEL', 'BHARTIARTL',
    'CIPLA', 'COALINDIA', 'DRREDDY', 'EICHERMOT', 'ETERNAL',
    'GRASIM', 'HCLTECH', 'HDFCBANK', 'HDFCLIFE', 'HINDALCO',
    'HINDUNILVR', 'ICICIBANK', 'INDIGO', 'INFY', 'ITC',
    'JIOFIN', 'JSWSTEEL', 'KOTAKBANK', 'LT', 'M&M',
    'MARUTI', 'MAXHEALTH', 'NESTLEIND', 'NTPC', 'ONGC',
    'POWERGRID', 'RELIANCE', 'SBILIFE', 'SHRIRAMFIN', 'SBIN',
    'SUNPHARMA', 'TCS', 'TATACONSUM', 'TMPV', 'TATASTEEL',
    'TECHM', 'TITAN', 'TRENT', 'ULTRACEMCO', 'WIPRO',
];

const BUCKET_OPTIONS = [
    { value: 0.25, label: '15s' },
    { value: 0.5,  label: '30s' },
    { value: 1,    label: '1m'  },
    { value: 2,    label: '2m'  },
    { value: 3,    label: '3m'  },
    { value: 4,    label: '4m'  },
    { value: 5,    label: '5m'  },
    { value: 10,   label: '10m' },
    { value: 15,   label: '15m' },
    { value: 30,   label: '30m' },
    { value: 45,   label: '45m' },
    { value: 60,   label: '60m' },
];

const VOLUME_UNIT_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: 'K',    label: 'K'    },
    { value: 'L',    label: 'L'    },
    { value: 'Cr',   label: 'Cr'   },
];

// ---------- Demo / dummy data ----------
// Plausible starting LTPs for the default stocks + indices. The dummy
// generator random-walks LTP and bumps TTQ each tick so the per-minute
// candle/volume logic in VerticalLayout has something to chew on.
const DEMO_SEEDS = [
    { tkn: '26000', ltp: 23000, symbol: 'NIFTY 50' },
    { tkn: '1',     ltp: 74000, symbol: 'SENSEX' },
    { tkn: '2885',  ltp: 1300,  symbol: 'RELIANCE' },
    { tkn: '1333',  ltp: 770,   symbol: 'HDFCBANK' },
    { tkn: '4963',  ltp: 1240,  symbol: 'ICICIBANK' },
    { tkn: '10604', ltp: 1820,  symbol: 'BHARTIARTL' },
    { tkn: '1594',  ltp: 1335,  symbol: 'INFY' },
    { tkn: '3045',  ltp: 1030,  symbol: 'SBIN' },
];

// MT Data Feed API field names (verified against MT_Data_Feed_API_V1.pdf):
//   MarketData (FT 1) packet fields:
//     LTP   = Last Traded Price
//     TTQ   = Total Traded Quantity
//     O     = Open Price (today's open)
//     H     = High Price
//     L     = Low Price
//     C     = Close Price  ← *** previous day's close ***
//     ATP   = Average Trade Price
//     ...
//   IndexData (FT 1, for NIFTY/SENSEX/etc):
//     Price = Index Value (current)
//     O     = Today's Open Value
//     C     = "Previous Days Close Value of Index"  (verbatim from docs)
//
// So the previous-day close is sent in the `C` field on every MarketData /
// IndexData packet — NOT under `PrevClose` / `PrevCl` / etc. that I was
// guessing earlier. We probe several candidate names just in case the feed
// version differs, but `C` is the one that actually arrives.
const PRICE_KEYS      = ['LTP', 'ltp', 'LastTradedPrice', 'Price', 'lp', 'iv'];
const OPEN_PRICE_KEYS = ['O', 'Open', 'OpenPrice', 'op', 'OpenRate'];
const PREV_CLOSE_KEYS = ['C', 'Close', 'PrevClose', 'PreviousClose', 'PrevCl', 'PC'];

const readNum = (packet, keys) => {
    if (!packet) return null;
    for (const k of keys) {
        if (packet[k] !== undefined && packet[k] !== null && packet[k] !== '') {
            const n = Number(packet[k]);
            if (!Number.isNaN(n) && n !== 0) return n;
        }
    }
    return null;
};
const readLtp       = (p) => readNum(p, PRICE_KEYS);
const readOpen      = (p) => readNum(p, OPEN_PRICE_KEYS);
const readPrevClose = (p) => readNum(p, PREV_CLOSE_KEYS);

const App = () => {
    return <AuthedApp user={{ username: 'guest' }} logout={() => {}} />;
};

const AuthedApp = ({ user, logout }) => {
    // Build a unique WS credential for this session. Stable for the lifetime
    // of this component (i.e. until logout / full reload) — we don't want a
    // new credential on every render because that would also cause a
    // reconnect storm.
    const wsCredential = useMemo(() => buildWsCredential(user), [user]);

    const [debugLogs, setDebugLogs] = useState([]);

    const [isWsEnabled, setIsWsEnabled] = useState(() => {
        const saved = localStorage.getItem('mt_ws_enabled');
        return saved !== null ? JSON.parse(saved) : true;
    });
    const [requestToken, setRequestToken] = useState('');
    const [tokenExchangeState, setTokenExchangeState] = useState('idle');
    const [accessToken, setAccessToken] = useState('');
    const [accessTokenState, setAccessTokenState] = useState('idle'); // idle | loading | error

    useEffect(() => {
        localStorage.setItem('mt_ws_enabled', JSON.stringify(isWsEnabled));
    }, [isWsEnabled]);

    // ---------- Multi-monitor state ----------
    // Each monitor is a fully independent "session": it has its own extra
    // stocks, its own timeframe, its own histories (stored inside
    // VerticalLayout, namespaced by monitorId). All monitors render at once
    // (inactive ones are hidden with CSS) so every monitor keeps processing
    // WS packets in the background. No monitor ever goes stale just because
    // it isn't the active tab.
    const [monitors, setMonitors] = useState(() => {
        try {
            const saved = localStorage.getItem('mt_monitors_list');
            const arr = saved ? JSON.parse(saved) : [{ id: 0 }];
            return Array.isArray(arr) && arr.length > 0 ? arr : [{ id: 0 }];
        } catch { return [{ id: 0 }]; }
    });
    const [activeMonitorId, setActiveMonitorId] = useState(() => {
        try {
            const saved = localStorage.getItem('mt_active_monitor_id');
            return saved !== null ? JSON.parse(saved) : 0;
        } catch { return 0; }
    });

    // Per-monitor extra stocks, keyed by monitor id.
    const [extraStocksByMonitor, setExtraStocksByMonitor] = useState(() => {
        try {
            const saved = localStorage.getItem('mt_extra_stocks_by_monitor_v1');
            if (saved) return JSON.parse(saved);
        } catch {}
        // Migrate from the old single-key storage if present
        try {
            const legacy = localStorage.getItem('vl_extra_stocks_v1');
            if (legacy) return { 0: JSON.parse(legacy) };
        } catch {}
        return { 0: [] };
    });

    // Per-monitor bucket size, keyed by monitor id.
    const [bucketSizeByMonitor, setBucketSizeByMonitor] = useState(() => {
        try {
            const saved = localStorage.getItem('mt_bucket_size_by_monitor_v1');
            if (saved) return JSON.parse(saved);
        } catch {}
        // Migrate from the old single-key storage
        try {
            const legacy = localStorage.getItem('vl_bucket_size');
            if (legacy) return { 0: JSON.parse(legacy) };
        } catch {}
        return { 0: 1 };
    });

    // Persist monitor collections
    useEffect(() => {
        try { localStorage.setItem('mt_monitors_list', JSON.stringify(monitors)); } catch {}
    }, [monitors]);
    useEffect(() => {
        try { localStorage.setItem('mt_active_monitor_id', JSON.stringify(activeMonitorId)); } catch {}
    }, [activeMonitorId]);
    useEffect(() => {
        try { localStorage.setItem('mt_extra_stocks_by_monitor_v1', JSON.stringify(extraStocksByMonitor)); } catch {}
    }, [extraStocksByMonitor]);
    useEffect(() => {
        try { localStorage.setItem('mt_bucket_size_by_monitor_v1', JSON.stringify(bucketSizeByMonitor)); } catch {}
    }, [bucketSizeByMonitor]);

    // Derived: the active monitor's per-monitor settings (used by top bar).
    const activeExtraStocks = extraStocksByMonitor[activeMonitorId] || [];
    const activeBucketSize = bucketSizeByMonitor[activeMonitorId] || 1;

    const handleAddExtraStockToActive = (symbol) => {
        if (!symbol) return;
        if (DEFAULT_SYMBOLS.has(symbol)) return;
        setExtraStocksByMonitor(prev => {
            const list = prev[activeMonitorId] || [];
            if (list.some(e => e.symbol === symbol)) return prev;
            return { ...prev, [activeMonitorId]: [...list, { symbol }] };
        });
    };
    const handleRemoveExtraStockFromMonitor = (monitorId, symbol) => {
        setExtraStocksByMonitor(prev => ({
            ...prev,
            [monitorId]: (prev[monitorId] || []).filter(e => e.symbol !== symbol),
        }));
    };
    const handleSetBucketSizeForActive = (size) => {
        setBucketSizeByMonitor(prev => ({ ...prev, [activeMonitorId]: size }));
    };

    const handleAddMonitor = () => {
        const newId = Math.max(-1, ...monitors.map(m => m.id)) + 1;
        setMonitors(prev => [...prev, { id: newId }]);
        setExtraStocksByMonitor(prev => ({ ...prev, [newId]: [] }));
        setBucketSizeByMonitor(prev => ({ ...prev, [newId]: 1 }));
        setActiveMonitorId(newId);
    };

    const handleRemoveMonitor = (id) => {
        if (monitors.length <= 1) return;
        setMonitors(prev => prev.filter(m => m.id !== id));
        setExtraStocksByMonitor(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
        setBucketSizeByMonitor(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
        if (activeMonitorId === id) {
            const remaining = monitors.filter(m => m.id !== id);
            setActiveMonitorId(remaining[0]?.id ?? 0);
        }
        // Clean up that monitor's namespaced localStorage so stale data
        // doesn't haunt us on the next refresh.
        try {
            localStorage.removeItem(`vl_state_v2_m${id}`);
            localStorage.removeItem(`vl_column_order_v1_m${id}`);
            localStorage.removeItem(`vl_column_widths_v1_m${id}`);
            localStorage.removeItem(`vl_int_vol_minutes_v1_m${id}`);
            localStorage.removeItem(`vl_sidebar_width_v1_m${id}`);
        } catch {}
    };

    // ---------- WebSocket ----------
    const addDebug = useCallback((msg) => {
        setDebugLogs(prev => [msg, ...prev].slice(0, 8));
    }, []);

    const handleRawMessage = useCallback((type, data) => {
        const highFreqTypes = ['Depth', 'DepthData', 'IndexData', 'MarketData'];
        if (type === 'Info' || (type === 'Login' && data?.Error === null)) {
            addDebug(`[WS] ${type} confirmed`);
        } else if (!highFreqTypes.includes(type)) {
            addDebug(`[WS] ${type} received`);
        }
    }, [addDebug]);

    const depthEvents = useRef(new EventTarget());
    // Mirror demoMode into a ref so the handleDepthPacket callback (which is
    // stable / memoized) can read the current value without needing to be
    // re-created. When demo is ON we discard real WS packets entirely so the
    // synthetic feed and the real feed don't race each other.
    const demoModeRef = useRef(false);
    const handleDepthPacket = useCallback((packet) => {
        if (demoModeRef.current) return;
        depthEvents.current.dispatchEvent(new CustomEvent('depth-packet', { detail: packet }));
    }, []);

    const { status, depthData, subscribe } = useMarketData(isWsEnabled, handleRawMessage, handleDepthPacket, wsCredential);

    const handleSetAccessToken = useCallback(async () => {
        if (!accessToken.trim()) return;
        setAccessTokenState('loading');
        try {
            const res = await fetch(`http://${window.location.hostname}:3000/api/set-access-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_token: accessToken.trim() }),
            });
            const data = await res.json();
            if (!data.ok) { setAccessTokenState('error'); return; }
            localStorage.setItem('kite_access_token', data.access_token);
            setAccessToken('');
            setAccessTokenState('idle');
            setIsWsEnabled(true);
        } catch {
            setAccessTokenState('error');
        }
    }, [accessToken]);

    const handleExchangeToken = useCallback(async () => {
        if (!requestToken.trim()) return;
        setTokenExchangeState('loading');
        try {
            const res = await fetch(`http://${window.location.hostname}:3000/api/exchange-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ request_token: requestToken.trim() }),
            });
            const data = await res.json();
            if (!data.ok) { setTokenExchangeState('error'); return; }
            localStorage.setItem('kite_access_token', data.access_token);
            setRequestToken('');
            setTokenExchangeState('idle');
            setIsWsEnabled(true);
        } catch {
            setTokenExchangeState('error');
        }
    }, [requestToken]);

    const handleClearAll = () => {
        // Monitor-scoped clear — only the ACTIVE monitor gets wiped.
        window.dispatchEvent(new CustomEvent('vl-clear', {
            detail: { monitorId: activeMonitorId },
        }));
    };

    // ---------- Live clock ----------
    const [clock, setClock] = useState(() => new Date());
    useEffect(() => {
        const id = setInterval(() => setClock(new Date()), 1000);
        return () => clearInterval(id);
    }, []);
    const clockStr = `${clock.getHours().toString().padStart(2, '0')}:${clock.getMinutes().toString().padStart(2, '0')}:${clock.getSeconds().toString().padStart(2, '0')}`;

    // ---------- Market open/close state ----------
    // NSE market hours: Mon–Fri, 09:15–15:32 IST. Outside this window we
    // show a "Market Closed" overlay and stop processing new packets.
    // (15:32 rather than 15:30 per user request — small grace window after
    // the official close so post-close auction prints still land cleanly.)
    // NOTE: when demoMode is ON we force-treat the market as open so the
    // synthetic feed can drive the UI regardless of wall-clock time.
    const isMarketOpenNow = (d) => {
        const day = d.getDay(); // 0 = Sun, 6 = Sat
        if (day === 0 || day === 6) return false;
        const mins = d.getHours() * 60 + d.getMinutes();
        const OPEN  = 9 * 60 + 15;   // 09:15
        const CLOSE = 15 * 60 + 32;  // 15:32
        return mins >= OPEN && mins < CLOSE;
    };
    const realMarketOpen = isMarketOpenNow(clock);

    // ---------- Demo mode ----------
    // Declared here (ABOVE the marketOpen computation) because demo mode
    // forces marketOpen to true regardless of wall-clock time. Persists to
    // localStorage so reloads keep the chosen mode.
    // Dummy/demo data feature disabled — always use the live WS feed.
    // const [demoMode, setDemoMode] = useState(() => {
    //     try { return JSON.parse(localStorage.getItem('vl_demo_mode') || 'false'); } catch { return false; }
    // });
    // useEffect(() => {
    //     try { localStorage.setItem('vl_demo_mode', JSON.stringify(demoMode)); } catch {}
    //     demoModeRef.current = demoMode;
    // }, [demoMode]);
    const demoMode = false;
    const setDemoMode = () => {};

    // Final marketOpen signal — real clock OR demo mode.
    const marketOpen = realMarketOpen || demoMode;

    // Let the user manually dismiss the overlay. Auto-resets the moment the
    // market opens again, so tomorrow morning the overlay can show normally.
    const [marketClosedDismissed, setMarketClosedDismissed] = useState(false);
    useEffect(() => {
        if (marketOpen && marketClosedDismissed) setMarketClosedDismissed(false);
    }, [marketOpen, marketClosedDismissed]);

    // ---------- Auto-disconnect on market close / auto-reconnect on open ----------
    // Track the previous marketOpen value so we can detect transitions.
    const prevMarketOpenRef = useRef(marketOpen);
    useEffect(() => {
        const wasOpen = prevMarketOpenRef.current;
        prevMarketOpenRef.current = marketOpen;

        if (!marketOpen && wasOpen) {
            // Market just closed → disconnect and remember we were connected
            setIsWsEnabled(false);
            try { localStorage.setItem('mt_ws_auto_reconnect', 'true'); } catch {}
        } else if (marketOpen && !wasOpen) {
            // Market just opened → auto-reconnect if we were connected before close
            try {
                const shouldReconnect = localStorage.getItem('mt_ws_auto_reconnect');
                if (shouldReconnect === 'true') {
                    setIsWsEnabled(true);
                    localStorage.removeItem('mt_ws_auto_reconnect');
                }
            } catch {}
        }
    }, [marketOpen]);

    const [demoDepth, setDemoDepth] = useState({});

    // Mirror the flattened union of every monitor's extra stocks into a ref
    // so the demo interval can pick up new user-added stocks across all
    // monitors without being torn down.
    const extraStocksRef = useRef([]);
    useEffect(() => {
        const union = [];
        const seen = new Set();
        for (const list of Object.values(extraStocksByMonitor)) {
            for (const es of (list || [])) {
                if (!seen.has(es.symbol)) {
                    seen.add(es.symbol);
                    union.push(es);
                }
            }
        }
        extraStocksRef.current = union;
    }, [extraStocksByMonitor]);

    // Per-token mutable demo state stays in a ref so accumulated TTQ persists
    // across renders (and we can add tokens on-the-fly when extras get added).
    // Each entry:  { tkn, symbol, ltp (current), ttq, prevClose (locked) }
    const demoStateRef = useRef({});

    // Demo data generator disabled.
    /*
    useEffect(() => {
        if (!demoMode) {
            setDemoDepth({});
            demoStateRef.current = {};
            return;
        }

        // Seed the default tokens. prevClose is locked at the seed LTP so it
        // behaves like a real previous day's close, giving A/D a baseline.
        for (const s of DEMO_SEEDS) {
            if (!demoStateRef.current[s.tkn]) {
                demoStateRef.current[s.tkn] = {
                    tkn: s.tkn,
                    symbol: s.symbol,
                    ltp: s.ltp,
                    ttq: 0,
                    prevClose: s.ltp,
                };
            }
        }

        // Helper: dispatch a synthetic depth-packet on the same event bus the
        // real WS uses. All downstream consumers (VerticalLayout.processPacket,
        // NIFTY A/D handler, ATM widget handler) listen to this bus, so this
        // is the ONLY place demo data needs to flow through.
        const dispatchDemo = (s) => {
            const packet = {
                Tkn: s.tkn,
                LTP: s.ltp,
                TTQ: s.ttq,
                C:   s.prevClose,           // prev close → NIFTY A/D baseline
                O:   s.prevClose,           // treat open as prev close in demo
                _type: 'MarketData',
                _receivedAt: Date.now(),
            };
            depthEvents.current.dispatchEvent(
                new CustomEvent('depth-packet', { detail: packet })
            );
        };

        // Pre-fill the snapshot + fire one packet per seed so the UI lights
        // up on the very first tick instead of waiting a full second.
        const initial = {};
        for (const s of Object.values(demoStateRef.current)) {
            initial[s.tkn] = { Tkn: s.tkn, LTP: s.ltp, TTQ: s.ttq, C: s.prevClose };
            dispatchDemo(s);
        }
        setDemoDepth(initial);

        const id = setInterval(() => {
            // Pull in any newly-added extra stocks. Look up their token from
            // stocks_nsecm.json and assign a plausible random starting LTP.
            for (const es of extraStocksRef.current) {
                const row = stocksData.find(r => r.s === es.symbol && (r.x === 'NSECM' || r.x === 'NSE'));
                if (row && !demoStateRef.current[row.t]) {
                    const seedLtp = 200 + Math.random() * 4800;
                    demoStateRef.current[row.t] = {
                        tkn: row.t,
                        symbol: es.symbol,
                        ltp: seedLtp,
                        ttq: 0,
                        prevClose: seedLtp,
                    };
                }
            }

            const next = {};
            for (const s of Object.values(demoStateRef.current)) {
                // LTP random walk ±0.15%
                const drift = (Math.random() - 0.5) * 0.003;
                s.ltp = +(s.ltp * (1 + drift)).toFixed(2);
                // TTQ jump 0..200000
                s.ttq += Math.floor(Math.random() * 200000);
                next[s.tkn] = { Tkn: s.tkn, LTP: s.ltp, TTQ: s.ttq, C: s.prevClose };
                dispatchDemo(s);
            }
            setDemoDepth(next);
        }, 1000);
        return () => clearInterval(id);
    }, [demoMode]);
    */

    // ---------- Effective depthData (real or dummy) ----------
    // Only used now by the NIFTY/SENSEX top-bar LTP tiles, which read
    // straight from state. Everything else is event-driven.
    const effectiveDepth = demoMode ? demoDepth : depthData;

    // ---------- NIFTY / SENSEX live LTP for the top bar ----------
    const niftyLtp = readLtp(effectiveDepth?.['26000']);
    const sensexLtp = readLtp(effectiveDepth?.['1']);

    // ---------- ATM strike widget (NIFTY / SENSEX) ----------
    // Build sorted strike arrays ONCE per mount from contracts_nsefo.json.
    // The ATM strike is the element closest to the live spot — NO hardcoded
    // 50/100 step, so we can never produce a non-existent strike.
    const availableStrikes = useMemo(() => {
        const todayIso = new Date().toISOString().split('T')[0];
        const strikes = {};
        for (const symbol of ['NIFTY', 'BSX']) {
            const future = contractsData.filter(
                c => c.s === symbol && (c.e || '') >= todayIso
            );
            const sortedExpiries = [...new Set(future.map(c => c.e))].sort();
            const nearest = sortedExpiries[0] || null;
            if (nearest) {
                const set = new Set();
                for (const c of future) {
                    if (c.e === nearest && c.p === 'CE') {
                        const n = Number(c.st);
                        if (Number.isFinite(n)) set.add(Math.round(n));
                    }
                }
                strikes[symbol] = [...set].sort((a, b) => a - b);
            } else {
                strikes[symbol] = [];
            }
        }
        return strikes;
    }, []);

    // Snap `spot` to the closest value in `strikes` (sorted ascending).
    // Returns an integer strike or null. Uses linear scan since the array
    // has ≤ a few hundred entries — fine for once-per-render work.
    const snapToClosestStrike = (spot, strikes) => {
        if (spot == null || !strikes || strikes.length === 0) return null;
        let best = strikes[0];
        let bestDiff = Math.abs(spot - best);
        for (let i = 1; i < strikes.length; i++) {
            const diff = Math.abs(spot - strikes[i]);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = strikes[i];
            } else if (strikes[i] > spot && diff >= bestDiff) {
                // early exit: sorted ascending, distance only grows from here
                break;
            }
        }
        return best; // already an integer (we rounded when building the set)
    };

    // Compute ATM strikes. These ARE guaranteed integers — the strike pool
    // is built from Math.round()'d values above, so there's no way a decimal
    // can sneak in no matter what the spot LTP is.
    const niftyAtmStrike  = snapToClosestStrike(niftyLtp,  availableStrikes.NIFTY);
    const sensexAtmStrike = snapToClosestStrike(sensexLtp, availableStrikes.BSX);

    // CE/PE option tracking removed — ATM widget now shows strike only.

    // ---------- NIFTY 50 Advance / Decline ----------
    // Resolve every NIFTY 50 constituent's NSE token via stocksData. Subscribe
    // to all 50 on mount, extract the baseline (prev-close > open > first-seen
    // LTP, in that priority) from each packet, then compare current LTP to
    // baseline to decide advance vs decline.
    const NIFTY_50_TOKENS = useMemo(() => {
        const out = [];
        const missing = [];
        for (const sym of NIFTY_50) {
            const row = stocksData.find(r => r.s === sym && (r.x === 'NSECM' || r.x === 'NSE'));
            if (row) out.push({ symbol: sym, tkn: row.t });
            else missing.push(sym);
        }
        if (missing.length > 0) {
            console.warn(
                `[NiftyAD] ${missing.length}/${NIFTY_50.length} symbols not found in stocks_nsecm.json — A/D will undercount by this many. Missing: ${missing.join(', ')}`
            );
        } else {
            console.log(`[NiftyAD] All ${out.length} NIFTY 50 symbols resolved to tokens.`);
        }
        return out;
    }, []);

    // The A/D baseline is STRICTLY previous day's close (the `C` field on
    // MarketData/IndexData packets, per MT Data Feed API V1). We do not
    // fall back to first-seen LTP or to today's open — those would tie the
    // calculation to whenever the user happened to open the app, which is
    // exactly the bug we're fixing.
    const niftyBaselineRef = useRef({});       // { [tkn]: prevDayClose }
    const niftyLtpsRef     = useRef({});       // { [tkn]: latest LTP }
    const [niftyAD, setNiftyAD] = useState({ advances: 0, declines: 0, unchanged: 0, tracked: 0 });

    // Load baselines from localStorage (day-keyed). The persisted blob from
    // older versions had a `baselineSource` field; we ignore it now since the
    // baseline is always "C" (prev close) under the new model.
    useEffect(() => {
        try {
            const raw = localStorage.getItem('nifty_baseline_v1');
            if (!raw) return;
            const parsed = JSON.parse(raw);
            const today = (() => {
                const d = new Date();
                return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
            })();
            if (parsed?.day === today && parsed.baseline) {
                niftyBaselineRef.current = parsed.baseline;
            }
        } catch {}
    }, []);

    // Subscribe to all NIFTY 50 tokens once the WS subscribe fn is available
    useEffect(() => {
        if (typeof subscribe !== 'function') return;
        if (NIFTY_50_TOKENS.length === 0) return;
        const quotes = NIFTY_50_TOKENS.map(t => ({
            Xchg: 'NSECM',
            Tkn: t.tkn,
            Symbol: t.symbol,
        }));
        try {
            subscribe(quotes, 1);
            console.log(`[NiftyAD] Subscribed to ${quotes.length} NIFTY 50 tokens.`);
        } catch (e) {
            console.warn('[NiftyAD] subscribe failed', e);
        }
    }, [subscribe, NIFTY_50_TOKENS]);

    // Once-only debug: log the FULL keys of the first NIFTY packet we see so
    // the user can identify any feed-specific field names we're missing.
    const niftyDebugLoggedRef = useRef(false);

    // Listen for every WS packet — pick out NIFTY 50 tokens and update the
    // baseline (prev close `C`) + latest LTP refs.
    useEffect(() => {
        const niftySet = new Set(NIFTY_50_TOKENS.map(t => t.tkn));
        const bus = depthEvents.current;

        const persistBaseline = () => {
            try {
                const d = new Date();
                const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
                localStorage.setItem('nifty_baseline_v1', JSON.stringify({
                    day: today,
                    baseline: niftyBaselineRef.current,
                }));
            } catch {}
        };

        const handler = (e) => {
            const packet = e.detail;
            const tkn = packet?.Tkn;
            if (!tkn || !niftySet.has(String(tkn))) return;
            const ltp = readLtp(packet);
            if (ltp == null) return;
            const tknStr = String(tkn);

            // One-time debug dump so we can see the full packet field set.
            if (!niftyDebugLoggedRef.current) {
                niftyDebugLoggedRef.current = true;
                console.log('[NiftyAD] sample NIFTY packet keys:', Object.keys(packet));
                console.log('[NiftyAD] sample NIFTY packet:', packet);
            }

            niftyLtpsRef.current[tknStr] = ltp;

            // STRICT: only set the baseline if the packet actually carries a
            // previous-close value. No LTP fallback, no open fallback. If the
            // feed never sends `C` for some token, that token simply won't be
            // counted in A/D — better to undercount than to silently fake it.
            const pc = readPrevClose(packet);
            if (pc != null && niftyBaselineRef.current[tknStr] !== pc) {
                niftyBaselineRef.current[tknStr] = pc;
                persistBaseline();
            }
        };
        bus.addEventListener('depth-packet', handler);
        return () => bus.removeEventListener('depth-packet', handler);
    }, [NIFTY_50_TOKENS]);

    // Recompute Advance / Decline counts every second from the refs.
    useEffect(() => {
        const id = setInterval(() => {
            const baselines = niftyBaselineRef.current;
            const ltps      = niftyLtpsRef.current;
            let advances = 0, declines = 0, unchanged = 0, tracked = 0;
            for (const t of NIFTY_50_TOKENS) {
                const b = baselines[t.tkn];
                const l = ltps[t.tkn];
                if (b == null || l == null) continue;
                tracked++;
                if (l > b) advances++;
                else if (l < b) declines++;
                else unchanged++;
            }
            setNiftyAD(prev => (
                prev.advances === advances &&
                prev.declines === declines &&
                prev.unchanged === unchanged &&
                prev.tracked === tracked
                    ? prev
                    : { advances, declines, unchanged, tracked }
            ));
        }, 1000);
        return () => clearInterval(id);
    }, [NIFTY_50_TOKENS]);

    // Bar widths — defaults to 50/50 when no data has arrived yet.
    const adTotal = niftyAD.advances + niftyAD.declines;
    const advancePct = adTotal > 0 ? (niftyAD.advances / adTotal) * 100 : 50;
    const declinePct = adTotal > 0 ? 100 - advancePct : 50;

    // ---------- Stock dropdown ----------
    // The dropdown is rendered in a React portal (document.body) with
    // position:fixed coordinates derived from the anchor button's bounding
    // rect. Why: the monitor tab bar uses overflow-x-auto, which per the CSS
    // spec also implies overflow-y: auto, so an in-place `absolute top-full`
    // dropdown gets clipped by the 28px-tall bar and is invisible/unclickable.
    // Escaping to document.body sidesteps the clipping entirely.
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [anchorRect, setAnchorRect] = useState(null);
    const anchorRef = useRef(null);       // the Add Stock button
    const popoverRef = useRef(null);      // the portal dropdown element

    // Recompute anchor position when opening, and on window resize/scroll
    // while open so the popover stays glued to the button.
    useLayoutEffect(() => {
        if (!dropdownOpen) return;
        const update = () => {
            if (anchorRef.current) {
                setAnchorRect(anchorRef.current.getBoundingClientRect());
            }
        };
        update();
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    }, [dropdownOpen]);

    // Click-outside close: consider both the anchor button AND the portal
    // popover as "inside" so clicking an option inside the portal doesn't
    // immediately close the dropdown before the onClick fires.
    useEffect(() => {
        const onDoc = (e) => {
            const t = e.target;
            if (anchorRef.current && anchorRef.current.contains(t)) return;
            if (popoverRef.current && popoverRef.current.contains(t)) return;
            setDropdownOpen(false);
        };
        if (dropdownOpen) document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [dropdownOpen]);

    // Add-Stock dropdown is restricted to NIFTY 50 constituents that we can
    // resolve to a token in stocks_nsecm.json.
    const niftySymbolsAvailable = useMemo(() => {
        const present = new Set();
        for (const r of stocksData) {
            if ((r.x === 'NSECM' || r.x === 'NSE') && r.s) present.add(r.s);
        }
        return NIFTY_50.filter(s => present.has(s)).sort();
    }, []);

    const filteredSymbols = useMemo(() => {
        const q = search.trim().toUpperCase();
        const exclude = new Set([
            ...DEFAULT_SYMBOLS,
            ...activeExtraStocks.map(e => e.symbol),
        ]);
        return niftySymbolsAvailable.filter(s => !exclude.has(s) && (!q || s.includes(q)));
    }, [niftySymbolsAvailable, search, activeExtraStocks]);

    // ---------- Volume display unit (auto/K/L/Cr) ----------
    const [volumeUnit, setVolumeUnit] = useState(() => {
        try {
            const saved = JSON.parse(localStorage.getItem('vl_volume_unit') || '"auto"');
            return VOLUME_UNIT_OPTIONS.some(o => o.value === saved) ? saved : 'auto';
        } catch { return 'auto'; }
    });
    useEffect(() => {
        try { localStorage.setItem('vl_volume_unit', JSON.stringify(volumeUnit)); } catch {}
    }, [volumeUnit]);

    return (
        <div className="min-h-screen bg-[#050505] text-white flex flex-col h-screen overflow-hidden font-sans selection:bg-blue-500/30">

            {/* --- TOP BAR --- */}
            <header className="flex items-center gap-3 px-4 h-12 border-b border-white/10 bg-[#0a0a0e] flex-shrink-0">
                {/* Title */}
                <div className="flex items-center gap-2">
                    <Activity size={16} className="text-emerald-400" />
                    <span className="text-[14px] text-white/90 uppercase font-black tracking-wider">
                        Funnel <span className="text-emerald-400">EQ</span>
                    </span>
                </div>

                {/* NIFTY / SENSEX live spot prices */}
                <div className="flex items-center gap-2 ml-3">
                    <div className="flex items-center gap-2 bg-white/[0.04] border border-white/10 rounded px-2.5 h-8">
                        <span className="text-[11px] font-black text-cyan-400/80 uppercase tracking-wider">Nifty</span>
                        <span className="text-[15px] font-black text-yellow-400 font-mono tabular-nums">
                            {niftyLtp !== null ? niftyLtp.toFixed(2) : '—'}
                        </span>
                    </div>
                    <div className="flex items-center gap-2 bg-white/[0.04] border border-white/10 rounded px-2.5 h-8">
                        <span className="text-[11px] font-black text-cyan-400/80 uppercase tracking-wider">Sensex</span>
                        <span className="text-[15px] font-black text-yellow-400 font-mono tabular-nums">
                            {sensexLtp !== null ? sensexLtp.toFixed(2) : '—'}
                        </span>
                    </div>

                    {/* NIFTY 50 Advance / Decline */}
                    <div
                        className="flex items-center gap-1.5 bg-white/[0.04] border border-white/10 rounded px-2 h-8"
                        title={
                            `NIFTY 50 — ${niftyAD.advances} advancing, ` +
                            `${niftyAD.declines} declining, ` +
                            `${niftyAD.unchanged} unchanged. ` +
                            `Tracked: ${niftyAD.tracked} of ${NIFTY_50.length}.`
                        }
                    >
                        <span className="text-[9px] font-black text-emerald-400/80 uppercase tracking-wider">Adv</span>
                        <span className="text-[13px] font-black text-emerald-400 font-mono tabular-nums leading-none w-5 text-right">
                            {niftyAD.advances}
                        </span>
                        <div className="w-24 h-3 bg-white/5 rounded-sm overflow-hidden flex border border-white/10">
                            <div
                                className="h-full bg-emerald-500 transition-[width] duration-700"
                                style={{ width: `${advancePct}%` }}
                            />
                            <div
                                className="h-full bg-red-500 transition-[width] duration-700"
                                style={{ width: `${declinePct}%` }}
                            />
                        </div>
                        <span className="text-[13px] font-black text-red-400 font-mono tabular-nums leading-none w-5 text-left">
                            {niftyAD.declines}
                        </span>
                        <span className="text-[9px] font-black text-red-400/80 uppercase tracking-wider">Dec</span>
                        <span className="text-[13px] font-black text-white/40 font-mono tabular-nums leading-none ml-1">
                            /{NIFTY_50.length}
                        </span>
                    </div>
                </div>

                {/* Timeframe filter (per active monitor) */}
                <div className="flex items-center gap-1.5 bg-white/[0.04] border border-white/10 rounded px-2 h-8 ml-3">
                    <span className="text-[9px] font-black text-white/40 uppercase tracking-wider">Timeframe Filters</span>
                    <select
                        value={activeBucketSize}
                        onChange={(e) => handleSetBucketSizeForActive(Number(e.target.value))}
                        className="bg-transparent text-[12px] font-black text-emerald-300 font-mono tabular-nums focus:outline-none cursor-pointer"
                    >
                        {BUCKET_OPTIONS.map(o => (
                            <option key={o.value} value={o.value} className="bg-[#0a0a0e] text-emerald-300">
                                {o.label}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Volume unit filter */}
                <div className="flex items-center gap-1.5 bg-white/[0.04] border border-white/10 rounded px-2 h-8">
                    <span className="text-[9px] font-black text-white/40 uppercase tracking-wider">Vol Unit</span>
                    <select
                        value={volumeUnit}
                        onChange={(e) => setVolumeUnit(e.target.value)}
                        className="bg-transparent text-[12px] font-black text-violet-300 font-mono tabular-nums focus:outline-none cursor-pointer"
                    >
                        {VOLUME_UNIT_OPTIONS.map(o => (
                            <option key={o.value} value={o.value} className="bg-[#0a0a0e] text-violet-300">
                                {o.label}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Add Stock has moved to the monitor tab bar below. */}

                {/* Right cluster: Demo toggle, clock, status + connect/disconnect + clear */}
                <div className="ml-auto flex items-center gap-2">
                    {/* Demo toggle disabled — dummy data feature removed. */}
                    {/*
                    <button
                        onClick={() => setDemoMode(d => !d)}
                        className={cn(
                            "flex items-center gap-1.5 border font-bold py-1 px-2.5 rounded text-[11px] uppercase tracking-wider h-8 transition-all",
                            demoMode
                                ? "bg-amber-500/15 border-amber-500/40 text-amber-300 shadow-[0_0_10px_rgba(251,191,36,0.25)]"
                                : "bg-white/5 border-white/10 text-white/50 hover:text-white/80"
                        )}
                        title={demoMode ? "Demo data is ON — click to use live feed" : "Use synthetic dummy data"}
                    >
                        <FlaskConical size={12} /> Demo {demoMode ? "ON" : "OFF"}
                    </button>
                    */}

                    {/* Live clock */}
                    <div className="flex items-center bg-white/[0.04] border border-white/10 rounded px-2.5 h-8">
                        <span className="text-[14px] font-black text-emerald-300 font-mono tabular-nums tracking-tight">
                            {clockStr}
                        </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-[10px] text-white/40">
                        <div className={cn("w-1.5 h-1.5 rounded-full",
                            status === 'connected' ? 'bg-emerald-400 animate-pulse' :
                                status === 'connecting' ? 'bg-yellow-400 animate-pulse' : 'bg-red-500')} />
                        <span className="font-bold uppercase tracking-wider">{status}</span>
                    </div>
                    <button
                        onClick={() => setIsWsEnabled(!isWsEnabled)}
                        className={cn(
                            "text-[10px] px-3 py-1 rounded border transition-all font-bold uppercase tracking-wider",
                            isWsEnabled
                                ? "bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20"
                                : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20"
                        )}
                    >
                        {isWsEnabled ? "Disconnect" : "Connect"}
                    </button>
                    {status === 'error' && (
                        <div className="flex items-center gap-1">
                            <input
                                type="text"
                                value={accessToken}
                                onChange={e => { setAccessToken(e.target.value); setAccessTokenState('idle'); }}
                                onKeyDown={e => e.key === 'Enter' && handleSetAccessToken()}
                                placeholder="access_token…"
                                className={cn(
                                    "w-36 bg-white/5 border rounded px-2 py-1 text-[9px] font-mono text-white/70 placeholder-white/20 outline-none focus:border-white/30 transition-colors",
                                    accessTokenState === 'error' ? "border-red-500/50" : "border-emerald-500/20"
                                )}
                            />
                            <button
                                onClick={handleSetAccessToken}
                                disabled={!accessToken.trim() || accessTokenState === 'loading'}
                                className="text-[10px] px-2 py-1 rounded border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 font-bold hover:bg-emerald-500/20 transition-all disabled:opacity-30"
                            >
                                {accessTokenState === 'loading' ? '…' : 'SET'}
                            </button>
                            <div className="w-px h-4 bg-white/10" />
                            <a
                                href={`http://${window.location.hostname}:3001/kite/login`}
                                className="flex items-center gap-1 text-[10px] px-3 py-1 rounded border border-[#387ed1]/30 bg-[#387ed1]/10 text-[#387ed1] font-bold uppercase tracking-wider hover:bg-[#387ed1]/20 transition-all"
                            >
                                <LogIn size={10} /> Login
                            </a>
                            <input
                                type="text"
                                value={requestToken}
                                onChange={e => { setRequestToken(e.target.value); setTokenExchangeState('idle'); }}
                                onKeyDown={e => e.key === 'Enter' && handleExchangeToken()}
                                placeholder="request_token…"
                                className={cn(
                                    "w-40 bg-white/5 border rounded px-2 py-1 text-[9px] font-mono text-white/70 placeholder-white/20 outline-none focus:border-white/30 transition-colors",
                                    tokenExchangeState === 'error' ? "border-red-500/50" : "border-white/10"
                                )}
                            />
                            <button
                                onClick={handleExchangeToken}
                                disabled={!requestToken.trim() || tokenExchangeState === 'loading'}
                                className="text-[10px] px-2 py-1 rounded border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 font-bold hover:bg-emerald-500/20 transition-all disabled:opacity-30"
                            >
                                {tokenExchangeState === 'loading' ? '…' : 'GO'}
                            </button>
                        </div>
                    )}
                    <button
                        onClick={handleClearAll}
                        className="bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20 font-bold py-1 px-3 rounded text-[10px] flex items-center gap-2 uppercase tracking-wider"
                    >
                        <Trash2 size={11} /> Clear
                    </button>

                    {/* Signed-in user chip + logout */}
                    <div className="flex items-center gap-1.5 bg-white/[0.04] border border-white/10 rounded h-8 pl-1 pr-1">
                        {user.picture ? (
                            <img
                                src={user.picture}
                                alt=""
                                className="w-6 h-6 rounded-full border border-white/10"
                                referrerPolicy="no-referrer"
                            />
                        ) : (
                            <div className="w-6 h-6 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-[10px] font-black text-emerald-300">
                                {(user.name || user.email || '?').charAt(0).toUpperCase()}
                            </div>
                        )}
                        <span className="text-[10px] font-bold text-white/60 max-w-[110px] truncate" title={user.email}>
                            {user.name || user.email}
                        </span>
                        <button
                            onClick={logout}
                            title="Sign out"
                            className="ml-1 p-1 rounded hover:bg-white/10 text-white/40 hover:text-red-400 transition-colors"
                        >
                            <LogOut size={12} />
                        </button>
                    </div>
                </div>
            </header>

            {/* --- MONITOR TAB BAR --- */}
            <div className="relative flex items-center gap-1 px-4 py-1 border-b border-white/10 bg-[#0a0a0e] flex-shrink-0 overflow-x-auto scrollbar-thin [&::-webkit-scrollbar]:h-1">
                <span className="text-[9px] font-black text-white/30 uppercase tracking-wider mr-2 flex-shrink-0">
                    Monitors
                </span>
                {monitors.map((m, idx) => (
                    <button
                        key={m.id}
                        onClick={() => setActiveMonitorId(m.id)}
                        className={cn(
                            "flex items-center gap-1 px-3 py-1 rounded text-[11px] font-bold transition-colors h-7 flex-shrink-0 group",
                            activeMonitorId === m.id
                                ? "bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 shadow-[0_0_8px_rgba(52,211,153,0.15)]"
                                : "bg-white/[0.04] border border-white/10 text-white/50 hover:bg-white/[0.08] hover:text-white/80"
                        )}
                    >
                        <span>Monitor {idx + 1}</span>
                        {monitors.length > 1 && (
                            <span
                                role="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleRemoveMonitor(m.id);
                                }}
                                className="ml-1 opacity-40 hover:opacity-100 hover:text-red-400 transition-colors"
                                title="Remove monitor"
                            >
                                <X size={10} />
                            </span>
                        )}
                    </button>
                ))}
                <button
                    onClick={handleAddMonitor}
                    className="flex items-center gap-1 px-2 py-1 rounded border border-dashed border-white/15 text-white/40 hover:text-white hover:bg-white/5 text-[11px] font-bold h-7 flex-shrink-0"
                    title="Add a new monitor session"
                >
                    <Plus size={11} /> Add Monitor
                </button>

                {/* ---------- ATM WIDGET (center of the monitor bar) ----------
                    Absolutely centered so it stays in the middle regardless of
                    how many monitor tabs are on the left or the Add Stock on
                    the right. Shows NIFTY and SENSEX ATM CE/PE side-by-side,
                    updating live from the WS depth feed. */}
                <div className="absolute left-1/2 -translate-x-1/2 pointer-events-none flex items-center gap-2">
                    {/* NIFTY ATM */}
                    <div className="pointer-events-auto flex items-center gap-1.5 bg-gradient-to-r from-cyan-500/[0.08] to-transparent border border-cyan-500/40 rounded h-7 px-2.5">
                        <span className="text-[9px] font-black text-cyan-400/90 uppercase tracking-wider">Nifty ATM</span>
                        <span className="text-[13px] font-black text-cyan-300 font-mono tabular-nums">
                            {niftyAtmStrike != null ? Math.round(niftyAtmStrike).toLocaleString() : '—'}
                        </span>
                    </div>

                    {/* SENSEX ATM */}
                    <div className="pointer-events-auto flex items-center gap-1.5 bg-gradient-to-r from-cyan-500/[0.08] to-transparent border border-cyan-500/40 rounded h-7 px-2.5">
                        <span className="text-[9px] font-black text-cyan-400/90 uppercase tracking-wider">Sensex ATM</span>
                        <span className="text-[13px] font-black text-cyan-300 font-mono tabular-nums">
                            {sensexAtmStrike != null ? Math.round(sensexAtmStrike).toLocaleString() : '—'}
                        </span>
                    </div>
                </div>

                {/* Add Stock — pinned to the FAR RIGHT of the monitor tab bar
                    via `ml-auto`. Acts on the active monitor. */}
                <div className="ml-auto flex-shrink-0">
                    <button
                        ref={anchorRef}
                        onClick={() => setDropdownOpen(o => !o)}
                        className="flex items-center gap-1.5 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 text-blue-300 font-bold py-1 px-3 rounded text-[11px] uppercase tracking-wider h-7"
                    >
                        <Plus size={11} /> Add Stock
                    </button>
                </div>

                {/* Portal-rendered dropdown. Escapes the monitor tab bar's
                    overflow-x-auto clipping context. Positioned via fixed
                    coords from anchorRect (tracked in a useLayoutEffect). */}
                {dropdownOpen && anchorRect && createPortal(
                    <div
                        ref={popoverRef}
                        className="fixed w-72 bg-[#0f1115] border border-white/10 rounded-lg shadow-2xl z-[1000] overflow-hidden"
                        style={{
                            top: anchorRect.bottom + 8,
                            left: Math.max(8, Math.min(anchorRect.right - 288, window.innerWidth - 296)),
                        }}
                    >
                        <div className="p-2 border-b border-white/10">
                            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded px-2 py-1">
                                <Search size={12} className="text-white/30" />
                                <input
                                    autoFocus
                                    type="text"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    placeholder="Search NSE symbol…"
                                    className="bg-transparent border-none flex-1 text-[12px] text-white placeholder-white/20 focus:outline-none"
                                />
                            </div>
                        </div>
                        <div className="max-h-72 overflow-y-auto scrollbar-thin">
                            {filteredSymbols.length === 0 ? (
                                <div className="text-[11px] text-white/30 italic text-center py-4">
                                    No matches
                                </div>
                            ) : (
                                filteredSymbols.map(sym => (
                                    <button
                                        key={sym}
                                        onClick={() => {
                                            handleAddExtraStockToActive(sym);
                                            setDropdownOpen(false);
                                            setSearch('');
                                        }}
                                        className="w-full text-left px-3 py-1.5 text-[12px] text-white/70 hover:bg-blue-500/10 hover:text-white font-mono tabular-nums transition-colors"
                                    >
                                        {sym}
                                    </button>
                                ))
                            )}
                        </div>
                        {activeExtraStocks.length > 0 && (
                            <div className="border-t border-white/10 p-2 max-h-32 overflow-y-auto scrollbar-none">
                                <div className="text-[9px] uppercase text-white/30 font-bold mb-1 px-1">Currently added (this monitor)</div>
                                <div className="flex flex-wrap gap-1">
                                    {activeExtraStocks.map(es => (
                                        <button
                                            key={es.symbol}
                                            onClick={() => handleRemoveExtraStockFromMonitor(activeMonitorId, es.symbol)}
                                            className="flex items-center gap-1 bg-white/5 hover:bg-red-500/15 border border-white/10 hover:border-red-500/30 rounded px-1.5 py-0.5 text-[10px] text-white/70 hover:text-red-300 font-mono"
                                            title="Remove"
                                        >
                                            {es.symbol} <X size={9} />
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>,
                    document.body
                )}
            </div>

            {/* --- MAIN CONTENT ---
                All monitors are mounted at once so every monitor keeps
                processing WS packets in the background. Only the active one
                is visible. MonitorDashboard already handles display via its
                own `isActive` prop (toggles between flex and hidden). */}
            <main className="flex-1 relative overflow-hidden bg-[#050505] p-3 min-h-0">
                {monitors.map(m => (
                    <MonitorDashboard
                        key={m.id}
                        id={m.id}
                        isActive={m.id === activeMonitorId}
                        depthData={effectiveDepth}
                        status={status}
                        subscribe={subscribe}
                        addGlobalNotification={() => {}}
                        visibleElements={{ config: false, ceDepth: false, peDepth: false, logs: false }}
                        onRemove={() => {}}
                        layoutMode={'vertical'}
                        onLayoutChange={() => {}}
                        depthEvents={depthEvents.current}
                        isSidebarVisible={false}
                        onToggleSidebar={() => {}}
                        extraStocks={extraStocksByMonitor[m.id] || []}
                        onRemoveExtraStock={(sym) => handleRemoveExtraStockFromMonitor(m.id, sym)}
                        bucketSize={bucketSizeByMonitor[m.id] || 1}
                        volumeUnit={volumeUnit}
                        monitorId={m.id}
                        marketOpen={marketOpen}
                    />
                ))}

                {/* Market-closed overlay — shown from 15:32 IST through 09:15
                    IST the next weekday, and all weekend. Dismissible via
                    the Dismiss button; the dismissed state resets the next
                    time the market actually opens. */}
                {!marketOpen && !marketClosedDismissed && (
                    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-sm pointer-events-auto">
                        <div className="relative px-8 py-6 rounded-2xl border-2 border-red-500/40 bg-[#0f1115]/95 shadow-[0_0_60px_rgba(239,68,68,0.25)] text-center">
                            {/* Dismiss button */}
                            <button
                                onClick={() => setMarketClosedDismissed(true)}
                                className="absolute top-2 right-2 p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors"
                                title="Dismiss"
                            >
                                <X size={14} />
                            </button>

                            <div className="flex items-center justify-center gap-2 mb-2">
                                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                <span className="text-[10px] font-black text-red-400/80 uppercase tracking-widest">NSE</span>
                            </div>
                            <div className="text-[32px] font-black text-red-300 tracking-tight leading-none">
                                Market Closed
                            </div>
                            <div className="text-[11px] font-black uppercase tracking-wider text-red-400/70 mt-2">
                                System stopped · WebSocket disconnected
                            </div>
                            <div className="text-[11px] font-mono text-white/40 mt-3 tabular-nums">
                                {clockStr} IST · {clock.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })}
                            </div>
                            <div className="text-[10px] text-white/30 mt-2 uppercase tracking-wider">
                                Trading hours: Mon–Fri · 09:15 → 15:32 IST
                            </div>

                            <button
                                onClick={() => setMarketClosedDismissed(true)}
                                className="mt-4 px-4 py-1.5 rounded border border-white/15 bg-white/[0.04] hover:bg-white/[0.08] text-[11px] font-bold text-white/70 hover:text-white uppercase tracking-wider transition-colors"
                            >
                                Dismiss
                            </button>
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
};

export default App;
