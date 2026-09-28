// Unit tests for the pure/network-shape logic in admin.js, run under `node --test` against a
// stubbed global.fetch — no real Supabase project needed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminApi } from './admin.js';

const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

function jsonRes(body, ok = true) {
    return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(body) };
}

test('createVerifiedUser retries the profile PATCH up to 5 times, then throws if no row ever comes back', async () => {
    let patchCalls = 0;
    global.fetch = async (url, init = {}) => {
        if (init.method === 'POST' && url.includes('/auth/v1/admin/users')) return jsonRes({ id: 'u1' });
        if (init.method === 'PATCH' && url.includes('/rest/v1/profiles')) { patchCalls += 1; return jsonRes([]); }
        throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
    };
    const api = adminApi({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', emailDomain: 'e2e.test', runId: 'abcd1234' });
    await assert.rejects(() => api.createVerifiedUser({}), /profile row not found for u1/);
    assert.equal(patchCalls, 5);
});

test('createVerifiedUser succeeds once the PATCH returns a row, without exhausting retries', async () => {
    let patchCalls = 0;
    global.fetch = async (url, init = {}) => {
        if (init.method === 'POST' && url.includes('/auth/v1/admin/users')) return jsonRes({ id: 'u2' });
        if (init.method === 'PATCH' && url.includes('/rest/v1/profiles')) {
            patchCalls += 1;
            return jsonRes(patchCalls < 3 ? [] : [{ id: 'u2', status: 'approved' }]);
        }
        throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
    };
    const api = adminApi({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', emailDomain: 'e2e.test', runId: 'abcd1234' });
    const u = await api.createVerifiedUser({});
    assert.equal(u.id, 'u2');
    assert.equal(patchCalls, 3);
});

test('createVerifiedUser assigns unique +9150 phone numbers (never a real Indian mobile) and a run-unique full_name', async () => {
    const created = [];
    global.fetch = async (url, init = {}) => {
        if (init.method === 'POST' && url.includes('/auth/v1/admin/users')) {
            const body = JSON.parse(init.body);
            created.push(body);
            return jsonRes({ id: `u${created.length}` });
        }
        if (init.method === 'PATCH') return jsonRes([{ id: 'x' }]);
        throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
    };
    const api = adminApi({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', emailDomain: 'e2e.test', runId: 'deadbeef' });
    await api.createVerifiedUser({});
    await api.createVerifiedUser({});
    assert.match(created[0].phone, /^\+9150\d{8}$/);
    assert.match(created[1].phone, /^\+9150\d{8}$/);
    assert.notEqual(created[0].phone, created[1].phone);
    assert.equal(created[0].user_metadata.full_name, 'E2E deadbeef 1');
    assert.equal(created[1].user_metadata.full_name, 'E2E deadbeef 2');
});

test('createVerifiedUser derives a valid phone even for a non-hex E2E_RUN_ID override', async () => {
    const created = [];
    global.fetch = async (url, init = {}) => {
        if (init.method === 'POST' && url.includes('/auth/v1/admin/users')) {
            const body = JSON.parse(init.body);
            created.push(body);
            return jsonRes({ id: `u${created.length}` });
        }
        if (init.method === 'PATCH') return jsonRes([{ id: 'x' }]);
        throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
    };
    const api = adminApi({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', emailDomain: 'e2e.test', runId: 'not-hex-run-id' });
    await api.createVerifiedUser({});
    assert.match(created[0].phone, /^\+9150\d{8}$/);
});

test('generated phones are unique across a run and never start with an Indian mobile digit (6-9)', async () => {
    const created = [];
    global.fetch = async (url, init = {}) => {
        if (init.method === 'POST' && url.includes('/auth/v1/admin/users')) {
            created.push(JSON.parse(init.body));
            return jsonRes({ id: `u${created.length}` });
        }
        if (init.method === 'PATCH') return jsonRes([{ id: 'x' }]);
        throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
    };
    const api = adminApi({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', emailDomain: 'e2e.test', runId: 'cafe0123' });
    for (let i = 0; i < 25; i += 1) await api.createVerifiedUser({});
    const phones = created.map((b) => b.phone);
    assert.equal(new Set(phones).size, phones.length);
    for (const p of phones) {
        assert.match(p, /^\+9150\d{8}$/);
        assert.doesNotMatch(p, /^\+91[6-9]/);
    }
    // A different run id gives different numbers.
    const other = adminApi({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', emailDomain: 'e2e.test', runId: 'beef4567' });
    created.length = 0;
    await other.createVerifiedUser({});
    assert.notEqual(created[0].phone, phones[0]);
});

test('deleteRunUsers paginates until a short page, matching by email prefix or an exact test-phone digit string', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}`, email: i === 0 ? 'e2e+run-1@x.test' : `other${i}@x.test` }));
    const page2 = [{ id: 'b1', email: 'someone@x.test', phone: '919999900001' }, { id: 'b2', email: 'e2e+run-2@x.test' }];
    const deletedIds = [];
    const seenPages = [];
    global.fetch = async (url, init = {}) => {
        if (init.method === 'DELETE') { deletedIds.push(url.split('/').pop()); return jsonRes(null); }
        if (url.includes('page=1&per_page=1000')) { seenPages.push(1); return jsonRes({ users: page1 }); }
        if (url.includes('page=2&per_page=1000')) { seenPages.push(2); return jsonRes({ users: page2 }); }
        if (url.includes('page=3&per_page=1000')) { seenPages.push(3); return jsonRes({ users: [] }); }
        throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
    };
    const api = adminApi({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'k', emailDomain: 'x.test', runId: 'run' });
    const count = await api.deleteRunUsers('e2e+run-', '919999900001');
    assert.equal(count, 3);
    assert.deepEqual(deletedIds.sort(), ['a0', 'b1', 'b2'].sort());
    assert.deepEqual(seenPages, [1, 2]); // stops as soon as a page comes back shorter than per_page
});
