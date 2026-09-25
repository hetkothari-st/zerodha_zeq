import { test, expect, vi } from 'vitest';
import { createApiFetch } from './apiFetch';
import { NETWORK_MESSAGE } from './errors';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('adds Bearer token and JSON body', async () => {
    const fetchImpl = vi.fn(async () => json(200, { ok: true }));
    const api = createApiFetch({ getAccessToken: async () => 'tok', fetchImpl });
    const r = await api('/api/x', { method: 'POST', body: { a: 1 } });
    expect(r).toEqual({ ok: true, status: 200, data: { ok: true } });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
});
test('401 signed_in_elsewhere → onSignedInElsewhere, not onUnauthenticated', async () => {
    const onSignedInElsewhere = vi.fn(); const onUnauthenticated = vi.fn();
    const api = createApiFetch({ getAccessToken: async () => 't', onSignedInElsewhere, onUnauthenticated,
        fetchImpl: async () => json(401, { code: 'signed_in_elsewhere', message: 'You signed in on another device.' }) });
    const r = await api('/api/x');
    expect(r).toMatchObject({ ok: false, status: 401, code: 'signed_in_elsewhere' });
    expect(onSignedInElsewhere).toHaveBeenCalledOnce();
    expect(onUnauthenticated).not.toHaveBeenCalled();
});
test('other 401 → onUnauthenticated', async () => {
    const onUnauthenticated = vi.fn();
    const api = createApiFetch({ getAccessToken: async () => 't', onUnauthenticated, fetchImpl: async () => json(401, { code: 'unauthenticated', message: 'Please sign in.' }) });
    await api('/api/x');
    expect(onUnauthenticated).toHaveBeenCalledOnce();
});
test('network failure → friendly network message', async () => {
    const api = createApiFetch({ getAccessToken: async () => null, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    expect(await api('/api/x')).toEqual({ ok: false, status: 0, code: 'network', message: NETWORK_MESSAGE });
});
test('non-JSON error body still yields a message', async () => {
    const api = createApiFetch({ getAccessToken: async () => 't', fetchImpl: async () => new Response('<html>', { status: 502 }) });
    const r = await api('/api/x');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('internal');
    expect(r.message).toBe('Something went wrong. Please try again.');
});
