import express from 'express';
import crypto from 'crypto';
import { sendError } from '../auth/errors.js';

const KITE_LOGIN = 'https://kite.zerodha.com/connect/login';
const KITE_TOKEN = 'https://api.kite.trade/session/token';

export function createKiteRouter({ config, auth, kiteSession, stateStore, hub, fetchImpl = fetch }) {
    const router = express.Router();

    async function exchange(requestToken) {
        const checksum = crypto.createHash('sha256')
            .update(config.kiteApiKey + requestToken + config.kiteApiSecret)
            .digest('hex');
        const res = await fetchImpl(KITE_TOKEN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
            body: new URLSearchParams({ api_key: config.kiteApiKey, request_token: requestToken, checksum }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.status !== 'success' || !data.data?.access_token) throw new Error(data.message || 'Token exchange failed');
        return data.data.access_token;
    }

    async function adopt(accessToken) {
        kiteSession.accessToken = accessToken;
        await hub.pushToken(accessToken);
    }

    const bodyString = (req, key) => (typeof req.body?.[key] === 'string' ? req.body[key].trim() : '');

    router.get('/api/kite-config', ...auth.requireAdmin, (req, res) => {
        res.json({ configured: Boolean(config.kiteApiKey && kiteSession.accessToken) });
    });

    router.post('/api/set-access-token', ...auth.requireAdmin, async (req, res) => {
        const token = bodyString(req, 'access_token');
        if (!token) return sendError(res, 'bad_request', 'access_token required');
        await adopt(token);
        res.json({ ok: true });
    });

    router.post('/api/exchange-token', ...auth.requireAdmin, async (req, res) => {
        const requestToken = bodyString(req, 'request_token');
        if (!requestToken) return sendError(res, 'bad_request', 'request_token required');
        if (!config.kiteApiKey || !config.kiteApiSecret) return sendError(res, 'kite_error', 'ZERODHA_API_KEY or ZERODHA_API_SECRET not configured');
        try {
            await adopt(await exchange(requestToken));
            res.json({ ok: true });
        } catch (err) {
            sendError(res, 'kite_error', err.message);
        }
    });

    router.post('/api/admin/kite/login-url', ...auth.requireAdmin, async (req, res) => {
        if (!config.kiteApiKey) return sendError(res, 'kite_error', 'ZERODHA_API_KEY not configured');
        const state = stateStore.issue();
        const url = `${KITE_LOGIN}?v=3&api_key=${encodeURIComponent(config.kiteApiKey)}&redirect_params=${encodeURIComponent(`state=${state}`)}`;
        // Kite answers an expired/invalid key with bare JSON; report it instead of sending the admin there.
        try {
            const check = await fetchImpl(url, { redirect: 'manual' });
            if ((check.headers.get('content-type') || '').includes('application/json')) {
                const body = await check.json().catch(() => ({}));
                console.error('[kite] Login rejected by Kite:', body.message || check.status);
                return sendError(res, 'kite_key_rejected');
            }
        } catch (err) {
            console.warn('[kite] Could not pre-check Kite login:', err.message);
        }
        res.json({ ok: true, url });
    });

    // Browser redirect from Zerodha: no Bearer header is possible, so the one-time state is the proof.
    router.get('/kite/callback', async (req, res) => {
        const { request_token: requestToken, status, state } = req.query;
        if (!stateStore.consume(typeof state === 'string' ? state : '')) return res.redirect('/admin?kite=expired');
        if (status !== 'success' || typeof requestToken !== 'string' || !requestToken) return res.redirect('/admin?kite=failed');
        try {
            await adopt(await exchange(requestToken));
            return res.redirect('/admin?kite=connected');
        } catch (err) {
            console.error('[kite] Token exchange failed:', err.message);
            return res.redirect('/admin?kite=failed');
        }
    });

    return router;
}
