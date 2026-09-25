'use strict';
const { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } = require('jose');

async function makeProject(name, url) {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = { ...(await exportJWK(publicKey)), kid: `${name}-key`, alg: 'ES256' };
    const project = { name, url, serviceKey: `${name}-service`, jwks: createLocalJWKSet({ keys: [jwk] }) };
    async function sign({ sub = 'u1', sessionId = 's1', issuer = `${url}/auth/v1` } = {}) {
        return new SignJWT({ session_id: sessionId })
            .setProtectedHeader({ alg: 'ES256', kid: `${name}-key` })
            .setSubject(sub).setIssuer(issuer).setAudience('authenticated')
            .setIssuedAt().setExpirationTime('1h').sign(privateKey);
    }
    return { project, sign };
}

// PostgREST fake: profiles keyed by `${projectUrl}|${userId}`; set `down = true` to fail.
function fakeRest() {
    const rows = new Map();
    const calls = [];
    const state = { down: false };
    async function fetchImpl(url, init) {
        calls.push({ url: String(url), init });
        if (state.down) return new Response('down', { status: 503 });
        const u = new URL(url);
        const id = u.searchParams.get('id').replace(/^eq\./, '');
        const row = rows.get(`${u.origin}|${id}`);
        return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
    }
    const set = (projectUrl, userId, row) => rows.set(`${projectUrl}|${userId}`, { id: userId, ...row });
    return { fetchImpl, set, calls, state };
}

function fakeSocket() {
    return { sent: [], closed: null, send(m) { this.sent.push(m); }, close(code, reason) { this.closed = { code, reason }; } };
}

module.exports = { makeProject, fakeRest, fakeSocket };
