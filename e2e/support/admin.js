const PROFILE_PATCH_RETRIES = 5;
const PROFILE_PATCH_RETRY_DELAY_MS = 200;
const LIST_PAGE_SIZE = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Deterministic 7-digit numeric hash so a phone number can be derived even when runId isn't hex
// (e.g. a caller-supplied E2E_RUN_ID).
function numericHash(str) {
    const n = parseInt(str, 16);
    if (Number.isFinite(n)) return n;
    let h = 0;
    for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h;
}

// A 10-digit Indian mobile number (+91, starting with 9) that's unique per (runId, counter) so
// concurrent/successive runs don't collide on a phone number.
function genPhone(runId, n) {
    const base = (numericHash(runId) % 1e7).toString().padStart(7, '0');
    return `+919${base}${String(n).padStart(2, '0')}`;
}

// Creates fully-verified users through the Supabase Admin API so no inbox/SMS is needed.
export function adminApi({ supabaseUrl, serviceKey, emailDomain, runId }) {
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
    let n = 0;
    async function call(path, init = {}) {
        const res = await fetch(`${supabaseUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
        const text = await res.text();
        if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${text}`);
        return text ? JSON.parse(text) : null;
    }
    return {
        async createVerifiedUser({ role = 'user', status = 'approved', withPhone = true } = {}) {
            n += 1;
            const email = `e2e+${runId}-${n}@${emailDomain}`;
            const password = `E2e-${runId}-${n}-pass1`;
            const phone = withPhone ? genPhone(runId, n) : undefined;
            const user = await call('/auth/v1/admin/users', {
                method: 'POST',
                body: JSON.stringify({ email, password, email_confirm: true, ...(phone ? { phone, phone_confirm: true } : {}), user_metadata: { full_name: `E2E ${runId} ${n}` } }),
            });
            // The profiles row is inserted asynchronously by a DB trigger on auth.users; retry the
            // PATCH until it lands instead of silently no-op'ing against zero rows.
            let profile = null;
            for (let attempt = 1; attempt <= PROFILE_PATCH_RETRIES && !profile; attempt += 1) {
                if (attempt > 1) await sleep(PROFILE_PATCH_RETRY_DELAY_MS);
                const rows = await call(`/rest/v1/profiles?id=eq.${user.id}`, {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: JSON.stringify({ status, role }),
                });
                if (Array.isArray(rows) && rows.length) profile = rows[0];
            }
            if (!profile) throw new Error(`profile row not found for ${user.id}`);
            return { id: user.id, email, password };
        },
        async setStatus(id, status) {
            await call(`/rest/v1/profiles?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status }) });
        },
        async deleteUser(id) {
            await call(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
        },
        // Deletes every user whose email starts with `prefix`, plus (when given) any user whose
        // phone equals `testPhoneDigits` (digits only, no '+') — self-healing a poisoned shared
        // test-phone number left behind by a crashed run.
        async deleteRunUsers(prefix = `e2e+${runId}-`, testPhoneDigits) {
            const mine = [];
            for (let page = 1; ; page += 1) {
                const r = await call(`/auth/v1/admin/users?page=${page}&per_page=${LIST_PAGE_SIZE}`);
                const users = r?.users || [];
                mine.push(...users.filter((u) => (u.email || '').startsWith(prefix) || (testPhoneDigits && u.phone === testPhoneDigits)));
                if (users.length < LIST_PAGE_SIZE) break;
            }
            for (const u of mine) await call(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' });
            return mine.length;
        },
    };
}
