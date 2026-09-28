import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createApp } from '../server/app.js';
import { createKiteRouter } from '../server/kite/routes.js';
import { createStateStore } from '../server/kite/state.js';
import { createAdminRouter } from '../server/admin/routes.js';
import { fakeAuth, approvedAdmin } from './helpers/fakeAuth.js';
import { listen } from './helpers/http.js';

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dist');
const config = { supabaseUrl: 'https://op.supabase.co', hubPublicUrl: 'wss://hub.example', kiteApiKey: 'k', kiteApiSecret: 's' };

async function setup({ extraRouters = [] } = {}) {
    const { auth, profiles } = fakeAuth({ admin: approvedAdmin });
    const kiteSession = { accessToken: 'super-secret-kite-token' };
    const routers = [
        createKiteRouter({ config, auth, kiteSession, stateStore: createStateStore({ secret: 'test-secret' }), hub: { pushToken: async () => true } }),
        createAdminRouter({ auth, profiles, profileAdmin: { listByStatus: async () => [] }, notifier: {} }),
        ...extraRouters,
    ];
    return listen(createApp({ config, distDir, routers }));
}

test('removed legacy endpoints are gone', async () => {
    const srv = await setup();
    try {
        for (const [method, p] of [['POST', '/api/login'], ['POST', '/api/logout'], ['POST', '/api/validate-session'],
            ['GET', '/api/active-sessions'], ['POST', '/api/force-logout'], ['GET', '/api/session']]) {
            const res = await fetch(srv.url + p, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
            assert.equal(res.status, 404, `${method} ${p}`);
            assert.equal((await res.json()).code, 'not_found');
        }
        for (const p of ['/connect', '/kite/login']) {
            const html = await (await fetch(srv.url + p)).text();
            assert.ok(html.includes('spa'), `${p} should fall through to the SPA`);
            assert.ok(!html.includes('Funnel Launcher'));
        }
    } finally { await srv.close(); }
});

test('kite-config never leaks the access token to anonymous callers', async () => {
    const srv = await setup();
    try {
        const res = await fetch(`${srv.url}/api/kite-config`);
        assert.equal(res.status, 401);
        assert.ok(!(await res.text()).includes('super-secret-kite-token'));
    } finally { await srv.close(); }
});

test('security headers: CSP with frame-ancestors none, no x-powered-by', async () => {
    const srv = await setup();
    try {
        const res = await fetch(srv.url + '/');
        const csp = res.headers.get('content-security-policy');
        assert.match(csp, /frame-ancestors 'none'/);
        assert.match(csp, /connect-src 'self' https:\/\/op\.supabase\.co wss:\/\/op\.supabase\.co https:\/\/api\.razorpay\.com https:\/\/lumberjack\.razorpay\.com wss:\/\/hub\.example/);
        assert.match(csp, /img-src 'self' data: https:\/\/\*\.googleusercontent\.com/); // Google avatars on any lhN host
        assert.equal(res.headers.get('x-powered-by'), null);
    } finally { await srv.close(); }
});

test('security headers: Cross-Origin-Opener-Policy allows Razorpay Checkout popups', async () => {
    const srv = await setup();
    try {
        const res = await fetch(srv.url + '/');
        assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
    } finally { await srv.close(); }
});

test('malformed JSON → 400 bad_request JSON, not an HTML stack trace', async () => {
    const srv = await setup();
    try {
        const res = await fetch(`${srv.url}/api/set-access-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).code, 'bad_request');
    } finally { await srv.close(); }
});

test('API rate limit: 61st request in a minute → 429 rate_limited', async () => {
    const srv = await setup();
    try {
        let last;
        for (let i = 0; i < 61; i++) last = await fetch(`${srv.url}/api/nothing-here`);
        assert.equal(last.status, 429);
        assert.equal((await last.json()).code, 'rate_limited');
    } finally { await srv.close(); }
});

test('unknown non-API paths serve the SPA', async () => {
    const srv = await setup();
    try {
        const res = await fetch(`${srv.url}/admin`);
        assert.equal(res.status, 200);
        assert.ok((await res.text()).includes('spa'));
    } finally { await srv.close(); }
});

test('billing webhook bypasses the JSON parser and the /api rate limit', async () => {
    const webhookRouter = express.Router();
    webhookRouter.post('/api/billing/webhook', (req, res) => res.json({ raw: Buffer.isBuffer(req.body), len: req.body.length }));
    const srv = await setup({ extraRouters: [webhookRouter] });
    try {
        for (let i = 0; i < 70; i++) {
            const res = await fetch(`${srv.url}/api/billing/webhook`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{"a":1}',
            });
            assert.equal(res.status, 200, `request ${i}`);
            assert.deepEqual(await res.json(), { raw: true, len: 7 });
        }
    } finally { await srv.close(); }
});

test('CSP allows Razorpay Checkout', async () => {
    const srv = await setup();
    try {
        const res = await fetch(srv.url + '/');
        const csp = res.headers.get('content-security-policy');
        assert.match(csp, /script-src 'self' https:\/\/checkout\.razorpay\.com/);
        assert.match(csp, /frame-src https:\/\/api\.razorpay\.com https:\/\/checkout\.razorpay\.com/);
        assert.match(csp, /connect-src[^;]*https:\/\/api\.razorpay\.com/);
        assert.match(csp, /connect-src[^;]*https:\/\/lumberjack\.razorpay\.com/);
    } finally { await srv.close(); }
});
