import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createProfileAdmin } from '../server/admin/profileAdmin.js';
import { createAdminRouter } from '../server/admin/routes.js';
import { fakeAuth, approvedUser, approvedAdmin } from './helpers/fakeAuth.js';
import { listen } from './helpers/http.js';

const TARGET = '22222222-2222-4222-8222-222222222222';
const pendingRow = { id: TARGET, full_name: 'Asha', email: 'asha@example.com', phone: '+919876543210', status: 'pending' };

function fakeProfileAdmin({ rows = [pendingRow], auditFails = false } = {}) {
    const log = { setStatus: [], audit: [] };
    return {
        log,
        listByStatus: async (status) => rows.filter((r) => r.status === status),
        setStatus: async (id, status, adminId) => {
            log.setStatus.push({ id, status, adminId });
            const row = rows.find((r) => r.id === id);
            return row ? { ...row, status } : null;
        },
        audit: async (...args) => { if (auditFails) throw new Error('audit down'); log.audit.push(args); },
    };
}

async function setup(opts) {
    const { auth, profiles, tokenFor } = fakeAuth({ user: approvedUser, admin: approvedAdmin });
    const profileAdmin = fakeProfileAdmin(opts);
    const notified = [];
    const notifier = { userApproved: async (p) => notified.push(['approved', p.id]), userRejected: async (p) => notified.push(['rejected', p.id]) };
    const app = express();
    app.use(express.json());
    app.use(createAdminRouter({ auth, profileAdmin, profiles, notifier }));
    const srv = await listen(app);
    const as = (who) => ({ Authorization: `Bearer ${tokenFor(who)}` });
    return { srv, as, profileAdmin, profiles, notified };
}

test('list defaults to pending, rejects unknown status, requires admin', async () => {
    const { srv, as } = await setup();
    try {
        assert.equal((await fetch(`${srv.url}/api/admin/users`, { headers: as('user') })).status, 403);
        const body = await (await fetch(`${srv.url}/api/admin/users`, { headers: as('admin') })).json();
        assert.deepEqual(body.users.map((u) => u.id), [TARGET]);
        const bad = await fetch(`${srv.url}/api/admin/users?status=deleted`, { headers: as('admin') });
        assert.equal(bad.status, 400);
    } finally { await srv.close(); }
});

test('approve: updates status, busts cache, audits, notifies', async () => {
    const { srv, as, profileAdmin, profiles, notified } = await setup();
    try {
        const res = await fetch(`${srv.url}/api/admin/users/${TARGET}/approve`, { method: 'POST', headers: as('admin') });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).user.status, 'approved');
        assert.deepEqual(profileAdmin.log.setStatus, [{ id: TARGET, status: 'approved', adminId: 'admin' }]);
        assert.ok(profiles.busted.includes(TARGET));
        assert.deepEqual(profileAdmin.log.audit, [['admin', TARGET, 'approve']]);
        assert.deepEqual(notified, [['approved', TARGET]]);
    } finally { await srv.close(); }
});

test('reject: notifies with the rejection template', async () => {
    const { srv, as, notified } = await setup();
    try {
        await fetch(`${srv.url}/api/admin/users/${TARGET}/reject`, { method: 'POST', headers: as('admin') });
        assert.deepEqual(notified, [['rejected', TARGET]]);
    } finally { await srv.close(); }
});

test('invalid id → 400, unknown id → 404', async () => {
    const { srv, as } = await setup();
    try {
        assert.equal((await fetch(`${srv.url}/api/admin/users/not-a-uuid/approve`, { method: 'POST', headers: as('admin') })).status, 400);
        const missing = await fetch(`${srv.url}/api/admin/users/33333333-3333-4333-8333-333333333333/approve`, { method: 'POST', headers: as('admin') });
        assert.equal(missing.status, 404);
    } finally { await srv.close(); }
});

test('approval succeeds when the audit write fails', async () => {
    const { srv, as, notified } = await setup({ auditFails: true });
    try {
        const res = await fetch(`${srv.url}/api/admin/users/${TARGET}/approve`, { method: 'POST', headers: as('admin') });
        assert.equal(res.status, 200);
        assert.deepEqual(notified, [['approved', TARGET]]);
    } finally { await srv.close(); }
});

test('profileAdmin talks to PostgREST correctly', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url, init });
        if (init.method === 'POST') return new Response(null, { status: 201 });
        return new Response(JSON.stringify([pendingRow]), { status: 200 });
    };
    const pa = createProfileAdmin({ supabaseUrl: 'https://op.supabase.co', serviceKey: 'svc', fetchImpl });

    await pa.listByStatus('pending');
    assert.equal(calls[0].url, 'https://op.supabase.co/rest/v1/profiles?status=eq.pending&select=id,full_name,email,phone,status,role,signup_provider,created_at,approved_at&order=created_at.desc');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer svc');

    await pa.setStatus(TARGET, 'approved', 'admin');
    assert.equal(calls[1].url, `https://op.supabase.co/rest/v1/profiles?id=eq.${TARGET}`);
    assert.equal(calls[1].init.method, 'PATCH');
    assert.equal(calls[1].init.headers.Prefer, 'return=representation');
    const patch = JSON.parse(calls[1].init.body);
    assert.equal(patch.status, 'approved');
    assert.equal(patch.approved_by, 'admin');
    assert.ok(!Number.isNaN(Date.parse(patch.approved_at)));

    await pa.audit('admin', TARGET, 'approve');
    assert.equal(calls[2].url, 'https://op.supabase.co/rest/v1/admin_audit_log');
    assert.deepEqual(JSON.parse(calls[2].init.body), { admin_id: 'admin', target_id: TARGET, action: 'approve' });
});

test('profileAdmin.setStatus to rejected clears approved_at', async () => {
    let body;
    const pa = createProfileAdmin({ supabaseUrl: 'https://x', serviceKey: 's', fetchImpl: async (url, init) => { body = JSON.parse(init.body); return new Response('[]', { status: 200 }); } });
    assert.equal(await pa.setStatus(TARGET, 'rejected', 'admin'), null);
    assert.equal(body.approved_at, null);
});
