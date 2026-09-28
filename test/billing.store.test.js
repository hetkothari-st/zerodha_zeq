import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBillingStore } from '../server/billing/store.js';

function rest(handler) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const { status = 200, body = [] } = handler(String(url), init) ?? {};
        return new Response(body === null ? '' : JSON.stringify(body), { status });
    };
    return { calls, store: createBillingStore({ supabaseUrl: 'https://p.supabase.co', serviceKey: 'svc', fetchImpl }) };
}

test('entitlement calls the rpc and defaults to free', async () => {
    const { calls, store } = rest(() => ({ body: [{ plan: 'pro', source: 'comp', until: null }] }));
    assert.deepEqual(await store.entitlement('u1'), { plan: 'pro', source: 'comp', until: null });
    assert.equal(calls[0].url, 'https://p.supabase.co/rest/v1/rpc/entitlement');
    assert.deepEqual(JSON.parse(calls[0].init.body), { uid: 'u1' });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer svc');
    const empty = rest(() => ({ body: [] }));
    assert.deepEqual(await empty.store.entitlement('u1'), { plan: 'free', source: null, until: null });
});

test('openSubscription filters on open statuses', async () => {
    const { calls, store } = rest(() => ({ body: [{ razorpay_subscription_id: 'sub_1', status: 'created' }] }));
    assert.equal((await store.openSubscription('u1')).razorpay_subscription_id, 'sub_1');
    assert.match(calls[0].url, /user_id=eq\.u1/);
    assert.match(calls[0].url, /status=in\.\(created,authenticated,active,pending\)/);
});

test('recordEvent: true when inserted, false on duplicate', async () => {
    let n = 0;
    const { calls, store } = rest(() => ({ status: 201, body: n++ === 0 ? [{ event_id: 'evt_1' }] : [] }));
    assert.equal(await store.recordEvent('evt_1'), true);
    assert.equal(await store.recordEvent('evt_1'), false);
    assert.match(calls[0].init.headers.Prefer, /resolution=ignore-duplicates/);
});

test('updateSubscription returns null when no row matched', async () => {
    const { store } = rest(() => ({ body: [] }));
    assert.equal(await store.updateSubscription('sub_missing', { status: 'active' }), null);
});

test('updateSubscription with notAfter adds the atomic stale-guard filter', async () => {
    const { calls, store } = rest(() => ({ body: [] }));
    assert.equal(await store.updateSubscription('sub_1', { status: 'active' }, { notAfter: '2026-01-01T00:00:00.000Z' }), null);
    assert.match(calls[0].url, /subscriptions\?razorpay_subscription_id=eq\.sub_1&or=\(last_event_at\.is\.null,last_event_at\.lte\.2026-01-01T00%3A00%3A00\.000Z\)/);
});

test('updateSubscription without notAfter omits the stale-guard filter', async () => {
    const { calls, store } = rest(() => ({ body: [{ razorpay_subscription_id: 'sub_1' }] }));
    await store.updateSubscription('sub_1', { status: 'active' });
    assert.ok(!calls[0].url.includes('&or='));
});

test('hasEvent: true when a row exists, false otherwise', async () => {
    const { calls, store } = rest((url) => ({ body: url.includes('evt_1') ? [{ event_id: 'evt_1' }] : [] }));
    assert.equal(await store.hasEvent('evt_1'), true);
    assert.equal(await store.hasEvent('evt_2'), false);
    assert.match(calls[0].url, /billing_events\?event_id=eq\.evt_1&select=event_id/);
});

test('failed PostgREST call throws without leaking the key', async () => {
    const { store } = rest(() => ({ status: 500, body: { message: 'boom' } }));
    await assert.rejects(store.latestSubscription('u1'), (e) => /failed: 500/.test(e.message) && !e.message.includes('svc'));
});

test('failed PostgREST call sets .status to the HTTP status', async () => {
    const { store } = rest(() => ({ status: 409, body: { message: 'conflict' } }));
    await assert.rejects(store.insertSubscription('u1', { razorpay_subscription_id: 'sub_1' }), (e) => e.status === 409);
    const notFound = rest(() => ({ status: 404, body: { message: 'nope' } }));
    await assert.rejects(notFound.store.getSubscription('sub_x'), (e) => e.status === 404);
});
