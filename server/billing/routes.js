import express from 'express';
import { sendError } from '../auth/errors.js';
import { wrap } from '../auth/middleware.js';
import { toRow, verifyWebhookSignature } from './razorpay.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANCELLABLE = new Set(['authenticated', 'active', 'pending']);
// A subscription past 'created' but not yet terminal: the user has already paid (or is mid
// mandate) and a webhook just hasn't caught the local row up yet. Must never be expired.
const OPEN_PROGRESSED = new Set(['authenticated', 'active', 'pending']);

export function createBillingRouter({ auth, billing, razorpay, planId, keyId, webhookSecret, priceLabel = '' }) {
    const router = express.Router();

    router.get('/api/billing/status', ...auth.requireUser, wrap(async (req, res) => {
        try {
            const [ent, sub] = await Promise.all([billing.entitlement(req.auth.userId), billing.latestSubscription(req.auth.userId)]);
            res.json({
                plan: ent.plan, source: ent.source ?? null, until: ent.until ?? null,
                status: sub?.status ?? null,
                cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
                manageUrl: sub?.short_url ?? null,
                priceLabel,
            });
        } catch (err) {
            console.error('[billing] status failed:', err.message);
            sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
        }
    }));

    router.post('/api/billing/subscribe', ...auth.requireUser, wrap(async (req, res) => {
        const userId = req.auth.userId;
        let ent, open;
        try {
            [ent, open] = await Promise.all([billing.entitlement(userId), billing.openSubscription(userId)]);
        } catch (err) {
            console.error('[billing] subscribe lookup failed:', err.message);
            return sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
        }
        if (ent.plan === 'pro') return sendError(res, 'conflict', 'You already have Pro.');

        if (open?.status === 'created') {
            // The local row may be stale: gone at Razorpay, for a different plan (e.g. plan
            // changed since it was created), or already moved past 'created' there. Check
            // before handing it back so we never resurrect a dead checkout.
            let remote = null;
            try {
                remote = await razorpay.fetchSubscription(open.razorpay_subscription_id);
            } catch (err) {
                if (err.status !== 404) {
                    console.error('[billing] subscribe: fetchSubscription failed:', err.message);
                    return sendError(res, 'payments_unavailable');
                }
                remote = null; // 404: gone at Razorpay — stale, fall through to expire + recreate
            }

            if (remote?.plan_id === planId && OPEN_PROGRESSED.has(remote.status)) {
                // The user already paid (or is mid-mandate) and the webhook that would have
                // caught the local row up just hasn't arrived yet: never expire this — sync it
                // from Razorpay's copy and make the client wait, don't create a second subscription.
                const { razorpay_subscription_id: _id, ...fields } = toRow(remote);
                if (fields.current_end === null) delete fields.current_end;
                try {
                    await billing.updateSubscription(open.razorpay_subscription_id, fields);
                } catch (err) {
                    console.error('[billing] subscribe: syncing progressed row failed:', err.message);
                    return sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
                }
                return sendError(res, 'conflict', 'Your subscription is being activated. Refresh in a minute.');
            }

            const reusable = remote?.plan_id === planId && remote.status === 'created';
            if (reusable) return res.json({ subscriptionId: open.razorpay_subscription_id, keyId });

            // Stale: gone at Razorpay (404), a different plan, or already terminal there
            // (cancelled, completed, expired, halted).
            try {
                await billing.updateSubscription(open.razorpay_subscription_id, { status: 'expired' });
            } catch (err) {
                console.error('[billing] subscribe: expiring stale row failed:', err.message);
                return sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
            }
            open = null; // continue below to create a fresh subscription
        }
        if (open) return sendError(res, 'conflict', 'Your subscription is being activated. Refresh in a minute.');

        let sub;
        try {
            sub = await razorpay.createSubscription({ planId, userId });
        } catch (err) {
            console.error('[billing] razorpay create failed:', err.message);
            return sendError(res, 'payments_unavailable');
        }
        try {
            await billing.insertSubscription(userId, toRow(sub));
        } catch (err) {
            // Another request (double click, second tab) inserted first: hand back its subscription.
            const winner = await billing.openSubscription(userId).catch(() => null);
            if (winner?.status === 'created') return res.json({ subscriptionId: winner.razorpay_subscription_id, keyId });
            console.error('[billing] subscription insert failed:', err.message);
            return sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
        }
        res.json({ subscriptionId: sub.id, keyId });
    }));

    router.post('/api/billing/cancel', ...auth.requireUser, wrap(async (req, res) => {
        let open;
        try {
            open = await billing.openSubscription(req.auth.userId);
        } catch (err) {
            console.error('[billing] cancel lookup failed:', err.message);
            return sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
        }
        if (!open || !CANCELLABLE.has(open.status)) return sendError(res, 'bad_request', 'No active subscription to cancel.');
        if (open.cancel_at_period_end) return res.json({ ok: true, until: open.current_end ?? null });
        try {
            await razorpay.cancelSubscription(open.razorpay_subscription_id);
        } catch (err) {
            console.error('[billing] razorpay cancel failed:', err.message);
            return sendError(res, 'payments_unavailable');
        }
        try {
            await billing.updateSubscription(open.razorpay_subscription_id, { cancel_at_period_end: true });
        } catch (err) {
            // Razorpay already cancelled; the subscription.cancelled webhook will catch us up.
            console.error('[billing] cancel flag write failed:', err.message);
        }
        res.json({ ok: true, until: open.current_end ?? null });
    }));

    router.post('/api/billing/webhook', wrap(async (req, res) => {
        const raw = req.body;
        if (!verifyWebhookSignature(raw, req.get('x-razorpay-signature'), webhookSecret)) {
            return sendError(res, 'bad_request', 'Invalid signature.');
        }
        let event;
        try {
            event = JSON.parse(raw.toString('utf8'));
        } catch {
            return sendError(res, 'bad_request', 'Malformed JSON.');
        }
        const eventId = req.get('x-razorpay-event-id');
        if (!eventId) return sendError(res, 'bad_request', 'Missing event id.');
        const entity = event?.payload?.subscription?.entity;
        if (!String(event?.event || '').startsWith('subscription.') || !entity?.id) return res.json({ ok: true, ignored: true });

        // The event is recorded only once processing reaches a definitive outcome (success,
        // stale, or a terminal/poison condition) — never on a transient failure, so Razorpay's
        // retry reprocesses it instead of getting stuck as a permanently-skipped duplicate.
        const recordProcessed = async () => {
            try {
                await billing.recordEvent(eventId);
            } catch (err) {
                console.error(`[billing] recordEvent failed for event ${eventId} (sub ${entity.id}):`, err.message);
            }
        };

        let duplicate;
        try {
            duplicate = await billing.hasEvent(eventId);
        } catch (err) {
            console.error('[billing] event lookup failed:', err.message);
            return sendError(res, 'internal');
        }
        if (duplicate) return res.json({ ok: true, duplicate: true });

        // Poison guard: a webhook for a different plan than the one this router serves should
        // never be applied here; it is a permanent mismatch, not something a retry will fix.
        if (entity.plan_id && entity.plan_id !== planId) {
            console.warn(`[billing] webhook for ${entity.id} targets plan ${entity.plan_id}, not ${planId}; ignored`);
            await recordProcessed();
            return res.json({ ok: true, ignored: true });
        }

        const eventAt = new Date((Number(event.created_at) || Math.floor(Date.now() / 1000)) * 1000).toISOString();

        let existing;
        try {
            existing = await billing.getSubscription(entity.id);
        } catch (err) {
            console.error(`[billing] webhook lookup failed for ${entity.id}:`, err.message);
            return sendError(res, 'internal');
        }

        if (existing) {
            const { razorpay_subscription_id: _id, ...fields } = toRow(entity);
            if (fields.current_end === null) delete fields.current_end; // never overwrite a known current_end with an unknown one
            let updated;
            try {
                updated = await billing.updateSubscription(entity.id, { ...fields, last_event_at: eventAt }, { notAfter: eventAt });
            } catch (err) {
                if (err.status === 409) {
                    // One-open-subscription-per-user unique violation: an old halted/cancelled
                    // subscription for this user was revived by this event while a newer one is
                    // already open. This will never resolve on retry — terminal, not a DB blip.
                    console.error(`[billing] CONFLICT updating subscription ${entity.id} for user ${existing.user_id} (event ${eventId}): ${err.message}`);
                    await recordProcessed();
                    return res.json({ ok: true, ignored: true, conflict: true });
                }
                console.error(`[billing] webhook update failed for ${entity.id}:`, err.message);
                return sendError(res, 'internal');
            }
            await recordProcessed();
            if (!updated) return res.json({ ok: true, stale: true });
            return res.json({ ok: true });
        }

        // No local row (insert failed, or created outside the app): trust Razorpay's copy.
        let remote;
        try {
            remote = await razorpay.fetchSubscription(entity.id);
        } catch (err) {
            if (err.status === 404) {
                // Razorpay has no record of it either — this will never resolve on retry.
                console.error(`[billing] webhook for unknown subscription ${entity.id}: not found at Razorpay (terminal, ignoring)`);
                await recordProcessed();
                return res.json({ ok: true, ignored: true });
            }
            console.error(`[billing] webhook fetchSubscription failed for ${entity.id}:`, err.message);
            return sendError(res, 'internal');
        }
        const userId = remote?.notes?.user_id;
        if (!UUID.test(String(userId || ''))) {
            console.warn(`[billing] webhook for ${entity.id} has no user; ignored`);
            await recordProcessed();
            return res.json({ ok: true, ignored: true });
        }
        try {
            await billing.insertSubscription(userId, { ...toRow(remote), last_event_at: eventAt });
        } catch (err) {
            if (err.status === 409) {
                // Row already exists (FK/unique conflict) — a concurrent insert won; nothing to retry.
                console.error(`[billing] webhook insert for ${entity.id} conflicted (409, terminal, ignoring): ${err.message}`);
                await recordProcessed();
                return res.json({ ok: true, ignored: true });
            }
            console.error(`[billing] webhook insertSubscription failed for ${entity.id}:`, err.message);
            return sendError(res, 'internal');
        }
        await recordProcessed();
        res.json({ ok: true });
    }));

    return router;
}
