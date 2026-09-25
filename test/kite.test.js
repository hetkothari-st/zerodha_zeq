import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createStateStore } from '../server/kite/state.js';
import { createHubClient } from '../server/kite/hubClient.js';
import { createKiteRouter } from '../server/kite/routes.js';
import { fakeAuth, approvedUser, approvedAdmin } from './helpers/fakeAuth.js';
import { listen } from './helpers/http.js';

const config = { kiteApiKey: 'kitekey', kiteApiSecret: 'kitesecret' };

// Fake network: Kite login page (HTML unless keyRejected) and token endpoint.
function fakeKite({ keyRejected = false, exchangeOk = true } = {}) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).startsWith('https://kite.zerodha.com/connect/login')) {
            return keyRejected
                ? new Response(JSON.stringify({ status: 'error', message: 'Invalid `api_key`.' }), { status: 400, headers: { 'content-type': 'application/json' } })
                : new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
        }
        if (String(url) === 'https://api.kite.trade/session/token') {
            return new Response(JSON.stringify(exchangeOk
                ? { status: 'success', data: { access_token: 'fresh-token', user_id: 'AB1234' } }
                : { status: 'error', message: 'Token is invalid or has expired.' }), { headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected fetch ${url}`);
    };
    return { fetchImpl, calls };
}

async function setup({ kite = fakeKite(), now } = {}) {
    const { auth, tokenFor } = fakeAuth({ user: approvedUser, admin: approvedAdmin });
    const pushed = [];
    const hub = { pushToken: async (t) => { pushed.push(t); return true; } };
    const kiteSession = { accessToken: '' };
    const stateStore = createStateStore(now ? { now } : {});
    const app = express();
    app.use(express.json());
    app.use(createKiteRouter({ config, auth, kiteSession, stateStore, hub, fetchImpl: kite.fetchImpl }));
    const srv = await listen(app);
    const as = (who) => ({ Authorization: `Bearer ${tokenFor(who)}`, 'Content-Type': 'application/json' });
    return { srv, as, pushed, kiteSession, kite, stateStore };
}

test('kite-config: 401 anonymous, 403 user, admin sees configured flag only', async () => {
    const { srv, as, kiteSession } = await setup();
    try {
        assert.equal((await fetch(`${srv.url}/api/kite-config`)).status, 401);
        assert.equal((await fetch(`${srv.url}/api/kite-config`, { headers: as('user') })).status, 403);
        kiteSession.accessToken = 'secret-token';
        const body = await (await fetch(`${srv.url}/api/kite-config`, { headers: as('admin') })).json();
        assert.deepEqual(body, { configured: true });
    } finally { await srv.close(); }
});

test('set-access-token: admin only, stores and pushes to hub', async () => {
    const { srv, as, pushed, kiteSession } = await setup();
    try {
        const anon = await fetch(`${srv.url}/api/set-access-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: 'x' }) });
        assert.equal(anon.status, 401);
        const bad = await fetch(`${srv.url}/api/set-access-token`, { method: 'POST', headers: as('admin'), body: '{}' });
        assert.equal(bad.status, 400);
        const ok = await fetch(`${srv.url}/api/set-access-token`, { method: 'POST', headers: as('admin'), body: JSON.stringify({ access_token: ' tok ' }) });
        assert.deepEqual(await ok.json(), { ok: true });
        assert.equal(kiteSession.accessToken, 'tok');
        assert.deepEqual(pushed, ['tok']);
    } finally { await srv.close(); }
});

test('exchange-token: admin only; Kite failure → 502 kite_error', async () => {
    const { srv, as } = await setup({ kite: fakeKite({ exchangeOk: false }) });
    try {
        const res = await fetch(`${srv.url}/api/exchange-token`, { method: 'POST', headers: as('admin'), body: JSON.stringify({ request_token: 'rt' }) });
        assert.equal(res.status, 502);
        assert.equal((await res.json()).message, 'Token is invalid or has expired.');
    } finally { await srv.close(); }
});

test('login-url: returns Kite URL carrying a state nonce', async () => {
    const { srv, as } = await setup();
    try {
        const body = await (await fetch(`${srv.url}/api/admin/kite/login-url`, { method: 'POST', headers: as('admin') })).json();
        const url = new URL(body.url);
        assert.equal(url.origin + url.pathname, 'https://kite.zerodha.com/connect/login');
        assert.equal(url.searchParams.get('api_key'), 'kitekey');
        assert.match(url.searchParams.get('redirect_params'), /^state=[0-9a-f]{48}$/);
    } finally { await srv.close(); }
});

test('login-url: rejected API key → 503 kite_key_rejected', async () => {
    const { srv, as } = await setup({ kite: fakeKite({ keyRejected: true }) });
    try {
        const res = await fetch(`${srv.url}/api/admin/kite/login-url`, { method: 'POST', headers: as('admin') });
        assert.equal(res.status, 503);
        assert.equal((await res.json()).code, 'kite_key_rejected');
    } finally { await srv.close(); }
});

async function loginState(srv, as) {
    const body = await (await fetch(`${srv.url}/api/admin/kite/login-url`, { method: 'POST', headers: as('admin') })).json();
    return new URL(body.url).searchParams.get('redirect_params').slice('state='.length);
}
const callback = (srv, qs) => fetch(`${srv.url}/kite/callback?${qs}`, { redirect: 'manual' });

test('callback with valid state exchanges, stores and redirects to admin', async () => {
    const { srv, as, pushed, kiteSession } = await setup();
    try {
        const state = await loginState(srv, as);
        const res = await callback(srv, `request_token=rt&status=success&state=${state}`);
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), '/admin?kite=connected');
        assert.equal(kiteSession.accessToken, 'fresh-token');
        assert.deepEqual(pushed, ['fresh-token']);
    } finally { await srv.close(); }
});

test('callback without, replayed or expired state never exchanges', async () => {
    let t = 0;
    const kite = fakeKite();
    const { srv, as } = await setup({ kite, now: () => t });
    try {
        const exchanges = () => kite.calls.filter((c) => c.url === 'https://api.kite.trade/session/token').length;

        let res = await callback(srv, 'request_token=rt&status=success');
        assert.equal(res.headers.get('location'), '/admin?kite=expired');

        const state = await loginState(srv, as);
        await callback(srv, `request_token=rt&status=success&state=${state}`);
        res = await callback(srv, `request_token=rt&status=success&state=${state}`);
        assert.equal(res.headers.get('location'), '/admin?kite=expired');
        assert.equal(exchanges(), 1);

        const late = await loginState(srv, as);
        t = 5 * 60 * 1000 + 1;
        res = await callback(srv, `request_token=rt&status=success&state=${late}`);
        assert.equal(res.headers.get('location'), '/admin?kite=expired');
        assert.equal(exchanges(), 1);
    } finally { await srv.close(); }
});

test('callback with status other than success redirects to failed', async () => {
    const { srv, as } = await setup();
    try {
        const state = await loginState(srv, as);
        const res = await callback(srv, `status=cancelled&state=${state}`);
        assert.equal(res.headers.get('location'), '/admin?kite=failed');
    } finally { await srv.close(); }
});

test('hub client sends the shared secret and reports failures without throwing', async () => {
    let seen;
    const hub = createHubClient({ hubUrl: 'http://hub', secret: 's3cret', fetchImpl: async (url, init) => { seen = { url, init }; return new Response('', { status: 200 }); } });
    assert.equal(await hub.pushToken('tok'), true);
    assert.equal(seen.url, 'http://hub/api/update-token');
    assert.equal(seen.init.headers['X-Hub-Secret'], 's3cret');
    assert.deepEqual(JSON.parse(seen.init.body), { access_token: 'tok' });

    const down = createHubClient({ hubUrl: 'http://hub', secret: 's', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(await down.pushToken('tok'), false);
});
