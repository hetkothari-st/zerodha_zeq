import crypto from 'node:crypto';

const API = 'https://api.razorpay.com/v1';
// Months a subscription may run before Razorpay stops it; effectively "until cancelled".
const TOTAL_COUNT = 120;

export class RazorpayError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'RazorpayError';
        this.status = status;
    }
}

// Minimal Razorpay REST client (Basic auth: key id + secret). Secrets never appear in errors.
export function createRazorpay({ keyId, keySecret, fetchImpl = fetch, timeoutMs = 8000 }) {
    const authHeader = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

    async function call(path, { method = 'GET', body } = {}) {
        let res;
        try {
            res = await fetchImpl(`${API}${path}`, {
                method,
                headers: { Authorization: authHeader, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            throw new RazorpayError(`razorpay ${method} ${path} network error: ${err.message}`, 0);
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new RazorpayError(`razorpay ${method} ${path} failed: ${res.status} ${data?.error?.description ?? ''}`.trim(), res.status);
        return data;
    }

    return {
        // startAt (unix seconds): when resuming after a cancel, the new subscription must not
        // start (or charge) until the old paid period actually ends.
        createSubscription: ({ planId, userId, startAt }) => call('/subscriptions', {
            method: 'POST',
            body: {
                plan_id: planId, total_count: TOTAL_COUNT, customer_notify: 1, notes: { user_id: userId },
                ...(startAt ? { start_at: startAt } : {}),
            },
        }),
        // atCycleEnd=false (cancel_at_cycle_end: 0) cancels immediately — used for a resumed
        // subscription that hasn't actually started billing yet, where "at cycle end" is
        // meaningless (there is no cycle running); atCycleEnd=true (default) is the normal case.
        cancelSubscription: (id, { atCycleEnd = true } = {}) => call(`/subscriptions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { cancel_at_cycle_end: atCycleEnd ? 1 : 0 } }),
        fetchSubscription: (id) => call(`/subscriptions/${encodeURIComponent(id)}`),
    };
}

export function verifyWebhookSignature(rawBody, signature, secret) {
    if (!secret || typeof signature !== 'string' || !Buffer.isBuffer(rawBody)) return false;
    const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
    const given = Buffer.from(signature);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Razorpay subscription entity → our subscriptions columns.
export function toRow(entity) {
    return {
        razorpay_subscription_id: entity.id,
        status: entity.status,
        current_end: entity.current_end ? new Date(entity.current_end * 1000).toISOString() : null,
        short_url: entity.short_url ?? null,
    };
}
