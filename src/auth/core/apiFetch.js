import { FALLBACK_MESSAGE, NETWORK_MESSAGE } from './errors';

// fetch wrapper for our own /api: adds the Supabase token and normalises errors.
export function createApiFetch({ getAccessToken, onSignedInElsewhere, onUnauthenticated, fetchImpl = (...args) => fetch(...args) }) {
    return async function apiFetch(path, { method = 'GET', body } = {}) {
        const token = await getAccessToken();
        const headers = { Accept: 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';

        let res;
        try {
            res = await fetchImpl(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        } catch {
            return { ok: false, status: 0, code: 'network', message: NETWORK_MESSAGE };
        }
        const data = await res.json().catch(() => ({}));
        if (res.ok) return { ok: true, status: res.status, data };

        const code = data.code || 'internal';
        if (res.status === 401 && code === 'signed_in_elsewhere') onSignedInElsewhere?.();
        else if (res.status === 401) onUnauthenticated?.();
        return { ok: false, status: res.status, code, message: data.message || FALLBACK_MESSAGE };
    };
}
