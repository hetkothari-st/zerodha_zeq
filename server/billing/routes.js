import express from 'express';
import { sendError } from '../auth/errors.js';
import { wrap } from '../auth/middleware.js';
import { toRow, verifyWebhookSignature } from './razorpay.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANCELLABLE = new Set(['authenticated', 'active', 'pending']);
// A subscription past 'created' but not yet terminal: the user has already paid (or is mid
// mandate) and a webhook just hasn't caught the local row up yet. Must never be expired.
const OPEN_PROGRESSED = new Set(['authenticated', 'active', 'pending']);
// A scheduled-cancel row (still Pro via source 'subscription') needs to grant enough runway to
// actually complete a resume checkout before it lapses; below this, offering/serving a resume
// just produces a startAt that's already past (or about to be) by the time Razorpay processes it.
const RESUME_GRACE_MS = 10 * 60 * 1000;

// From all open-status rows for a user (newest first), pick the one non-cancelling row ("open",
// same row store.openSubscription would return) and the cancel-scheduled row with the latest
// non-null current_end ("scheduled", same row store.scheduledCancel would return) — one query
// instead of two, for callers (the status route) that need both.
function deriveOpenAndScheduled(rows) {
    const open = rows.find((r) => !r.cancel_at_period_end) ?? null;
    let scheduled = null;
    for (const r of rows) {
        if (!r.cancel_at_period_end || !r.current_end) continue;
        if (!scheduled || Date.parse(r.current_end) > Date.parse(scheduled.current_end)) scheduled = r;
    }
    return { open, scheduled };
}

// Whether a scheduled-cancel row still gives enough runway to resume against (see RESUME_GRACE_MS).
function scheduledIsUsable(scheduled) {
    if (!scheduled?.current_end) return false;
    const ms = Date.parse(scheduled.current_end);
    return Number.isFinite(ms) && ms > Date.now() + RESUME_GRACE_MS;
}

export function createBillingRouter({ auth, billing, razorpay, planId, keyId, webhookSecret, priceLabel = '' }) {
    const router = express.Router();

    router.get('/api/billing/status', ...auth.requireUser, wrap(async (req, res) => {
        try {
            const userId = req.auth.userId;
            const [ent, sub] = await Promise.all([billing.entitlement(userId), billing.latestSubscription(userId)]);
            // resumable / cancelAtPeriodEnd: Pro via subscription only — free/comp/admin can
            // never resume, so skip the extra query for them.
            let resumable = false;
            let cancelAtPeriodEnd = Boolean(sub?.cancel_at_period_end);
            if (ent.source === 'subscription') {
                const { open, scheduled } = deriveOpenAndScheduled(await billing.openRows(userId));
                const usable = scheduledIsUsable(scheduled);
                if (open?.status === 'created' && scheduled) {
                    // Abandoned/in-progress resume: the OLD scheduled row is what's actually
                    // granting access right now, not the fresh (unauthenticated) 'created' row
                    // `latestSubscription` may have picked up — display must reflect that.
                    resumable = usable;
                    cancelAtPeriodEnd = true;
                } else {
                    resumable = usable && !open;
                }
            }
            res.json({
                plan: ent.plan, source: ent.source ?? null, until: ent.until ?? null,
                status: sub?.status ?? null,
                cancelAtPeriodEnd,
                manageUrl: sub?.short_url ?? null,
                priceLabel,
                resumable,
            });
        } catch (err) {
            console.error('[billing] status failed:', err.message);
            sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
        }
    }));

    router.post('/api/billing/subscribe', ...auth.requireUser, wrap(async (req, res) => {
        const userId = req.auth.userId;
        let ent;
        try {
            ent = await billing.entitlement(userId);
        } catch (err) {
            console.error('[billing] subscribe lookup failed:', err.message);
            return sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
        }

        let open;
        // C1 / I2: computed once, in scope for every createSubscription/insertSubscription call
        // this request might make (including the stale-row fallback below) — never let a
        // resume's create fall through to an immediate, un-delayed charge (or a row with no
        // current_end) just because the reuse logic found the row stale.
        let resumeStartAt;
        let resumeCurrentEnd;
        if (ent.plan === 'pro') {
            // Only a subscription can be resumed; comp/admin Pro has nothing to undo.
            if (ent.source !== 'subscription') return sendError(res, 'conflict', 'You already have Pro.');
            let scheduled;
            try {
                [open, scheduled] = await Promise.all([billing.openSubscription(userId), billing.scheduledCancel(userId)]);
            } catch (err) {
                console.error('[billing] subscribe lookup failed:', err.message);
                return sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
            }

            // m1: no scheduled-cancel row at all means nothing to resume, full stop — return
            // before any reuse/fallback logic runs, so a Pro user can never reach the generic
            // fallback create below (which has no resume context to delay a charge with).
            if (!scheduled) return sendError(res, 'conflict', 'You already have Pro.');

            if (!scheduledIsUsable(scheduled)) {
                return sendError(res, 'conflict', 'Your Pro ends shortly — subscribe again once it ends.');
            }
            resumeStartAt = Math.floor(Date.parse(scheduled.current_end) / 1000);
            resumeCurrentEnd = scheduled.current_end;

            // Minor 1: a real, non-cancelling open row that isn't a resume-in-progress 'created'
            // row means genuinely already Pro with nothing to resume.
            if (open && open.status !== 'created') return sendError(res, 'conflict', 'You already have Pro.');

            if (!open) {
                // Resume Pro after cancelling: the old row stays 'active'/cancel_at_period_end
                // until current_end, so start the new subscription exactly then — no charge now.
                let sub;
                try {
                    sub = await razorpay.createSubscription({ planId, userId, startAt: resumeStartAt });
                } catch (err) {
                    console.error('[billing] razorpay create (resume) failed:', err.message);
                    return sendError(res, 'payments_unavailable');
                }
                // I2: pre-fill current_end from the old row so entitlement() has continuous
                // coverage the moment this row goes 'authenticated', even before its own webhook
                // (with the real cycle-end date) arrives — never a gap at the old row's boundary.
                const fields = { ...toRow(sub), current_end: resumeCurrentEnd };
                try {
                    await billing.insertSubscription(userId, fields);
                } catch (err) {
                    // Another request (double click, second tab) inserted first: hand back its subscription.
                    const winner = await billing.openSubscription(userId).catch(() => null);
                    if (winner?.status === 'created') return res.json({ subscriptionId: winner.razorpay_subscription_id, keyId });
                    console.error('[billing] resume subscription insert failed:', err.message);
                    return sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
                }
                return res.json({ subscriptionId: sub.id, keyId });
            }
            // open exists (a resume-in-progress 'created' row): fall through to the same
            // reuse/'created' handling as a first-time subscribe, below — `resumeStartAt` stays
            // in scope for its stale-row fallback create.
        } else {
            try {
                open = await billing.openSubscription(userId);
            } catch (err) {
                console.error('[billing] subscribe lookup failed:', err.message);
                return sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
            }
        }

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

            // I4/m2: a remote start_at already in the past is not safely reusable in a resume
            // context — reusing it would let Razorpay charge as soon as it's authenticated,
            // defeating a resume's whole point of a delayed start. This only applies when we're
            // actually resuming (resumeStartAt is set, i.e. the Pro/scheduled branch above ran):
            // Razorpay may fill an ordinary Free subscription's start_at with its creation time,
            // which would otherwise make an ordinary, still-valid reused row look stale moments
            // after it was created.
            const remoteStartPast = resumeStartAt !== undefined && Boolean(remote?.start_at) && remote.start_at * 1000 <= Date.now();
            const reusable = remote?.plan_id === planId && remote.status === 'created' && !remoteStartPast;
            if (reusable) return res.json({ subscriptionId: open.razorpay_subscription_id, keyId });

            // Stale: gone at Razorpay (404), a different plan, already terminal there (cancelled,
            // completed, expired, halted), or its start_at has already lapsed.
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
            sub = await razorpay.createSubscription({ planId, userId, startAt: resumeStartAt });
        } catch (err) {
            console.error('[billing] razorpay create failed:', err.message);
            return sendError(res, 'payments_unavailable');
        }
        // I2: same current_end pre-fill as the direct resume-create path above, for a resume
        // that reaches this fallback because its 'created' row was found stale (C1).
        const fields = resumeCurrentEnd ? { ...toRow(sub), current_end: resumeCurrentEnd } : toRow(sub);
        try {
            await billing.insertSubscription(userId, fields);
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
        const userId = req.auth.userId;
        let open;
        try {
            open = await billing.openSubscription(userId);
        } catch (err) {
            console.error('[billing] cancel lookup failed:', err.message);
            return sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
        }
        if (!open) {
            // openSubscription excludes rows already scheduled to cancel: if that's the only
            // open row, there's nothing new to cancel — keep the existing short-circuit response.
            let scheduled;
            try {
                scheduled = await billing.scheduledCancel(userId);
            } catch (err) {
                console.error('[billing] cancel lookup failed:', err.message);
                return sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
            }
            if (scheduled) return res.json({ ok: true, until: scheduled.current_end ?? null });
            return sendError(res, 'bad_request', 'No active subscription to cancel.');
        }

        // I1: a resumed subscription still 'created' (checkout not completed) or 'authenticated'
        // with billing not yet actually started has nothing running to "let finish a cycle" —
        // cancel it immediately. Only relevant alongside a scheduled-cancel row (a genuine
        // resume attempt); a plain non-resume 'created' row keeps the old "nothing to cancel" 400.
        let scheduled = null;
        if (open.status === 'created' || open.status === 'authenticated') {
            try {
                scheduled = await billing.scheduledCancel(userId);
            } catch (err) {
                console.error('[billing] cancel lookup failed:', err.message);
                return sendError(res, 'auth_unavailable', 'Billing is temporarily unavailable.');
            }
        }
        if (!scheduled && !CANCELLABLE.has(open.status)) {
            return sendError(res, 'bad_request', 'No active subscription to cancel.');
        }

        // N1: every resume sets Razorpay's start_at = scheduled.current_end (see /subscribe), so
        // whether the resumed row has actually started billing is fully decided by that
        // comparison — no need to ask Razorpay, and nothing here should depend on
        // razorpay.fetchSubscription succeeding.
        const notStarted = Boolean(scheduled) && Date.parse(scheduled.current_end) > Date.now();

        try {
            await razorpay.cancelSubscription(open.razorpay_subscription_id, { atCycleEnd: !notStarted });
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
        res.json({ ok: true, until: (notStarted ? scheduled?.current_end : open.current_end) ?? null });
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
