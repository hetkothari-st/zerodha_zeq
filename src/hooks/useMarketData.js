import { useState, useEffect, useCallback, useRef } from 'react';
import { ZERODHA_CONFIG } from '../config/zerodha';
import instrumentMap from '../instrument_map.json';

// ─────────────────────────────────────────────────────────────────────
// Zerodha KiteTicker WebSocket — Binary Market Data
// ─────────────────────────────────────────────────────────────────────
// Drop-in replacement for the old JSON-based broker hook.
// Same external API: useMarketData(enabled, onMessage, onDepthPacket)
// Same return shape: { status, depthData, subscribe }
// ─────────────────────────────────────────────────────────────────────

// ── Binary Parsing ────────────────────────────────────────────────────

function parseTickPacket(buffer) {
    const view = new DataView(buffer);
    const len = buffer.byteLength;
    const instrumentToken = view.getInt32(0);
    const divisor = 100; // all prices in paise

    // Index packet (28 or 32 bytes)
    if (len === 28 || len === 32) {
        const indexName = ZERODHA_CONFIG.INDEX_TOKENS[instrumentToken];
        let appToken = String(instrumentToken);
        if (indexName) {
            for (const [oldTkn, name] of Object.entries(ZERODHA_CONFIG.OLD_INDEX_MAP)) {
                if (name === indexName) { appToken = oldTkn; break; }
            }
        }
        return {
            Tkn: appToken,
            Token: appToken,
            Price: view.getInt32(4) / divisor,
            ltp: view.getInt32(4) / divisor,
            LastTradedPrice: view.getInt32(4) / divisor,
            High: view.getInt32(8) / divisor,
            Low: view.getInt32(12) / divisor,
            Open: view.getInt32(16) / divisor,
            Close: view.getInt32(20) / divisor,
            Change: view.getInt32(24) / divisor,
            _instrumentToken: instrumentToken,
            _type: 'IndexData',
            _receivedAt: Date.now(),
        };
    }

    // LTP packet (8 bytes)
    if (len === 8) {
        return {
            Tkn: String(instrumentToken),
            Token: String(instrumentToken),
            ltp: view.getInt32(4) / divisor,
            _instrumentToken: instrumentToken,
            _type: 'LTP',
            _receivedAt: Date.now(),
        };
    }

    // Quote (44 bytes) or Full/Depth (184 bytes)
    const packet = {
        Tkn: String(instrumentToken),
        Token: String(instrumentToken),
        ltp: view.getInt32(4) / divisor,
        LTP: view.getInt32(4) / divisor,
        LastTradedPrice: view.getInt32(4) / divisor,
        LastTradedQty: view.getInt32(8),
        ATP: view.getInt32(12) / divisor,
        Volume: view.getInt32(16),
        TTQ: view.getInt32(16),    // alias — VerticalLayout reads TTQ
        TotalTradedQty: view.getInt32(16),
        TotalBuyQ: view.getInt32(20),
        TotalSellQ: view.getInt32(24),
        Open: view.getInt32(28) / divisor,
        O: view.getInt32(28) / divisor,
        High: view.getInt32(32) / divisor,
        H: view.getInt32(32) / divisor,
        Low: view.getInt32(36) / divisor,
        L: view.getInt32(36) / divisor,
        Close: view.getInt32(40) / divisor,  // previous day's close (like old `C` field)
        C: view.getInt32(40) / divisor,
        _instrumentToken: instrumentToken,
        _type: len === 184 ? 'Depth' : 'Quote',
        _receivedAt: Date.now(),
    };

    // Full mode: 5-level market depth (bytes 64-183)
    if (len === 184) {
        packet.LastTradeTime = view.getInt32(44);
        packet.OI = view.getInt32(48);
        packet.OIDayHigh = view.getInt32(52);
        packet.OIDayLow = view.getInt32(56);
        packet.ExchangeTimestamp = view.getInt32(60);

        const depths = [];
        const depthOffset = 64;
        // 5 bid entries then 5 ask entries, each 12 bytes
        for (let i = 0; i < 5; i++) {
            const bidBase = depthOffset + (i * 12);
            const askBase = depthOffset + 60 + (i * 12);
            depths.push({
                BP: view.getInt32(bidBase + 4) / divisor,
                BQ: view.getInt32(bidBase),
                BO: view.getInt16(bidBase + 8),
                SP: view.getInt32(askBase + 4) / divisor,
                SQ: view.getInt32(askBase),
                SO: view.getInt16(askBase + 8),
            });
        }
        packet.depths = depths;
    }

    return packet;
}

function parseBinaryMessage(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const packets = [];
    if (arrayBuffer.byteLength < 2) return packets;

    const numPackets = view.getInt16(0);
    let offset = 2;

    for (let i = 0; i < numPackets; i++) {
        if (offset + 2 > arrayBuffer.byteLength) break;
        const packetLen = view.getInt16(offset);
        offset += 2;
        if (offset + packetLen > arrayBuffer.byteLength) break;
        const parsed = parseTickPacket(arrayBuffer.slice(offset, offset + packetLen));
        if (parsed) packets.push(parsed);
        offset += packetLen;
    }

    return packets;
}

// ── Token Mapping ─────────────────────────────────────────────────────

function exchangeTokenToInstrumentToken(exchangeToken, exchange = 'NFO') {
    const code = ZERODHA_CONFIG.EXCHANGE_CODES[exchange] ?? 2;
    return parseInt(exchangeToken) * 256 + code;
}

// ── Hook ──────────────────────────────────────────────────────────────

// Signature kept identical to old hook (4th wsCredential param is unused)
export const useMarketData = (enabled = true, onMessage = null, onDepthPacket = null, _wsCredential = null) => {
    const [status, setStatus] = useState('disconnected');
    const [depthData, setDepthData] = useState({});

    const ws = useRef(null);
    const reconnectTimeout = useRef(null);
    const onMessageRef = useRef(onMessage);
    const onDepthPacketRef = useRef(onDepthPacket);
    const enabledRef = useRef(enabled);
    const isReady = useRef(false);
    const pendingSubs = useRef([]);

    // instrument_token → exchange_token (string)
    const tokenMap = useRef(new Map());
    // exchange_token → instrument_token
    const reverseTokenMap = useRef(new Map());

    const activeSubscriptions = useRef(new Map()); // exchangeToken → quote obj
    const lastPacketTimes = useRef(new Map());

    // For depthData state sync (50ms batching to avoid React storms)
    const depthBuffer = useRef({});

    const packetRates = useRef({});
    const lastTelemetry = useRef(Date.now());

    useEffect(() => {
        onMessageRef.current = onMessage;
        onDepthPacketRef.current = onDepthPacket;
        enabledRef.current = enabled;
    }, [onMessage, onDepthPacket, enabled]);

    // ── Offline Instrument Map ────────────────────────────────────────
    const instrumentMapLoaded = useRef(false);

    const loadInstrumentMap = useCallback(() => {
        if (instrumentMapLoaded.current) return;
        let count = 0;
        for (const [exchToken, instToken] of Object.entries(instrumentMap)) {
            reverseTokenMap.current.set(exchToken, instToken);
            tokenMap.current.set(instToken, exchToken);
            count++;
        }
        console.log(`[KiteWS] Loaded ${count} instrument mappings`);
        instrumentMapLoaded.current = true;
    }, []);

    // ── Resolve exchange_token → Zerodha instrument_token ─────────────
    const resolveInstrumentToken = useCallback((exchangeToken, exchange = 'NFO') => {
        // NFO/BFO: check offline map first (most reliable)
        const fromMap = reverseTokenMap.current.get(String(exchangeToken));
        if (fromMap) return fromMap;

        // Index tokens (NIFTY, BANKNIFTY, SENSEX)
        const indexName = ZERODHA_CONFIG.OLD_INDEX_MAP[String(exchangeToken)];
        if (indexName) return ZERODHA_CONFIG.INDEX_TOKEN_BY_NAME[indexName];

        // Fallback: formula (verified for NSE, NFO, BSE, BFO)
        return exchangeTokenToInstrumentToken(exchangeToken, exchange);
    }, []);

    // ── Resolve Zerodha instrument_token → app exchange_token ──────────
    const resolveAppToken = useCallback((instrumentToken) => {
        // Index tokens
        const indexName = ZERODHA_CONFIG.INDEX_TOKENS[instrumentToken];
        if (indexName) {
            for (const [oldTkn, name] of Object.entries(ZERODHA_CONFIG.OLD_INDEX_MAP)) {
                if (name === indexName) return oldTkn;
            }
        }

        // NFO/BFO instrument map
        const fromMap = tokenMap.current.get(instrumentToken);
        if (fromMap) return fromMap;

        // Fallback: floor division (works for all exchanges since
        // instrument_token = exchange_token * 256 + code, so floor(t/256) = exchange_token)
        return String(Math.floor(instrumentToken / 256));
    }, []);

    // ── Connect ───────────────────────────────────────────────────────
    const connect = useCallback(() => {
        // If VITE_WS_HUB_URL is set, connect to the local hub instead of Zerodha directly.
        // The hub holds the single Zerodha connection and relays ticks to all apps.
        const hubUrl = import.meta.env.VITE_WS_HUB_URL || null;

        if (!hubUrl) {
            const { API_KEY, ACCESS_TOKEN } = ZERODHA_CONFIG;
            if (!API_KEY || !ACCESS_TOKEN) {
                console.error('[KiteWS] Missing API_KEY or ACCESS_TOKEN and no VITE_WS_HUB_URL set');
                setStatus('error');
                return;
            }
        }

        if (ws.current) {
            ws.current.onclose = null;
            ws.current.close();
        }

        loadInstrumentMap();

        const { API_KEY, ACCESS_TOKEN, WS_URL } = ZERODHA_CONFIG;
        const url = hubUrl || `${WS_URL}?api_key=${API_KEY}&access_token=${ACCESS_TOKEN}`;
        console.log('[KiteWS] Connecting...');
        setStatus('connecting');

        ws.current = new WebSocket(url);
        ws.current.binaryType = 'arraybuffer';

        ws.current.onopen = () => {
            console.log('[KiteWS] Connected');
            setStatus('connected');
            isReady.current = true;

            const allTokens = [
                ...Array.from(activeSubscriptions.current.values()),
                ...pendingSubs.current.flat(),
            ];

            const indexTokens = [256265, 260105, 265]; // NIFTY, BANKNIFTY, SENSEX

            if (allTokens.length > 0) {
                const instrumentTokens = allTokens.map(q => {
                    return resolveInstrumentToken(q.Tkn, q.Xchg || 'NFO');
                }).filter(Boolean);

                const all = [...new Set([...instrumentTokens, ...indexTokens])];
                ws.current.send(JSON.stringify({ a: 'subscribe', v: all }));
                ws.current.send(JSON.stringify({ a: 'mode', v: ['full', all] }));
                console.log(`[KiteWS] Subscribed ${all.length} tokens in full mode`);
                allTokens.forEach(q => activeSubscriptions.current.set(String(q.Tkn), q));
            } else {
                ws.current.send(JSON.stringify({ a: 'subscribe', v: indexTokens }));
                ws.current.send(JSON.stringify({ a: 'mode', v: ['full', indexTokens] }));
                console.log('[KiteWS] Subscribed to indices only');
            }

            pendingSubs.current = [];

            // Notify App so debug log shows connection confirmed
            if (onMessageRef.current) onMessageRef.current('Login', { Error: null });
        };

        ws.current.onmessage = (event) => {
            try {
                // Text messages (errors, order updates)
                if (typeof event.data === 'string') {
                    const text = event.data.trim();
                    if (!text || !text.startsWith('{')) return;
                    try {
                        const msg = JSON.parse(text);
                        if (msg.type === 'error') console.error('[KiteWS] Error:', msg.data);
                        if (onMessageRef.current) onMessageRef.current(msg.type || 'Info', msg.data);
                    } catch {}
                    return;
                }

                // Binary market data
                if (!(event.data instanceof ArrayBuffer)) return;
                if (event.data.byteLength <= 1) return; // heartbeat

                const packets = parseBinaryMessage(event.data);

                packets.forEach(packet => {
                    const appToken = resolveAppToken(packet._instrumentToken);
                    packet.Tkn = appToken;
                    packet.Token = appToken;

                    const tknStr = String(appToken);
                    lastPacketTimes.current.set(tknStr, Date.now());
                    packetRates.current[tknStr] = (packetRates.current[tknStr] || 0) + 1;

                    // Buffer for depthData state (top-bar LTPs, MonitorDashboard polling)
                    depthBuffer.current[tknStr] = packet;

                    // Event bus — all packet types so VerticalLayout / MonitorDashboard fire correctly
                    if (onDepthPacketRef.current) {
                        onDepthPacketRef.current(packet);
                    }
                });

                // Telemetry every 5 seconds
                if (Date.now() - lastTelemetry.current > 5000) {
                    const total = Object.values(packetRates.current).reduce((a, b) => a + b, 0);
                    if (total > 0) console.log('[KiteWS] 5s Traffic:', JSON.stringify(packetRates.current));
                    packetRates.current = {};
                    lastTelemetry.current = Date.now();
                }
            } catch (err) {
                console.error('[KiteWS] Message error:', err);
            }
        };

        ws.current.onclose = (event) => {
            console.warn(`[KiteWS] Closed: ${event.code} — ${event.reason || 'Unknown'}`);
            setStatus('disconnected');
            isReady.current = false;

            if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);

            if (enabledRef.current) {
                console.warn('[KiteWS] Reconnecting in 3s...');
                reconnectTimeout.current = setTimeout(connect, 3000);
            }
        };

        ws.current.onerror = () => {
            console.error('[KiteWS] WebSocket error');
            setStatus('error');
            try { ws.current?.close(); } catch {}
        };

    }, [loadInstrumentMap, resolveInstrumentToken, resolveAppToken]);

    // ── Watchdog: resubscribe stale tokens ────────────────────────────
    useEffect(() => {
        if (!enabled) return;

        const watchdog = setInterval(() => {
            if (ws.current?.readyState !== WebSocket.OPEN || !isReady.current) return;
            if (activeSubscriptions.current.size === 0) return;

            const now = Date.now();
            const staleTokens = [];

            activeSubscriptions.current.forEach((quote, tkn) => {
                const lastTime = lastPacketTimes.current.get(String(tkn)) || 0;
                if (now - lastTime > 30000) {
                    const instToken = resolveInstrumentToken(tkn, quote.Xchg || 'NFO');
                    if (instToken) staleTokens.push(instToken);
                    lastPacketTimes.current.set(String(tkn), now);
                }
            });

            if (staleTokens.length > 0) {
                console.warn('[KiteWS] Watchdog resubscribing:', staleTokens.length, 'stale tokens');
                ws.current.send(JSON.stringify({ a: 'subscribe', v: staleTokens }));
                ws.current.send(JSON.stringify({ a: 'mode', v: ['full', staleTokens] }));
            }
        }, 15000);

        return () => clearInterval(watchdog);
    }, [enabled, resolveInstrumentToken]);

    // ── depthData state sync (50ms batching) ──────────────────────────
    useEffect(() => {
        if (!enabled) return;

        const syncInterval = setInterval(() => {
            if (Object.keys(depthBuffer.current).length === 0) return;
            const snapshot = { ...depthBuffer.current };
            depthBuffer.current = {};
            setDepthData(prev => ({ ...prev, ...snapshot }));
        }, 50);

        return () => clearInterval(syncInterval);
    }, [enabled]);

    // ── Subscribe (same API as old hook) ─────────────────────────────
    // quotes = [{ Xchg, Tkn, Symbol }], feedType ignored (always full mode)
    const subscribe = useCallback((quotes, feedType = 2) => {
        quotes.forEach(q => {
            const tknStr = String(q.Tkn);
            activeSubscriptions.current.set(tknStr, q);
            lastPacketTimes.current.set(tknStr, Date.now());
        });

        if (ws.current?.readyState === WebSocket.OPEN && isReady.current) {
            const instrumentTokens = quotes.map(q =>
                resolveInstrumentToken(q.Tkn, q.Xchg || 'NFO')
            ).filter(Boolean);

            if (instrumentTokens.length > 0) {
                ws.current.send(JSON.stringify({ a: 'subscribe', v: instrumentTokens }));
                ws.current.send(JSON.stringify({ a: 'mode', v: ['full', instrumentTokens] }));
                console.log('[KiteWS] Subscribed:', instrumentTokens.length, 'tokens');
            }
        } else {
            console.log('[KiteWS] Not ready, queueing:', quotes.length, 'tokens');
            pendingSubs.current.push(quotes);
        }
    }, [resolveInstrumentToken]);

    // ── Init Effect ───────────────────────────────────────────────────
    useEffect(() => {
        if (enabled) {
            connect();
        } else {
            if (ws.current) {
                ws.current.close();
                ws.current = null;
            }
            if (reconnectTimeout.current) {
                clearTimeout(reconnectTimeout.current);
                reconnectTimeout.current = null;
            }
            setStatus('disconnected');
        }
        return () => {
            if (ws.current) ws.current.close();
            if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
        };
    }, [enabled, connect]);

    return { status, depthData, subscribe };
};
