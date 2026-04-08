import { useState, useEffect, useCallback, useRef } from 'react';

// WebSocket endpoint resolution:
//   - In the browser on production (HTTPS), hit /ws on the same origin so the
//     Node server on Railway can proxy to the broker over plain TCP. This
//     avoids the mixed-content block browsers put on ws:// from an https:
//     page.
//   - In local Vite dev (http://localhost:5292), ALSO hit /ws — vite.config.js
//     proxies it straight to the broker, so dev behaves identically to prod
//     without needing the Node server running.
//   - If something non-browser (SSR, tests) imports this, fall back to the
//     direct broker URL.
const resolveWsUrl = () => {
    if (typeof window !== 'undefined' && window.location) {
        const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${scheme}//${window.location.host}/ws`;
    }
    return 'ws://115.242.15.134:19101';
};

const WS_URL = resolveWsUrl();

// Credentials are now passed in per hook invocation. Each call site builds
// a fresh unique string via buildWsCredential(user) (see src/auth/AuthContext)
// and hands it to us. The same value goes into both LoginId and Password,
// per the broker's "any text, must be unique per session" contract.
export const useMarketData = (enabled = true, onMessage = null, onDepthPacket = null, wsCredential = null) => {
    const [status, setStatus] = useState('disconnected');
    const [depthData, setDepthData] = useState({});

    const ws = useRef(null);
    const hbInterval = useRef(null);
    const reconnectTimeout = useRef(null);
    const syncInterval = useRef(null);
    const handshakeTimeout = useRef(null);
    const onMessageRef = useRef(onMessage);
    const onDepthPacketRef = useRef(onDepthPacket);
    const enabledRef = useRef(enabled);
    const wsCredentialRef = useRef(wsCredential);
    const isLoggedIn = useRef(false);
    const isReady = useRef(false);
    const pendingSubs = useRef([]);

    // Data Buffers to prevent "React Storms"
    const depthBuffer = useRef({});
    const lastUpdate = useRef(0);
    const packetRates = useRef({});
    const lastTelemetry = useRef(Date.now());

    // Keep refs updated
    useEffect(() => {
        onMessageRef.current = onMessage;
        onDepthPacketRef.current = onDepthPacket;
        enabledRef.current = enabled;
        wsCredentialRef.current = wsCredential;
    }, [onMessage, onDepthPacket, enabled, wsCredential]);

    const connect = useCallback(() => {
        if (ws.current) {
            ws.current.onclose = null;
            ws.current.close();
        }

        console.log('[WS] Connecting to:', WS_URL);
        setStatus('connecting');
        ws.current = new WebSocket(WS_URL);

        ws.current.onopen = () => {
            console.log('[WS] Connected, authenticating...');
            setStatus('connected');
            // Build LoginId/Password from the caller-supplied credential.
            // Both fields receive the same string, which is already guaranteed
            // unique per session by buildWsCredential().
            const cred = wsCredentialRef.current || `anon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            ws.current.send(JSON.stringify({
                Type: "Login",
                Data: { LoginId: cred, Password: cred }
            }));
        };

        ws.current.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                const { Type, Data } = msg;

                // 1. Handle Login
                if (Type === 'Login') {
                    if (Data.Error === null) {
                        console.log('[WS] Login Success');
                        isLoggedIn.current = true;
                        isReady.current = true;

                        // Unified Handshake (Restored + Pending)
                        const activeQuotes = Array.from(activeSubscriptions.current.values());
                        const freshQuotes = pendingSubs.current.flat().filter(q =>
                            !activeSubscriptions.current.has(String(q.Tkn))
                        );

                        // 1. Separate tokens by Exchange
                        // NSEFO / BSEFO -> FeedType 2 (Depth) — options on both exchanges
                        // NSE / BSE / NSECM / BSECM -> FeedType 1 (Touchline / MarketData)
                        const allTokens = [...activeQuotes, ...freshQuotes];
                        const depthTokens = allTokens.filter(
                            q => q.Xchg === 'NSEFO' || q.Xchg === 'BSEFO'
                        );

                        const indexTokens = [
                            { Tkn: '26000', Xchg: 'NSE' },
                            { Tkn: '26009', Xchg: 'NSE' },
                            { Tkn: '1', Xchg: 'BSE' }, // SENSEX Spot Token
                            ...allTokens.filter(q => ['NSE', 'BSE', 'NSECM', 'BSECM'].includes(q.Xchg))
                        ].filter((v, i, a) => a.findIndex(t => t.Tkn === v.Tkn && t.Xchg === v.Xchg) === i); // Deduplicate

                        // Send Depth Sub
                        if (depthTokens.length > 0) {
                            ws.current.send(JSON.stringify({
                                Type: "TokenRequest",
                                Data: { SubType: true, FeedType: 2, quotes: depthTokens }
                            }));
                            console.log('[WS] Subscribed to Depth (FT2):', depthTokens.length);
                            depthTokens.forEach(q => activeSubscriptions.current.set(String(q.Tkn), q));
                        }

                        // Send Index/Touchline Sub
                        if (indexTokens.length > 0) {
                            ws.current.send(JSON.stringify({
                                Type: "TokenRequest",
                                Data: { SubType: true, FeedType: 1, quotes: indexTokens }
                            }));
                            console.log('[WS] Subscribed to Index/Touchline (FT1):', indexTokens.map(t => t.Tkn));
                            indexTokens.forEach(q => activeSubscriptions.current.set(String(q.Tkn), q));
                        }

                        pendingSubs.current = [];

                        if (hbInterval.current) clearInterval(hbInterval.current);
                        hbInterval.current = setInterval(() => {
                            if (ws.current?.readyState === WebSocket.OPEN) {
                                ws.current.send(JSON.stringify({
                                    Type: "Info",
                                    Data: {
                                        InfoType: "HB",
                                        InfoMsg: "Heartbeat"
                                    }
                                }));
                            }
                        }, 3000); // 3s Heartbeat
                    } else {
                        console.error('[WS] Login Failed:', Data.Error);
                    }
                    return;
                }

                // 2. Buffer Depth & Index/MarketData Data
                if ((Type === 'Depth' || Type === 'DepthData' || Type === 'IndexData' || Type === 'MarketData') && Data) {

                    // Normalize Data to Array for uniform processing
                    const packets = Array.isArray(Data) ? Data : [Data];

                    packets.forEach(packet => {
                        let token = packet.Tkn || packet.Token;

                        // IndexData usually has Symbol but no Token. Map them back.
                        if (!token && Type === 'IndexData' && packet.Symbol) {
                            const sym = packet.Symbol.toUpperCase();
                            if (sym === 'NIFTY50' || sym === 'NIFTY 50') token = '26000';
                            if (sym === 'NIFTYBANK' || sym === 'BANKNIFTY') token = '26009';
                            if (sym === 'SENSEX') token = '1';
                        }

                        if (token) {
                            const tknStr = String(token);
                            const receivedAt = Date.now();
                            lastPacketTimes.current.set(tknStr, receivedAt);
                            const enriched = {
                                ...packet,
                                Tkn: tknStr,           // ensure Tkn is always set (IndexData often lacks it)
                                _type: Type,
                                _receivedAt: receivedAt,
                            };
                            depthBuffer.current[tknStr] = enriched;

                            // Fire packet callback for ALL data types so consumers
                            // can drive their own bucketing from event-driven WS
                            // messages instead of throttled setInterval polling.
                            // (Depth, DepthData, IndexData, MarketData all flow through.)
                            if (onDepthPacketRef.current) {
                                onDepthPacketRef.current(enriched);
                            }

                            // Telemetry tracking
                            packetRates.current[tknStr] = (packetRates.current[tknStr] || 0) + 1;
                        }
                    });
                    return;
                }

                // 3. Telemetry Log every 5 seconds
                if (Date.now() - lastTelemetry.current > 5000) {
                    const stats = packetRates.current;
                    const total = Object.values(stats).reduce((a, b) => a + b, 0);
                    if (total > 0) {
                        console.log('[WS] 5s Traffic Report:', JSON.stringify(stats));
                    }
                    packetRates.current = {};
                    lastTelemetry.current = Date.now();
                }

                // 3. Early ignore for high-volume packets
                const ignoredTypes = ['Touchline', 'Quote'];
                if (ignoredTypes.includes(Type)) return;

                // 4. User callback for management pulses
                if (onMessageRef.current) onMessageRef.current(Type, Data);

            } catch (err) {
                console.error('WS Message Error:', err);
            }
        };

        ws.current.onclose = (event) => {
            console.warn(`[WS] Closed: ${event.code} - ${event.reason || 'Abnormal Closure'}`);
            setStatus('disconnected');
            isLoggedIn.current = false;
            isReady.current = false;

            if (hbInterval.current) clearInterval(hbInterval.current);
            if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
            if (handshakeTimeout.current) clearTimeout(handshakeTimeout.current);

            if (enabledRef.current) {
                // Modifying aggressive reconnect to prevent 1006 loops/bans
                console.warn('[WS] Reconnecting (2000ms)...');
                reconnectTimeout.current = setTimeout(connect, 2000);
            }
        };

        ws.current.onerror = () => setStatus('error');

    }, []); // Only create connect once

    // Watchdog State
    const activeSubscriptions = useRef(new Map()); // Map<TokenID, QuoteObject>
    const lastPacketTimes = useRef(new Map());     // Map<TokenID, Timestamp>
    const watchdogInterval = useRef(null);

    // Watchdog Interval
    useEffect(() => {
        if (!enabled) return;

        watchdogInterval.current = setInterval(() => {
            if (ws.current?.readyState !== WebSocket.OPEN) return;
            if (activeSubscriptions.current.size === 0) return;

            const now = Date.now();
            const staleQuotes = [];

            activeSubscriptions.current.forEach((quote, tkn) => {
                const lastTime = lastPacketTimes.current.get(String(tkn)) || 0;
                if (now - lastTime > 30000) { // Relax watchdog to 30s
                    staleQuotes.push(quote);
                    lastPacketTimes.current.set(String(tkn), now);
                }
            });

            if (staleQuotes.length > 0 && isReady.current) {
                console.warn('[WS] Watchdog resubscribing to stale tokens:', staleQuotes.length);
                ws.current.send(JSON.stringify({
                    Type: "TokenRequest",
                    Data: {
                        SubType: true,
                        FeedType: 2,
                        quotes: staleQuotes
                    }
                }));
            }
        }, 5000);

        return () => clearInterval(watchdogInterval.current);
    }, [enabled]);

    // Subscribe Function
    const subscribe = useCallback((quotes, feedType = 2) => {
        // 1. Track locally for persistence/watchdog
        quotes.forEach(q => {
            const tknStr = String(q.Tkn);
            activeSubscriptions.current.set(tknStr, q);
            lastPacketTimes.current.set(tknStr, Date.now());
        });

        // 2. Send if ready, otherwise queue
        if (ws.current?.readyState === WebSocket.OPEN && isReady.current) {
            const payload = {
                Type: "TokenRequest",
                Data: { SubType: true, FeedType: feedType, quotes }
            };
            console.log('[WS] Outbound Direct:', JSON.stringify(payload));
            ws.current.send(JSON.stringify(payload));
        } else {
            console.log('[WS] Connection not ready, queueing subscription:', quotes.length);
            pendingSubs.current.push(quotes);
        }
    }, []);

    // Data Sync Loop (Phase 3)
    useEffect(() => {
        if (!enabled) return;

        syncInterval.current = setInterval(() => {
            const hasDepth = Object.keys(depthBuffer.current).length > 0;

            if (hasDepth) {
                // IMPORTANT: Capture buffer snapshot BEFORE clearing it
                // React's functional updates are async, so clearing it immediately
                // would result in an empty merge if we don't capture it.
                const bufferSnapshot = { ...depthBuffer.current };
                depthBuffer.current = {};

                setDepthData(prev => ({
                    ...prev,
                    ...bufferSnapshot
                }));
            }
        }, 50);

        return () => clearInterval(syncInterval.current);
    }, [enabled]);

    // Init Effect
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
            if (hbInterval.current) clearInterval(hbInterval.current);
            if (watchdogInterval.current) clearInterval(watchdogInterval.current);
            if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
            if (syncInterval.current) clearInterval(syncInterval.current);
            if (handshakeTimeout.current) clearTimeout(handshakeTimeout.current);
        };
    }, [enabled, connect]);

    return { status, depthData, subscribe };
};
