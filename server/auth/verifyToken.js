import { createRemoteJWKSet, jwtVerify } from 'jose';

// jose codes that mean "this token is not acceptable" (→ 401). Anything else thrown
// while verifying — JWKS timeouts, fetch/network errors, JWKS HTTP failures — is an
// infrastructure problem and must not sign users out (→ 503).
const BAD_TOKEN_CODES = new Set([
    'ERR_JWKS_NO_MATCHING_KEY',
    'ERR_JWKS_INVALID',
    'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
    'ERR_JOSE_ALG_NOT_ALLOWED',
    'ERR_JOSE_NOT_SUPPORTED',
]);

export function isBadTokenError(err) {
    const code = typeof err?.code === 'string' ? err.code : '';
    return code.startsWith('ERR_JWT_') || code.startsWith('ERR_JWS_') || code.startsWith('ERR_JWK_') || BAD_TOKEN_CODES.has(code);
}

function authUnavailable(cause) {
    const err = new Error(`token verification unavailable: ${cause?.message ?? cause}`);
    err.code = 'AUTH_UNAVAILABLE';
    err.cause = cause;
    return err;
}

// Verifies Supabase access tokens offline against the project's JWKS.
// `jwks` is injectable for tests; production fetches and caches the remote set.
// Rejects with err.code === 'AUTH_UNAVAILABLE' for infrastructure failures; any
// other rejection means the token itself is invalid.
export function createTokenVerifier({ supabaseUrl, jwks }) {
    const issuer = `${supabaseUrl}/auth/v1`;
    const keySet = jwks ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

    return async function verify(token) {
        let payload;
        try {
            ({ payload } = await jwtVerify(token, keySet, { issuer, audience: 'authenticated' }));
        } catch (err) {
            if (isBadTokenError(err)) throw err;
            throw authUnavailable(err);
        }
        if (!payload.sub || !payload.session_id) {
            const err = new Error('token missing sub or session_id');
            err.code = 'ERR_JWT_CLAIM_MISSING';
            throw err;
        }
        return { userId: payload.sub, sessionId: payload.session_id };
    };
}
