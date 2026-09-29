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

const OPEN_STATUSES = ['created', 'authenticated', 'active', 'pending'];

function fakeBilling({ ent = { plan: 'free', source: null, until: null }, subs = [] } = {}) {
    const events = new Set();
    const log = { inserted: [], updated: [] };
    const calls = { openSubscription: 0, scheduledCancel: 0, openRows: 0 };
    const store = {
        log, subs, calls,
        entitlement: async () => ent,
        latestSubscription: async (uid) => subs.filter((s) => s.user_id === uid).at(-1) ?? null,
        openSubscription: async (uid) => {
            calls.openSubscription += 1;
            return subs.find((s) => s.user_id === uid && OPEN_STATUSES.includes(s.status) && !s.cancel_at_period_end) ?? null;
        },
        // Mirrors the real store: only rows with a non-null current_end are eligible, and the
        // one with the latest current_end wins (not just the latest by array/created_at order).
        scheduledCancel: async (uid) => {
            calls.scheduledCancel += 1;
            const rows = subs.filter((s) => s.user_id === uid && OPEN_STATUSES.includes(s.status) && s.cancel_at_period_end && s.current_end);
            return rows.length ? rows.reduce((best, r) => (Date.parse(r.current_end) > Date.parse(best.current_end) ? r : best)) : null;
        },
        openRows: async (uid) => {
            calls.openRows += 1;
            return subs.filter((s) => s.user_id === uid && OPEN_STATUSES.includes(s.status));
        },
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
    const log = { created: [], cancelled: [], fetched: [] };
    return {
        log,
        createSubscription: async ({ planId, userId, startAt }) => {
            if (fail) throw new RazorpayError('down', 0);
            log.created.push({ planId, userId, ...(startAt !== undefined ? { startAt } : {}) });
            return { id: `sub_new${log.created.length}`, status: 'created', current_end: null, short_url: 'https://rzp.io/i/new' };
        },
        cancelSubscription: async (id, { atCycleEnd = true } = {}) => {
            if (fail) throw new RazorpayError('down', 0);
            log.cancelled.push({ id, atCycleEnd });
            return { id, status: 'active' };
        },
        fetchSubscription: async (id) => {
            log.fetched.push(id);
            if (!remote[id]) throw new RazorpayError('not found', 404);
            return remote[id];
        },
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
        assert.deepEqual(await res.json(), { plan: 'free', source: null, until: null, status: null, cancelAtPeriodEnd: false, manageUrl: null, priceLabel: '₹499/month', resumable: false });
        assert.equal((await fetch(`${srv.url}/api/billing/status`)).status, 401);
    } finally { await srv.close(); }
});

test('status: resumable is true only when Pro via subscription has a scheduled cancellation and no newer open row', async () => {
    const cancelled = await setup({ billing: fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z' },
        subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'active', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: true }],
    }) });
    try {
        const body = await (await fetch(`${cancelled.srv.url}/api/billing/status`, { headers: cancelled.headers })).json();
        assert.equal(body.resumable, true);
        assert.equal(body.cancelAtPeriodEnd, true);
    } finally { await cancelled.srv.close(); }

    const active = await setup({ billing: fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z' },
        subs: [{ user_id: USER, razorpay_subscription_id: 'sub_act', status: 'active', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: false }],
    }) });
    try {
        const body = await (await fetch(`${active.srv.url}/api/billing/status`, { headers: active.headers })).json();
        assert.equal(body.resumable, false);
    } finally { await active.srv.close(); }

    const comp = await setup({ billing: fakeBilling({ ent: { plan: 'pro', source: 'comp', until: null } }) });
    try {
        const body = await (await fetch(`${comp.srv.url}/api/billing/status`, { headers: comp.headers })).json();
        assert.equal(body.resumable, false);
    } finally { await comp.srv.close(); }
});

// I4: the OLD scheduled-cancel row is the one actually granting Pro access while the new
// 'created' row is still unauthenticated (an abandoned or in-progress resume) — display must
// derive from that row, not the fresh 'created' one `latestSubscription` happens to pick up.
test('status: an abandoned/in-progress resume (open row is still "created", scheduled row exists) displays as Cancelled + Resume, not as a live renewal', async () => {
    const billing = fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z' },
        subs: [
            { user_id: USER, razorpay_subscription_id: 'sub_old', status: 'active', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: true },
            { user_id: USER, razorpay_subscription_id: 'sub_new', status: 'created', cancel_at_period_end: false },
        ],
    });
    const { srv, headers } = await setup({ billing });
    try {
        const body = await (await fetch(`${srv.url}/api/billing/status`, { headers })).json();
        assert.equal(body.resumable, true);
        assert.equal(body.cancelAtPeriodEnd, true);
    } finally { await srv.close(); }
});

// Minor 2: same 10-minute grace constant as C1 — resuming (or displaying Resume) when the old
// period is about to lapse anyway is pointless and confusing.
test('status: resumable is false when the scheduled cancellation ends in under 10 minutes, even with no open row', async () => {
    const billing = fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: '2026-09-29T00:05:00.000Z' },
        subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'active', current_end: new Date(Date.now() + 5 * 60000).toISOString(), cancel_at_period_end: true }],
    });
    const { srv, headers } = await setup({ billing });
    try {
        const body = await (await fetch(`${srv.url}/api/billing/status`, { headers })).json();
        assert.equal(body.resumable, false);
    } finally { await srv.close(); }
});

// Minor 4: status derives open+scheduled from one combined query (openRows), not the two
// separate store calls subscribe/cancel use.
test('status: derives open/scheduled from one openRows query, not openSubscription+scheduledCancel', async () => {
    const billing = fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z' },
        subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'active', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: true }],
    });
    const { srv, headers } = await setup({ billing });
    try {
        const body = await (await fetch(`${srv.url}/api/billing/status`, { headers })).json();
        assert.equal(body.resumable, true);
        assert.equal(billing.calls.openRows, 1);
        assert.equal(billing.calls.openSubscription, 0);
        assert.equal(billing.calls.scheduledCancel, 0);
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
    const remote = { sub_old: { id: 'sub_old', status: 'created', plan_id: 'plan_1' } };
    const { srv, headers, razorpay } = await setup({ billing, razorpay: fakeRazorpay({ remote }) });
    try {
        const body = await (await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers })).json();
        assert.equal(body.subscriptionId, 'sub_old');
        assert.equal(razorpay.log.created.length, 0);
    } finally { await srv.close(); }
});

test('subscribe: reused open row gone at Razorpay (404) is expired locally, then a new one is created', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'created' }] });
    const { srv, headers, razorpay } = await setup({ billing, razorpay: fakeRazorpay({ remote: {} }) });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).subscriptionId, 'sub_new1');
        assert.equal(billing.subs.find((s) => s.razorpay_subscription_id === 'sub_old').status, 'expired');
        assert.equal(razorpay.log.created.length, 1);
    } finally { await srv.close(); }
});

test('subscribe: reused open row is for a different plan is expired locally, then a new one is created', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'created' }] });
    const remote = { sub_old: { id: 'sub_old', status: 'created', plan_id: 'plan_other' } };
    const { srv, headers } = await setup({ billing, razorpay: fakeRazorpay({ remote }) });
    try {
        const body = await (await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers })).json();
        assert.equal(body.subscriptionId, 'sub_new1');
        assert.equal(billing.subs.find((s) => s.razorpay_subscription_id === 'sub_old').status, 'expired');
    } finally { await srv.close(); }
});

test('subscribe: reused open row already terminal at Razorpay (e.g. halted) is expired locally, then a new one is created', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'created' }] });
    const remote = { sub_old: { id: 'sub_old', status: 'halted', plan_id: 'plan_1' } };
    const { srv, headers, razorpay } = await setup({ billing, razorpay: fakeRazorpay({ remote }) });
    try {
        const body = await (await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers })).json();
        assert.equal(body.subscriptionId, 'sub_new1');
        assert.equal(billing.subs.find((s) => s.razorpay_subscription_id === 'sub_old').status, 'expired');
        assert.equal(razorpay.log.created.length, 1);
    } finally { await srv.close(); }
});

// Follow-up fix (A, money-safety): a reused row that has already progressed past 'created'
// (authenticated/active/pending) at Razorpay means the user already paid — a webhook just
// hasn't caught the local row up yet. Must never be expired or replaced by a second subscription.
test('subscribe: reused open row already paid at Razorpay (progressed, not terminal) is synced, not expired — 409, no new subscription', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'created' }] });
    const remote = { sub_old: { id: 'sub_old', status: 'active', plan_id: 'plan_1', current_end: 1767225600, short_url: 'https://rzp.io/i/old' } };
    const { srv, headers, razorpay } = await setup({ billing, razorpay: fakeRazorpay({ remote }) });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 409);
        assert.equal(billing.subs[0].razorpay_subscription_id, 'sub_old');
        assert.equal(billing.subs[0].status, 'active');
        assert.equal(billing.subs[0].current_end, '2026-01-01T00:00:00.000Z');
        assert.equal(billing.subs[0].short_url, 'https://rzp.io/i/old');
        assert.equal(razorpay.log.created.length, 0);
    } finally { await srv.close(); }
});

test('subscribe: fetchSubscription transient failure (Razorpay down) on a reused row → 503, row untouched', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'created' }] });
    const razorpay = fakeRazorpay();
    razorpay.fetchSubscription = async () => { throw new RazorpayError('down', 0); };
    const { srv, headers } = await setup({ billing, razorpay });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 503);
        assert.equal((await res.json()).message, 'Payments unavailable, try later.');
        assert.equal(billing.subs[0].status, 'created');
    } finally { await srv.close(); }
});

test('subscribe: fetchSubscription 5xx failure on a reused row → 503, row untouched', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'created' }] });
    const razorpay = fakeRazorpay();
    razorpay.fetchSubscription = async () => { throw new RazorpayError('server error', 502); };
    const { srv, headers } = await setup({ billing, razorpay });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 503);
        assert.equal(billing.subs[0].status, 'created');
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

// Resume Pro after cancelling: cancel_at_cycle_end keeps our row 'active' with
// cancel_at_period_end=true (and the user Pro/subscription) until the paid period ends. Before
// this, /subscribe always 409'd for any Pro user, so there was no way to undo the cancel.
test('subscribe: resume — no open row, a scheduled cancellation still in its paid period → creates a new subscription starting when the old period ends', async () => {
    const billing = fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z' },
        subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'active', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: true }],
    });
    const { srv, headers, billing: b, razorpay } = await setup({ billing });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 200);
        // Minor 5: no unused/inconsistent `resume` flag on the response.
        assert.deepEqual(await res.json(), { subscriptionId: 'sub_new1', keyId: 'rzp_test_k' });
        assert.equal(razorpay.log.created[0].startAt, Math.floor(Date.parse('2026-10-28T00:00:00.000Z') / 1000));
        assert.equal(b.log.inserted[0].status, 'created');
        // I2: the new row's current_end is pre-filled from the old row's, so entitlement()
        // never sees a gap between the old grant lapsing and the new row's own webhook landing.
        assert.equal(b.log.inserted[0].current_end, '2026-10-28T00:00:00.000Z');
        // the old scheduled-cancel row is untouched: it keeps Pro access until current_end.
        assert.equal(billing.subs.find((s) => s.razorpay_subscription_id === 'sub_old').status, 'active');
    } finally { await srv.close(); }
});

// C1 (critical, money-safety): an abandoned/duplicate resume attempt's 'created' row can be
// found stale by the reuse logic below (404 / plan mismatch / terminal at Razorpay). The
// fall-through create must still carry the resume's startAt — otherwise it charges immediately,
// mid the paid-for period the OLD row already covers.
test('C1: resume — open created row is stale at Razorpay → fallback create still gets startAt (no immediate charge)', async () => {
    const billing = fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z' },
        subs: [
            { user_id: USER, razorpay_subscription_id: 'sub_old', status: 'active', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: true },
            { user_id: USER, razorpay_subscription_id: 'sub_stale', status: 'created', cancel_at_period_end: false },
        ],
    });
    // remote: {} → sub_stale is 404 at Razorpay → stale → expired locally, then recreated.
    const { srv, headers, razorpay } = await setup({ billing, razorpay: fakeRazorpay({ remote: {} }) });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { subscriptionId: 'sub_new1', keyId: 'rzp_test_k' });
        assert.equal(razorpay.log.created.length, 1);
        assert.equal(razorpay.log.created[0].startAt, Math.floor(Date.parse('2026-10-28T00:00:00.000Z') / 1000));
        assert.equal(billing.subs.find((s) => s.razorpay_subscription_id === 'sub_stale').status, 'expired');
        assert.equal(billing.log.inserted[0].current_end, '2026-10-28T00:00:00.000Z');
    } finally { await srv.close(); }
});

// I4 (folded into the reuse check): a 'created' row whose remote start_at has already lapsed is
// not safely reusable either — reusing it would mean Razorpay charges as soon as it's
// authenticated, defeating the whole point of a delayed resume start.
test('I4: reused created row is treated as stale when its remote start_at is already in the past', async () => {
    const billing = fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z' },
        subs: [
            { user_id: USER, razorpay_subscription_id: 'sub_old', status: 'active', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: true },
            { user_id: USER, razorpay_subscription_id: 'sub_past_start', status: 'created', cancel_at_period_end: false },
        ],
    });
    const remote = { sub_past_start: { id: 'sub_past_start', status: 'created', plan_id: 'plan_1', start_at: Math.floor(Date.now() / 1000) - 3600 } };
    const { srv, headers, razorpay } = await setup({ billing, razorpay: fakeRazorpay({ remote }) });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).subscriptionId, 'sub_new1');
        assert.equal(razorpay.log.created[0].startAt, Math.floor(Date.parse('2026-10-28T00:00:00.000Z') / 1000));
        assert.equal(billing.subs.find((s) => s.razorpay_subscription_id === 'sub_past_start').status, 'expired');
    } finally { await srv.close(); }
});

// m1: without a scheduled-cancel row at all, a Pro/subscription user must never reach the
// reuse/fallback logic below — that logic's fallback create has no resume context to delay a
// charge with, so it must be unreachable for Pro, not merely rare.
test('m1: subscribe — Pro/subscription, an open "created" row but no scheduled-cancel row → 409 before any reuse/fallback logic runs', async () => {
    const billing = fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: null },
        subs: [{ user_id: USER, razorpay_subscription_id: 'sub_leftover', status: 'created', cancel_at_period_end: false }],
    });
    const remote = { sub_leftover: { id: 'sub_leftover', status: 'created', plan_id: 'plan_1' } }; // would otherwise be reusable
    const { srv, headers, razorpay } = await setup({ billing, razorpay: fakeRazorpay({ remote }) });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 409);
        assert.equal((await res.json()).message, 'You already have Pro.');
        // Never even looked at Razorpay's copy of the leftover row, let alone created a new one.
        assert.equal(razorpay.log.fetched.length, 0);
        assert.equal(razorpay.log.created.length, 0);
    } finally { await srv.close(); }
});

// m2: Razorpay may fill a normal (non-resume) subscription's start_at with its creation time,
// which is trivially "in the past" moments later — that must never make a Free user's ordinary
// reused row look stale. The past-start_at staleness check is a resume-only safeguard (m2/I4).
test('m2: Free subscribe — a reused created row is still reused even when its remote start_at is already in the past', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'created' }] }); // ent defaults to free
    const remote = { sub_old: { id: 'sub_old', status: 'created', plan_id: 'plan_1', start_at: Math.floor(Date.now() / 1000) - 3600 } };
    const { srv, headers, razorpay } = await setup({ billing, razorpay: fakeRazorpay({ remote }) });
    try {
        const body = await (await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers })).json();
        assert.equal(body.subscriptionId, 'sub_old');
        assert.equal(razorpay.log.created.length, 0);
        assert.equal(billing.subs.find((s) => s.razorpay_subscription_id === 'sub_old').status, 'created');
    } finally { await srv.close(); }
});

// C1: when the scheduled row itself is about to lapse (< 10 min), don't resume with a
// near-immediate/past startAt — tell the user to wait instead.
test('C1: subscribe — scheduled cancellation ends in under 10 minutes → 409 "ends shortly", no subscription created', async () => {
    const billing = fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: '2026-09-29T00:05:00.000Z' },
        subs: [{ user_id: USER, razorpay_subscription_id: 'sub_old', status: 'active', current_end: new Date(Date.now() + 5 * 60000).toISOString(), cancel_at_period_end: true }],
    });
    const { srv, headers, razorpay } = await setup({ billing });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 409);
        assert.equal((await res.json()).message, 'Your Pro ends shortly — subscribe again once it ends.');
        assert.equal(razorpay.log.created.length, 0);
    } finally { await srv.close(); }
});

test('subscribe: resume — a new created row already exists (double click) reuses it instead of creating another', async () => {
    const remote = { sub_new_click: { id: 'sub_new_click', status: 'created', plan_id: 'plan_1' } };
    const billing = fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z' },
        subs: [
            { user_id: USER, razorpay_subscription_id: 'sub_old', status: 'active', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: true },
            { user_id: USER, razorpay_subscription_id: 'sub_new_click', status: 'created', cancel_at_period_end: false },
        ],
    });
    const { srv, headers, razorpay } = await setup({ billing, razorpay: fakeRazorpay({ remote }) });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { subscriptionId: 'sub_new_click', keyId: 'rzp_test_k' });
        assert.equal(razorpay.log.created.length, 0);
    } finally { await srv.close(); }
});

test('subscribe: comp Pro → 409 (no resume path for non-subscription sources)', async () => {
    const { srv, headers } = await setup({ billing: fakeBilling({ ent: { plan: 'pro', source: 'comp', until: null } }) });
    try {
        assert.equal((await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers })).status, 409);
    } finally { await srv.close(); }
});

test('subscribe: admin Pro → 409 (no resume path for non-subscription sources)', async () => {
    const { srv, headers } = await setup({ billing: fakeBilling({ ent: { plan: 'pro', source: 'admin', until: null } }) });
    try {
        assert.equal((await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers })).status, 409);
    } finally { await srv.close(); }
});

// Minor 1: a real, non-cancelling open row (status !== 'created') means genuinely already Pro —
// assert the exact message, not just the status code.
test('Minor 1: subscribe — active, not cancelled (real open row, no scheduled-cancel row) → 409 "You already have Pro."', async () => {
    const billing = fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z' },
        subs: [{ user_id: USER, razorpay_subscription_id: 'sub_act', status: 'active', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: false }],
    });
    const { srv, headers } = await setup({ billing });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 409);
        assert.equal((await res.json()).message, 'You already have Pro.');
    } finally { await srv.close(); }
});

test('subscribe: Pro/subscription, no open row and no scheduled-cancel row → 409 "You already have Pro." (nothing to resume)', async () => {
    const billing = fakeBilling({
        ent: { plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z' },
        subs: [],
    });
    const { srv, headers } = await setup({ billing });
    try {
        const res = await fetch(`${srv.url}/api/billing/subscribe`, { method: 'POST', headers });
        assert.equal(res.status, 409);
        assert.equal((await res.json()).message, 'You already have Pro.');
    } finally { await srv.close(); }
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
        assert.deepEqual(razorpay.log.cancelled, [{ id: 'sub_act', atCycleEnd: true }]);
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

test('webhook: existing-row update conflict (409, one-open-per-user violation) is terminal — ignored', async () => {
    const billing = fakeBilling({ subs: [{ user_id: USER, razorpay_subscription_id: 'sub_1', status: 'halted' }] });
    billing.updateSubscription = async () => { const err = new Error('duplicate key value violates unique constraint "one_open_subscription_per_user"'); err.status = 409; throw err; };
    const { srv } = await setup({ billing });
    try {
        const req = signed(subEvent('subscription.activated', { id: 'sub_1', status: 'active', current_end: 1767225600 }), { eventId: 'evt_update_conflict' });
        const res = await fetch(`${srv.url}/api/billing/webhook`, req);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, ignored: true, conflict: true });
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

// I1: cancelling a resumed subscription that hasn't actually started billing yet — nothing is
// running to "let finish a cycle", and the OLD scheduled-cancel row is what still covers Pro
// until its own current_end either way, so cancel it immediately (cancel_at_cycle_end: 0).
// N1: every resume sets Razorpay's start_at = the old scheduled row's current_end, so whether
// the resumed subscription has actually started is fully decided by comparing
// scheduled.current_end to now — no need to ask Razorpay at all, and a failing/slow
// razorpay.fetchSubscription must have zero effect on this decision.
test('N1: cancel — resumed row not yet started (scheduled.current_end still future) → immediate cancel, decided locally (razorpay.fetchSubscription is never consulted)', async () => {
    const billing = fakeBilling({
        subs: [
            { user_id: USER, razorpay_subscription_id: 'sub_old', status: 'active', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: true },
            { user_id: USER, razorpay_subscription_id: 'sub_resumed', status: 'authenticated', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: false },
        ],
    });
    const razorpay = fakeRazorpay();
    razorpay.fetchSubscription = async () => { throw new RazorpayError('down', 0); }; // must have no effect
    const { srv, headers } = await setup({ billing, razorpay });
    try {
        const res = await fetch(`${srv.url}/api/billing/cancel`, { method: 'POST', headers });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, until: '2026-10-28T00:00:00.000Z' });
        assert.deepEqual(razorpay.log.cancelled, [{ id: 'sub_resumed', atCycleEnd: false }]);
        assert.equal(billing.subs.find((s) => s.razorpay_subscription_id === 'sub_resumed').cancel_at_period_end, true);
    } finally { await srv.close(); }
});

test('N1: cancel — resumed row already past its scheduled start time (scheduled.current_end in the past) → normal at-cycle-end cancel', async () => {
    const billing = fakeBilling({
        subs: [
            { user_id: USER, razorpay_subscription_id: 'sub_old', status: 'active', current_end: new Date(Date.now() - 3600000).toISOString(), cancel_at_period_end: true },
            { user_id: USER, razorpay_subscription_id: 'sub_resumed', status: 'authenticated', current_end: '2026-11-28T00:00:00.000Z', cancel_at_period_end: false },
        ],
    });
    const { srv, headers, razorpay } = await setup({ billing });
    try {
        const res = await fetch(`${srv.url}/api/billing/cancel`, { method: 'POST', headers });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, until: '2026-11-28T00:00:00.000Z' });
        assert.deepEqual(razorpay.log.cancelled, [{ id: 'sub_resumed', atCycleEnd: true }]);
    } finally { await srv.close(); }
});

test('I1: cancel — a normal (non-resumed) active subscription still cancels at cycle end', async () => {
    const billing = fakeBilling({
        subs: [{ user_id: USER, razorpay_subscription_id: 'sub_act', status: 'active', current_end: '2026-10-28T00:00:00.000Z', cancel_at_period_end: false }],
    });
    const { srv, headers, razorpay } = await setup({ billing });
    try {
        const res = await fetch(`${srv.url}/api/billing/cancel`, { method: 'POST', headers });
        assert.equal(res.status, 200);
        assert.deepEqual(razorpay.log.cancelled, [{ id: 'sub_act', atCycleEnd: true }]);
    } finally { await srv.close(); }
});
