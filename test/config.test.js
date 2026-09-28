import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

const base = {
    SUPABASE_URL: 'https://op.supabase.co/',
    SUPABASE_SERVICE_KEY: 'service',
    APP_ORIGIN: 'https://funnelop.in',
    HUB_SHARED_SECRET: 'hub-secret',
};

test('loadConfig lists every missing required variable', () => {
    assert.throws(() => loadConfig({}, { defaultPort: 3001 }),
        /SUPABASE_URL, SUPABASE_SERVICE_KEY, APP_ORIGIN, HUB_SHARED_SECRET/);
});

test('loadConfig applies defaults and strips the trailing slash', () => {
    const c = loadConfig(base, { defaultPort: 3001 });
    assert.equal(c.port, 3001);
    assert.equal(c.supabaseUrl, 'https://op.supabase.co');
    assert.equal(c.hubUrl, 'http://127.0.0.1:8765');
    assert.equal(c.productName, 'Funnel');
    assert.equal(c.kiteAccessToken, '');
    assert.equal(c.requireMobile, false);
});

test('loadConfig only sets requireMobile true for the literal string "true"', () => {
    assert.equal(loadConfig({ ...base, REQUIRE_MOBILE: 'true' }, { defaultPort: 3001 }).requireMobile, true);
    assert.equal(loadConfig({ ...base, REQUIRE_MOBILE: '1' }, { defaultPort: 3001 }).requireMobile, false);
    assert.equal(loadConfig({ ...base, REQUIRE_MOBILE: 'false' }, { defaultPort: 3001 }).requireMobile, false);
});

test('loadConfig reads PORT and optional values', () => {
    const c = loadConfig({ ...base, PORT: '8080', PRODUCT_NAME: 'Funnel Op', ZERODHA_API_KEY: 'k',
        WS_HUB_URL: 'http://ws-hub.railway.internal:8765', HUB_PUBLIC_URL: 'wss://hub.example' }, { defaultPort: 3001 });
    assert.equal(c.port, 8080);
    assert.equal(c.productName, 'Funnel Op');
    assert.equal(c.kiteApiKey, 'k');
    assert.equal(c.hubUrl, 'http://ws-hub.railway.internal:8765');
    assert.equal(c.hubPublicUrl, 'wss://hub.example');
});
