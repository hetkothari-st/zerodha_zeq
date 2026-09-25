import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errors as joseErrors } from 'jose';
import { createTokenVerifier } from '../server/auth/verifyToken.js';
import { makeIssuer, USER_ID, SESSION_ID } from './helpers/tokens.js';

const op = await makeIssuer('https://op-test.supabase.co');
const eq = await makeIssuer('https://eq-test.supabase.co');
const verify = createTokenVerifier({ supabaseUrl: op.supabaseUrl, jwks: op.jwks });

test('accepts a valid token and returns user and session ids', async () => {
    assert.deepEqual(await verify(await op.sign()), { userId: USER_ID, sessionId: SESSION_ID });
});

test('rejects an expired token', async () => {
    const token = await op.sign({ expiresIn: Math.floor(Date.now() / 1000) - 60 });
    await assert.rejects(verify(token));
});

test('rejects a token from another project', async () => {
    await assert.rejects(verify(await eq.sign()));
});

test('rejects a token with our issuer but signed by a different key', async () => {
    await assert.rejects(verify(await eq.sign({ issuer: `${op.supabaseUrl}/auth/v1` })));
});

test('rejects a token with the wrong audience', async () => {
    await assert.rejects(verify(await op.sign({ audience: 'anon' })));
});

test('rejects a token without session_id', async () => {
    await assert.rejects(verify(await op.sign({ sessionId: null })), /session_id/);
});

test('rejects garbage', async () => {
    await assert.rejects(verify('not-a-jwt'));
});

test('bad tokens are verification failures, not AUTH_UNAVAILABLE', async () => {
    for (const token of ['not-a-jwt', await eq.sign(), await op.sign({ audience: 'anon' }), await op.sign({ sessionId: null })]) {
        await assert.rejects(verify(token), (err) => err.code !== 'AUTH_UNAVAILABLE');
    }
});

test('JWKS network failure → AUTH_UNAVAILABLE', async () => {
    const down = createTokenVerifier({ supabaseUrl: op.supabaseUrl, jwks: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(down(await op.sign()), (err) => err.code === 'AUTH_UNAVAILABLE');
});

test('JWKS timeout and HTTP failure → AUTH_UNAVAILABLE', async () => {
    const timeout = createTokenVerifier({ supabaseUrl: op.supabaseUrl, jwks: async () => { throw new joseErrors.JWKSTimeout(); } });
    await assert.rejects(timeout(await op.sign()), (err) => err.code === 'AUTH_UNAVAILABLE');
    const http = createTokenVerifier({ supabaseUrl: op.supabaseUrl, jwks: async () => { throw new joseErrors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response'); } });
    await assert.rejects(http(await op.sign()), (err) => err.code === 'AUTH_UNAVAILABLE');
});

test('no matching key / invalid JWKS stay verification failures', async () => {
    for (const E of [joseErrors.JWKSNoMatchingKey, joseErrors.JWKSInvalid]) {
        const v = createTokenVerifier({ supabaseUrl: op.supabaseUrl, jwks: async () => { throw new E(); } });
        await assert.rejects(v(await op.sign()), (err) => err.code !== 'AUTH_UNAVAILABLE');
    }
});
