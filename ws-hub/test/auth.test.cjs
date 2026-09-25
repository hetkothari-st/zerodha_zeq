'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { errors: joseErrors } = require('jose');
const { createHubAuth, hasHubSecret } = require('../auth.cjs');
const { makeProject, fakeRest } = require('./helpers.cjs');

async function setup() {
    const op = await makeProject('op', 'https://op-test.supabase.co');
    const eq = await makeProject('eq', 'https://eq-test.supabase.co');
    const rest = fakeRest();
    let t = 0;
    const hubAuth = createHubAuth({ projects: [op.project, eq.project], fetchImpl: rest.fetchImpl, now: () => t });
    return { op, eq, rest, hubAuth, tick: (ms) => { t += ms; } };
}

test('accepts approved users from either project', async () => {
    const { op, eq, rest, hubAuth } = await setup();
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's1' });
    rest.set(eq.project.url, 'u1', { status: 'approved', current_session_id: 's1' });
    const a = await hubAuth.authenticate(await op.sign());
    assert.equal(a.ok, true);
    assert.equal(a.identity.project, 'op');
    const b = await hubAuth.authenticate(await eq.sign());
    assert.equal(b.identity.project, 'eq');
    assert.equal(rest.calls[0].init.headers.apikey, 'op-service');
});

test('rejects unknown issuer, wrong key and garbage', async () => {
    const { op, eq, hubAuth } = await setup();
    const stranger = await makeProject('x', 'https://stranger.supabase.co');
    assert.deepEqual(await hubAuth.authenticate(await stranger.sign()), { ok: false, reason: 'unauthenticated' });
    assert.deepEqual(await hubAuth.authenticate(await eq.sign({ issuer: `${op.project.url}/auth/v1` })), { ok: false, reason: 'unauthenticated' });
    assert.deepEqual(await hubAuth.authenticate('garbage'), { ok: false, reason: 'unauthenticated' });
});

test('pending user → not_approved; displaced session → signed_in_elsewhere', async () => {
    const { op, rest, hubAuth } = await setup();
    rest.set(op.project.url, 'u1', { status: 'pending', current_session_id: 's1' });
    assert.equal((await hubAuth.authenticate(await op.sign())).reason, 'not_approved');
    rest.set(op.project.url, 'u2', { status: 'approved', current_session_id: 's9' });
    assert.equal((await hubAuth.authenticate(await op.sign({ sub: 'u2' }))).reason, 'signed_in_elsewhere');
});

test('stale cache refetch: a newly current session is accepted', async () => {
    const { op, rest, hubAuth } = await setup();
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's1' });
    assert.equal((await hubAuth.authenticate(await op.sign({ sessionId: 's1' }))).ok, true);
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's2' });
    assert.equal((await hubAuth.authenticate(await op.sign({ sessionId: 's2' }))).ok, true);
});

test('profile service down → unavailable', async () => {
    const { op, rest, hubAuth } = await setup();
    rest.state.down = true;
    assert.deepEqual(await hubAuth.authenticate(await op.sign()), { ok: false, reason: 'unavailable' });
});

test('hasHubSecret compares in constant time and rejects missing values', () => {
    assert.equal(hasHubSecret('s3cret', 's3cret'), true);
    assert.equal(hasHubSecret('s3creT', 's3cret'), false);
    assert.equal(hasHubSecret('short', 's3cret'), false);
    assert.equal(hasHubSecret(undefined, 's3cret'), false);
    assert.equal(hasHubSecret('anything', ''), false);
});

test('pending user whose session is NOT current → not_approved (status checked before session)', async () => {
    const { op, rest, hubAuth } = await setup();
    rest.set(op.project.url, 'u1', { status: 'pending', current_session_id: 's1' });
    const result = await hubAuth.authenticate(await op.sign({ sessionId: 's2' }));
    assert.deepEqual(result, { ok: false, reason: 'not_approved' });
});

test('profile fetch that hangs times out → unavailable', async () => {
    const op = await makeProject('op', 'https://op-test.supabase.co');
    const hangingFetch = (url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const hubAuth = createHubAuth({ projects: [op.project], fetchImpl: hangingFetch, fetchTimeoutMs: 50 });
    const result = await hubAuth.authenticate(await op.sign());
    assert.deepEqual(result, { ok: false, reason: 'unavailable' });
});

test('connection-time authenticate within the TTL is served from cache', async () => {
    const { op, rest, hubAuth, tick } = await setup();
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's1' });
    assert.equal((await hubAuth.authenticate(await op.sign())).ok, true);
    const fetches = rest.calls.length;
    tick(14999);
    assert.equal((await hubAuth.authenticate(await op.sign())).ok, true);
    assert.equal(rest.calls.length, fetches);
});

test('check(identity, { fresh: true }) bypasses the cache', async () => {
    const { op, rest, hubAuth } = await setup();
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's1' });
    const { identity } = await hubAuth.authenticate(await op.sign());
    const fetches = rest.calls.length;
    assert.equal((await hubAuth.check(identity)).ok, true);
    assert.equal(rest.calls.length, fetches, 'plain check uses the cache');
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's2' });
    assert.deepEqual(await hubAuth.check(identity, { fresh: true }), { ok: false, reason: 'signed_in_elsewhere' });
    assert.equal(rest.calls.length, fetches + 1);
});

test('JWKS network failure → unavailable, not unauthenticated', async () => {
    const op = await makeProject('op', 'https://op-test.supabase.co');
    const rest = fakeRest();
    rest.set(op.project.url, 'u1', { status: 'approved', current_session_id: 's1' });
    const down = { ...op.project, jwks: async () => { throw new TypeError('fetch failed'); } };
    const hubAuth = createHubAuth({ projects: [down], fetchImpl: rest.fetchImpl });
    assert.deepEqual(await hubAuth.authenticate(await op.sign()), { ok: false, reason: 'unavailable' });
    const timeout = createHubAuth({ projects: [{ ...op.project, jwks: async () => { throw new joseErrors.JWKSTimeout(); } }], fetchImpl: rest.fetchImpl });
    assert.deepEqual(await timeout.authenticate(await op.sign()), { ok: false, reason: 'unavailable' });
});

test('bad tokens stay unauthenticated when JWKS says no matching key', async () => {
    const op = await makeProject('op', 'https://op-test.supabase.co');
    const hubAuth = createHubAuth({ projects: [{ ...op.project, jwks: async () => { throw new joseErrors.JWKSNoMatchingKey(); } }], fetchImpl: fakeRest().fetchImpl });
    assert.deepEqual(await hubAuth.authenticate(await op.sign()), { ok: false, reason: 'unauthenticated' });
});
