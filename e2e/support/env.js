import crypto from 'crypto';

// True only for a hostname we trust as a non-production target: localhost/127.0.0.1 exactly,
// or a hostname whose dot/dash-separated labels include "staging" AND that either lives under
// Railway's default domain or is explicitly allow-listed via E2E_STAGING_HOSTS (exact match).
// Deliberately hostname-only (never path/query/fragment) so `?staging=1` or `#localhost` can't
// smuggle a production host past the guard, and label-only matching is not enough on its own so
// `staging-funnelop.in.evil.com` doesn't pass just because "staging" appears as a label.
function isAllowedTarget(baseUrl, stagingHostsCsv) {
    let hostname;
    try {
        hostname = new URL(baseUrl).hostname.toLowerCase();
    } catch {
        return false;
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    if (!hostname.split(/[.-]/).includes('staging')) return false;
    if (hostname.endsWith('.up.railway.app')) return true;
    const allowed = (stagingHostsCsv || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    return allowed.includes(hostname);
}

function hostOf(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    try {
        return new URL(v.includes('://') ? v : `https://${v}`).hostname.toLowerCase();
    } catch {
        return '';
    }
}

// Returns null when the suite isn't configured (tests skip); throws when pointed at production.
export function readE2EEnv(env = process.env) {
    const baseUrl = env.E2E_BASE_URL;
    const supabaseUrl = env.E2E_SUPABASE_URL;
    const serviceKey = env.E2E_SUPABASE_SERVICE_KEY;
    if (!baseUrl || !supabaseUrl || !serviceKey) return null;
    if (env.E2E_ALLOW_ANY_TARGET !== '1' && !isAllowedTarget(baseUrl, env.E2E_STAGING_HOSTS)) {
        throw new Error(
            `Refusing to run E2E against ${baseUrl} (not staging/localhost). If this is your staging app, add its hostname to `
            + 'E2E_STAGING_HOSTS (comma-separated; the hostname must still contain a "staging" label, e.g. staging.funnelop.in). '
            + 'E2E_ALLOW_ANY_TARGET=1 is only for local special cases — never production.',
        );
    }
    // Production Supabase projects are refused outright (no override): the suite creates and
    // deletes users there.
    const supabaseHost = hostOf(supabaseUrl);
    if (!supabaseHost) throw new Error(`Refusing to run E2E: E2E_SUPABASE_URL "${supabaseUrl}" is not a valid URL.`);
    const prodHosts = (env.E2E_PROD_SUPABASE_HOSTS || '').split(',').map(hostOf).filter(Boolean);
    if (prodHosts.includes(supabaseHost)) {
        throw new Error(`Refusing to run E2E against Supabase project ${supabaseHost}: it is listed in E2E_PROD_SUPABASE_HOSTS (production). Use the staging project's URL and keys.`);
    }
    return {
        baseUrl: baseUrl.replace(/\/$/, ''),
        supabaseUrl: supabaseUrl.replace(/\/$/, ''),
        serviceKey,
        emailDomain: env.E2E_EMAIL_DOMAIN || 'funnel-e2e.test',
        testPhone: env.E2E_TEST_PHONE || '',   // a Supabase "test phone number", e.g. +919999900001
        testOtp: env.E2E_TEST_OTP || '',       // its fixed OTP, e.g. 123456
        runId: env.E2E_RUN_ID || crypto.randomBytes(4).toString('hex'),
    };
}
