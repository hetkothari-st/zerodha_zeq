# Payments runbook (Razorpay)

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
- Webhook deliveries: Razorpay dashboard → Webhooks → the endpoint → recent deliveries should be 200.

## Go live
Create the live plan + live keys + live webhook, replace the four Railway variables, deploy.

## Complimentary Pro
/admin → Users → find by email → **Comp Pro**. Remove with **Remove comp**.

## Turn billing off
Unset any one of the four RAZORPAY_* variables and redeploy: every user is treated as Pro.

## Troubleshooting
- Paid but still Free: check webhook deliveries (signature errors = wrong RAZORPAY_WEBHOOK_SECRET),
  then `select * from subscriptions where user_id = '<id>'` in Supabase.
- Refunds: Razorpay dashboard → Payments → Refund. Cancel the subscription there too if needed.
