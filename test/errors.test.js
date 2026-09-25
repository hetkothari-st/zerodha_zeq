import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { sendError } from '../server/auth/errors.js';
import { listen } from './helpers/http.js';

test('sendError maps codes to statuses and default messages', async () => {
    const app = express();
    app.get('/:code', (req, res) => sendError(res, req.params.code));
    const srv = await listen(app);
    try {
        const cases = { unauthenticated: 401, signed_in_elsewhere: 401, not_approved: 403, forbidden: 403,
            not_found: 404, bad_request: 400, rate_limited: 429, auth_unavailable: 503,
            kite_key_rejected: 503, kite_error: 502, internal: 500 };
        for (const [code, status] of Object.entries(cases)) {
            const res = await fetch(`${srv.url}/${code}`);
            assert.equal(res.status, status, code);
            const body = await res.json();
            assert.equal(body.code, code);
            assert.ok(body.message.length > 0);
        }
    } finally { await srv.close(); }
});

test('sendError uses a custom message when given', async () => {
    const app = express();
    app.get('/', (req, res) => sendError(res, 'bad_request', 'access_token required'));
    const srv = await listen(app);
    try {
        const body = await (await fetch(srv.url)).json();
        assert.deepEqual(body, { code: 'bad_request', message: 'access_token required' });
    } finally { await srv.close(); }
});
