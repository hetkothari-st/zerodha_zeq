import { createAuthMiddleware } from '../../server/auth/middleware.js';

// In-memory profile store with the same caching semantics as the real one
// (cached until bust), plus a verifier that accepts "test:<userId>:<sessionId>".
export function fakeProfileStore(initial = {}) {
    const db = new Map(Object.entries(initial));
    const cache = new Map();
    const calls = [];
    const busted = [];
    return {
        db, calls, busted,
        async get(id) {
            if (cache.has(id)) return cache.get(id);
            calls.push(id);
            const p = db.has(id) ? { ...db.get(id) } : null;
            cache.set(id, p);
            return p;
        },
        bust(id) { busted.push(id); cache.delete(id); },
    };
}

export function fakeAuth(initialProfiles = {}) {
    const profiles = fakeProfileStore(initialProfiles);
    const verify = async (token) => {
        const [prefix, userId, sessionId] = String(token).split(':');
        if (prefix !== 'test' || !userId || !sessionId) throw new Error('bad token');
        return { userId, sessionId };
    };
    return {
        auth: createAuthMiddleware({ verify, profiles }),
        profiles,
        tokenFor: (userId, sessionId = 's1') => `test:${userId}:${sessionId}`,
    };
}

export const approvedUser = { id: 'user', status: 'approved', role: 'user', current_session_id: 's1' };
export const approvedAdmin = { id: 'admin', status: 'approved', role: 'admin', current_session_id: 's1' };
