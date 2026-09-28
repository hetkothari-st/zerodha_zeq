import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import UpgradeModal from './UpgradeModal';

const FREE = { plan: 'free', source: null, until: null, status: null, cancelAtPeriodEnd: false, manageUrl: null, priceLabel: '' };
const noop = async () => ({ ok: false });

export const EntitlementContext = createContext({ ...FREE, loading: false, isPro: false, billingEnabled: true, refresh: noop, openUpgrade: () => {}, closeUpgrade: () => {} });

export function EntitlementProvider({ children, pollMs = 300000 }) {
    const { apiFetch, session } = useAuth();
    const userId = session?.user?.id ?? null;
    const [state, setState] = useState({ ...FREE, loading: true, billingEnabled: true });
    const [upgradeOpen, setUpgradeOpen] = useState(false);

    // apiFetch is read through a ref (not a useCallback dependency) so refresh keeps a stable
    // identity even if a consumer's useAuth() returns a freshly-created function on every render
    // (some test doubles do); otherwise the poll/focus effect below would tear down and
    // re-register on every render, re-firing refresh and re-rendering forever.
    const apiFetchRef = useRef(apiFetch);
    apiFetchRef.current = apiFetch;

    const refresh = useCallback(async () => {
        const r = await apiFetchRef.current('/api/billing/status');
        if (r.ok) setState({ ...FREE, ...r.data, loading: false, billingEnabled: true });
        // 404 = billing not configured on this server: nothing is sellable, so nothing is locked.
        else if (r.status === 404) setState({ ...FREE, plan: 'pro', loading: false, billingEnabled: false });
        else setState((s) => ({ ...s, loading: false }));
        return r;
    }, []);

    useEffect(() => {
        if (!userId) return undefined;
        refresh();
        const id = setInterval(refresh, pollMs);
        const onFocus = () => refresh();
        window.addEventListener('focus', onFocus);
        return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
    }, [userId, refresh, pollMs]);

    const value = useMemo(() => ({
        ...state,
        isPro: state.plan === 'pro',
        refresh,
        openUpgrade: () => setUpgradeOpen(true),
        closeUpgrade: () => setUpgradeOpen(false),
    }), [state, refresh]);

    return (
        <EntitlementContext.Provider value={value}>
            {children}
            {upgradeOpen && state.billingEnabled && <UpgradeModal onClose={() => setUpgradeOpen(false)} />}
        </EntitlementContext.Provider>
    );
}

export function useEntitlement() {
    return useContext(EntitlementContext);
}
