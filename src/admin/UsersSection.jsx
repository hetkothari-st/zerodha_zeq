import React, { useCallback, useEffect, useRef, useState } from 'react';
import { theme } from '../auth/theme';

const TABS = [{ value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }];

export default function UsersSection({ apiFetch }) {
    const c = theme.classes;
    const [status, setStatus] = useState('pending');
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [busyId, setBusyId] = useState(null);
    // Bumped on every load() call so a response from a superseded request (e.g. the
    // previous tab's still-in-flight fetch) can be told apart from the latest one and ignored.
    const requestIdRef = useRef(0);

    const load = useCallback(async () => {
        const requestId = ++requestIdRef.current;
        const requestStatus = status;
        setLoading(true); setError(null);
        const r = await apiFetch(`/api/admin/users?status=${requestStatus}`);
        if (requestIdRef.current !== requestId) return; // a newer request superseded this one; drop the stale response
        setLoading(false);
        if (r.ok) setUsers(r.data.users || []); else setError(r.message);
    }, [apiFetch, status]);

    useEffect(() => { load(); }, [load]);

    async function act(user, action) {
        if (busyId) return;
        setBusyId(user.id); setError(null);
        const r = await apiFetch(`/api/admin/users/${user.id}/${action}`, { method: 'POST' });
        setBusyId(null);
        if (r.ok) load(); else setError(r.message);
    }

    return (
        <section className={`${c.card} flex flex-col gap-4`}>
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">Users</h2>
                <div role="tablist" className={c.tabs}>
                    {TABS.map((t) => (
                        <button key={t.value} type="button" role="tab" aria-selected={status === t.value}
                            className={status === t.value ? c.tabOn : c.tabOff} onClick={() => setStatus(t.value)}>{t.label}</button>
                    ))}
                </div>
            </div>
            {error && <div role="alert" className={c.error}>{error}</div>}
            {loading ? <p className={c.muted}>Loading…</p> : users.length === 0 ? <p className={c.muted}>No {status} users.</p> : (
                <table className="w-full text-left text-sm">
                    <thead><tr className={c.muted}><th className="py-2">Name</th><th>Email</th><th>Mobile</th><th>Signed up via</th><th>Joined</th><th /></tr></thead>
                    <tbody>
                        {users.map((u) => (
                            <tr key={u.id} className="border-t border-current/10">
                                <td className="py-2 font-semibold">{u.full_name || '—'}</td>
                                <td>{u.email || '—'}</td>
                                <td>{u.phone || <span className={c.muted}>not verified</span>}</td>
                                <td>{u.signup_provider}</td>
                                <td>{new Date(u.created_at).toLocaleDateString('en-IN')}</td>
                                <td className="flex justify-end gap-2 py-2">
                                    {status !== 'approved' && (
                                        <button type="button" className={c.secondary} aria-label={`Approve ${u.full_name || u.email}`}
                                            disabled={busyId === u.id} onClick={() => act(u, 'approve')}>Approve</button>
                                    )}
                                    {status !== 'rejected' && (
                                        <button type="button" className={c.secondary} aria-label={`Reject ${u.full_name || u.email}`}
                                            disabled={busyId === u.id} onClick={() => act(u, 'reject')}>Reject</button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}
