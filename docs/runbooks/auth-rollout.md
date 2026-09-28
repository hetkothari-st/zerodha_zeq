# Auth rollout runbook: Funnel Op & Funnel Eq

Operator checklist for rolling out the new Supabase login to Funnel Op and Funnel Eq. Follow the sections in order. Values in `<…>` are things you fill in yourself.

## 1. What this rolls out

- A new sign-up/sign-in for both Funnel Op and Funnel Eq (Google, email + password, mobile + OTP), replacing the old plain-text `app_users` login.
- Every new user lands on a waitlist; an admin must approve them before they can use the app.
- Only one device may be signed in per account at a time.
- Ships from branch `feature/auth-rollout`, which is built on `feature/auth-frontend`, which is built on `feature/auth-backend`.

## 2. Prerequisites (business — start these first, they take the longest)

1. Register for **TRAI DLT** (India's SMS regulator): register the entity, get a header/sender ID, and submit these two templates for approval:
   - OTP template: `Your <product> code is {#var#}`
   - Approved-user template: `Hi {#var#}, you're in! Sign in to {#var#}: {#var#}` — the three `{#var#}` values map to MSG91 variables `name`, `product`, `link`, in that order.
2. Pick the SMS providers:
   - **OTP codes** (sign-in and "Add your mobile") are sent by Supabase itself, so they need an SMS provider that Supabase supports out of the box: **Twilio** (recommended), Vonage, MessageBird or Textlocal. Create an account there and register your DLT sender ID and the OTP template with it.
   - The **"you're approved" SMS** is sent by the app servers through **MSG91**. Create an MSG91 account and note the approved-user DLT template ID once it is approved.
3. Create a **Resend** account and verify a sending domain (SPF + DKIM records) for each product separately.
4. Register product domains if you haven't already, e.g. `funnelop.in` and `funneleq.in`.
5. Create a **Google Cloud OAuth client** for each product (separate client per product, branded consent screen, correct domain).

Do not start OTP testing with real phone numbers until the DLT templates are approved — the SMS providers will reject unapproved template sends. Until then, use the Supabase test phone numbers from section 3 step 5.

## 3. Supabase projects

Repeat this whole section for `op-staging` and `eq-staging` now, and again later for `op-prod` and `eq-prod` (section 9). Use region **Mumbai** for every project.

1. Open the Supabase SQL editor for the project and run the contents of `supabase/migrations/20260925000000_auth_profiles.sql`.
2. In the same SQL editor, run `supabase/checks/auth_profiles_check.sql`. Read the output: every line should start with `ok:`. If you see any `FAIL:` line, stop and fix the migration before continuing — do not proceed to step 3.
3. Go to **Authentication → URL Configuration**:
   - **Site URL** = the product's public origin, with no trailing slash, e.g. `https://funnelop.in`. The set-password email link is built from this value (step 6), so it must be exactly the address users open the app on.
   - **Redirect URLs**: add `<origin>` and `<origin>/reset-password`, e.g. `https://funnelop.in` and `https://funnelop.in/reset-password`. For staging projects only, also add `http://localhost:5191` and `http://localhost:5191/reset-password` (Funnel Op dev server) or `http://localhost:5292` and `http://localhost:5292/reset-password` (Funnel Eq dev server).
   - **Staging vs production origins:** on a staging project, `<origin>` is the product's Railway staging domain, e.g. `https://funnel-op-staging.up.railway.app` (Funnel Eq: `https://funnel-eq-staging.up.railway.app`). Use that same staging domain everywhere staging asks for an origin: Site URL and Redirect URLs here, and `APP_ORIGIN`, `HUB_ALLOWED_ORIGINS`, `HUB_PUBLIC_URL` and `VITE_WS_HUB_URL` in section 4. Never put a production domain (`funnelop.in`, `funneleq.in`) into a staging project or the staging Railway environment.
4. Go to **Authentication → Settings** (or **Policies**, depending on your Supabase version) and set:
   - Confirm email: **ON**
   - Secure email change: **ON**
   - Minimum password length: **8**
   - Leaked password protection: **ON** (if your plan offers it)
   - JWT expiry: **3600** seconds
   - **Asymmetric JWT signing keys: ON.** After enabling, open `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json` in a browser and confirm the `keys` array is not empty. If it is empty, the servers and ws-hub cannot verify tokens — do not proceed until this is populated.
5. Go to **Authentication → Providers** and enable:
   - **Google**: paste the client ID and secret from section 2 step 5. Set the authorized redirect URI on the Google Cloud side to `https://<project-ref>.supabase.co/auth/v1/callback`.
   - **Email**: already on by default; confirm it's enabled.
   - **Phone**: enable it and choose Supabase's built-in **Twilio** provider (or Vonage, MessageBird or Textlocal) — the provider from section 2 step 2, set up with your DLT-registered sender ID and OTP template. Set OTP length to **6** and OTP expiry to **300** seconds.
     - MSG91 is **not** a supported route for OTP codes here: it would need a custom Supabase "Send SMS" auth hook, which this project does not include. MSG91 is still used by the app servers for the "you're approved" SMS (section 4).
   - Staging only: under the phone provider settings, add two **test phone numbers**. Supabase never texts these numbers; it simply accepts the fixed code:
     - `+919999900001`, code `123456` — for your own staging admin account (section 6).
     - `+919999900002`, code `123456` — for the automated E2E tests only (section 7). Keep the two separate: the E2E tests delete whichever account holds their number.
6. Set up email:
   1. Go to **Project Settings → Auth → SMTP Settings** and enter the Resend host, username and password for this product. Set the sender to `<Product Name> <hello@<domain>>`, e.g. `Funnel Op <hello@funnelop.in>`.
   2. Go to **Authentication → Email Templates**. Leave **Confirm signup**, **Magic Link**, **Change Email Address** and the other templates as they are — they keep their `{{ .ConfirmationURL }}` link.
   3. Open the **Reset Password** template and replace its subject and body with the text below. This is the email migrated users receive (section 8) **and** the email sent by the in-app "Forgot password" link, so the wording works for both. For Funnel Op paste it as is; for Funnel Eq, change "Funnel Op" to "Funnel Eq".

      Subject:
      ```text
      Set your Funnel Op password
      ```
      Message body:
      ```html
      <h2>Set your Funnel Op password</h2>
      <p>Click below to choose a password (new sign-in system: you can also continue with Google).</p>
      <p><a href="{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&type=recovery">Choose a password</a></p>
      <p>If you didn't ask for this, you can ignore this email.</p>
      ```
      The link **must** be exactly `{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&type=recovery` — do not use `{{ .ConfirmationURL }}` in this one template (a `{{ .ConfirmationURL }}` link fails for migrated users). The app checks this kind of link itself, so it also works when the email is opened on a different device or browser from the one that asked for it. `{{ .SiteURL }}` is the Site URL from step 3, so the link always opens on that address, even if the reset was requested from a localhost dev server.
7. Go to **Authentication → Providers → (any identity provider) → Advanced** and turn **Automatic identity linking ON**, so a Google sign-in and an email sign-up with the same verified email become one account.
8. Before running the user migration in section 8, double-check step 3: the Site URL is exactly `<origin>` (the set-password email opens `<Site URL>/reset-password`) and `<origin>/reset-password` is in the Redirect URLs list (the in-app "Forgot password" request uses it).
9. Before running the migration in section 8 with `--apply`, go to **Authentication → Rate Limits** and raise "emails sent per hour" (under your custom SMTP) above your total user count. Otherwise some migrated users will come back in the migration report as "email rate limited — rerun later".

## 4. Railway

All of this lives under the Railway project **`funnel-zerodha`**.

1. Create a new environment called **`staging`** by duplicating the production environment (Railway → project settings → Environments → duplicate). Duplicating copies the production values, so go through every variable below and replace production values with staging ones.
2. Point each service at the rollout branch:
   - `funnel-op` → repo `hetkothari-st/zerodha_funnelop`, branch `feature/auth-rollout`.
   - `funnel-eq` → repo `hetkothari-st/zerodha_zeq`, branch `feature/auth-rollout`.
   - `ws-hub` → repo `hetkothari-st/zerodha_zeq`, branch `feature/auth-rollout`, root directory `ws-hub`.
3. Generate the shared secret once (you'll use the same value in three places below):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   In the staging environment, give each service a public domain whose name contains the word `staging` (service → **Settings → Networking → Generate Domain**, then edit the name), e.g. `funnel-op-staging.up.railway.app`, `funnel-eq-staging.up.railway.app` and `ws-hub-staging.up.railway.app`. The automated tests in section 7 refuse to run against a host without a `staging` label.

   **Staging origins:** in the staging environment every origin is a Railway staging domain, never a production one:
   - `APP_ORIGIN` = `https://funnel-op-staging.up.railway.app` on `funnel-op`, `https://funnel-eq-staging.up.railway.app` on `funnel-eq`
   - `HUB_PUBLIC_URL` and `VITE_WS_HUB_URL` = `wss://ws-hub-staging.up.railway.app`
   - `HUB_ALLOWED_ORIGINS` (on `ws-hub`) = `https://funnel-op-staging.up.railway.app,https://funnel-eq-staging.up.railway.app`
   - `SUPABASE_URL` / `VITE_SUPABASE_URL` and keys = the `op-staging` / `eq-staging` Supabase projects
4. Set these **server** variables on `funnel-op` and `funnel-eq` (values differ per product — use each product's own Supabase project ref, domain, and Zerodha app). The examples show production values; on staging use the staging values above:

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | the project's `service_role` key |
   | `APP_ORIGIN` | `https://funnelop.in` (or `https://funneleq.in`) |
   | `PRODUCT_NAME` | `Funnel Op` (or `Funnel Eq`) |
   | `HUB_SHARED_SECRET` | the value generated in step 3 (same on both servers and ws-hub) |
   | `WS_HUB_URL` | `http://ws-hub.railway.internal:8765` |
   | `HUB_PUBLIC_URL` | `wss://<hub public domain>` |
   | `ZERODHA_API_KEY` | this product's Kite Connect API key |
   | `ZERODHA_API_SECRET` | this product's Kite Connect API secret |
   | `RESEND_API_KEY` | Resend API key |
   | `EMAIL_FROM` | `Funnel Op <hello@funnelop.in>` (or the Eq equivalent) |
   | `MSG91_AUTH_KEY` | MSG91 auth key — **leave empty on staging** (see below) |
   | `MSG91_APPROVED_TEMPLATE_ID` | the approved-user DLT template ID from section 2 — **leave empty on staging** (see below) |

   **On staging, leave `MSG91_AUTH_KEY` and `MSG91_APPROVED_TEMPLATE_ID` empty** unless you are manually testing the approval SMS with your own phone number. Every approval — including the ones the automated tests make — sends an SMS to that user's phone; while these two are empty the server simply skips the SMS. If you fill them in for a manual SMS test, empty them again afterwards.

   Also add these three frontend variables to the same two services as **normal service variables**, right next to the ones above. Railway makes service variables available while the app is being built, and the build bakes these three into the frontend. After changing any of them, redeploy the service so the frontend is rebuilt:

   | Variable | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | must equal this service's `SUPABASE_URL` |
   | `VITE_SUPABASE_ANON_KEY` | the project's anon/public key |
   | `VITE_WS_HUB_URL` | must equal this service's `HUB_PUBLIC_URL` |

5. Set these variables on `ws-hub`:

   | Variable | Value |
   |---|---|
   | `PORT` | `8765` |
   | `HUB_SHARED_SECRET` | same value as on both app servers |
   | `HUB_ALLOWED_ORIGINS` | `<op origin>,<eq origin>` — production: `https://funnelop.in,https://funneleq.in`; staging: `https://funnel-op-staging.up.railway.app,https://funnel-eq-staging.up.railway.app` (no trailing slashes, no wildcards) |
   | `SUPABASE_PROJECTS` | `[{"name":"op","url":"https://<op-project-ref>.supabase.co","serviceKey":"<op-service-role-key>"},{"name":"eq","url":"https://<eq-project-ref>.supabase.co","serviceKey":"<eq-service-role-key>"}]` |
   | `ZERODHA_API_KEY` | either product's Kite Connect API key (see section 5) |

## 5. Zerodha (Kite Connect)

Set the Kite Connect app's redirect URL to `https://<the product that owns the API key>/kite/callback` — only one product needs to be the "owner" of the redirect. The automatic Kite login always lands on that owning product's URL, but it works no matter which product's admin started it, because the login `state` is HMAC-signed with `HUB_SHARED_SECRET` and both servers can verify it. The other product's admin can still connect Zerodha without going through that redirect at all: pasting a request token or access token on its own `/admin` page is a plain admin-only API call and doesn't use the login state.

## 6. First admin

For each product, once staging is deployed:
1. Sign up as yourself through the normal sign-up flow on that product's staging site. When you reach **Add your mobile**: if your DLT/SMS setup isn't live yet, enter the staging admin test number from section 3 step 5 (`9999900001`) and the code `123456`; otherwise use your own mobile number.
2. In that product's Supabase project, open the SQL editor and run:
   ```sql
   update profiles set status='approved', role='admin' where email='<your-email>';
   ```
3. Refresh the app — you should now see the `/admin` page.

## 7. Staging verification

Do this for each product once staging is deployed (section 4) and you have a staging admin (section 6).

1. **Check that one-device sign-in is recorded.** Sign in once on the product's staging site, then in that product's staging Supabase project open the SQL editor and run:
   ```sql
   select current_session_id from profiles where email = '<your-email>';
   ```
   The result must not be empty (null). If it is null, the app isn't recording the signed-in device (`claim_session()`), so stop and fix the front end before moving on.
2. Run the security check against each product (server, then hub):
   ```bash
   scripts/security-check.sh https://funnel-op-staging.up.railway.app https://ws-hub-staging.up.railway.app
   scripts/security-check.sh https://funnel-eq-staging.up.railway.app https://ws-hub-staging.up.railway.app
   ```
   (Use your real staging domains if you named them differently.) Every line must say `ok`. Any `FAIL` line must be fixed before continuing.
3. **Run the automated end-to-end (E2E) tests.** These open the staging site in a real browser and create, approve and delete test users on the staging Supabase project.
   1. One-time setup on the computer you run them from, inside each repo folder:
      ```bash
      npm ci
      npx playwright install chromium
      ```
   2. Set the test settings in the terminal (Git Bash on Windows). These are E2E-only — they are not in `.env.example` and are never deployed to Railway. For Funnel Op:
      ```bash
      export E2E_BASE_URL=https://funnel-op-staging.up.railway.app
      export E2E_SUPABASE_URL=https://<op-staging-project-ref>.supabase.co
      export E2E_SUPABASE_SERVICE_KEY=<op-staging-service-role-key>
      export E2E_TEST_PHONE=+919999900002
      export E2E_TEST_OTP=123456
      export E2E_EMAIL_DOMAIN=<a-domain-you-own-with-catch-all-email>
      export E2E_PROD_SUPABASE_HOSTS=<op-prod-project-ref>.supabase.co,<eq-prod-project-ref>.supabase.co
      ```
      For Funnel Eq use `https://funnel-eq-staging.up.railway.app` and the `eq-staging` project's URL and key instead.

      What each one is for:
      - `E2E_BASE_URL`, `E2E_SUPABASE_URL`, `E2E_SUPABASE_SERVICE_KEY` — the staging site and **staging** Supabase project to test. Never use production Supabase keys for E2E: the tests create and delete users.
      - `E2E_TEST_PHONE` / `E2E_TEST_OTP` — the E2E test phone number from section 3 step 5 (`+919999900002`, not the one your admin account uses — the tests delete whichever account holds this number). Leave both out to skip the phone sign-up test.
      - `E2E_EMAIL_DOMAIN` — the tests approve their test users, and **every approval sends a real email** to `e2e+…@<this domain>`. Use a domain you own that has a catch-all mailbox so those emails land somewhere harmless. If you leave it out, the emails go to `funnel-e2e.test`, which doesn't exist, so they bounce — acceptable for an occasional run, but many bounces can hurt your sending domain's reputation with Resend.
      - Approvals also send an SMS when `MSG91_AUTH_KEY` / `MSG91_APPROVED_TEMPLATE_ID` are set, which is why they stay **empty on staging** (section 4). (The test users' numbers start with `+9150`, which is never a real Indian mobile, as an extra safety net.)
      - `E2E_PROD_SUPABASE_HOSTS` — both **production** Supabase hosts. The tests refuse to run if `E2E_SUPABASE_URL` points at one of them. Set this on every computer that runs E2E; if the production projects don't exist yet (they are created in section 9), add it as soon as they do.

      The tests also refuse to run unless `E2E_BASE_URL` is `localhost`/`127.0.0.1` or a Railway staging host (`*.up.railway.app` with `staging` in the name). If your staging site uses its own domain, allow it explicitly — the hostname must still contain a `staging` label:
      ```bash
      export E2E_STAGING_HOSTS=staging.funnelop.in
      ```
      There is also `E2E_ALLOW_ANY_TARGET=1`, which switches this check off. It is only for local special cases (e.g. a dev server on another machine name) — never set it for anything that could be production.
   3. Run the tests, then clean up the test users (same terminal, same settings):
      ```bash
      npm run test:e2e
      npm run e2e:cleanup
      ```
      The cleanup removes any leftover `e2e+…` test users and the user holding `E2E_TEST_PHONE`.
4. **Test the migrated-user email end to end.** This proves a migrated user's "set your password" email really works before you run the migration on production.
   1. Create a throwaway Supabase project to act as the old login database (e.g. `legacy-test`; the free tier is fine). Never add test rows to the real old project that production still uses. In the throwaway project's SQL editor run the following, putting in an email inbox you can open that has no account on staging yet (a plus-address such as `you+migtest@gmail.com` works):
      ```sql
      create table if not exists public.app_users (username text primary key, password text, is_active boolean not null default true);
      insert into public.app_users (username, password, is_active) values ('<an-email-inbox-you-can-open>', 'not-used', true);
      ```
   2. In a terminal in the product's repo folder, point the migration at the throwaway project (old) and the product's **staging** project (new), then do a dry run and an apply:
      ```bash
      export OLD_SUPABASE_URL=https://<throwaway-project-ref>.supabase.co
      export OLD_SUPABASE_SERVICE_KEY=<throwaway-service-role-key>
      export SUPABASE_URL=https://<op-staging-project-ref>.supabase.co
      export SUPABASE_SERVICE_KEY=<op-staging-service-role-key>
      export APP_ORIGIN=https://funnel-op-staging.up.railway.app
      npm run migrate:users
      npm run migrate:users -- --apply
      ```
      The dry run should list your address under `would_create`; the apply should print `created 1` and `failed 0`.
   3. Open the "Set your Funnel Op password" email in a **fresh private/incognito browser window** (or on another device) and click **Choose a password**. The **Set a new password** screen must appear. Set a password; the app then continues with the normal sign-in steps (you can stop there).
      - If you see **That link has expired** instead, check the Reset Password template link and the Site URL (section 3 steps 3 and 6), then rerun the apply command (it resends the email).
   4. Clean up: in the staging project delete that user (**Authentication → Users**), delete the `migration-report-*.json` files the script wrote, and delete the throwaway project.
5. Do these manual checks on each product, on staging:
   - Sign in with Google.
   - Sign up with a real email on the same device you'll check the inbox on, and click the verification link.
   - Reset a password: click "Forgot password", open the email (on any device), set a new password, and sign in with it.
   - Approve a waitlisted user as admin, and confirm that user receives the approval email. (The approval SMS is only sent if you temporarily filled in the MSG91 variables — section 4 — and only test it with your own phone number.)
   - On `/admin`, connect Zerodha (or paste a request/access token) and confirm the connection status updates.

## 8. Existing users (migration)

Run this once per product, against that product's **production** Supabase project (do this as part of section 9, not before).

1. Set these environment variables for the migration script:
   - `OLD_SUPABASE_URL` / `OLD_SUPABASE_SERVICE_KEY` — the current project that still holds the `app_users` table. These are migration-script-only — they are not in `.env.example` and are never deployed to Railway.
   - `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` — the new production Supabase project for this product (same variables as the server's `.env.example`, just pointed at the new production project for this run).
   - `APP_ORIGIN` — this product's public origin (same variable as in `.env.example`), e.g. `https://funnelop.in`. It must be exactly the same address as the project's Site URL and the origin you added to Redirect URLs in section 3 (the set-password email opens `<Site URL>/reset-password`). It must start with `https://` (the script refuses anything else except `http://localhost`).
2. Do a dry run first:
   ```bash
   npm run migrate:users
   ```
   This writes a report file `migration-report-<timestamp>.json` and does not change anything. It lists each user as `would_create`, `would_resend`, or `would_skip`, and proves your `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` for the new project are correct. Read the report before continuing.
3. Once the dry run looks right, apply it:
   ```bash
   npm run migrate:users -- --apply
   ```
   This creates the new auth users, approves them (it never changes a user who is already `rejected`), and emails each one a set-password link (the Reset Password template from section 3 step 6). Rerunning the command is safe: users who haven't signed in yet get the email again (reported as `resent`), and users who already signed in are skipped. To space the emails out further, add `--email-delay-ms 5000` (or `--email-delay-ms=5000`); the number is milliseconds between emails and the default is `2500`. If the email service keeps refusing even after the script's automatic waits, the script stops waiting: the remaining users are still created and approved, but are reported under `failed` as "email rate limited — rerun later" — raise the email rate limit (section 3 step 9) and rerun the same command to send their emails.

   Already-signed-in users are listed in the report under `skipped_exists`. Users whose profile is already `rejected` are listed under `skipped_rejected` and get no email. Any per-user error is listed under `failed` with a reason, and the command exits with code 1 — fix the cause (for example, raise the email rate limit from section 3) and rerun. Exit code 2 means a setup problem: missing env vars, `OLD_SUPABASE_URL` and `SUPABASE_URL` pointing at the same project, or `APP_ORIGIN` not being `https://`. If the script can't read `app_users` at all, it prints `Migration failed: …` and exits 1 without writing a report.
4. The report file contains user email addresses — keep it private and delete it once you're done with it.
5. The report will also list users whose `app_users.username` is not an email address — these can't be migrated automatically. Collect real email addresses for them from the product owner, then either:
   - add each collected email as that user's `username` in `app_users` and re-run the migration (dry run first). The rerun processes all users: already-signed-in users are skipped, but every migrated user who hasn't signed in yet is sent the set-password email again. Or
   - ask them to sign up fresh, then click **Approve** for them on `/admin` → **Users**. Do **not** use the section 6 SQL for them — it also grants admin.

## 9. Production cutover

1. Create the production Supabase projects (`op-prod`, `eq-prod`) following section 3 in full — but skip the staging-only parts (no localhost Redirect URLs, no test phone numbers). Site URL is the real product domain, e.g. `https://funnelop.in`.
2. Set the production variables following section 4, but on the Railway **`production`** environment, with production domains and the production Supabase projects. Here `MSG91_AUTH_KEY` and `MSG91_APPROVED_TEMPLATE_ID` **are** filled in.
3. Point `funnel-op`, `funnel-eq` and `ws-hub` at `feature/auth-rollout` (or merge that branch into each service's normal deploy branch first).
4. Deploy `ws-hub` and both app servers together (ws-hub must be up before the servers, since the servers call it).
5. Run the security check (section 7 step 2) against the production URLs, e.g. `scripts/security-check.sh https://funnelop.in https://<hub-production-domain>`.
6. **OTP check — before migrating or announcing, verify a real OTP to your own number on the production app.** On each product's production site, sign up as yourself. At **Add your mobile**, enter your own mobile number: the SMS must arrive within about a minute and its code must be accepted. If no SMS arrives or the code is refused, stop here and fix the phone provider (section 3 step 5, section 2 step 2) — every user has to pass this step, so nothing else can go ahead until it works.
7. **Create the first admin on each production project.** Using the account from step 6 (it has now completed Add-mobile), follow section 6 steps 2–3 on that product's **production** Supabase project, and confirm you can open `/admin` on the production site. Do this before the migration and the announcement, so someone can approve new sign-ups from the first minute.
8. Run the migration (section 8) with `--apply` against production.
9. Announce the cutover to users.
10. No action needed for stale Kite tokens: the app already clears `kite_access_token` on load.

## 10. Rollback

1. In Railway, point `funnel-op` back at its previous branch/commit (`main`), and `funnel-eq` / `ws-hub` back at their previous deployment.
2. Restore the previous environment variables for those services.
3. Nothing else to do: this rollout never touches the old `app_users` table, so the old login keeps working immediately after rollback.
4. Do not drop `app_users` until at least a week after a stable launch (see section 11).

## 11. After launch

1. Once the new login has been stable for at least a week, drop the old `app_users` table (it stores plain-text passwords — don't keep it around longer than necessary).
2. Keep an eye on Railway logs for these warning strings, which indicate a broken profile or a failed notification:
   - `[auth] profile lookup failed`
   - any line starting `[notify] …` and ending `failed` or `error`
