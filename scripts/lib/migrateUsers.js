// Moves legacy app_users (plain-text password table) onto Supabase Auth. See docs/runbooks/auth-rollout.md.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALREADY_REGISTERED = /already been registered/i;
const MAX_EMAIL_RETRIES = 3;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const DEFAULT_EMAIL_DELAY_MS = 2500;
const RATE_LIMITED = 'email rate limited — rerun later';

// CLI flags: --apply, and --email-delay-ms=<n> or --email-delay-ms <n>. An invalid delay is
// reported in `warnings` and the default is kept.
export function parseArgs(argv) {
    const warnings = [];
    let emailDelayMs = DEFAULT_EMAIL_DELAY_MS;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        let raw;
        if (arg.startsWith('--email-delay-ms=')) raw = arg.slice('--email-delay-ms='.length);
        else if (arg === '--email-delay-ms') {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) { raw = next; i++; } else raw = '';
        } else continue;
        const n = raw.trim() === '' ? NaN : Number(raw);
        if (Number.isFinite(n) && n >= 0) emailDelayMs = n;
        else warnings.push(`Ignoring invalid --email-delay-ms value "${raw}" (must be a number of milliseconds >= 0); using ${DEFAULT_EMAIL_DELAY_MS}.`);
    }
    return { apply: argv.includes('--apply'), emailDelayMs, warnings };
}

export function planMigration(rows) {
    const seen = new Set();
    const migrate = [];
    const manual = [];
    for (const row of rows) {
        if (!row.is_active) continue;
        const email = String(row.username ?? '').trim().toLowerCase();
        if (!EMAIL.test(email)) { manual.push({ username: row.username, reason: 'username is not an email' }); continue; }
        if (seen.has(email)) continue;
        seen.add(email);
        migrate.push({ email, name: email.split('@')[0], username: row.username });
    }
    return { migrate, manual };
}

export function createSupabaseAdmin({ url, serviceKey, fetchImpl = fetch, log = console }) {
    const base = url.replace(/\/$/, '');
    const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
    async function call(path, init = {}) {
        const res = await fetchImpl(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
        const text = await res.text();
        let body = null;
        if (text) {
            try { body = JSON.parse(text); } catch { body = { raw: text }; } // never throw on a non-JSON body
        }
        return { status: res.status, ok: res.ok, body, headers: res.headers };
    }
    return {
        // Read-only: selects only username + is_active, never the legacy password column.
        async listLegacyUsers() {
            const r = await call('/rest/v1/app_users?select=username,is_active&is_active=eq.true', { headers: { Range: '0-9999' } });
            if (!r.ok) throw new Error(`legacy read failed: ${r.status}`);
            if (Array.isArray(r.body) && r.body.length === 1000) {
                log.warn('[migrate] legacy read returned exactly 1000 rows — possible PostgREST page cap; verify all rows were fetched.');
            }
            return r.body;
        },
        async createUser({ email, name }) {
            const r = await call('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: name } }) });
            if (r.ok) return { id: r.body.id, created: true };
            const msg = r.body?.msg || r.body?.message || '';
            if (r.status === 422 && (r.body?.code === 'email_exists' || ALREADY_REGISTERED.test(msg))) {
                return { id: null, created: false };
            }
            throw new Error(`create failed: ${r.status} ${msg}`.trim());
        },
        // Loads the full target user list ONCE per run: email (lower-case) -> { id, lastSignInAt }.
        async listAllUsers() {
            const map = new Map();
            for (let page = 1; page <= 50; page++) {
                const r = await call(`/auth/v1/admin/users?page=${page}&per_page=1000`);
                if (!r.ok) throw new Error(`list users failed: ${r.status}`);
                const list = r.body.users || [];
                for (const u of list) {
                    if (u.email) map.set(u.email.toLowerCase(), { id: u.id, lastSignInAt: u.last_sign_in_at ?? null });
                }
                if (!list.length) break;
            }
            return map;
        },
        // Fallback lookup for the rare race where createUser reports "exists" for an email
        // that wasn't in the pre-loaded map (created concurrently by something else).
        async findUserIdByEmail(email) {
            for (let page = 1; page <= 50; page++) {
                const r = await call(`/auth/v1/admin/users?page=${page}&per_page=1000`);
                if (!r.ok) throw new Error(`list users failed: ${r.status}`);
                const hit = (r.body.users || []).find((u) => (u.email || '').toLowerCase() === email);
                if (hit) return hit.id;
                if (!r.body.users?.length) return null;
            }
            return null;
        },
        // Approves exactly one row (id=eq.<id>&status=eq.pending), never resetting an already-approved
        // row and never touching a rejected one. Returns the outcome instead of throwing for the
        // legitimate non-pending cases so the caller can classify them.
        async approveProfile(id) {
            const r = await call(`/rest/v1/profiles?id=eq.${id}&status=eq.pending`, {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify({ status: 'approved', approved_at: new Date().toISOString() }),
            });
            if (!r.ok) throw new Error(`approve failed: ${r.status}`);
            const rows = Array.isArray(r.body) ? r.body : [];
            if (rows.length > 0) return { outcome: 'approved' };
            const g = await call(`/rest/v1/profiles?id=eq.${id}&select=status`);
            if (!g.ok) throw new Error(`profile lookup failed: ${g.status}`);
            const found = Array.isArray(g.body) ? g.body[0] : null;
            if (!found) throw new Error('no profile row (was the migration SQL applied?)');
            if (found.status === 'rejected') return { outcome: 'rejected' };
            if (found.status === 'approved') return { outcome: 'already_approved' };
            throw new Error(`unexpected profile status: ${found.status}`);
        },
        // Throws a plain Error for ordinary failures, or an Error with .status === 429 and
        // .retryAfter (seconds) set when GoTrue rate-limits the recover endpoint.
        async sendPasswordSetEmail(email, redirectTo) {
            const r = await call(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, { method: 'POST', body: JSON.stringify({ email }) });
            if (r.status === 429) {
                const header = r.headers?.get ? Number(r.headers.get('Retry-After')) : NaN;
                const err = new Error('rate limited');
                err.status = 429;
                err.retryAfter = Number.isFinite(header) && header > 0 ? header : DEFAULT_RETRY_AFTER_SECONDS;
                throw err;
            }
            if (!r.ok) throw new Error(`recover email failed: ${r.status}`);
        },
    };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runMigration({ legacy, target, appOrigin, apply, emailDelayMs = DEFAULT_EMAIL_DELAY_MS, sleep = defaultSleep, log = console }) {
    const rows = await legacy.listLegacyUsers();
    const { migrate, manual } = planMigration(rows);
    // Loaded once per run (not per user) so a rerun's classification is consistent and cheap.
    const targetUsers = await target.listAllUsers();

    if (!apply) {
        const would_create = [];
        const would_resend = [];
        const would_skip = [];
        for (const { email } of migrate) {
            const existing = targetUsers.get(email);
            if (!existing) would_create.push(email);
            else if (!existing.lastSignInAt) would_resend.push(email);
            else would_skip.push(email);
        }
        return { dryRun: true, would_create, would_resend, would_skip, manual };
    }

    const report = { dryRun: false, created: [], resent: [], skipped_exists: [], skipped_rejected: [], failed: [], manual };
    let emailsSent = 0;
    // After one user exhausts its 429 retries, GoTrue is clearly still limiting us: stop
    // waiting for the rest of the run and mark their emails failed at once (the users are
    // still created and approved; a rerun sends the emails).
    let rateLimitExhausted = false;

    async function sendThrottled(email, redirectTo) {
        if (rateLimitExhausted) throw new Error(RATE_LIMITED);
        if (emailsSent > 0) await sleep(emailDelayMs);
        emailsSent++;
        for (let attempt = 0; attempt <= MAX_EMAIL_RETRIES; attempt++) {
            try {
                await target.sendPasswordSetEmail(email, redirectTo);
                return;
            } catch (err) {
                if (err.status === 429 && attempt < MAX_EMAIL_RETRIES) {
                    await sleep(err.retryAfter * 1000);
                    continue;
                }
                if (err.status === 429) { rateLimitExhausted = true; throw new Error(RATE_LIMITED); }
                throw err;
            }
        }
    }

    for (const { email, name } of migrate) {
        try {
            const existing = targetUsers.get(email);
            let userId;
            let isNewUser;
            let alreadySignedIn = false;
            if (existing) {
                userId = existing.id;
                isNewUser = false;
                alreadySignedIn = Boolean(existing.lastSignInAt);
            } else {
                const created = await target.createUser({ email, name });
                if (created.created) {
                    userId = created.id;
                    isNewUser = true;
                } else {
                    // Someone else created this user between listAllUsers() and now; fall back to a lookup.
                    userId = await target.findUserIdByEmail(email);
                    if (!userId) throw new Error('user exists but could not be found');
                    isNewUser = false;
                }
            }

            const approveResult = await target.approveProfile(userId);
            if (approveResult.outcome === 'rejected') {
                report.skipped_rejected.push(email);
                log.info(`[migrate] rejected (left untouched) ${email}`);
                continue;
            }

            const needsEmail = isNewUser || !alreadySignedIn;
            if (needsEmail) {
                await sendThrottled(email, `${appOrigin}/reset-password`);
                if (isNewUser) report.created.push(email);
                else report.resent.push(email);
            } else {
                report.skipped_exists.push(email);
            }
            log.info(`[migrate] ${isNewUser ? 'created' : needsEmail ? 'resent ' : 'exists '} ${email}`);
        } catch (err) {
            report.failed.push({ email, reason: err.message });
            log.error(`[migrate] FAILED ${email}: ${err.message}`);
        }
    }
    return report;
}
