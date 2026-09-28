import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readE2EEnv } from './env.js';

const base = { E2E_BASE_URL: 'https://funnel-op-staging.up.railway.app', E2E_SUPABASE_URL: 'https://x.supabase.co', E2E_SUPABASE_SERVICE_KEY: 'k' };

test('guard refuses production target', () => {
    assert.throws(() => readE2EEnv({ ...base, E2E_BASE_URL: 'https://funnelop.in' }), /refusing/i);
});
test('allows staging and localhost, and explicit override', () => {
    assert.equal(readE2EEnv(base).baseUrl, base.E2E_BASE_URL);
    assert.equal(readE2EEnv({ ...base, E2E_BASE_URL: 'http://localhost:5191' }).baseUrl, 'http://localhost:5191');
    assert.equal(readE2EEnv({ ...base, E2E_BASE_URL: 'https://funnelop.in', E2E_ALLOW_ANY_TARGET: '1' }).baseUrl, 'https://funnelop.in');
});
test('guard ignores staging appearing outside the hostname (path/query/fragment)', () => {
    assert.throws(() => readE2EEnv({ ...base, E2E_BASE_URL: 'https://funnelop.in/?staging=1' }), /refusing/i);
    assert.throws(() => readE2EEnv({ ...base, E2E_BASE_URL: 'https://funnelop.in/#localhost' }), /refusing/i);
});
test('guard requires the literal hostname localhost/127.0.0.1, not a lookalike subdomain', () => {
    assert.throws(() => readE2EEnv({ ...base, E2E_BASE_URL: 'https://localhost.evil.com' }), /refusing/i);
});
test('guard requires a staging label AND a trusted suffix, so a spoofed label-only hostname is refused', () => {
    assert.throws(() => readE2EEnv({ ...base, E2E_BASE_URL: 'https://staging-funnelop.in.evil.com' }), /refusing/i);
    // Also true for a hostname that merely has the "staging" label but isn't *.up.railway.app or listed:
    assert.throws(() => readE2EEnv({ ...base, E2E_BASE_URL: 'https://staging.funnelop.in' }), /refusing/i);
});
test('E2E_STAGING_HOSTS allows an exact non-Railway staging hostname (still requires the staging label)', () => {
    assert.equal(readE2EEnv({ ...base, E2E_BASE_URL: 'https://staging.funnelop.in', E2E_STAGING_HOSTS: 'staging.funnelop.in' }).baseUrl, 'https://staging.funnelop.in');
    assert.throws(() => readE2EEnv({ ...base, E2E_BASE_URL: 'https://other.funnelop.in', E2E_STAGING_HOSTS: 'staging.funnelop.in' }), /refusing/i);
});
test('hostname comparison is case-insensitive', () => {
    assert.equal(readE2EEnv({ ...base, E2E_BASE_URL: 'https://FUNNEL-OP-STAGING.UP.RAILWAY.APP' }).baseUrl, 'https://FUNNEL-OP-STAGING.UP.RAILWAY.APP');
});
test('defaults and run id', () => {
    const e = readE2EEnv(base);
    assert.equal(e.emailDomain, 'funnel-e2e.test');
    assert.match(e.runId, /^[a-z0-9]{8}$/);
});
test('missing required vars → null (suite skips)', () => {
    assert.equal(readE2EEnv({}), null);
});
