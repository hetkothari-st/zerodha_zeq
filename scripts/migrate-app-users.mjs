#!/usr/bin/env node
// Usage (dry run):  node scripts/migrate-app-users.mjs
//        (apply):   node scripts/migrate-app-users.mjs --apply [--email-delay-ms=<n>]
// Env: OLD_SUPABASE_URL, OLD_SUPABASE_SERVICE_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, APP_ORIGIN
// --email-delay-ms: milliseconds to wait between password-set emails (default 2500), to stay under
//                   GoTrue's rate limit. On a 429 the script backs off using the Retry-After header
//                   and retries up to 3 times before giving up on that one user.
import { writeFileSync } from 'fs';
import { createSupabaseAdmin, runMigration } from './lib/migrateUsers.js';

const required = ['OLD_SUPABASE_URL', 'OLD_SUPABASE_SERVICE_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'APP_ORIGIN'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) { console.error(`Missing env: ${missing.join(', ')}`); process.exit(2); }

let oldUrl, newUrl, appOriginUrl;
try {
    oldUrl = new URL(process.env.OLD_SUPABASE_URL);
    newUrl = new URL(process.env.SUPABASE_URL);
    appOriginUrl = new URL(process.env.APP_ORIGIN);
} catch (err) {
    console.error(`Invalid URL in env: ${err.message}`);
    process.exit(2);
}

if (oldUrl.host.toLowerCase() === newUrl.host.toLowerCase()) {
    console.error('OLD_SUPABASE_URL and SUPABASE_URL are the same project; refusing.');
    process.exit(2);
}

const isLocalhost = appOriginUrl.hostname === 'localhost' || appOriginUrl.hostname === '127.0.0.1';
if (!(appOriginUrl.protocol === 'https:' || (appOriginUrl.protocol === 'http:' && isLocalhost))) {
    console.error('APP_ORIGIN must be an https:// origin (http:// is only allowed for localhost).');
    process.exit(2);
}

const apply = process.argv.includes('--apply');
const delayArg = process.argv.find((a) => a.startsWith('--email-delay-ms='));
const parsedDelay = delayArg ? Number(delayArg.split('=')[1]) : NaN;
const emailDelayMs = Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : 2500;

try {
    const report = await runMigration({
        legacy: createSupabaseAdmin({ url: process.env.OLD_SUPABASE_URL, serviceKey: process.env.OLD_SUPABASE_SERVICE_KEY }),
        target: createSupabaseAdmin({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY }),
        appOrigin: process.env.APP_ORIGIN.replace(/\/$/, ''),
        apply,
        emailDelayMs,
    });

    const file = `migration-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(file, JSON.stringify(report, null, 2));
    if (report.dryRun) {
        console.log(`DRY RUN: would create ${report.would_create.length}, would resend ${report.would_resend.length}, would skip ${report.would_skip.length}, manual ${report.manual.length}. Report: ${file}`);
    } else {
        console.log(`APPLIED: created ${report.created.length}, resent ${report.resent.length}, existing ${report.skipped_exists.length}, rejected ${report.skipped_rejected.length}, failed ${report.failed.length}, manual ${report.manual.length}. Report: ${file}`);
    }
    if (report.manual.length) console.log('Manual follow-up (no email):', report.manual.map((m) => m.username).join(', '));
    process.exit(report.failed?.length ? 1 : 0);
} catch (err) {
    console.error(`Migration failed: ${err.message}`);
    process.exit(1);
}
