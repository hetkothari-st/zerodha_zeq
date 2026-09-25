'use strict';
const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify, decodeJwt } = require('jose');

// Verifies Supabase tokens from any configured product project and checks
// approval + current session against that project's profiles table.
function createHubAuth({ projects, ttlMs = 15000, now = Date.now, fetchImpl = fetch }) {
    const byIssuer = new Map(projects.map((p) => {
        const url = p.url.replace(/\/$/, '');
        const issuer = `${url}/auth/v1`;
        return [issuer, {
            name: p.name, url, issuer, serviceKey: p.serviceKey,
            keySet: p.jwks || createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)),
            cache: new Map(),
        }];
    }));

    async function fetchProfile(project, userId) {
        const hit = project.cache.get(userId);
        if (hit && now() - hit.at < ttlMs) return hit.profile;
        const res = await fetchImpl(
            `${project.url}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,status,current_session_id`,
            { headers: { apikey: project.serviceKey, Authorization: `Bearer ${project.serviceKey}` } },
        );
        if (!res.ok) throw new Error(`profile lookup failed: ${res.status}`);
        const profile = (await res.json())[0] || null;
        project.cache.set(userId, { profile, at: now() });
        return profile;
    }

    async function check(identity, fresh = false) {
        const project = byIssuer.get(identity.issuer);
        if (!project) return { ok: false, reason: 'unauthenticated' };
        if (fresh) project.cache.delete(identity.userId);
        let profile;
        try {
            profile = await fetchProfile(project, identity.userId);
        } catch {
            return { ok: false, reason: 'unavailable' };
        }
        if (!profile) return { ok: false, reason: 'unauthenticated' };
        if (profile.status !== 'approved') return { ok: false, reason: 'not_approved' };
        if (profile.current_session_id !== identity.sessionId) {
            // The cache may predate a sign-in on this device: confirm before rejecting.
            return fresh ? { ok: false, reason: 'signed_in_elsewhere' } : check(identity, true);
        }
        return { ok: true, identity };
    }

    async function authenticate(token) {
        let issuer;
        try {
            issuer = decodeJwt(token).iss;
        } catch {
            return { ok: false, reason: 'unauthenticated' };
        }
        const project = byIssuer.get(issuer);
        if (!project) return { ok: false, reason: 'unauthenticated' };
        let payload;
        try {
            ({ payload } = await jwtVerify(token, project.keySet, { issuer: project.issuer, audience: 'authenticated' }));
        } catch {
            return { ok: false, reason: 'unauthenticated' };
        }
        if (!payload.sub || !payload.session_id) return { ok: false, reason: 'unauthenticated' };
        return check({ issuer: project.issuer, project: project.name, userId: payload.sub, sessionId: payload.session_id });
    }

    return { authenticate, check: (identity) => check(identity) };
}

function hasHubSecret(headerValue, secret) {
    if (!secret || typeof headerValue !== 'string') return false;
    const a = Buffer.from(headerValue);
    const b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createHubAuth, hasHubSecret };
