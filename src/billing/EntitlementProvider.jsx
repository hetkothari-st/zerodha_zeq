import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import UpgradeModal from './UpgradeModal';

const FREE = { plan: 'free', source: null, until: null, status: null, cancelAtPeriodEnd: false, manageUrl: null, priceLabel: '' };
const noop = async () => ({ ok: false });
// Backoff schedule for retrying while entitlement is still unknown (no successful response yet):
// 2s, 5s, 15s, then every 30s until one succeeds.
const RETRY_DELAYS_MS = [2000, 5000, 15000];
const RETRY_STEADY_MS = 30000;

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

    // Whether any request has ever completed (success or 404-billing-off) for the current user.
    // Before that, entitlement is genuinely unknown, so the app must behave as Pro (see isPro
    // below) and keep retrying; once settled, a later transient error just keeps the last known
    // state (today's behaviour) instead of reverting to "unknown".
    const settledRef = useRef(false);
    const retryStepRef = useRef(0);
    const retryTimerRef = useRef(null);
    // Bumped whenever this provider unmounts or the signed-in user changes (in the effect
    // cleanup below, which React runs for both cases). A request that was already in flight at
    // that point must not act on its result: no setState, and — the actual leak this guards —
    // no scheduling a further retry via setTimeout once nothing is listening any more.
    const requestIdRef = useRef(0);

    const clearRetryTimer = useCallback(() => {
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    }, []);

    const refresh = useCallback(async () => {
        const requestId = requestIdRef.current;
        const r = await apiFetchRef.current('/api/billing/status');
        if (requestIdRef.current !== requestId) return r; // unmounted or user changed mid-request
        if (r.ok) {
            settledRef.current = true;
            retryStepRef.current = 0;
            clearRetryTimer();
            setState({ ...FREE, ...r.data, loading: false, billingEnabled: true });
        } else if (r.status === 404) {
            // 404 = billing not configured on this server: nothing is sellable, so nothing is locked.
            settledRef.current = true;
            retryStepRef.current = 0;
            clearRetryTimer();
            setState({ ...FREE, plan: 'pro', loading: false, billingEnabled: false });
        } else if (!settledRef.current) {
            // Unknown entitlement, not yet resolved once: stay in "loading" (isPro reads true)
            // and schedule the next retry per the backoff schedule.
            setState((s) => (s.loading ? s : { ...s, loading: true }));
            const delay = RETRY_DELAYS_MS[retryStepRef.current] ?? RETRY_STEADY_MS;
            retryStepRef.current = Math.min(retryStepRef.current + 1, RETRY_DELAYS_MS.length);
            clearRetryTimer();
            retryTimerRef.current = setTimeout(refresh, delay);
        } else {
            // Already resolved once: keep the last known state, just stop loading.
            setState((s) => ({ ...s, loading: false }));
        }
        return r;
    }, [clearRetryTimer]);

    useEffect(() => {
        if (!userId) return undefined;
        settledRef.current = false;
        retryStepRef.current = 0;
        refresh();
        const id = setInterval(refresh, pollMs);
        const onFocus = () => refresh();
        window.addEventListener('focus', onFocus);
        return () => {
            requestIdRef.current += 1; // invalidate any in-flight request (unmount or user change)
            clearInterval(id);
            window.removeEventListener('focus', onFocus);
            clearRetryTimer();
        };
    }, [userId, refresh, pollMs, clearRetryTimer]);

    const value = useMemo(() => ({
        ...state,
        // While entitlement is unknown (never resolved), the app behaves as Pro: nothing locks,
        // no data pruning — not Free.
        isPro: state.loading || state.plan === 'pro',
        refresh,
        openUpgrade: () => setUpgradeOpen(true),
        closeUpgrade: () => setUpgradeOpen(false),
    }), [state, refresh]);

    return (
        <EntitlementContext.Provider value={value}>
            {children}
            {upgradeOpen && !state.loading && state.billingEnabled && <UpgradeModal onClose={() => setUpgradeOpen(false)} />}
        </EntitlementContext.Provider>
    );
}

export function useEntitlement() {
    return useContext(EntitlementContext);
}
