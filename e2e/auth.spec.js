import { test, expect } from '@playwright/test';
import { readE2EEnv } from './support/env.js';
import { adminApi } from './support/admin.js';
import { signIn } from './support/login.js';

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const env = readE2EEnv();
test.skip(!env, 'E2E_* env not set (see docs/runbooks/auth-rollout.md)');
const admin = env ? adminApi(env) : null;
const created = [];

test.afterAll(async () => {
    for (const id of created) { try { await admin.deleteUser(id); } catch {} }
});

async function user(opts) { const u = await admin.createVerifiedUser(opts); created.push(u.id); return u; }

test('pending user waits, then enters the app after approval without reloading', async ({ page }) => {
    const u = await user({ status: 'pending' });
    await signIn(page, u);
    await expect(page.getByText("You're on the list")).toBeVisible();
    await admin.setStatus(u.id, 'approved');
    await expect(page.getByText("You're on the list")).toBeHidden({ timeout: 45_000 });
});

test('rejected user sees the not-approved screen', async ({ page }) => {
    const u = await user({ status: 'rejected' });
    await signIn(page, u);
    await expect(page.getByText("We can't approve your account right now")).toBeVisible();
});

test('user without a verified mobile is asked to add one', async ({ page }) => {
    const u = await user({ withPhone: false });
    await signIn(page, u);
    await expect(page.getByRole('heading', { name: 'Add your mobile' })).toBeVisible();
});

test('one device at a time: the first device is told within ~15 s', async ({ browser }) => {
    const u = await user({});
    const a = await (await browser.newContext()).newPage();
    const b = await (await browser.newContext()).newPage();
    await signIn(a, u);
    await expect(a.getByRole('heading', { name: 'Sign in' })).toBeHidden({ timeout: 20_000 });
    await signIn(b, u);
    await expect(b.getByRole('heading', { name: 'Sign in' })).toBeHidden({ timeout: 20_000 });
    await expect(a.getByRole('dialog')).toContainText('You signed in on another device', { timeout: 30_000 });
});

test('admin approves a pending user from /admin', async ({ page }) => {
    const boss = await user({ role: 'admin' });
    const pending = await user({ status: 'pending' });
    await signIn(page, boss);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await page.getByRole('row', { name: new RegExp(escapeRegExp(pending.email)) })
        .getByRole('button', { name: /^Approve/ }).click();
    await expect(page.getByText(pending.email)).toBeHidden({ timeout: 15_000 });
});

test('non-admin opening /admin sees no access', async ({ page }) => {
    const u = await user({});
    await signIn(page, u);
    await page.goto('/admin');
    await expect(page.getByText("You don't have access to this page.")).toBeVisible();
});

test('expired email link shows the expired screen', async ({ page }) => {
    await page.goto('/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    await expect(page.getByRole('heading', { name: 'That link has expired' })).toBeVisible();
});

test('phone-first sign-up with a Supabase test number reaches the add-email step', async ({ page }) => {
    test.skip(!env?.testPhone || !env?.testOtp, 'E2E_TEST_PHONE / E2E_TEST_OTP not set');
    const phoneDigits = env.testPhone.replace(/^\+/, '');
    async function findTestPhoneUser() {
        const r = await fetch(`${env.supabaseUrl}/auth/v1/admin/users?page=1&per_page=1000`, { headers: { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` } });
        const body = await r.json();
        return (body.users || []).find((x) => x.phone === phoneDigits);
    }
    // The test phone number is shared across runs; a crashed earlier run can leave it attached
    // to a stale user. Self-heal by clearing it before we try to use it.
    const stale = await findTestPhoneUser();
    if (stale) { try { await admin.deleteUser(stale.id); } catch {} }
    try {
        await page.goto('/');
        await page.getByRole('button', { name: 'Create an account' }).click();
        await page.getByRole('tab', { name: 'Mobile OTP' }).click();
        await page.getByLabel('Mobile number').fill(env.testPhone.replace(/^\+91/, ''));
        await page.getByRole('button', { name: 'Send code' }).click();
        await page.getByLabel('6-digit code').fill(env.testOtp);
        await page.getByRole('button', { name: 'Verify' }).click();
        await expect(page.getByRole('heading', { name: 'A few more details' })).toBeVisible();
    } finally {
        // Look the user up by phone regardless of whether the assertions above passed, so a
        // failed run still gets cleaned up and doesn't poison the next one.
        const found = await findTestPhoneUser();
        if (found) created.push(found.id);
    }
});
