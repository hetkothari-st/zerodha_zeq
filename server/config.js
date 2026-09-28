const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'APP_ORIGIN', 'HUB_SHARED_SECRET'];

export function loadConfig(env, { defaultPort }) {
    const missing = REQUIRED.filter((k) => !env[k]);
    if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);
    return {
        port: Number(env.PORT) || defaultPort,
        appOrigin: env.APP_ORIGIN,
        productName: env.PRODUCT_NAME || 'Funnel',
        supabaseUrl: env.SUPABASE_URL.replace(/\/$/, ''),
        supabaseServiceKey: env.SUPABASE_SERVICE_KEY,
        hubUrl: env.WS_HUB_URL || 'http://127.0.0.1:8765',
        hubPublicUrl: env.HUB_PUBLIC_URL || '',
        hubSharedSecret: env.HUB_SHARED_SECRET,
        kiteApiKey: env.ZERODHA_API_KEY || '',
        kiteApiSecret: env.ZERODHA_API_SECRET || '',
        kiteAccessToken: env.ZERODHA_ACCESS_TOKEN || '',
        resendApiKey: env.RESEND_API_KEY || '',
        emailFrom: env.EMAIL_FROM || '',
        msg91AuthKey: env.MSG91_AUTH_KEY || '',
        msg91ApprovedTemplateId: env.MSG91_APPROVED_TEMPLATE_ID || '',
        // Mobile OTP verification is on hold during development until SMS/DLT is live.
        // Set REQUIRE_MOBILE=true to require a verified phone before admin approval again.
        requireMobile: env.REQUIRE_MOBILE === 'true',
        razorpayKeyId: env.RAZORPAY_KEY_ID || '',
        razorpayKeySecret: env.RAZORPAY_KEY_SECRET || '',
        razorpayWebhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
        razorpayPlanId: env.RAZORPAY_PLAN_ID || '',
        proPriceLabel: env.PRO_PRICE_LABEL || '',
        // Payments stay off (routes 404, everything unlocked) until every Razorpay value is set.
        billingEnabled: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.RAZORPAY_WEBHOOK_SECRET && env.RAZORPAY_PLAN_ID),
    };
}
