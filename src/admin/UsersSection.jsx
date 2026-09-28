import React, { useCallback, useEffect, useRef, useState } from 'react';
import { theme } from '../auth/theme';

const TABS = [{ value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }];

const OPEN_PAID = new Set(['authenticated', 'active', 'pending']);
export function planLabel(u, now = Date.now()) {
    if (u.role === 'admin') return 'Admin';
    if (u.comp_pro) return 'Comp';
    const paid = (u.subscriptions || []).some((s) => s.current_end && (
        (OPEN_PAID.has(s.status) && new Date(s.current_end).getTime() + 3 * 86400000 > now)
        || (s.status === 'cancelled' && new Date(s.current_end).getTime() > now)));
    return paid ? 'Pro' : 'Free';
}

export default function UsersSection({ apiFetch }) {
    const c = theme.classes;
    const [status, setStatus] = useState('pending');
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [busyId, setBusyId] = useState(null);
    const [counts, setCounts] = useState({}); // status → number of users, for the tab badges
    const [query, setQuery] = useState('');
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

    // Badge counts for every tab, via the same list endpoint. A failed count just hides that badge.
    const countsRequestRef = useRef(0);
    const loadCounts = useCallback(async () => {
        const requestId = ++countsRequestRef.current;
        const results = await Promise.all(TABS.map(async (t) => {
            try {
                const r = await apiFetch(`/api/admin/users?status=${t.value}`);
                return [t.value, r.ok ? (r.data.users || []).length : undefined];
            } catch {
                return [t.value, undefined];
            }
        }));
        if (countsRequestRef.current !== requestId) return;
        setCounts(Object.fromEntries(results));
    }, [apiFetch]);

    useEffect(() => { loadCounts(); }, [loadCounts]);

    async function act(user, action) {
        if (busyId) return;
        setBusyId(user.id); setError(null);
        const r = await apiFetch(`/api/admin/users/${user.id}/${action}`, { method: 'POST' });
        setBusyId(null);
        if (r.ok) { load(); loadCounts(); } else setError(r.message);
    }

    const shown = users.filter((u) => (u.email || '').toLowerCase().includes(query.trim().toLowerCase()));

    return (
        <section className={`${c.card} flex flex-col gap-4`}>
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">Users</h2>
                <div role="tablist" className={c.tabs}>
                    {TABS.map((t) => (
                        <button key={t.value} type="button" role="tab" aria-selected={status === t.value}
                            className={status === t.value ? c.tabOn : c.tabOff} onClick={() => setStatus(t.value)}>
                            {counts[t.value] === undefined ? t.label : `${t.label} (${counts[t.value]})`}
                        </button>
                    ))}
                </div>
            </div>
            {error && <div role="alert" className={c.error}>{error}</div>}
            <input type="search" aria-label="Find by email" placeholder="Find by email" className={c.input}
                value={query} onChange={(e) => setQuery(e.target.value)} />
            {loading ? <p className={c.muted}>Loading…</p> : shown.length === 0 ? <p className={c.muted}>No {status} users.</p> : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                        <thead><tr className={c.muted}><th className="py-2">Name</th><th>Email</th><th>Mobile</th><th>Signed up via</th><th>Joined</th><th>Plan</th><th /></tr></thead>
                        <tbody>
                            {shown.map((u) => (
                                <tr key={u.id} className="border-t border-current/10">
                                    <td className="py-2 font-semibold">{u.full_name || '—'}</td>
                                    <td>{u.email || '—'}</td>
                                    <td>{u.phone || <span className={c.muted}>not verified</span>}</td>
                                    <td>{u.signup_provider}</td>
                                    <td>{new Date(u.created_at).toLocaleDateString('en-IN')}</td>
                                    <td>{planLabel(u)}</td>
                                    <td className="flex justify-end gap-2 py-2">
                                        {u.role !== 'admin' && (
                                            <button type="button" className={c.secondary}
                                                aria-label={u.comp_pro ? `Remove complimentary Pro from ${u.full_name || u.email}` : `Give ${u.full_name || u.email} complimentary Pro`}
                                                disabled={busyId === u.id} onClick={() => act(u, u.comp_pro ? 'revoke_comp' : 'grant_comp')}>
                                                {u.comp_pro ? 'Remove comp' : 'Comp Pro'}
                                            </button>
                                        )}
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
                </div>
            )}
        </section>
    );
}
