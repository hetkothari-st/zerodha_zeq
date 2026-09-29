# Payments runbook (Razorpay)

## Deploying this code (even with billing off)
Apply `supabase/migrations/20260929000000_billing.sql` to **both** Supabase projects —
Funnel Op (`nqnylxxpnussanswccgg`) and Funnel Eq (`yntcmnvttxscqtsmxmna`) — **before** deploying
this code, even if RAZORPAY_* vars are not set yet and billing stays off. The admin user list
embeds `subscriptions(...)` and the Approve flow reads it too; both fail without the table.
Run `npx supabase@latest db push` (linked to that project) or paste the migration into the SQL
editor, once per project.

## One-time setup (per product: Funnel Op and Funnel Eq separately)
1. Razorpay dashboard → complete KYC. Ask support to enable **Subscriptions** (and UPI AutoPay).
2. Test mode: Subscriptions → Plans → Create plan: period monthly, interval 1, amount = your price. Copy `plan_…`.
3. Settings → API keys → generate test key. Copy key id and secret.
4. Settings → Webhooks → Add: URL `https://<app-origin>/api/billing/webhook`, secret = a new random string,
   events: all `subscription.*`. Copy the secret.
5. Apply the migration to the product's Supabase project:
   `npx supabase@latest db push` from the repo (linked to that project), or run
   `supabase/migrations/20260929000000_billing.sql` in the SQL editor.
   Apply the migration BEFORE deploying the new code — the admin user list embeds subscriptions(...) and fails without the table.
6. Railway (that product's service): set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET,
   RAZORPAY_PLAN_ID, PRO_PRICE_LABEL. Deploy.

## Test (test keys)
- Sign up a fresh user → Free locks visible → Upgrade → pay with Razorpay test UPI `success@razorpay`
  or test card → modal shows "You're on Pro" within ~30 s → locks gone.
- Account chip → Billing → Cancel → "Pro until <date>".
- Cancel then Resume Pro → Razorpay asks for a new mandate; no charge until the old period ends.
- Webhook deliveries: Razorpay dashboard → Webhooks → the endpoint → recent deliveries should be 200.

## Go live
1. Clear this product's Supabase test data **before any live payment is taken** — run only at
   go-live, not routinely:
   `delete from public.subscriptions; delete from public.billing_events;`
   (Do NOT use `update subscriptions set status='expired' where razorpay_subscription_id like
   'sub_%'` — that leaves test rows behind and does not clear `billing_events`, so a live webhook
   event id that happens to collide with a test one would be silently treated as a duplicate.)
2. Create the live plan + live keys + live webhook.
3. Replace the four RAZORPAY_* Railway variables (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
   RAZORPAY_WEBHOOK_SECRET, RAZORPAY_PLAN_ID) with the live values, and update PRO_PRICE_LABEL to
   match the live plan's actual price. Deploy.

## Complimentary Pro
/admin → Users → find by email → **Comp Pro**. Remove with **Remove comp**.

## Turn billing off
Unset any one of the four RAZORPAY_* variables and redeploy: every user is treated as Pro.
**Warning:** this does not stop Razorpay from charging existing subscribers — their auto-renew
(UPI AutoPay / card e-mandate) keeps running and Razorpay keeps collecting payment regardless of
what this app does. Before turning billing off, either cancel all active subscriptions in the
Razorpay dashboard first, or confirm there are no live subscribers.

## Troubleshooting
- Paid but still Free: check webhook deliveries (signature errors = wrong RAZORPAY_WEBHOOK_SECRET),
  then `select * from subscriptions where user_id = '<id>'` in Supabase.
- Refunds: Razorpay dashboard → Payments → Refund. Cancel the subscription there too if needed.
