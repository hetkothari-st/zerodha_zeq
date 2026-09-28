import express from 'express';
import path from 'path';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { sendError } from './auth/errors.js';

export function createApp({ config, distDir, routers }) {
    const app = express();
    app.set('trust proxy', 1); // Railway sits in front; needed for per-IP rate limits
    app.disable('x-powered-by');

    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", 'https://checkout.razorpay.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
                fontSrc: ["'self'", 'https://fonts.gstatic.com'],
                imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com', 'https://cdn.razorpay.com'], // Google avatars are served from lh3/lh4/… hosts
                connectSrc: ["'self'", config.supabaseUrl, config.supabaseUrl.replace(/^http/, 'ws'), 'https://api.razorpay.com', 'https://lumberjack.razorpay.com', ...(config.hubPublicUrl ? [config.hubPublicUrl] : [])],
                frameSrc: ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
                frameAncestors: ["'none'"],
                formAction: ["'self'"],
            },
        },
        crossOriginEmbedderPolicy: false,
    }));

    const WEBHOOK_PATH = '/api/billing/webhook';
    const limiter = (limit) => rateLimit({
        windowMs: 60_000,
        limit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        // Razorpay retries from a few IPs; its signature check is the gate, not a rate limit.
        skip: (req) => req.originalUrl.split('?')[0] === WEBHOOK_PATH,
        handler: (req, res) => sendError(res, 'rate_limited'),
    });
    app.use('/api/admin', limiter(20));
    app.use('/api', limiter(60));
    // The webhook signature is computed over the exact bytes, so keep them raw.
    app.use(WEBHOOK_PATH, express.raw({ type: '*/*', limit: '100kb' }));
    app.use(express.json({ limit: '10kb' }));

    for (const router of routers) app.use(router);

    app.use('/api', (req, res) => sendError(res, 'not_found'));
    app.use(express.static(distDir));
    app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err.type === 'entity.parse.failed') return sendError(res, 'bad_request', 'Malformed JSON.');
        if (err.type === 'entity.too.large') return sendError(res, 'bad_request', 'Request body too large.');
        console.error('[server] unhandled error:', err);
        sendError(res, 'internal');
    });

    return app;
}
