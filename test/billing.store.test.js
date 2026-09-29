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

test('openSubscription filters on open statuses and excludes scheduled cancellations', async () => {
    const { calls, store } = rest(() => ({ body: [{ razorpay_subscription_id: 'sub_1', status: 'created' }] }));
    assert.equal((await store.openSubscription('u1')).razorpay_subscription_id, 'sub_1');
    assert.match(calls[0].url, /user_id=eq\.u1/);
    assert.match(calls[0].url, /status=in\.\(created,authenticated,active,pending\)/);
    assert.match(calls[0].url, /cancel_at_period_end=is\.false/);
});

test('scheduledCancel returns the open row flagged cancel_at_period_end (excludes rows with no current_end)', async () => {
    const { calls, store } = rest(() => ({ body: [{ razorpay_subscription_id: 'sub_old', status: 'active', cancel_at_period_end: true, current_end: '2026-11-01T00:00:00.000Z' }] }));
    assert.equal((await store.scheduledCancel('u1')).razorpay_subscription_id, 'sub_old');
    assert.match(calls[0].url, /user_id=eq\.u1/);
    assert.match(calls[0].url, /status=in\.\(created,authenticated,active,pending\)/);
    assert.match(calls[0].url, /cancel_at_period_end=is\.true/);
});

// I3: a stale/dud scheduled row with no current_end (never actually granted access) must never
// win over a real one — filter it out server-side and order by current_end (not created_at), so
// the row that grants access the longest (the one Resume should key off of) is the one returned.
test('scheduledCancel filters out rows with null current_end and orders by current_end desc', async () => {
    const { calls, store } = rest(() => ({ body: [{ razorpay_subscription_id: 'sub_latest', status: 'active', cancel_at_period_end: true, current_end: '2026-11-01T00:00:00.000Z' }] }));
    assert.equal((await store.scheduledCancel('u1')).razorpay_subscription_id, 'sub_latest');
    assert.match(calls[0].url, /current_end=not\.is\.null/);
    assert.match(calls[0].url, /order=current_end\.desc/);
    assert.ok(!calls[0].url.includes('created_at.desc'));
});

test('openRows returns every open-status row for a user, newest first, with no cancel_at_period_end filter or limit', async () => {
    const { calls, store } = rest(() => ({ body: [{ razorpay_subscription_id: 'sub_a' }, { razorpay_subscription_id: 'sub_b' }] }));
    const rows = await store.openRows('u1');
    assert.equal(rows.length, 2);
    assert.match(calls[0].url, /user_id=eq\.u1/);
    assert.match(calls[0].url, /status=in\.\(created,authenticated,active,pending\)/);
    assert.match(calls[0].url, /order=created_at\.desc/);
    assert.ok(!calls[0].url.includes('cancel_at_period_end=is')); // no filter on it — select= listing it is fine
    assert.ok(!calls[0].url.includes('limit='));
});

test('openRows returns [] (not null) when there are no rows', async () => {
    const { store } = rest(() => ({ body: [] }));
    assert.deepEqual(await store.openRows('u1'), []);
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
