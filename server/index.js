// Production server (Railway / any HTTPS host).
// Responsibilities:
//   1. Serve the built Vite SPA from ../dist
//   2. /api/* for Supabase-backed auth with single-session enforcement
//   3. /api/kite-config  — exposes Zerodha token status (no OAuth flow)

import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const ZERODHA_API_KEY = process.env.ZERODHA_API_KEY || '';
const ZERODHA_ACCESS_TOKEN = process.env.ZERODHA_ACCESS_TOKEN || '';

// ===================== SESSION TRACKING =====================
const activeSessions = new Map();

function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

// ===================== SUPABASE HELPER =====================
async function validateCredentials(username, password) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        console.error('[auth] SUPABASE_URL or SUPABASE_SERVICE_KEY not configured');
        return { ok: false, error: 'Server auth not configured.' };
    }

    try {
        const url = `${SUPABASE_URL}/rest/v1/app_users?username=eq.${encodeURIComponent(username)}&is_active=eq.true&select=username,password`;
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
        if (rows.length === 0) return { ok: false, error: 'Invalid username or password.' };

        const user = rows[0];
        if (user.password !== password) return { ok: false, error: 'Invalid username or password.' };

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

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.json({ ok: false, error: 'Username and password are required.' });

    const result = await validateCredentials(username, password);
    if (!result.ok) return res.json(result);

    const existing = activeSessions.get(username);
    if (existing) {
        return res.json({ ok: false, error: 'This account is already logged in from another session.' });
    }

    const sessionToken = generateSessionToken();
    activeSessions.set(username, { sessionToken, connectedAt: Date.now() });
    console.log(`[auth] Login SUCCESS for ${username} (sessions: ${activeSessions.size})`);
    return res.json({ ok: true, user: result.user, sessionToken });
});

app.post('/api/logout', (req, res) => {
    const { sessionToken } = req.body || {};
    if (!sessionToken) return res.json({ ok: false, error: 'No session token provided.' });

    for (const [username, session] of activeSessions) {
        if (session.sessionToken === sessionToken) {
            activeSessions.delete(username);
            console.log(`[auth] Logout SUCCESS for ${username}`);
            break;
        }
    }
    return res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
    const token = req.headers['x-session-token'];
    if (!token) return res.json({ ok: false });
    for (const [username, session] of activeSessions) {
        if (session.sessionToken === token) return res.json({ ok: true, username });
    }
    return res.json({ ok: false });
});

app.get('/api/active-sessions', (req, res) => {
    const sessions = [];
    for (const [username, session] of activeSessions) {
        sessions.push({
            username,
            connectedAt: new Date(session.connectedAt).toISOString(),
            durationMin: Math.round((Date.now() - session.connectedAt) / 60000),
        });
    }
    return res.json({ count: sessions.length, sessions });
});

app.post('/api/force-logout', (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.json({ ok: false, error: 'Username required.' });
    if (activeSessions.has(username)) {
        activeSessions.delete(username);
        return res.json({ ok: true, message: `${username} has been logged out.` });
    }
    return res.json({ ok: false, error: `${username} has no active session.` });
});

app.post('/api/set-access-token', async (req, res) => {
    const { access_token } = req.body || {};
    if (!access_token) return res.json({ ok: false, error: 'access_token required' });

    console.log('[kite] Access token set directly');

    try {
        await fetch(`${process.env.WS_HUB_URL || 'http://127.0.0.1:8765'}/api/update-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token }),
        });
        console.log('[kite] ws-hub notified');
    } catch (err) {
        console.warn('[kite] Could not notify ws-hub:', err.message);
    }

    return res.json({ ok: true, access_token });
});

app.post('/api/exchange-token', async (req, res) => {
    const { request_token } = req.body || {};
    if (!request_token) return res.json({ ok: false, error: 'request_token required' });
    const ZERODHA_API_SECRET = process.env.ZERODHA_API_SECRET || '';
    if (!ZERODHA_API_KEY || !ZERODHA_API_SECRET)
        return res.json({ ok: false, error: 'ZERODHA_API_KEY or ZERODHA_API_SECRET not configured' });

    try {
        const checksum = crypto
            .createHash('sha256')
            .update(ZERODHA_API_KEY + request_token + ZERODHA_API_SECRET)
            .digest('hex');

        const tokenRes = await fetch('https://api.kite.trade/session/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
            body: new URLSearchParams({ api_key: ZERODHA_API_KEY, request_token, checksum }),
        });

        const data = await tokenRes.json();
        if (data.status !== 'success' || !data.data?.access_token)
            return res.json({ ok: false, error: data.message || 'Token exchange failed' });

        console.log(`[kite] Token exchanged via API (user: ${data.data.user_id})`);

        try {
            await fetch(`${process.env.WS_HUB_URL || 'http://127.0.0.1:8765'}/api/update-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_token: data.data.access_token }),
            });
        } catch (_) {}

        return res.json({ ok: true, access_token: data.data.access_token });
    } catch (err) {
        console.error('[kite] exchange-token error:', err.message);
        return res.json({ ok: false, error: err.message });
    }
});

// Zerodha config endpoint — token is set manually in .env
app.get('/api/kite-config', (req, res) => {
    return res.json({
        apiKey: ZERODHA_API_KEY,
        accessToken: ZERODHA_ACCESS_TOKEN,
        configured: !!(ZERODHA_API_KEY && ZERODHA_ACCESS_TOKEN),
    });
});

app.get('/kite/login', (req, res) => {
    if (!ZERODHA_API_KEY) {
        return res.status(400).send('ZERODHA_API_KEY not configured in .env');
    }
    const redirectUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${ZERODHA_API_KEY}`;
    res.redirect(redirectUrl);
});

app.get('/kite/callback', async (req, res) => {
    const { request_token, status } = req.query;

    if (status !== 'success' || !request_token) {
        console.error('[kite] Callback failed:', req.query);
        return res.redirect('/?kite_error=callback_failed');
    }

    const ZERODHA_API_SECRET = process.env.ZERODHA_API_SECRET || '';

    if (!ZERODHA_API_KEY || !ZERODHA_API_SECRET) {
        console.error('[kite] ZERODHA_API_KEY or ZERODHA_API_SECRET not set');
        return res.redirect('/?kite_error=not_configured');
    }

    try {
        const checksum = crypto
            .createHash('sha256')
            .update(ZERODHA_API_KEY + request_token + ZERODHA_API_SECRET)
            .digest('hex');

        const tokenRes = await fetch('https://api.kite.trade/session/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
            body: new URLSearchParams({ api_key: ZERODHA_API_KEY, request_token, checksum }),
        });

        const data = await tokenRes.json();
        if (data.status !== 'success' || !data.data?.access_token) {
            console.error('[kite] Token exchange failed:', JSON.stringify(data));
            return res.redirect('/?kite_error=token_exchange_failed');
        }

        console.log(`[kite] Access token exchanged (user: ${data.data.user_id})`);
        
        // Update ws-hub dynamically
        try {
            await fetch(`${process.env.WS_HUB_URL || 'http://127.0.0.1:8765'}/api/update-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_token: data.data.access_token })
            });
            console.log('[kite] ws-hub notified of new token');
        } catch (err) {
            console.warn('[kite] Could not notify ws-hub (is it running?):', err.message);
        }
        
        return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Zerodha Auth</title>
<style>body{background:#050505;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px}
.ok{color:#4ade80;font-size:1.2rem;font-weight:bold}.sub{color:#ffffff60;font-size:.8rem}</style></head>
<body><div class="ok">✓ Zerodha connected</div>
<div class="sub">Token exchanged. You can close this tab.</div>
<div class="sub">Return to the app tab to continue.</div>
<script>if(window.opener)window.opener.postMessage('zerodha_connected','*');setTimeout(()=>window.close(),1500)</script></body></html>`);
    } catch (err) {
        console.error('[kite] Token exchange error:', err.message);
        return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Auth Error</title>
<style>body{background:#050505;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style></head>
<body style="color:#f87171">Auth error: ${err.message}</body></html>`);
    }
});

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// ===================== START =====================
app.listen(PORT, async () => {
    console.log(`[server] listening on :${PORT}`);
    console.log(`[server] static dir: ${DIST_DIR}`);
    console.log(`[server] supabase: ${!!(SUPABASE_URL && SUPABASE_SERVICE_KEY)}`);
    console.log(`[server] zerodha api key: ${ZERODHA_API_KEY ? ZERODHA_API_KEY.slice(0, 4) + '...' : 'NOT SET'}`);
    console.log(`[server] zerodha token: ${ZERODHA_ACCESS_TOKEN ? 'SET' : 'NOT SET — add to .env'}`);

    try {
        const r = await fetch('https://api.ipify.org');
        const ip = await r.text();
        console.log(`[server] outbound IP: ${ip}  <-- whitelist this at Zerodha`);
    } catch {}
});
