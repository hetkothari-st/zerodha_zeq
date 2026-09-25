import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfileStore, supabaseProfileFetcher } from '../server/auth/profileStore.js';

function counter(profile) {
    const fn = async (id) => { fn.calls.push(id); return profile; };
    fn.calls = [];
    return fn;
}

test('caches within the TTL and refetches after it', async () => {
    let t = 0;
    const fetchProfile = counter({ id: 'u1', status: 'approved' });
    const store = createProfileStore({ fetchProfile, ttlMs: 15000, now: () => t });
    await store.get('u1');
    t = 14999;
    await store.get('u1');
    assert.equal(fetchProfile.calls.length, 1);
    t = 15000;
    await store.get('u1');
    assert.equal(fetchProfile.calls.length, 2);
});

test('bust forces the next get to refetch', async () => {
    const fetchProfile = counter({ id: 'u1' });
    const store = createProfileStore({ fetchProfile, now: () => 0 });
    await store.get('u1');
    store.bust('u1');
    await store.get('u1');
    assert.equal(fetchProfile.calls.length, 2);
});

test('fetch errors propagate and are not cached', async () => {
    let fail = true;
    const store = createProfileStore({
        fetchProfile: async () => { if (fail) throw new Error('down'); return { id: 'u1' }; },
        now: () => 0,
    });
    await assert.rejects(store.get('u1'), /down/);
    fail = false;
    assert.deepEqual(await store.get('u1'), { id: 'u1' });
});

test('supabaseProfileFetcher calls PostgREST with the service key', async () => {
    let seen;
    const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify([{ id: 'u1', status: 'pending' }]), { status: 200 }); };
    const fetchProfile = supabaseProfileFetcher({ supabaseUrl: 'https://op.supabase.co', serviceKey: 'svc', fetchImpl });
    assert.deepEqual(await fetchProfile('u1'), { id: 'u1', status: 'pending' });
    assert.equal(seen.url, 'https://op.supabase.co/rest/v1/profiles?id=eq.u1&select=id,status,role,current_session_id');
    assert.equal(seen.init.headers.apikey, 'svc');
    assert.equal(seen.init.headers.Authorization, 'Bearer svc');
});

test('supabaseProfileFetcher returns null for no rows and throws on HTTP errors', async () => {
    const empty = supabaseProfileFetcher({ supabaseUrl: 'https://x', serviceKey: 's', fetchImpl: async () => new Response('[]', { status: 200 }) });
    assert.equal(await empty('u1'), null);
    const broken = supabaseProfileFetcher({ supabaseUrl: 'https://x', serviceKey: 's', fetchImpl: async () => new Response('no', { status: 500 }) });
    await assert.rejects(broken('u1'), /500/);
});

test('supabaseProfileFetcher times out a hung request', async () => {
    let signal;
    const fetchImpl = (url, init) => new Promise((resolve, reject) => {
        signal = init.signal;
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
    const hung = supabaseProfileFetcher({ supabaseUrl: 'https://x', serviceKey: 's', fetchImpl, timeoutMs: 50 });
    await assert.rejects(hung('u1'));
    assert.ok(signal.aborted);
});
