'use strict';

const CLOSE_CODES = { unauthenticated: 4401, not_approved: 4403, signed_in_elsewhere: 4409, unavailable: 1013 };

function normalizeOrigin(origin) {
    if (typeof origin !== 'string') return '';
    return origin.trim().replace(/\/+$/, '').toLowerCase();
}

function createGate({ hubAuth, allowedOrigins }) {
    const normalizedAllowed = new Set(allowedOrigins.map(normalizeOrigin));

    async function admit(req) {
        const origin = req.headers.origin;
        if (typeof origin !== 'string' || !normalizedAllowed.has(normalizeOrigin(origin))) return { ok: false, http: 403 };
        let token;
        try {
            token = new URL(req.url, 'http://hub.local').searchParams.get('token');
        } catch {
            return { ok: false, reason: 'unauthenticated' };
        }
        if (!token) return { ok: false, reason: 'unauthenticated' };
        return hubAuth.authenticate(token);
    }

    // Periodic re-validation of connected clients. Supabase outages never disconnect anyone.
    async function recheck(clients) {
        await Promise.all([...clients].map(async ([ws, identity]) => {
            const result = await hubAuth.check(identity, { fresh: true });
            if (result.ok || result.reason === 'unavailable') return;
            if (result.reason === 'signed_in_elsewhere') {
                try { ws.send(JSON.stringify({ type: 'signed_in_elsewhere' })); } catch {}
            }
            clients.delete(ws);
            try { ws.close(CLOSE_CODES[result.reason], result.reason); } catch {}
        }));
    }

    return { admit, recheck };
}

module.exports = { createGate, CLOSE_CODES };
