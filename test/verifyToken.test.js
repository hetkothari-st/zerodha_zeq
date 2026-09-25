import { test } from 'node:test';
import assert from 'node:assert/strict';
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
