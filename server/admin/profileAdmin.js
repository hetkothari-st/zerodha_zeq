const LIST_FIELDS = 'id,full_name,email,phone,status,role,signup_provider,created_at,approved_at,comp_pro,subscriptions(status,current_end)';

// Service-key access to profiles/admin_audit_log via PostgREST (bypasses RLS: server only).
export function createProfileAdmin({ supabaseUrl, serviceKey, fetchImpl = fetch }) {
    const baseHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

    async function call(path, init = {}) {
        const res = await fetchImpl(`${supabaseUrl}/rest/v1/${path}`, { ...init, headers: { ...baseHeaders, ...(init.headers || {}) } });
        if (!res.ok) throw new Error(`supabase ${init.method || 'GET'} ${path.split('?')[0]} failed: ${res.status}`);
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    }

    return {
        listByStatus(status) {
            return call(`profiles?status=eq.${status}&select=${LIST_FIELDS}&order=created_at.desc`);
        },
        async getById(id) {
            const rows = await call(`profiles?id=eq.${id}&select=${LIST_FIELDS}`);
            return rows?.[0] ?? null;
        },
        async setStatus(id, status, adminId) {
            const patch = { status, approved_at: status === 'approved' ? new Date().toISOString() : null, approved_by: adminId };
            const rows = await call(`profiles?id=eq.${id}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify(patch),
            });
            return rows?.[0] ?? null;
        },
        async audit(adminId, targetId, action) {
            await call('admin_audit_log', {
                method: 'POST',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify({ admin_id: adminId, target_id: targetId, action }),
            });
        },
        async setCompPro(id, value) {
            const rows = await call(`profiles?id=eq.${id}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({ comp_pro: Boolean(value) }),
            });
            return rows?.[0] ?? null;
        },
    };
}
