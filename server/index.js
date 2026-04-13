// Production server for Railway (or any HTTPS host).
//
// Responsibilities:
//   1. Serve the built Vite SPA from ../dist
//   2. Expose a WebSocket route at /ws that transparently proxies frames
//      to the upstream broker
//   3. Expose /api/login and /api/logout for Supabase-backed auth with
//      single-session enforcement

import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const UPSTREAM_WS = process.env.UPSTREAM_WS || 'ws://115.242.15.134:19101';
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

// Supabase config (set these as env vars on Railway)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// ===================== SESSION TRACKING =====================
// In-memory store: { username -> { sessionToken, connectedAt } }
// Cleared on server restart (users just re-login)
const activeSessions = new Map();

function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

// ===================== SUPABASE HELPER =====================
async function validateCredentials(username, password) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        console.error('[auth] SUPABASE_URL or SUPABASE_SERVICE_KEY not configured');
        return { ok: false, error: 'Server auth not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars.' };
    }

    try {
        const url = `${SUPABASE_URL}/rest/v1/app_users?username=eq.${encodeURIComponent(username)}&is_active=eq.true&select=username,password`;
        console.log(`[auth] Querying Supabase for user: ${username}`);

        const res = await fetch(url, {
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
            },
        });

        if (!res.ok) {
            const body = await res.text();
            console.error(`[auth] Supabase query failed: ${res.status} ${body}`);
            return { ok: false, error: 'Authentication service unavailable.' };
        }

        const rows = await res.json();
        console.log(`[auth] Supabase returned ${rows.length} row(s) for user: ${username}`);

        if (rows.length === 0) {
            return { ok: false, error: 'Invalid username or password.' };
        }

        const user = rows[0];
        if (user.password !== password) {
            console.log(`[auth] Password mismatch for user: ${username}`);
            return { ok: false, error: 'Invalid username or password.' };
        }

        return { ok: true, user: { username: user.username } };
    } catch (err) {
        console.error(`[auth] Supabase request error:`, err.message);
        return { ok: false, error: 'Authentication service error. Try again.' };
    }
}

// ===================== EXPRESS APP =====================
const app = express();
app.use(express.json());
app.use(express.static(DIST_DIR));

// ----- POST /api/login -----
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    console.log(`[auth] Login attempt: username=${username}`);

    if (!username || !password) {
        return res.json({ ok: false, error: 'Username and password are required.' });
    }

    // 1. Validate against Supabase
    const result = await validateCredentials(username, password);
    if (!result.ok) {
        console.log(`[auth] Login REJECTED for ${username}: ${result.error}`);
        return res.json(result);
    }

    // 2. Check single-session enforcement
    const existing = activeSessions.get(username);
    if (existing) {
        console.log(`[auth] Login BLOCKED for ${username}: already has active session (since ${new Date(existing.connectedAt).toISOString()})`);
        return res.json({
            ok: false,
            error: 'This account is already logged in from another session. Please log out there first, or wait for it to disconnect.',
        });
    }

    // 3. Create session
    const sessionToken = generateSessionToken();
    activeSessions.set(username, {
        sessionToken,
        connectedAt: Date.now(),
    });
    console.log(`[auth] Login SUCCESS for ${username} — session created (active sessions: ${activeSessions.size})`);

    return res.json({
        ok: true,
        user: result.user,
        sessionToken,
    });
});

// ----- POST /api/logout -----
app.post('/api/logout', (req, res) => {
    const { sessionToken } = req.body || {};
    console.log(`[auth] Logout request — token: ${sessionToken ? sessionToken.substring(0, 8) + '...' : 'none'}`);

    if (!sessionToken) {
        return res.json({ ok: false, error: 'No session token provided.' });
    }

    // Find and remove the session
    let found = false;
    for (const [username, session] of activeSessions) {
        if (session.sessionToken === sessionToken) {
            activeSessions.delete(username);
            console.log(`[auth] Logout SUCCESS for ${username} — session cleared (active sessions: ${activeSessions.size})`);
            found = true;
            break;
        }
    }

    if (!found) {
        console.log(`[auth] Logout — session token not found (already expired or server restarted)`);
    }

    return res.json({ ok: true });
});

// ----- GET /api/session -----
// Quick check if a session token is still valid (for page reload validation)
app.get('/api/session', (req, res) => {
    const token = req.headers['x-session-token'];
    if (!token) return res.json({ ok: false });

    for (const [username, session] of activeSessions) {
        if (session.sessionToken === token) {
            return res.json({ ok: true, username });
        }
    }
    return res.json({ ok: false });
});

// ----- GET /api/active-sessions (admin diagnostics) -----
app.get('/api/active-sessions', (req, res) => {
    const sessions = [];
    for (const [username, session] of activeSessions) {
        sessions.push({
            username,
            connectedAt: new Date(session.connectedAt).toISOString(),
            durationMin: Math.round((Date.now() - session.connectedAt) / 60000),
        });
    }
    console.log(`[auth] Active sessions query: ${sessions.length} session(s)`);
    return res.json({ count: sessions.length, sessions });
});

// ----- POST /api/force-logout (admin: kick a user) -----
app.post('/api/force-logout', (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.json({ ok: false, error: 'Username required.' });

    if (activeSessions.has(username)) {
        activeSessions.delete(username);
        console.log(`[auth] Force-logout SUCCESS for ${username} (active sessions: ${activeSessions.size})`);
        return res.json({ ok: true, message: `${username} has been logged out.` });
    }
    return res.json({ ok: false, error: `${username} has no active session.` });
});

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// ===================== WEBSOCKET PROXY =====================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let connectionId = 0;

wss.on('connection', (client, req) => {
    const id = ++connectionId;
    const remote = req.socket.remoteAddress;
    console.log(`[ws-proxy #${id}] client connected from ${remote}, opening upstream -> ${UPSTREAM_WS}`);

    const upstream = new WebSocket(UPSTREAM_WS);

    const pending = [];
    let upstreamReady = false;
    let clientMsgCount = 0;
    let upstreamMsgCount = 0;
    const upstreamMsgTypes = {};

    const safeClose = (code, reason) => {
        try { client.close(code, reason); } catch {}
        try { upstream.close(code, reason); } catch {}
    };

    upstream.on('open', () => {
        upstreamReady = true;
        console.log(`[ws-proxy #${id}] upstream OPEN, flushing ${pending.length} pending frame(s)`);
        for (const frame of pending) {
            console.log(`[ws-proxy #${id}] flushing pending frame: ${frame.substring(0, 120)}`);
            try { upstream.send(frame); } catch (e) { console.warn(`[ws-proxy #${id}] flush send failed`, e.message); }
        }
        pending.length = 0;
    });

    upstream.on('message', (data) => {
        upstreamMsgCount++;
        const text = typeof data === 'string' ? data : data.toString('utf8');

        if (upstreamMsgCount <= 5 || upstreamMsgCount % 100 === 0) {
            try {
                const parsed = JSON.parse(text);
                upstreamMsgTypes[parsed.Type] = (upstreamMsgTypes[parsed.Type] || 0) + 1;
                console.log(`[ws-proxy #${id}] upstream msg #${upstreamMsgCount} type=${parsed.Type} (totals: ${JSON.stringify(upstreamMsgTypes)})`);
            } catch {
                console.log(`[ws-proxy #${id}] upstream msg #${upstreamMsgCount} (non-JSON, ${text.length} bytes)`);
            }
        } else {
            try {
                const parsed = JSON.parse(text);
                upstreamMsgTypes[parsed.Type] = (upstreamMsgTypes[parsed.Type] || 0) + 1;
            } catch {}
        }

        if (client.readyState === WebSocket.OPEN) {
            client.send(text);
        } else {
            console.warn(`[ws-proxy #${id}] client not open (state=${client.readyState}), dropping upstream msg`);
        }
    });

    upstream.on('close', (code, reason) => {
        console.log(`[ws-proxy #${id}] upstream CLOSED code=${code} reason=${reason?.toString?.() || 'none'} (forwarded ${upstreamMsgCount} msgs, types: ${JSON.stringify(upstreamMsgTypes)})`);
        safeClose(code, reason);
    });

    upstream.on('error', (err) => {
        console.warn(`[ws-proxy #${id}] upstream ERROR: ${err.message}`);
        safeClose(1011, 'upstream error');
    });

    client.on('message', (data) => {
        clientMsgCount++;
        const text = typeof data === 'string' ? data : data.toString('utf8');

        try {
            const parsed = JSON.parse(text);
            console.log(`[ws-proxy #${id}] client msg #${clientMsgCount} type=${parsed.Type} (upstream ready=${upstreamReady})`);
        } catch {
            console.log(`[ws-proxy #${id}] client msg #${clientMsgCount} (non-JSON, ${text.length} bytes)`);
        }

        if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
            try { upstream.send(text); } catch (e) { console.warn(`[ws-proxy #${id}] forward failed: ${e.message}`); }
        } else {
            console.log(`[ws-proxy #${id}] upstream not ready, buffering client msg #${clientMsgCount}`);
            pending.push(text);
        }
    });

    client.on('close', (code, reason) => {
        console.log(`[ws-proxy #${id}] client CLOSED code=${code} reason=${reason?.toString?.() || 'none'} (received ${clientMsgCount} client msgs, forwarded ${upstreamMsgCount} upstream msgs)`);
        safeClose(code, reason);
    });

    client.on('error', (err) => {
        console.warn(`[ws-proxy #${id}] client ERROR: ${err.message}`);
        safeClose(1011, 'client error');
    });
});

// ===================== START =====================
server.listen(PORT, async () => {
    console.log(`[server] listening on :${PORT}`);
    console.log(`[server] static dir: ${DIST_DIR}`);
    console.log(`[server] ws proxy:   /ws -> ${UPSTREAM_WS}`);
    console.log(`[server] node version: ${process.version}`);
    console.log(`[server] supabase configured: ${!!(SUPABASE_URL && SUPABASE_SERVICE_KEY)}`);

    try {
        const res = await fetch('https://api.ipify.org');
        const ip = await res.text();
        console.log(`[server] outbound IP: ${ip}  <-- WHITELIST THIS AT THE BROKER`);
    } catch (e) {
        console.warn('[server] could not resolve outbound IP:', e.message);
    }
});
