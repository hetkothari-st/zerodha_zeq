'use strict';

const CLOSE_CODES = { unauthenticated: 4401, not_approved: 4403, signed_in_elsewhere: 4409, unavailable: 1013 };

function createGate({ hubAuth, allowedOrigins }) {
    async function admit(req) {
        const origin = req.headers.origin;
        if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) return { ok: false, http: 403 };
        const token = new URL(req.url, 'http://hub.local').searchParams.get('token');
        if (!token) return { ok: false, reason: 'unauthenticated' };
        return hubAuth.authenticate(token);
    }

    // Periodic re-validation of connected clients. Supabase outages never disconnect anyone.
    async function recheck(clients) {
        await Promise.all([...clients].map(async ([ws, identity]) => {
            const result = await hubAuth.check(identity);
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
