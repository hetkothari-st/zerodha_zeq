import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planMigration, createSupabaseAdmin, runMigration } from '../scripts/lib/migrateUsers.js';

const noSleep = async () => {};

test('planMigration keeps active rows, lowercases emails, routes non-emails to manual', () => {
    const plan = planMigration([
        { username: 'Asha@Example.com', is_active: true },
        { username: 'ravi', is_active: true },
        { username: 'old@example.com', is_active: false },
        { username: ' bob@x.in ', is_active: true },
        { username: 'asha@example.com', is_active: true },
    ]);
    assert.deepEqual(plan.migrate, [
        { email: 'asha@example.com', name: 'asha', username: 'Asha@Example.com' },
        { email: 'bob@x.in', name: 'bob', username: ' bob@x.in ' },
    ]);
    assert.deepEqual(plan.manual, [{ username: 'ravi', reason: 'username is not an email' }]);
});

// Fake GoTrue + PostgREST for one "new" (target) project and one "legacy" project.
// `existing` entries may be a plain email string or an object:
//   { email, lastSignInAt = null, profileStatus = 'pending', approvedAt = null, noProfile = false }
// `recoverFailures`: { [email]: { times: <429s to return before succeeding>, retryAfter: <seconds> } }
function fakeProjects({ legacyRows = [], existing = [], failFor = [], recoverFailures = {} } = {}) {
    const users = new Map(); // lower-case email -> { id, lastSignInAt }
    const profiles = new Map(); // id -> { status, approved_at }
    const recoverAttempts = new Map(); // email -> attempts already returned as 429
    let nextId = 0;

    for (const e of existing) {
        const opts = typeof e === 'string' ? { email: e } : e;
        const id = opts.id || `id-${nextId++}`;
        users.set(opts.email, { id, lastSignInAt: opts.lastSignInAt ?? null });
        if (!opts.noProfile) {
            profiles.set(id, { status: opts.profileStatus || 'pending', approved_at: opts.approvedAt ?? null });
        }
    }

    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const method = init.method || 'GET';
        calls.push({ method, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });

        if (u.origin === 'https://legacy.supabase.co' && u.pathname === '/rest/v1/app_users') {
            return new Response(JSON.stringify(legacyRows), { status: 200 });
        }
        if (u.pathname === '/auth/v1/admin/users' && method === 'POST') {
            const { email } = JSON.parse(init.body);
            if (failFor.includes(email)) throw new Error('ECONNRESET');
            if (users.has(email)) {
                return new Response(JSON.stringify({ code: 'email_exists', msg: 'A user with this email address has already been registered' }), { status: 422 });
            }
            const id = `id-${nextId++}`;
            users.set(email, { id, lastSignInAt: null });
            profiles.set(id, { status: 'pending', approved_at: null }); // simulates the DB trigger that creates the profile row
            return new Response(JSON.stringify({ id, email }), { status: 200 });
        }
        if (u.pathname === '/auth/v1/admin/users' && method === 'GET') {
            const page = Number(u.searchParams.get('page') || 1);
            const list = page === 1 ? [...users].map(([email, v]) => ({ id: v.id, email, last_sign_in_at: v.lastSignInAt })) : [];
            return new Response(JSON.stringify({ users: list }), { status: 200 });
        }
        if (u.pathname === '/rest/v1/profiles' && method === 'PATCH') {
            const id = (u.searchParams.get('id') || '').replace('eq.', '');
            const statusFilter = u.searchParams.get('status'); // e.g. "eq.pending"
            const row = profiles.get(id);
            if (row && statusFilter === `eq.${row.status}`) {
                const patch = JSON.parse(init.body);
                profiles.set(id, { ...row, ...patch });
                return new Response(JSON.stringify([{ id, ...profiles.get(id) }]), { status: 200 });
            }
            return new Response(JSON.stringify([]), { status: 200 });
        }
        if (u.pathname === '/rest/v1/profiles' && method === 'GET') {
            const id = (u.searchParams.get('id') || '').replace('eq.', '');
            const row = profiles.get(id);
            return new Response(JSON.stringify(row ? [{ id, ...row }] : []), { status: 200 });
        }
        if (u.pathname === '/auth/v1/recover' && method === 'POST') {
            const { email } = JSON.parse(init.body);
            const cfg = recoverFailures[email];
            const done = recoverAttempts.get(email) || 0;
            if (cfg && done < cfg.times) {
                recoverAttempts.set(email, done + 1);
                return new Response('{}', { status: 429, headers: { 'Retry-After': String(cfg.retryAfter ?? 60) } });
            }
            return new Response('{}', { status: 200 });
        }
        throw new Error(`unexpected ${method} ${url}`);
    };
    return { fetchImpl, calls, users, profiles, recoverFailures };
}

const quiet = { info() {}, warn() {}, error() {} };

function setup(opts) {
    const f = fakeProjects(opts);
    const legacy = createSupabaseAdmin({ url: 'https://legacy.supabase.co', serviceKey: 'old', fetchImpl: f.fetchImpl });
    const target = createSupabaseAdmin({ url: 'https://new.supabase.co', serviceKey: 'new', fetchImpl: f.fetchImpl });
    return { f, legacy, target };
}

test('legacy read never selects the password column', async () => {
    const { f, legacy } = setup({ legacyRows: [] });
    await legacy.listLegacyUsers();
    const q = f.calls[0].path;
    assert.match(q, /select=username,is_active/);
    assert.doesNotMatch(q, /password/);
    assert.match(q, /is_active=eq\.true/);
});

// --- Item 8: Range header + 1000-row cap warning ---

test('legacy read sends Range: 0-9999 and warns if exactly 1000 rows come back', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ username: `u${i}@x.in`, is_active: true }));
    const warnings = [];
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        if (u.pathname === '/rest/v1/app_users') {
            assert.equal(init.headers.Range, '0-9999');
            return new Response(JSON.stringify(rows), { status: 200 });
        }
        throw new Error('unexpected');
    };
    const legacy = createSupabaseAdmin({ url: 'https://legacy.supabase.co', serviceKey: 'old', fetchImpl, log: { warn: (m) => warnings.push(m), info() {}, error() {} } });
    const result = await legacy.listLegacyUsers();
    assert.equal(result.length, 1000);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /1000/);
});

// --- Item 6: safe JSON parse + clear error messages ---

test('legacy read failure produces a clear, status-bearing error even with a non-JSON body', async () => {
    const legacy = createSupabaseAdmin({
        url: 'https://legacy.supabase.co', serviceKey: 'old',
        fetchImpl: async () => new Response('<html>Internal Server Error</html>', { status: 500 }),
    });
    await assert.rejects(() => legacy.listLegacyUsers(), /legacy read failed: 500/);
});

// --- Item 4: dry run pre-flight loads the target user map read-only ---

test('dry run loads the target user map (read-only) and classifies would_create / would_resend / would_skip, writing nothing', async () => {
    const { f, legacy, target } = setup({
        legacyRows: [
            { username: 'brand-new@x.in', is_active: true },
            { username: 'never-signed-in@x.in', is_active: true },
            { username: 'signed-in@x.in', is_active: true },
        ],
        existing: [
            { email: 'never-signed-in@x.in', lastSignInAt: null },
            { email: 'signed-in@x.in', lastSignInAt: '2026-01-01T00:00:00Z' },
        ],
    });
    const r = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: false, log: quiet });
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.would_create, ['brand-new@x.in']);
    assert.deepEqual(r.would_resend, ['never-signed-in@x.in']);
    assert.deepEqual(r.would_skip, ['signed-in@x.in']);
    assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0);
});

// --- Apply: create, approve, email (baseline, still true after the fix) ---

test('apply creates, approves and sends a password-set email for a brand-new user', async () => {
    const { f, legacy, target } = setup({ legacyRows: [{ username: 'a@x.in', is_active: true }, { username: 'ravi', is_active: true }] });
    const r = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, sleep: noSleep });
    assert.deepEqual(r.created, ['a@x.in']);
    assert.deepEqual(r.manual, [{ username: 'ravi', reason: 'username is not an email' }]);
    const create = f.calls.find((c) => c.method === 'POST' && c.path === '/auth/v1/admin/users');
    assert.deepEqual(create.body, { email: 'a@x.in', email_confirm: true, user_metadata: { full_name: 'a' } });
    assert.equal(create.headers.Authorization, 'Bearer new');
    const id = f.users.get('a@x.in').id;
    assert.equal(f.profiles.get(id).status, 'approved');
    assert.ok(!Number.isNaN(Date.parse(f.profiles.get(id).approved_at)));
    const recover = f.calls.find((c) => c.path.startsWith('/auth/v1/recover'));
    assert.equal(recover.path, `/auth/v1/recover?redirect_to=${encodeURIComponent('https://funnelop.in/reset-password')}`);
    assert.deepEqual(recover.body, { email: 'a@x.in' });
});

test('one failing user does not stop the run', async () => {
    const { legacy, target } = setup({ legacyRows: [{ username: 'bad@x.in', is_active: true }, { username: 'good@x.in', is_active: true }], failFor: ['bad@x.in'] });
    const r = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, sleep: noSleep });
    assert.deepEqual(r.failed, [{ email: 'bad@x.in', reason: 'ECONNRESET' }]);
    assert.deepEqual(r.created, ['good@x.in']);
});

// --- Item 1: stranded users on rerun (target map loaded once; last_sign_in_at drives resend vs skip) ---

test('existing target user who never signed in gets the password-set email resent', async () => {
    const { f, legacy, target } = setup({
        legacyRows: [{ username: 'a@x.in', is_active: true }],
        existing: [{ email: 'a@x.in', lastSignInAt: null }],
    });
    const r = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, sleep: noSleep });
    assert.deepEqual(r.resent, ['a@x.in']);
    assert.deepEqual(r.created, []);
    assert.deepEqual(r.skipped_exists, []);
    assert.ok(f.calls.find((c) => c.path.startsWith('/auth/v1/recover')));
    const createCalls = f.calls.filter((c) => c.method === 'POST' && c.path === '/auth/v1/admin/users');
    assert.equal(createCalls.length, 0);
});

test('existing target user who already signed in is skipped_exists with no email, but is still approved', async () => {
    const { f, legacy, target } = setup({
        legacyRows: [{ username: 'a@x.in', is_active: true }],
        existing: [{ email: 'a@x.in', lastSignInAt: '2026-01-01T00:00:00Z' }],
    });
    const r = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, sleep: noSleep });
    assert.deepEqual(r.skipped_exists, ['a@x.in']);
    assert.deepEqual(r.resent, []);
    assert.deepEqual(r.created, []);
    assert.equal(f.calls.find((c) => c.path.startsWith('/auth/v1/recover')), undefined);
    assert.equal(f.profiles.get(f.users.get('a@x.in').id).status, 'approved');
});

test('a user whose password-set email failed is resent it on the next run, not re-created', async () => {
    const { f, legacy, target } = setup({
        legacyRows: [{ username: 'a@x.in', is_active: true }],
        recoverFailures: { 'a@x.in': { times: 10, retryAfter: 1 } }, // always 429s until we flip it off below
    });
    const sleeps1 = [];
    const r1 = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, sleep: async (ms) => sleeps1.push(ms) });
    assert.deepEqual(r1.failed, [{ email: 'a@x.in', reason: 'email rate limited — rerun later' }]);
    assert.deepEqual(r1.created, []);
    assert.ok(f.users.has('a@x.in')); // user + profile were created despite the email failure

    f.recoverFailures['a@x.in'].times = 0; // simulate the rate limit having cleared before the rerun
    const r2 = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, sleep: noSleep });
    assert.deepEqual(r2.resent, ['a@x.in']);
    assert.deepEqual(r2.created, []);
    assert.deepEqual(r2.failed, []);
    const createCalls = f.calls.filter((c) => c.method === 'POST' && c.path === '/auth/v1/admin/users');
    assert.equal(createCalls.length, 1); // only ever created once, across both runs
});

// --- Item 2: email throttling + 429 retry/backoff ---

test('email sends are throttled by emailDelayMs (default 2500ms) between sends', async () => {
    const { legacy, target } = setup({ legacyRows: [{ username: 'a@x.in', is_active: true }, { username: 'b@x.in', is_active: true }] });
    const sleeps = [];
    const r = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, sleep: async (ms) => sleeps.push(ms) });
    assert.deepEqual(r.created.slice().sort(), ['a@x.in', 'b@x.in']);
    assert.deepEqual(sleeps, [2500]);
});

test('emailDelayMs option overrides the default throttle wait', async () => {
    const { legacy, target } = setup({ legacyRows: [{ username: 'a@x.in', is_active: true }, { username: 'b@x.in', is_active: true }] });
    const sleeps = [];
    await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, emailDelayMs: 9000, sleep: async (ms) => sleeps.push(ms) });
    assert.deepEqual(sleeps, [9000]);
});

test('a 429 from /recover waits Retry-After seconds and retries, then succeeds', async () => {
    const { f, legacy, target } = setup({
        legacyRows: [{ username: 'a@x.in', is_active: true }],
        recoverFailures: { 'a@x.in': { times: 1, retryAfter: 45 } },
    });
    const sleeps = [];
    const r = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, sleep: async (ms) => sleeps.push(ms) });
    assert.deepEqual(r.created, ['a@x.in']);
    assert.deepEqual(sleeps, [45000]);
    assert.deepEqual(f.calls.filter((c) => c.path.startsWith('/auth/v1/recover')).length, 2);
});

test('429s exhausted after 3 retries report failed with a rerun-later reason', async () => {
    const { legacy, target } = setup({
        legacyRows: [{ username: 'a@x.in', is_active: true }],
        recoverFailures: { 'a@x.in': { times: 10 } }, // default retryAfter 60s
    });
    const sleeps = [];
    const r = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, sleep: async (ms) => sleeps.push(ms) });
    assert.deepEqual(r.failed, [{ email: 'a@x.in', reason: 'email rate limited — rerun later' }]);
    assert.deepEqual(sleeps, [60000, 60000, 60000]);
});

// --- Item 3: approve affects exactly one row; rejected/approved/missing handling ---

test('approve: a missing profile row fails with a clear reason', async () => {
    const { legacy, target } = setup({
        legacyRows: [{ username: 'a@x.in', is_active: true }],
        existing: [{ email: 'a@x.in', lastSignInAt: null, noProfile: true }],
    });
    const r = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, sleep: noSleep });
    assert.deepEqual(r.failed, [{ email: 'a@x.in', reason: 'no profile row (was the migration SQL applied?)' }]);
});

test('approve: a rejected profile is left untouched and reported under skipped_rejected, no email sent', async () => {
    const { f, legacy, target } = setup({
        legacyRows: [{ username: 'a@x.in', is_active: true }],
        existing: [{ email: 'a@x.in', lastSignInAt: null, profileStatus: 'rejected' }],
    });
    const r = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, sleep: noSleep });
    assert.deepEqual(r.skipped_rejected, ['a@x.in']);
    assert.deepEqual(r.created, []);
    assert.deepEqual(r.resent, []);
    assert.equal(f.profiles.get(f.users.get('a@x.in').id).status, 'rejected');
    assert.equal(f.calls.find((c) => c.path.startsWith('/auth/v1/recover')), undefined);
});

test('approve: an already-approved profile is treated as success and approved_at is not reset', async () => {
    const approvedAt = '2025-01-01T00:00:00.000Z';
    const { f, legacy, target } = setup({
        legacyRows: [{ username: 'a@x.in', is_active: true }],
        existing: [{ email: 'a@x.in', lastSignInAt: '2026-01-01T00:00:00Z', profileStatus: 'approved', approvedAt }],
    });
    const r = await runMigration({ legacy, target, appOrigin: 'https://funnelop.in', apply: true, log: quiet, sleep: noSleep });
    assert.deepEqual(r.skipped_exists, ['a@x.in']); // already signed in -> no email, but still a success
    const id = f.users.get('a@x.in').id;
    assert.equal(f.profiles.get(id).status, 'approved');
    assert.equal(f.profiles.get(id).approved_at, approvedAt);
});

// --- Item 5: only email_exists (or an "already registered" message) counts as existing ---

test('createUser: a 422 that is not "already exists" fails with the server message', async () => {
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        if (u.pathname === '/auth/v1/admin/users' && (init.method || 'GET') === 'POST') {
            return new Response(JSON.stringify({ code: 'weak_password', msg: 'Password is too weak' }), { status: 422 });
        }
        throw new Error('unexpected');
    };
    const target = createSupabaseAdmin({ url: 'https://new.supabase.co', serviceKey: 'new', fetchImpl });
    await assert.rejects(() => target.createUser({ email: 'a@x.in', name: 'a' }), /Password is too weak/);
});

test('createUser: a 422 whose message says "already been registered" (no code) counts as existing', async () => {
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        if (u.pathname === '/auth/v1/admin/users' && (init.method || 'GET') === 'POST') {
            return new Response(JSON.stringify({ msg: 'A user with this email address has already been registered' }), { status: 422 });
        }
        throw new Error('unexpected');
    };
    const target = createSupabaseAdmin({ url: 'https://new.supabase.co', serviceKey: 'new', fetchImpl });
    const result = await target.createUser({ email: 'a@x.in', name: 'a' });
    assert.deepEqual(result, { id: null, created: false });
});

// --- Item 7: same-project guard is case-insensitive on host; APP_ORIGIN must be https (localhost exempt) ---

const cliPath = fileURLToPath(new URL('../scripts/migrate-app-users.mjs', import.meta.url));

function runCli(envOverrides) {
    return spawnSync(process.execPath, [cliPath], {
        env: {
            ...process.env,
            OLD_SUPABASE_URL: 'https://old-project.supabase.co',
            OLD_SUPABASE_SERVICE_KEY: 'old-key',
            SUPABASE_URL: 'https://new-project.supabase.co',
            SUPABASE_SERVICE_KEY: 'new-key',
            APP_ORIGIN: 'https://funnelop.in',
            ...envOverrides,
        },
        encoding: 'utf8',
        timeout: 10000,
    });
}

test('CLI refuses when OLD_SUPABASE_URL and SUPABASE_URL are the same project, case-insensitively', () => {
    const res = runCli({ OLD_SUPABASE_URL: 'https://SAME-project.supabase.co', SUPABASE_URL: 'https://same-project.supabase.co' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /same project/i);
});

test('CLI rejects a non-https APP_ORIGIN that is not localhost', () => {
    const res = runCli({ APP_ORIGIN: 'http://evil.example.com' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /https/i);
});

test('CLI allows http://localhost for APP_ORIGIN (staging) and proceeds past validation', () => {
    // Point at unused local loopback ports so the network call fails fast (ECONNREFUSED) instead of
    // hanging on DNS - a fast, deterministic way to prove validation was passed without real network access.
    const res = runCli({
        OLD_SUPABASE_URL: 'http://127.0.0.1:9',
        SUPABASE_URL: 'http://127.0.0.1:10',
        APP_ORIGIN: 'http://localhost:3000',
    });
    assert.notEqual(res.status, 2); // did not fail same-project or APP_ORIGIN validation
});

test('CLI usage comment documents --email-delay-ms', () => {
    const src = readFileSync(cliPath, 'utf8');
    assert.match(src, /--email-delay-ms/);
});
