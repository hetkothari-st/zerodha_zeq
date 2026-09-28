import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { createBillingRouter } from '../server/billing/routes.js';
import { RazorpayError } from '../server/billing/razorpay.js';
import { fakeAuth, approvedUser } from './helpers/fakeAuth.js';
import { listen } from './helpers/http.js';

const USER = approvedUser.id; // 'user'
const OWNER = '66666666-6666-4666-8666-666666666666';
const SECRET = 'whsec_test';

function fakeBilling({ ent = { plan: 'free', source: null, until: null }, subs = [] } = {}) {
    const events = new Set();
    const log = { inserted: [], updated: [] };
    const store = {
        log, subs,
        entitlement: async () => ent,
        latestSubscription: async (uid) => subs.filter((s) => s.user_id === uid).at(-1) ?? null,
        openSubscription: async (uid) => subs.find((s) => s.user_id === uid && ['created', 'authenticated', 'active', 'pending'].includes(s.status)) ?? null,
        getSubscription: async (id) => subs.find((s) => s.razorpay_subscription_id === id) ?? null,
        insertSubscription: async (uid, fields) => {
            if (store.failInsert) throw new Error('unique violation');
            const row = { user_id: uid, cancel_at_period_end: false, last_event_at: null, ...fields };
            subs.push(row); log.inserted.push(row); return row;
        },
        updateSubscription: async (id, patch, { notAfter } = {}) => {
            if (store.failUpdate) throw new Error('db down');
            const row = subs.find((s) => s.razorpay_subscription_id === id);
            if (!row) return null;
            if (notAfter && row.last_event_at && Date.parse(row.last_event_at) > Date.parse(notAfter)) return null;
            Object.assign(row, patch); log.updated.push({ id, patch }); return row;
        },
        hasEvent: async (id) => events.has(id),
        recordEvent: async (id) => { if (events.has(id)) return false; events.add(id); return true; },
    };
    return store;
}

function fakeRazorpay({ fail = false, remote = {} } = {}) {
    const log = { created: [], cancelled: [] };
    return {
        log,
        createSubscription: async ({ planId, userId }) => {
            if (fail) throw new RazorpayError('down', 0);
            log.created.push({ planId, userId });
            return { id: `sub_new${log.created.length}`, status: 'created', current_end: null, short_url: 'https://rzp.io/i/new' };
        },
        cancelSubscription: async (id) => { if (fail) throw new RazorpayError('down', 0); log.cancelled.push(id); return { id, status: 'active' }; },
        fetchSubscription: async (id) => { if (!remote[id]) throw new RazorpayError('not found', 404); return remote[id]; },
    };
}

async function setup({ billing = fakeBilling(), razorpay = fakeRazorpay() } = {}) {
    const { auth, tokenFor } = fakeAuth({ user: approvedUser });
    const app = express();
    app.use('/api/billing/webhook', express.raw({ type: '*/*' }));
    app.use(express.json());
    app.use(createBillingRouter({ auth, billing, razorpay, planId: 'plan_1', keyId: 'rzp_test_k', webhookSecret: SECRET, priceLabel: '₹499/month' }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => res.status(500).json({ code: 'internal' }));
    const srv = await listen(app);
    const headers = { Authorization: `Bearer ${tokenFor('user')}` };
    return { srv, headers, billing, razorpay };
}

function signed(body, { eventId = 'evt_1', secret = SECRET } = {}) {
    const raw = JSON.stringify(body);
    return {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-razorpay-event-id': eventId,
            'x-razorpay-signature': crypto.createHmac('sha256', secret).update(raw).digest('hex'),
        },
        body: raw,
    };
}
const subEvent = (event, entity, createdAt = 1767225600) => ({ event, created_at: createdAt, payload: { subscription: { entity } } });

test('status: free user with no subscription', async () => {
    const { srv, headers } = await setup();
    try {
        const res = await fetch(`${srv.url}/api/billing/status`, { headers });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { plan: 'free', source: null, until: null, status: null, cancelAtPeriodEnd: false, manageUrl: null, priceLabel: '₹499/month' });
        assert.equal((await fetch(`${srv.url}/api/billing/status`)).status, 401);
    } finally { await srv.close(); }
});

test('subscribe creates a Razorpay subscription and stores it', async () => {
    const { srv, headers, billing, razorpay } = await setup();
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { subscriptionId: 'sub_new1', keyId: 'rzp_test_k' });
        assert.deepEqual(razorpay.log.created, [{ planId: 'plan_1', userId: USER }]);
        assert.equal(billing.log.inserted[0].status, 'created');
    } finally { await srv.close(); }
});

test('subscribe reuses an open created subscription', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'created' }] });
    const { srv, headers, razorpay } = await setup({ billing });
    try {
        const body = await (await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers })).json();
        assert.equal(body.subscriptionId, 'sub_old');
        assert.equal(razorpay.log.created.length, 0);
    } finally { await srv.close(); }
});

test('subscribe: already pro → 409; activation in progress → 409', async () => {
    const pro = await setup({ billing: fakeBilling({ ent: { plan: 'pro', source: 'comp', until: null } }) });
    try {
        assert.equal((await fetch(`${pro.srv.url}/api/billing/subscribe`, { method: 'POST', headers: pro.headers })).status, 409);
    } finally { await pro.srv.close(); }
    const busy = await setup({ billing: fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_a', status: 'authenticated' }] }) });
    try {
        assert.equal((await fetch(`${busy.srv.url}/api/billing/subscribe`, { method: 'POST', headers: busy.headers })).status, 409);
    } finally { await busy.srv.close(); }
});

test('subscribe: insert race returns the winner', async () => {
    const billing = fakeBilling();
    billing.failInsert = true;
    const origOpen = billing.openSubscription;
    let calls = 0;
    billing.openSubscription = async (uid) => (calls++ === 0 ? null : { user_id: uid, razorpay_subscription_id: 'sub_winner', status: 'created' });
    const { srv, headers } = await setup({ billing });
    try {
        const body = await (await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers })).json();
        assert.equal(body.subscriptionId, 'sub_winner');
    } finally { await srv.close(); billing.openSubscription = origOpen; }
});

test('subscribe: Razorpay down → 503 friendly message', async () => {
    const { srv, headers } = await setup({ razorpay: fakeRazorpay({ fail: true }) });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 503);
        assert.equal((await res.json()).message, 'Payments unavailable, try later.');
    } finally { await srv.close(); }
});

test('cancel: cancels at cycle end and flags the row; nothing to cancel → 400', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_act', status: 'active', current_end: '2026-10-28T00:00:00.000Z' }] });
    const { srv, headers, razorpay } = await setup({ billing });
    try {
        const res = await fetch(`${srv.url}/api/billing/cancel`, { method: 'POST', headers });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, until: '2026-10-28T00:00:00.000Z' });
        assert.deepEqual(razorpay.log.cancelled, ['sub_act']);
        assert.equal(billing.subs[0].cancel_at_period_end, true);
    } finally { await srv.close(); }
    const none = await setup();
    try {
        assert.equal((await fetch(`${none.srv.url}/api/billing/cancel`, { method: 'POST', headers: none.headers })).status, 400);
    } finally { await none.srv.close(); }
});

test('webhook: bad or missing signature → 400, no change', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_1', status: 'created' }] });
    const { srv } = await setup({ billing });
    try {
        const req = signed(subEvent('subscription.activated', { id: 'sub_1', status: 'active', current_end: 1767225600 }), { secret: 'wrong' });
        assert.equal((await fetch(`${srv.url}/api/billing/webhook`, req)).status, 400);
        const { ['x-razorpay-signature']: _, ...noSig } = req.headers;
        assert.equal((await fetch(`${srv.url}/api/billing/webhook`, { ...req, headers: noSig })).status, 400);
        assert.equal(billing.subs[0].status, 'created');
    } finally { await srv.close(); }
});

test('webhook: activation updates status and current_end; duplicate is a no-op', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_1', status: 'created' }] });
    const { srv } = await setup({ billing });
    try {
        const req = signed(subEvent('subscription.activated', { id: 'sub_1', status: 'active', current_end: 1767225600, short_url: 'https://rzp.io/i/x' }));
        assert.equal((await fetch(`${srv.url}/api/billing/webhook`, req)).status, 200);
        assert.equal(billing.subs[0].status, 'active');
        assert.equal(billing.subs[0].current_end, '2026-01-01T00:00:00.000Z');
        const again = await fetch(`${srv.url}/api/billing/webhook`, req);
        assert.equal(again.status, 200);
        assert.equal((await again.json()).duplicate, true);
        assert.equal(billing.log.updated.length, 1);
    } finally { await srv.close(); }
});

test('webhook: stale event is ignored', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_1', status: 'cancelled', last_event_at: '2026-01-02T00:00:00.000Z' }] });
    const { srv } = await setup({ billing });
    try {
        const older = signed(subEvent('subscription.charged', { id: 'sub_1', status: 'active', current_end: 1769904000 }, 1767225600), { eventId: 'evt_old' });
        assert.equal((await fetch(`${srv.url}/api/billing/webhook`, older)).status, 200);
        assert.equal(billing.subs[0].status, 'cancelled');
    } finally { await srv.close(); }
});

test('webhook: unknown subscription is fetched and inserted; unknown user ignored', async () => {
    const remote = {
        sub_dash: { id: 'sub_dash', status: 'active', current_end: 1767225600, notes: { user_id: OWNER } },
        sub_anon: { id: 'sub_anon', status: 'active', current_end: 1767225600, notes: {} },
    };
    const billing = fakeBilling();
    const { srv } = await setup({ billing, razorpay: fakeRazorpay({ remote }) });
    try {
        const a = signed(subEvent('subscription.activated', { id: 'sub_dash', status: 'active', current_end: 1767225600 }), { eventId: 'evt_a' });
        assert.equal((await fetch(`${srv.url}/api/billing/webhook`, a)).status, 200);
        assert.equal(billing.log.inserted[0].user_id, OWNER);
        assert.equal(billing.log.inserted[0].status, 'active');
        const b = signed(subEvent('subscription.activated', { id: 'sub_anon', status: 'active' }), { eventId: 'evt_b' });
        assert.equal((await fetch(`${srv.url}/api/billing/webhook`, b)).status, 200);
        assert.equal(billing.log.inserted.length, 1);
    } finally { await srv.close(); }
});

test('webhook: non-subscription events are acknowledged and ignored', async () => {
    const { srv, billing } = await setup();
    try {
        const res = await fetch(`${srv.url}/api/billing/webhook`, signed({ event: 'payment.captured', payload: {} }));
        assert.equal(res.status, 200);
        assert.equal(billing.log.updated.length, 0);
    } finally { await srv.close(); }
});

test('webhook: DB failure → 500 and the event is never recorded, so a retry reprocesses it', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_1', status: 'created' }] });
    billing.failUpdate = true;
    const { srv } = await setup({ billing });
    try {
        const req = signed(subEvent('subscription.activated', { id: 'sub_1', status: 'active', current_end: 1767225600 }));
        assert.equal((await fetch(`${srv.url}/api/billing/webhook`, req)).status, 500);
        assert.equal(await billing.hasEvent('evt_1'), false);
        billing.failUpdate = false;
        assert.equal((await fetch(`${srv.url}/api/billing/webhook`, req)).status, 200);
        assert.equal(billing.subs[0].status, 'active');
        assert.equal(await billing.hasEvent('evt_1'), true);
    } finally { await srv.close(); }
});

test('webhook: event with no current_end does not clear a known current_end', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_1', status: 'active', current_end: '2026-01-01T00:00:00.000Z', last_event_at: null }] });
    const { srv } = await setup({ billing });
    try {
        const req = signed(subEvent('subscription.pending', { id: 'sub_1', status: 'pending' }));
        assert.equal((await fetch(`${srv.url}/api/billing/webhook`, req)).status, 200);
        assert.equal(billing.subs[0].status, 'pending');
        assert.equal(billing.subs[0].current_end, '2026-01-01T00:00:00.000Z');
    } finally { await srv.close(); }
});

test('webhook: duplicate event id is a no-op without hitting the DB update path twice', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_1', status: 'created' }] });
    const { srv } = await setup({ billing });
    try {
        const req = signed(subEvent('subscription.activated', { id: 'sub_1', status: 'active', current_end: 1767225600 }), { eventId: 'evt_dup' });
        assert.equal((await fetch(`${srv.url}/api/billing/webhook`, req)).status, 200);
        assert.equal(billing.log.updated.length, 1);
        const again = await fetch(`${srv.url}/api/billing/webhook`, req);
        assert.equal(again.status, 200);
        assert.deepEqual(await again.json(), { ok: true, duplicate: true });
        assert.equal(billing.log.updated.length, 1);
    } finally { await srv.close(); }
});

test('webhook: plan mismatch is ignored but the event is still recorded (dedup on retry)', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_1', status: 'created' }] });
    const { srv } = await setup({ billing });
    try {
        const req = signed(subEvent('subscription.activated', { id: 'sub_1', status: 'active', current_end: 1767225600, plan_id: 'plan_other' }), { eventId: 'evt_plan' });
        const res = await fetch(`${srv.url}/api/billing/webhook`, req);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, ignored: true });
        assert.equal(billing.subs[0].status, 'created');
        const again = await fetch(`${srv.url}/api/billing/webhook`, req);
        assert.deepEqual(await again.json(), { ok: true, duplicate: true });
    } finally { await srv.close(); }
});

test('webhook: unknown subscription not found at Razorpay (404) is terminal — ignored and recorded', async () => {
    const billing = fakeBilling();
    const { srv } = await setup({ billing, razorpay: fakeRazorpay({ remote: {} }) });
    try {
        const req = signed(subEvent('subscription.activated', { id: 'sub_ghost', status: 'active', current_end: 1767225600 }), { eventId: 'evt_404' });
        const res = await fetch(`${srv.url}/api/billing/webhook`, req);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, ignored: true });
        assert.equal(billing.log.inserted.length, 0);
        const again = await fetch(`${srv.url}/api/billing/webhook`, req);
        assert.deepEqual(await again.json(), { ok: true, duplicate: true });
    } finally { await srv.close(); }
});

test('webhook: insert conflict (409) for an unknown subscription is terminal — ignored', async () => {
    const remote = { sub_x: { id: 'sub_x', status: 'active', current_end: 1767225600, notes: { user_id: OWNER } } };
    const billing = fakeBilling();
    billing.insertSubscription = async () => { const err = new Error('duplicate key value violates unique constraint'); err.status = 409; throw err; };
    const { srv } = await setup({ billing, razorpay: fakeRazorpay({ remote }) });
    try {
        const req = signed(subEvent('subscription.activated', { id: 'sub_x', status: 'active', current_end: 1767225600 }), { eventId: 'evt_409' });
        const res = await fetch(`${srv.url}/api/billing/webhook`, req);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, ignored: true });
    } finally { await srv.close(); }
});

test('webhook: malformed JSON body → 400', async () => {
    const { srv } = await setup();
    try {
        const raw = '{not json';
        const res = await fetch(`${srv.url}/api/billing/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-razorpay-event-id': 'evt_bad',
                'x-razorpay-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('hex'),
            },
            body: raw,
        });
        assert.equal(res.status, 400);
    } finally { await srv.close(); }
});

test('webhook: missing x-razorpay-event-id header → 400', async () => {
    const { srv } = await setup();
    try {
        const raw = JSON.stringify(subEvent('subscription.activated', { id: 'sub_1', status: 'active' }));
        const res = await fetch(`${srv.url}/api/billing/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-razorpay-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('hex'),
            },
            body: raw,
        });
        assert.equal(res.status, 400);
    } finally { await srv.close(); }
});

test('cancel: already flagged cancel_at_period_end is a no-op (does not call Razorpay again)', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_act', status: 'active', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: true }] });
    const { srv, headers, razorpay } = await setup({ billing });
    try {
        const res = await fetch(`${srv.url}/api/billing/cancel`, { method: 'POST', headers });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, until: '2026-10-28T00:00:00.000Z' });
        assert.deepEqual(razorpay.log.cancelled, []);
    } finally { await srv.close(); }
});
