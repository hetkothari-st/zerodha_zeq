import express from 'express';
import { sendError } from '../auth/errors.js';

const STATUSES = new Set(['pending', 'approved', 'rejected']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAdminRouter({ auth, profileAdmin, profiles, notifier }) {
    const router = express.Router();

    router.get('/api/admin/users', ...auth.requireAdmin, async (req, res) => {
        const status = req.query.status ?? 'pending';
        if (!STATUSES.has(status)) return sendError(res, 'bad_request', 'status must be pending, approved or rejected');
        try {
            res.json({ users: await profileAdmin.listByStatus(status) });
        } catch (err) {
            console.error('[admin] list failed:', err.message);
            sendError(res, 'auth_unavailable');
        }
    });

    for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected']]) {
        router.post(`/api/admin/users/:id/${action}`, ...auth.requireAdmin, async (req, res) => {
            const { id } = req.params;
            if (!UUID.test(id)) return sendError(res, 'bad_request', 'Invalid user id.');

            let updated;
            try {
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
        });
    }

    return router;
}
