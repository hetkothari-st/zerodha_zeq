import { createRemoteJWKSet, jwtVerify } from 'jose';

// Verifies Supabase access tokens offline against the project's JWKS.
// `jwks` is injectable for tests; production fetches and caches the remote set.
export function createTokenVerifier({ supabaseUrl, jwks }) {
    const issuer = `${supabaseUrl}/auth/v1`;
    const keySet = jwks ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

    return async function verify(token) {
        const { payload } = await jwtVerify(token, keySet, { issuer, audience: 'authenticated' });
        if (!payload.sub || !payload.session_id) throw new Error('token missing sub or session_id');
        return { userId: payload.sub, sessionId: payload.session_id };
    };
}
