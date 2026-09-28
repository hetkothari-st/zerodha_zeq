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
2. Create an **MSG91** account and note the DLT template IDs once approved — you'll need one for the OTP template and one for the approved-user template.
3. Create a **Resend** account and verify a sending domain (SPF + DKIM records) for each product separately.
4. Register product domains if you haven't already, e.g. `funnelop.in` and `funneleq.in`.
5. Create a **Google Cloud OAuth client** for each product (separate client per product, branded consent screen, correct domain).

Do not start OTP testing with real phone numbers until the DLT templates are approved — Supabase/MSG91 will reject unapproved template sends.

## 3. Supabase projects

Repeat this whole section for `op-staging` and `eq-staging` now, and again later for `op-prod` and `eq-prod` (section 9). Use region **Mumbai** for every project.

1. Open the Supabase SQL editor for the project and run the contents of `supabase/migrations/20260925000000_auth_profiles.sql`.
2. In the same SQL editor, run `supabase/checks/auth_profiles_check.sql`. Read the output: every line should start with `ok:`. If you see any `FAIL:` line, stop and fix the migration before continuing — do not proceed to step 3.
3. Go to **Authentication → URL Configuration**:
   - **Site URL** = the product's public origin, e.g. `https://funnelop.in`.
   - **Redirect URLs**: add `https://<origin>` and `https://<origin>/reset-password`. For staging projects only, also add `http://localhost:5191` and `http://localhost:5191/reset-password` (Funnel Op dev server) or `http://localhost:5292` and `http://localhost:5292/reset-password` (Funnel Eq dev server).
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
   - **Phone**: enable, configure the SMS provider (MSG91 via the Supabase SMS hook, or Twilio if MSG91 isn't wired yet). Set OTP length to **6** and OTP expiry to **300** seconds.
   - Staging only: under phone provider settings, add test phone numbers so OTP tests don't send real SMS, e.g. `+919999900001` with fixed code `123456`.
6. Go to **Project Settings → Auth → SMTP Settings** and enter the Resend host, username and password for this product. Set the sender to `<Product Name> <hello@<domain>>`, e.g. `Funnel Op <hello@funnelop.in>`. Leave the default email templates as-is — they use `{{ .ConfirmationURL }}`, which the PKCE sign-in flow requires. The one exception is the **Reset Password** template: edit its text to say something like "Funnel has a new sign-in: set your password or continue with Google" (keep the `{{ .ConfirmationURL }}` link) — this is the email migrated users receive.
7. Go to **Authentication → Providers → (any identity provider) → Advanced** and turn **Automatic identity linking ON**, so a Google sign-in and an email sign-up with the same verified email become one account.
8. Confirm `<origin>/reset-password` is in the Redirect URLs list (section 3 step 3) before running the user migration in section 8 — otherwise the reset-password email link falls back to the Site URL instead of the reset-password page.
9. Before running the migration in section 8 with `--apply`, go to **Authentication → Rate Limits** and raise "emails sent per hour" (under your custom SMTP) above your total user count. Otherwise some migrated users will come back in the migration report as "email rate limited — rerun later".
10. Smoke test `claim_session`: sign in once on this project's staging app, then in the SQL editor run:
    ```sql
    select current_session_id from profiles where email = '<your-email>';
    ```
    Confirm the result is not null. If it is null, `claim_session()` isn't being called after sign-in — check the front end before moving on.

## 4. Railway

All of this lives under the Railway project **`funnel-zerodha`**.

1. Create a new environment called **`staging`** by duplicating the production environment (Railway → project settings → Environments → duplicate).
2. Point each service at the rollout branch:
   - `funnel-op` → repo `hetkothari-st/zerodha_funnelop`, branch `feature/auth-rollout`.
   - `funnel-eq` → repo `hetkothari-st/zerodha_zeq`, branch `feature/auth-rollout`.
   - `ws-hub` → repo `hetkothari-st/zerodha_zeq`, branch `feature/auth-rollout`, root directory `ws-hub`.
3. Generate the shared secret once (you'll use the same value in three places below):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. Set these **server** variables on `funnel-op` and `funnel-eq` (values differ per product — use each product's own Supabase project ref, domain, and Zerodha app):

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
   | `MSG91_AUTH_KEY` | MSG91 auth key |
   | `MSG91_APPROVED_TEMPLATE_ID` | the DLT-approved template ID from section 2 |

   And these **build (Vite)** variables on the same two services — set them under the Railway "Build" variables tab, since they're baked into the frontend bundle at build time, not read at runtime:

   | Build variable | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | must equal this service's `SUPABASE_URL` |
   | `VITE_SUPABASE_ANON_KEY` | the project's anon/public key |
   | `VITE_WS_HUB_URL` | must equal this service's `HUB_PUBLIC_URL` |

5. Set these variables on `ws-hub`:

   | Variable | Value |
   |---|---|
   | `PORT` | `8765` |
   | `HUB_SHARED_SECRET` | same value as on both app servers |
   | `HUB_ALLOWED_ORIGINS` | `<op origin>,<eq origin>`, e.g. `https://funnelop.in,https://funneleq.in` (no trailing slashes, no wildcards) |
   | `SUPABASE_PROJECTS` | `[{"name":"op","url":"https://<op-project-ref>.supabase.co","serviceKey":"<op-service-role-key>"},{"name":"eq","url":"https://<eq-project-ref>.supabase.co","serviceKey":"<eq-service-role-key>"}]` |
   | `ZERODHA_API_KEY` | either product's Kite Connect API key (see section 5) |

## 5. Zerodha (Kite Connect)

Set the Kite Connect app's redirect URL to `https://<the product that owns the API key>/kite/callback` — only one product needs to be the "owner" of the redirect. The automatic Kite login always lands on that owning product's URL, but it works no matter which product's admin started it, because the login `state` is HMAC-signed with `HUB_SHARED_SECRET` and both servers can verify it. The other product's admin can still connect Zerodha without going through that redirect at all: pasting a request token or access token on its own `/admin` page is a plain admin-only API call and doesn't use the login state.

## 6. First admin

For each product, once staging is deployed:
1. Sign up as yourself through the normal sign-up flow on that product's staging site.
2. In that product's Supabase project, open the SQL editor and run:
   ```sql
   update profiles set status='approved', role='admin' where email='<your-email>';
   ```
3. Refresh the app — you should now see the `/admin` page.

## 7. Staging verification

1. Run the security check against each product (server, then hub):
   ```bash
   scripts/security-check.sh https://<op-staging-url> https://<hub-staging-url>
   scripts/security-check.sh https://<eq-staging-url> https://<hub-staging-url>
   ```
   Every line must say `ok`. Any `FAIL` line must be fixed before continuing.
2. Run the automated end-to-end tests. In each repo, set these environment variables (these are E2E-only — they are not in `.env.example` and are not deployed to Railway):
   - `E2E_BASE_URL` — the staging app URL to test against
   - `E2E_SUPABASE_URL` — that product's staging Supabase URL
   - `E2E_SUPABASE_SERVICE_KEY` — that project's `service_role` key
   - `E2E_TEST_PHONE` / `E2E_TEST_OTP` — optional; only needed for the phone-sign-up test. Set them if you added a Supabase test phone number in section 3 step 5
   - Optional: `E2E_EMAIL_DOMAIN`, `E2E_ALLOW_ANY_TARGET`

   The suite refuses to run against anything that doesn't look like a safe test target: `E2E_BASE_URL` must be `localhost`/`127.0.0.1`, or a Railway staging host (`*.up.railway.app` whose name contains "staging"). If your staging host is named differently, list it explicitly with `E2E_STAGING_HOSTS=<comma-separated exact hostnames>`. `E2E_ALLOW_ANY_TARGET=1` overrides this check — never set it when `E2E_BASE_URL` could be production.

   Then run:
   ```bash
   npm run test:e2e
   ```
   When the run finishes, clean up test data:
   ```bash
   npm run e2e:cleanup
   ```
   This removes any leftover `e2e+…` test users and the user tied to your configured `E2E_TEST_PHONE`.
3. Do these manual checks on each product, on staging:
   - Sign in with Google.
   - Sign up with a real email on the same device you'll check the inbox on, and click the verification link.
   - Reset a password on the same device (request the link, click it, set a new password, sign in with it).
   - Approve a waitlisted user as admin, and confirm that user receives the approval email and SMS.
   - On `/admin`, connect Zerodha (or paste a request/access token) and confirm the connection status updates.

## 8. Existing users (migration)

Run this once per product, against that product's **production** Supabase project (do this as part of section 9, not before).

1. Set these environment variables for the migration script:
   - `OLD_SUPABASE_URL` / `OLD_SUPABASE_SERVICE_KEY` — the current project that still holds the `app_users` table. These are migration-script-only — they are not in `.env.example` and are never deployed to Railway.
   - `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` — the new production Supabase project for this product (same variables as the server's `.env.example`, just pointed at the new production project for this run).
   - `APP_ORIGIN` — this product's public origin (same variable as in `.env.example`), e.g. `https://funnelop.in`. The set-password email links to `<APP_ORIGIN>/reset-password`, so this must be exactly the origin you added to Redirect URLs in section 3. It must start with `https://` (the script refuses anything else except `http://localhost`).
2. Do a dry run first:
   ```bash
   npm run migrate:users
   ```
   This writes a report file `migration-report-<timestamp>.json` and does not change anything. It lists each user as `would_create`, `would_resend`, or `would_skip`, and proves your `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` for the new project are correct. Read the report before continuing.
3. Once the dry run looks right, apply it:
   ```bash
   npm run migrate:users -- --apply
   ```
   This creates the new auth users, approves them (it never changes a user who is already `rejected`), and emails each one a set-password link (the Reset Password template from section 3 step 6). Rerunning the command is safe: users who haven't signed in yet get the email again (reported as `resent`), and users who already signed in are skipped. Use the `--email-delay-ms=<n>` form (with `=`, default `2500`) to space the emails out further if needed.

   Already-signed-in users are listed in the report under `skipped_exists`. Users whose profile is already `rejected` are listed under `skipped_rejected` and get no email. Any per-user error is listed under `failed` with a reason, and the command exits with code 1 — fix the cause (for example, raise the email rate limit from section 3) and rerun. Exit code 2 means a setup problem: missing env vars, `OLD_SUPABASE_URL` and `SUPABASE_URL` pointing at the same project, or `APP_ORIGIN` not being `https://`. If the script can't read `app_users` at all, it prints `Migration failed: …` and exits 1 without writing a report.
4. The report file contains user email addresses — keep it private and delete it once you're done with it.
5. The report will also list users whose `app_users.username` is not an email address — these can't be migrated automatically. Collect real email addresses for them from the product owner, then either:
   - add each collected email as that user's `username` in `app_users` and re-run the migration (dry run first). The rerun processes all users: already-signed-in users are skipped, but every migrated user who hasn't signed in yet is sent the set-password email again. Or
   - ask them to sign up fresh, then click **Approve** for them on `/admin` → **Users**. Do **not** use the section 6 SQL for them — it also grants admin.

## 9. Production cutover

1. Create the production Supabase projects (`op-prod`, `eq-prod`) following section 3 in full.
2. Set the production variables following section 4, but on the Railway **`production`** environment.
3. Point `funnel-op`, `funnel-eq` and `ws-hub` at `feature/auth-rollout` (or merge that branch into each service's normal deploy branch first).
4. Deploy `ws-hub` and both app servers together (ws-hub must be up before the servers, since the servers call it).
5. Run the security check (section 7 step 1) against the production URLs.
6. Run the migration (section 8) with `--apply` against production.
7. Announce the cutover to users.
8. No action needed for stale Kite tokens: the app already clears `kite_access_token` on load.

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
