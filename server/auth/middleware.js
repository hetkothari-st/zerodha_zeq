import { sendError } from './errors.js';

// Wraps async middleware/handlers so rejections reach the Express error handler.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Chains: requireUser = signed in + approved + current session.
//         requireAdmin = requireUser + role admin.
export function createAuthMiddleware({ verify, profiles }) {
    function bearer(req) {
        const header = req.get('authorization') || '';
        return header.startsWith('Bearer ') ? header.slice(7) : null;
    }

    async function loadProfile(req, res) {
        try {
            return await profiles.get(req.auth.userId);
        } catch (err) {
            console.error('[auth] profile lookup failed:', err.message);
            sendError(res, 'auth_unavailable');
            return undefined;
        }
    }

    async function authenticate(req, res, next) {
        const token = bearer(req);
        if (!token) return sendError(res, 'unauthenticated');
        try {
            req.auth = await verify(token);
        } catch (err) {
            if (err?.code === 'AUTH_UNAVAILABLE') {
                console.error('[auth] token verification unavailable:', err.message);
                return sendError(res, 'auth_unavailable');
            }
            return sendError(res, 'unauthenticated');
        }
        const profile = await loadProfile(req, res);
        if (profile === undefined) return;
        if (!profile) return sendError(res, 'unauthenticated');
        req.auth.profile = profile;
        next();
    }

    // A just-signed-in device can race the 15 s cache, so refetch once before rejecting.
    async function requireCurrentSession(req, res, next) {
        if (req.auth.profile.current_session_id !== req.auth.sessionId) {
            profiles.bust(req.auth.userId);
            const fresh = await loadProfile(req, res);
            if (fresh === undefined) return;
            if (!fresh || fresh.current_session_id !== req.auth.sessionId) return sendError(res, 'signed_in_elsewhere');
            req.auth.profile = fresh;
        }
        next();
    }

    function requireApproved(req, res, next) {
        if (req.auth.profile.status !== 'approved') return sendError(res, 'not_approved');
        next();
    }

    function requireAdminRole(req, res, next) {
        if (req.auth.profile.role !== 'admin') return sendError(res, 'forbidden');
        next();
    }

    const requireUser = [wrap(authenticate), requireApproved, wrap(requireCurrentSession)];
    return { requireUser, requireAdmin: [...requireUser, requireAdminRole] };
}
