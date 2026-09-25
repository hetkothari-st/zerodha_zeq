import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';

export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// A fake Supabase project: its own key pair, JWKS and a token signer.
export async function makeIssuer(supabaseUrl = 'https://op-test.supabase.co') {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256' };
    const jwks = createLocalJWKSet({ keys: [jwk] });

    async function sign({
        sub = USER_ID,
        sessionId = SESSION_ID,
        expiresIn = '1h',
        issuer = `${supabaseUrl}/auth/v1`,
        audience = 'authenticated',
    } = {}) {
        const claims = sessionId === null ? {} : { session_id: sessionId };
        return new SignJWT(claims)
            .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
            .setSubject(sub)
            .setIssuer(issuer)
            .setAudience(audience)
            .setIssuedAt()
            .setExpirationTime(expiresIn)
            .sign(privateKey);
    }

    return { supabaseUrl, jwks, sign };
}
