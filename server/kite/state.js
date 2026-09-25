import crypto from 'crypto';

// Signed, self-contained OAuth state that ties a Kite login redirect back to an
// admin-initiated login. OP and EQ share one Kite API key (one redirect URL), so a
// state issued by either server must verify on both: they share `secret`
// (HUB_SHARED_SECRET). Format (URL-safe): <base64url nonce>.<expiryMs>.<base64url HMAC>.
// Replay is blocked per server by remembering consumed nonces until they expire.
export function createStateStore({ secret, ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
    if (!secret) throw new Error('createStateStore: secret is required');
    const used = new Map(); // nonce -> expiryMs

    const sign = (nonce, expiry) => crypto.createHmac('sha256', secret).update(`${nonce}.${expiry}`).digest('base64url');

    function prune() {
        const t = now();
        for (const [nonce, expiry] of used) if (expiry < t) used.delete(nonce);
    }

    function validSignature(nonce, expiry, sig) {
        const expected = Buffer.from(sign(nonce, expiry));
        const given = Buffer.from(sig);
        return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    }

    return {
        issue() {
            const nonce = crypto.randomBytes(24).toString('base64url');
            const expiry = now() + ttlMs;
            return `${nonce}.${expiry}.${sign(nonce, expiry)}`;
        },
        consume(state) {
            if (typeof state !== 'string' || !state) return false;
            const parts = state.split('.');
            if (parts.length !== 3) return false;
            const [nonce, expiryStr, sig] = parts;
            if (!/^[A-Za-z0-9_-]+$/.test(nonce) || !/^\d+$/.test(expiryStr) || !/^[A-Za-z0-9_-]+$/.test(sig)) return false;
            if (!validSignature(nonce, expiryStr, sig)) return false;
            const expiry = Number(expiryStr);
            if (expiry < now()) return false;
            prune();
            if (used.has(nonce)) return false;
            used.set(nonce, expiry);
            return true;
        },
    };
}
