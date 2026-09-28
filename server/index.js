import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createTokenVerifier } from './auth/verifyToken.js';
import { createProfileStore, supabaseProfileFetcher } from './auth/profileStore.js';
import { createAuthMiddleware } from './auth/middleware.js';
import { createStateStore } from './kite/state.js';
import { createHubClient } from './kite/hubClient.js';
import { createKiteRouter } from './kite/routes.js';
import { createProfileAdmin } from './admin/profileAdmin.js';
import { createAdminRouter } from './admin/routes.js';
import { createNotifier } from './notify/notifier.js';
import { createRazorpay } from './billing/razorpay.js';
import { createBillingStore } from './billing/store.js';
import { createBillingRouter } from './billing/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig(process.env, { defaultPort: 3000 });
if (!config.hubPublicUrl) console.warn('[server] HUB_PUBLIC_URL not set — browsers will be blocked from the ws-hub by CSP');
if (!config.billingEnabled) console.warn('[server] Razorpay not configured — billing off, all features unlocked');

const profiles = createProfileStore({
    fetchProfile: supabaseProfileFetcher({ supabaseUrl: config.supabaseUrl, serviceKey: config.supabaseServiceKey }),
});
const auth = createAuthMiddleware({ verify: createTokenVerifier({ supabaseUrl: config.supabaseUrl }), profiles });
const kiteSession = { accessToken: config.kiteAccessToken };

const app = createApp({
    config,
    distDir: path.resolve(__dirname, '..', 'dist'),
    routers: [
        createKiteRouter({
            config, auth, kiteSession,
            stateStore: createStateStore({ secret: config.hubSharedSecret }),
            hub: createHubClient({ hubUrl: config.hubUrl, secret: config.hubSharedSecret }),
        }),
        createAdminRouter({
            auth, profiles,
            profileAdmin: createProfileAdmin({ supabaseUrl: config.supabaseUrl, serviceKey: config.supabaseServiceKey }),
            notifier: createNotifier(config),
            requireMobile: config.requireMobile,
        }),
        ...(config.billingEnabled ? [createBillingRouter({
            auth,
            billing: createBillingStore({ supabaseUrl: config.supabaseUrl, serviceKey: config.supabaseServiceKey }),
            razorpay: createRazorpay({ keyId: config.razorpayKeyId, keySecret: config.razorpayKeySecret }),
            planId: config.razorpayPlanId,
            keyId: config.razorpayKeyId,
            webhookSecret: config.razorpayWebhookSecret,
            priceLabel: config.proPriceLabel,
        })] : []),
    ],
});

app.listen(config.port, async () => {
    console.log(`[server] listening on :${config.port}`);
    console.log(`[server] supabase: ${config.supabaseUrl}`);
    try {
        const ip = await (await fetch('https://api.ipify.org')).text();
        console.log(`[server] outbound IP: ${ip}  <-- WHITELIST THIS AT ZERODHA`);
    } catch (e) {
        console.warn('[server] could not resolve outbound IP:', e.message);
    }
});
