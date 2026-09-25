'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHubAuth } = require('../auth.cjs');
const { createGate, CLOSE_CODES } = require('../gate.cjs');
const { makeProject, fakeRest, fakeSocket } = require('./helpers.cjs');

const ORIGINS = ['https://funnelop.in', 'https://funneleq.in'];

async function setup() {
    const op = await makeProject('op', 'https://op-test.supabase.co');
    const rest = fakeRest();
    let t = 0;
    const hubAuth = createHubAuth({ projects: [op.project], fetchImpl: rest.fetchImpl, now: () => t });
    return { op, rest, gate: createGate({ hubAuth, allowedOrigins: ORIGINS }), tick: (ms) => { t += ms; } };
}
const req = (origin, token) => ({ headers: { origin }, url: token ? `/?token=${encodeURIComponent(token)}` : '/' });

test('admit: foreign origin → HTTP 403; missing token → unauthenticated', async () => {
    const { gate, op } = await setup();
    assert.deepEqual(await gate.admit(req('https://evil.example', await op.sign())), { ok: false, http: 403 });
    assert.deepEqual(await gate.admit(req(undefined, await op.sign())), { ok: false, http: 403 });
    assert.deepEqual(await gate.admit(req('https://funnelop.in')), { ok: false, reason: 'unauthenticated' });
});

test('admit: allowed origin + approved token → ok', async () => {
    const { gate, op, rest } = await setup();
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's1' });
    const r = await gate.admit(req('https://funnelop.in', await op.sign()));
    assert.equal(r.ok, true);
    assert.equal(r.identity.userId, 'u1');
});

test('recheck: displaced client is told and closed with 4409', async () => {
    const { gate, op, rest, tick } = await setup();
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's1' });
    const { identity } = await gate.admit(req('https://funnelop.in', await op.sign()));
    const ws = fakeSocket();
    const clients = new Map([[ws, identity]]);
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's2' });
    tick(15001);
    await gate.recheck(clients);
    assert.deepEqual(ws.sent, [JSON.stringify({ type: 'signed_in_elsewhere' })]);
    assert.deepEqual(ws.closed, { code: CLOSE_CODES.signed_in_elsewhere, reason: 'signed_in_elsewhere' });
    assert.equal(clients.size, 0);
});

test('recheck: rejected user closed with 4403', async () => {
    const { gate, op, rest, tick } = await setup();
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's1' });
    const { identity } = await gate.admit(req('https://funnelop.in', await op.sign()));
    const ws = fakeSocket();
    const clients = new Map([[ws, identity]]);
    rest.set(op.project.url, 'u1', { status: 'rejected', current_session_id: 's1' });
    tick(15001);
    await gate.recheck(clients);
    assert.equal(ws.closed.code, 4403);
});

test('recheck keeps clients when unavailable (Supabase down)', async () => {
    const { gate, op, rest, tick } = await setup();
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's1' });
    const { identity } = await gate.admit(req('https://funnelop.in', await op.sign()));
    const ws = fakeSocket();
    const clients = new Map([[ws, identity]]);
    rest.state.down = true;
    tick(15001);
    await gate.recheck(clients);
    assert.equal(ws.closed, null);
    assert.equal(clients.size, 1);
});

test('admit: malformed request URL does not reject the promise', async () => {
    const { gate, op } = await setup();
    const result = await gate.admit({ headers: { origin: 'https://funnelop.in' }, url: 'http://[' });
    assert.deepEqual(result, { ok: false, reason: 'unauthenticated' });
});

test('admit: allowed origin matches case- and trailing-slash-insensitively', async () => {
    const op = await makeProject('op', 'https://op-test.supabase.co');
    const rest = fakeRest();
    const hubAuth = createHubAuth({ projects: [op.project], fetchImpl: rest.fetchImpl, now: () => 0 });
    const gate = createGate({ hubAuth, allowedOrigins: ['https://FunnelOp.in/'] });
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's1' });
    const r = await gate.admit(req('https://funnelop.in', await op.sign()));
    assert.equal(r.ok, true);
});
