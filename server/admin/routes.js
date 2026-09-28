import express from 'express';
import { sendError } from '../auth/errors.js';
import { wrap } from '../auth/middleware.js';

const STATUSES = new Set(['pending', 'approved', 'rejected']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAdminRouter({ auth, profileAdmin, profiles, notifier, requireMobile = false }) {
    const router = express.Router();

    router.get('/api/admin/users', ...auth.requireAdmin, wrap(async (req, res) => {
        const status = req.query.status ?? 'pending';
        if (!STATUSES.has(status)) return sendError(res, 'bad_request', 'status must be pending, approved or rejected');
        try {
            res.json({ users: await profileAdmin.listByStatus(status) });
        } catch (err) {
            console.error('[admin] list failed:', err.message);
            sendError(res, 'auth_unavailable');
        }
    }));

    for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected']]) {
        router.post(`/api/admin/users/:id/${action}`, ...auth.requireAdmin, wrap(async (req, res) => {
            const { id } = req.params;
            if (!UUID.test(id)) return sendError(res, 'bad_request', 'Invalid user id.');
            if (id.toLowerCase() === String(req.auth.userId).toLowerCase()) {
                return sendError(res, 'bad_request', "You can't change your own account status.");
            }

            let updated;
            try {
                if (status === 'approved') {
                    if (requireMobile) {
                        const target = await profileAdmin.getById(id);
                        if (!target) return sendError(res, 'not_found', 'No such user.');
                        if (!target.phone) return sendError(res, 'bad_request', "This user hasn't verified a mobile number yet.");
                    } else if (!(await profileAdmin.getById(id))) {
                        return sendError(res, 'not_found', 'No such user.');
                    }
                }
                updated = await profileAdmin.setStatus(id, status, req.auth.userId);
            } catch (err) {
                console.error(`[admin] ${action} failed:`, err.message);
                return sendError(res, 'auth_unavailable');
            }
            if (!updated) return sendError(res, 'not_found', 'No such user.');

            profiles.bust(id);
            try {
                await profileAdmin.audit(req.auth.userId, id, action);
            } catch (err) {
                console.error(`[admin] audit write failed for ${action} ${id}:`, err.message);
            }
            await (status === 'approved' ? notifier.userApproved(updated) : notifier.userRejected(updated));
            res.json({ ok: true, user: updated });
        }));
    }

    for (const [action, value] of [['grant_comp', true], ['revoke_comp', false]]) {
        router.post(`/api/admin/users/:id/${action}`, ...auth.requireAdmin, wrap(async (req, res) => {
            const { id } = req.params;
            if (!UUID.test(id)) return sendError(res, 'bad_request', 'Invalid user id.');
            let updated;
            try {
                updated = await profileAdmin.setCompPro(id, value);
            } catch (err) {
                console.error(`[admin] ${action} failed:`, err.message);
                return sendError(res, 'auth_unavailable');
            }
            if (!updated) return sendError(res, 'not_found', 'No such user.');
            try {
                await profileAdmin.audit(req.auth.userId, id, action);
            } catch (err) {
                console.error(`[admin] audit write failed for ${action} ${id}:`, err.message);
            }
            res.json({ ok: true, user: updated });
        }));
    }

    return router;
}
