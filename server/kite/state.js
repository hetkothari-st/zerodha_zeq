import crypto from 'crypto';

// One-time nonces that tie a Kite login redirect back to an admin-initiated login.
export function createStateStore({ ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
    const pending = new Map();
    function prune() {
        const t = now();
        for (const [nonce, expiresAt] of pending) if (expiresAt < t) pending.delete(nonce);
    }
    return {
        issue() {
            prune();
            const nonce = crypto.randomBytes(24).toString('hex');
            pending.set(nonce, now() + ttlMs);
            return nonce;
        },
        consume(nonce) {
            if (!nonce) return false;
            const expiresAt = pending.get(nonce);
            pending.delete(nonce);
            return expiresAt !== undefined && expiresAt >= now();
        },
    };
}
