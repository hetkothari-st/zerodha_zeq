'use strict';

const fs   = require('fs');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');
const http = require('http');
const url = require('url');

// ── ENV Management ────────────────────────────────────────────────────────
const ENV_PATHS = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '../../../funnel_op_zerodha/.env'),
];

function loadEnv() {
    for (const filePath of ENV_PATHS) {
        try {
            const lines = fs.readFileSync(filePath, 'utf8').split('\n');
            for (const line of lines) {
                const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
                if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
            }
        } catch {}
    }
}
loadEnv();

let API_KEY      = process.env.ZERODHA_API_KEY      || process.env.VITE_ZERODHA_API_KEY || '';
let ACCESS_TOKEN = process.env.ZERODHA_ACCESS_TOKEN || process.env.VITE_ZERODHA_ACCESS_TOKEN || '';
const HUB_PORT   = parseInt(process.env.PORT || process.env.HUB_PORT || '8765', 10);

function updateTokenInEnvFiles(newToken) {
    ACCESS_TOKEN = newToken;
    for (const filePath of ENV_PATHS) {
        try {
            if (!fs.existsSync(filePath)) continue;
            let content = fs.readFileSync(filePath, 'utf8');
            content = content.replace(/(VITE_ZERODHA_ACCESS_TOKEN=)[^\r\n]*/g, `$1${newToken}`);
            content = content.replace(/^(ZERODHA_ACCESS_TOKEN=)[^\r\n]*/gm, `$1${newToken}`);
            fs.writeFileSync(filePath, content, 'utf8');
            console.log(`[hub] Updated token in ${filePath}`);
        } catch (e) {
            console.error(`[hub] Error updating token in ${filePath}: ${e.message}`);
        }
    }
}

// ── State ─────────────────────────────────────────────────────────────
const clients        = new Set();
const subscribedSet  = new Set();
const fullModeSet    = new Set();
let zerodha          = null;
let reconnectTimer   = null;
let isAuthError      = false;

// ── Broadcast ─────────────────────────────────────────────────────────
function broadcast(data, isBinary) {
    clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(data, { binary: isBinary });
        }
    });
}

// ── Zerodha Methods ───────────────────────────────────────────────────
function zerodhaReady() { return zerodha && zerodha.readyState === WebSocket.OPEN; }

function subscribeOnZerodha(tokens) {
    const fresh = tokens.filter(t => !subscribedSet.has(t));
    if (!fresh.length || !zerodhaReady()) return;
    fresh.forEach(t => subscribedSet.add(t));
    zerodha.send(JSON.stringify({ a: 'subscribe', v: fresh }));
    console.log(`[hub→Zerodha] subscribe ${fresh.length} tokens (total: ${subscribedSet.size})`);
}

function setFullModeOnZerodha(tokens) {
    const fresh = tokens.filter(t => !fullModeSet.has(t));
    if (!fresh.length || !zerodhaReady()) return;
    fresh.forEach(t => fullModeSet.add(t));
    zerodha.send(JSON.stringify({ a: 'mode', v: ['full', fresh] }));
}

function handleClientMessage(data) {
    try {
        const msg = JSON.parse(data.toString());
        if (!msg.a || !Array.isArray(msg.v)) return;
        if (msg.a === 'subscribe') { subscribeOnZerodha(msg.v); }
        else if (msg.a === 'mode') {
            const [mode, tokens] = msg.v;
            if (mode === 'full' && Array.isArray(tokens)) {
                subscribeOnZerodha(tokens);
                setFullModeOnZerodha(tokens);
            }
        }
    } catch {}
}

function connectZerodha() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (!API_KEY || !ACCESS_TOKEN) {
        console.warn('[hub] Missing credentials, waiting for user login...');
        isAuthError = true;
        broadcast(JSON.stringify({ type: 'auth_error', message: 'Token missing or expired' }), false);
        return;
    }

    console.log('[hub] Connecting to Zerodha...');
    const ZERODHA_URL = `wss://ws.kite.trade?api_key=${API_KEY}&access_token=${ACCESS_TOKEN}`;
    zerodha = new WebSocket(ZERODHA_URL);
    zerodha.binaryType = 'nodebuffer';

    zerodha.on('unexpected-response', (request, response) => {
        if (response.statusCode === 403) {
            console.error('[hub] Zerodha Auth Failed (403). Token expired or invalid.');
            isAuthError = true;
            broadcast(JSON.stringify({ type: 'auth_error', message: 'Token missing or expired' }), false);
            try { zerodha.terminate(); } catch {}
        }
    });

    zerodha.on('open', () => {
        console.log('[hub] Connected to Zerodha');
        isAuthError = false;
        broadcast(JSON.stringify({ type: 'auth_success' }), false);
        if (subscribedSet.size > 0) {
            const tokens = [...subscribedSet];
            zerodha.send(JSON.stringify({ a: 'subscribe', v: tokens }));
            if (fullModeSet.size > 0) {
                zerodha.send(JSON.stringify({ a: 'mode', v: ['full', [...fullModeSet]] }));
            }
        }
    });

    zerodha.on('message', (data, isBinary) => {
        broadcast(data, isBinary);
    });

    zerodha.on('close', (code, reason) => {
        if (!isAuthError) {
            console.warn(`[hub] Zerodha closed: ${code} ${reason || ''} — reconnecting in 3s`);
            reconnectTimer = setTimeout(connectZerodha, 3000);
        }
    });

    zerodha.on('error', err => {
        console.error('[hub] Zerodha error:', err.message);
        try { zerodha.terminate(); } catch {}
    });
}

// ── HTTP Server (for Auth Flow updates) ───────────────────────────────
const server = http.createServer((req, res) => {
    // CORS headers for local access if needed
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, POST, GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const parsedUrl = url.parse(req.url, true);

    if (parsedUrl.pathname === '/api/update-token' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const { access_token } = JSON.parse(body);
                if (access_token) {
                    console.log('[hub] Received new access_token from frontend server');
                    updateTokenInEnvFiles(access_token);
                    connectZerodha();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'missing access_token' }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid json' }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end();
});

// ── WebSocket Server ──────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('listening', () => {
    console.log(`[hub] Listening on ws://localhost:${HUB_PORT} (HTTP + WS)`);
});

wss.on('connection', (clientWs, req) => {
    clients.add(clientWs);
    
    if (isAuthError) {
        clientWs.send(JSON.stringify({ type: 'auth_error', message: 'Token missing or expired' }));
    } else if (zerodhaReady()) {
        clientWs.send(JSON.stringify({ type: 'auth_success' }));
    }

    clientWs.on('message', handleClientMessage);
    clientWs.on('close', () => clients.delete(clientWs));
    clientWs.on('error', () => clients.delete(clientWs));
});

// ── Start ─────────────────────────────────────────────────────────────
server.listen(HUB_PORT);
connectZerodha();

setInterval(() => {
    console.log(`[hub] Status — clients: ${clients.size} | subscribed: ${subscribedSet.size} tokens | zerodha: ${zerodha?.readyState === WebSocket.OPEN ? 'connected' : (isAuthError ? 'auth_error' : 'disconnected')}`);
}, 30000);

process.on('SIGINT', () => {
    console.log('\n[hub] Shutting down...');
    if (zerodha) zerodha.close();
    wss.close(() => server.close(() => process.exit(0)));
});
