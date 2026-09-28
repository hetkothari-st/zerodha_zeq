export const OPEN_STATUSES = ['created', 'authenticated', 'active', 'pending'];
const SUB_FIELDS = 'user_id,razorpay_subscription_id,status,current_end,cancel_at_period_end,short_url,last_event_at';

// Service-key access to billing tables via PostgREST (bypasses RLS: server only).
export function createBillingStore({ supabaseUrl, serviceKey, fetchImpl = fetch, timeoutMs = 5000 }) {
    const baseHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

    async function call(path, init = {}) {
        const res = await fetchImpl(`${supabaseUrl}/rest/v1/${path}`, {
            ...init,
            headers: { ...baseHeaders, ...(init.headers || {}) },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
            const err = new Error(`supabase ${init.method || 'GET'} ${path.split('?')[0]} failed: ${res.status}`);
            err.status = res.status;
            throw err;
        }
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    }
    const enc = encodeURIComponent;
    const first = (rows) => rows?.[0] ?? null;

    return {
        async entitlement(userId) {
            const rows = await call('rpc/entitlement', { method: 'POST', body: JSON.stringify({ uid: userId }) });
            return first(rows) ?? { plan: 'free', source: null, until: null };
        },
        async latestSubscription(userId) {
            return first(await call(`subscriptions?user_id=eq.${enc(userId)}&select=${SUB_FIELDS}&order=created_at.desc&limit=1`));
        },
        async openSubscription(userId) {
            return first(await call(`subscriptions?user_id=eq.${enc(userId)}&status=in.(${OPEN_STATUSES.join(',')})&select=${SUB_FIELDS}&limit=1`));
        },
        async getSubscription(subId) {
            return first(await call(`subscriptions?razorpay_subscription_id=eq.${enc(subId)}&select=${SUB_FIELDS}`));
        },
        async insertSubscription(userId, fields) {
            return first(await call('subscriptions', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({ user_id: userId, ...fields }),
            }));
        },
        // notAfter makes the write conditional: only applies when the row has never seen a
        // newer event (atomic stale-event guard, evaluated by Postgres, not read-then-compare in JS).
        async updateSubscription(subId, patch, { notAfter } = {}) {
            let path = `subscriptions?razorpay_subscription_id=eq.${enc(subId)}`;
            if (notAfter) path += `&or=(last_event_at.is.null,last_event_at.lte.${encodeURIComponent(notAfter)})`;
            return first(await call(path, {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
            }));
        },
        async hasEvent(eventId) {
            const rows = await call(`billing_events?event_id=eq.${enc(eventId)}&select=event_id`);
            return Array.isArray(rows) && rows.length > 0;
        },
        async recordEvent(eventId) {
            const rows = await call('billing_events', {
                method: 'POST',
                headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
                body: JSON.stringify({ event_id: eventId }),
            });
            return Array.isArray(rows) && rows.length > 0;
        },
    };
}
