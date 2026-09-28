import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRazorpay, verifyWebhookSignature, toRow, RazorpayError } from '../server/billing/razorpay.js';

function recorder(responses) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
    };
    return { calls, fetchImpl };
}

test('createSubscription posts plan, notes.user_id and basic auth', async () => {
    const { calls, fetchImpl } = recorder([{ body: { id: 'sub_1', status: 'created' } }]);
    const rz = createRazorpay({ keyId: 'rzp_test_k', keySecret: 's3cret', fetchImpl });
    const sub = await rz.createSubscription({ planId: 'plan_1', userId: 'u1' });
    assert.equal(sub.id, 'sub_1');
    assert.equal(calls[0].url, 'https://api.razorpay.com/v1/subscriptions');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('rzp_test_k:s3cret').toString('base64')}`);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.plan_id, 'plan_1');
    assert.equal(body.notes.user_id, 'u1');
    assert.ok(body.total_count >= 12);
});

test('cancelSubscription cancels at cycle end', async () => {
    const { calls, fetchImpl } = recorder([{ body: { id: 'sub_1', status: 'active' } }]);
    await createRazorpay({ keyId: 'k', keySecret: 's', fetchImpl }).cancelSubscription('sub_1');
    assert.equal(calls[0].url, 'https://api.razorpay.com/v1/subscriptions/sub_1/cancel');
    assert.deepEqual(JSON.parse(calls[0].init.body), { cancel_at_cycle_end: 1 });
});

test('HTTP errors and network errors become RazorpayError', async () => {
    const { fetchImpl } = recorder([{ status: 400, body: { error: { description: 'bad plan' } } }, new Error('ECONNRESET')]);
    const rz = createRazorpay({ keyId: 'k', keySecret: 's', fetchImpl });
    await assert.rejects(rz.fetchSubscription('sub_x'), (e) => e instanceof RazorpayError && e.status === 400 && !e.message.includes('s3cret'));
    await assert.rejects(rz.fetchSubscription('sub_x'), (e) => e instanceof RazorpayError && e.status === 0);
});

test('verifyWebhookSignature: valid, wrong, missing, different length', () => {
    const raw = Buffer.from('{"event":"subscription.activated"}');
    const good = crypto.createHmac('sha256', 'whsec').update(raw).digest('hex');
    assert.equal(verifyWebhookSignature(raw, good, 'whsec'), true);
    assert.equal(verifyWebhookSignature(raw, good.replace(/.$/, good.endsWith('0') ? '1' : '0'), 'whsec'), false);
    assert.equal(verifyWebhookSignature(raw, undefined, 'whsec'), false);
    assert.equal(verifyWebhookSignature(raw, 'abc', 'whsec'), false);
    assert.equal(verifyWebhookSignature(raw, good, ''), false);
});

test('toRow maps unix seconds to ISO and keeps short_url', () => {
    assert.deepEqual(toRow({ id: 'sub_1', status: 'active', current_end: 1767225600, short_url: 'https://rzp.io/i/x' }), {
        razorpay_subscription_id: 'sub_1', status: 'active', current_end: '2026-01-01T00:00:00.000Z', short_url: 'https://rzp.io/i/x',
    });
    assert.equal(toRow({ id: 'sub_2', status: 'created', current_end: null }).current_end, null);
});
