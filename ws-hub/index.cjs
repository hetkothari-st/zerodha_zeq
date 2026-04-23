// Zerodha WebSocket Hub
// ─────────────────────────────────────────────────────────────────────
// Holds ONE connection to Zerodha's WS on behalf of multiple local apps.
// Both apps connect here (ws://localhost:8765) instead of Zerodha directly.
//
// What it does:
//   - Connects to wss://ws.kite.trade with the single API key + token
//   - Relays every binary tick frame to ALL connected local app clients
//   - Aggregates subscriptions: collects {"a":"subscribe"} commands from
//     all clients, deduplicates, and forwards only new tokens to Zerodha
//   - Auto-reconnects to Zerodha and re-subscribes all tokens on drop
//
// Start: node ws-hub/index.cjs  (from project root, or cd ws-hub && node index.cjs)
// ─────────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');

// ── Load .env ─────────────────────────────────────────────────────────
// Reads ws-hub/.env then falls back to parent project's .env
function loadEnv(filePath) {
    try {
        const lines = fs.readFileSync(filePath, 'utf8').split('\n');
        for (const line of lines) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
        }
    } catch {}
}
loadEnv(path.join(__dirname, '.env'));
loadEnv(path.join(__dirname, '..', '.env'));

const API_KEY      = process.env.ZERODHA_API_KEY      || '';
const ACCESS_TOKEN = process.env.ZERODHA_ACCESS_TOKEN || '';
const HUB_PORT     = parseInt(process.env.HUB_PORT || '8765', 10);

if (!API_KEY || !ACCESS_TOKEN) {
    console.error('[hub] ERROR: ZERODHA_API_KEY or ZERODHA_ACCESS_TOKEN not set in .env');
    process.exit(1);
}

const ZERODHA_URL = `wss://ws.kite.trade?api_key=${API_KEY}&access_token=${ACCESS_TOKEN}`;

// ── State ─────────────────────────────────────────────────────────────
const clients        = new Set();   // connected local app WS clients
const subscribedSet  = new Set();   // instrument_tokens subscribed on Zerodha
const fullModeSet    = new Set();   // instrument_tokens in "full" mode on Zerodha
let zerodha          = null;
let reconnectTimer   = null;

// ── Broadcast to all local clients ────────────────────────────────────
function broadcast(data, isBinary) {
    clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(data, { binary: isBinary });
        }
    });
}

// ── Forward subscription commands to Zerodha ──────────────────────────
function zerodhaReady() {
    return zerodha && zerodha.readyState === WebSocket.OPEN;
}

function subscribeOnZerodha(tokens) {
    const fresh = tokens.filter(t => !subscribedSet.has(t));
    if (!fresh.length || !zerodhaReady()) return;
    fresh.forEach(t => subscribedSet.add(t));
    zerodha.send(JSON.stringify({ a: 'subscribe', v: fresh }));
    console.log(`[hub→Zerodha] subscribe ${fresh.length} new tokens (total: ${subscribedSet.size})`);
}

function setFullModeOnZerodha(tokens) {
    const fresh = tokens.filter(t => !fullModeSet.has(t));
    if (!fresh.length || !zerodhaReady()) return;
    fresh.forEach(t => fullModeSet.add(t));
    zerodha.send(JSON.stringify({ a: 'mode', v: ['full', fresh] }));
    console.log(`[hub→Zerodha] full-mode ${fresh.length} new tokens (total: ${fullModeSet.size})`);
}

// ── Handle a subscription message arriving from a local app client ─────
function handleClientMessage(data) {
    try {
        const msg = JSON.parse(data.toString());
        if (!msg.a || !Array.isArray(msg.v)) return;

        if (msg.a === 'subscribe') {
            subscribeOnZerodha(msg.v);
        } else if (msg.a === 'mode') {
            const [mode, tokens] = msg.v;
            if (mode === 'full' && Array.isArray(tokens)) {
                // Also ensure these are subscribed first
                subscribeOnZerodha(tokens);
                setFullModeOnZerodha(tokens);
            }
        }
    } catch {}
}

// ── Connect to Zerodha ────────────────────────────────────────────────
function connectZerodha() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    console.log('[hub] Connecting to Zerodha...');
    zerodha = new WebSocket(ZERODHA_URL);
    zerodha.binaryType = 'nodebuffer';

    zerodha.on('open', () => {
        console.log('[hub] Connected to Zerodha');

        // Re-subscribe everything we had before (handles reconnect case)
        if (subscribedSet.size > 0) {
            const tokens = [...subscribedSet];
            zerodha.send(JSON.stringify({ a: 'subscribe', v: tokens }));
            if (fullModeSet.size > 0) {
                zerodha.send(JSON.stringify({ a: 'mode', v: ['full', [...fullModeSet]] }));
            }
            console.log(`[hub] Re-subscribed ${tokens.length} tokens after reconnect`);
        }
    });

    zerodha.on('message', (data, isBinary) => {
        // Relay every frame (binary ticks or JSON text) to all local clients
        broadcast(data, isBinary);
    });

    zerodha.on('close', (code, reason) => {
        console.warn(`[hub] Zerodha closed: ${code} ${reason || ''} — reconnecting in 3s`);
        reconnectTimer = setTimeout(connectZerodha, 3000);
    });

    zerodha.on('error', err => {
        console.error('[hub] Zerodha error:', err.message);
        try { zerodha.terminate(); } catch {}
    });
}

// ── Local WebSocket server (apps connect here) ────────────────────────
const wss = new WebSocketServer({ port: HUB_PORT });

wss.on('listening', () => {
    console.log(`[hub] Listening on ws://localhost:${HUB_PORT}`);
    console.log('[hub] Both apps should set VITE_WS_HUB_URL=ws://localhost:' + HUB_PORT);
});

wss.on('connection', (clientWs, req) => {
    const origin = req.socket.remoteAddress;
    clients.add(clientWs);
    console.log(`[hub] App connected (${origin}) — total clients: ${clients.size}`);

    clientWs.on('message', handleClientMessage);

    clientWs.on('close', () => {
        clients.delete(clientWs);
        console.log(`[hub] App disconnected — total clients: ${clients.size}`);
    });

    clientWs.on('error', () => {
        clients.delete(clientWs);
    });
});

wss.on('error', err => {
    console.error('[hub] Server error:', err.message);
});

// ── Start ─────────────────────────────────────────────────────────────
connectZerodha();

// Stats every 30s
setInterval(() => {
    console.log(`[hub] Status — clients: ${clients.size} | subscribed: ${subscribedSet.size} tokens | zerodha: ${zerodha?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected'}`);
}, 30000);

process.on('SIGINT', () => {
    console.log('\n[hub] Shutting down...');
    if (zerodha) zerodha.close();
    wss.close(() => process.exit(0));
});
