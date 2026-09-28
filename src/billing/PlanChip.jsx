import React, { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { theme } from '../auth/theme';
import { useEntitlement } from './EntitlementProvider';
import { ProBadge } from './ProGate';

const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export default function PlanChip() {
    const ent = useEntitlement();
    const [open, setOpen] = useState(false);
    if (ent.loading) return null;
    if (!ent.billingEnabled) return null;
    if (!ent.isPro) {
        return (
            <button type="button" onClick={ent.openUpgrade} className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-300 hover:underline">
                Upgrade
            </button>
        );
    }
    return (
        <>
            <button type="button" onClick={() => setOpen(true)} aria-label="Pro"><ProBadge /></button>
            {open && <BillingModal onClose={() => setOpen(false)} />}
        </>
    );
}

function BillingModal({ onClose }) {
    const { apiFetch } = useAuth();
    const ent = useEntitlement();
    const c = theme.classes;
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    async function cancel() {
        setBusy(true); setError(null);
        const r = await apiFetch('/api/billing/cancel', { method: 'POST' });
        setBusy(false);
        if (!r.ok) { setError(r.message); return; }
        setConfirming(false);
        await ent.refresh();
    }

    let body;
    if (ent.source === 'comp') body = <p>Pro (complimentary)</p>;
    else if (ent.source === 'admin') body = <p>Pro (admin)</p>;
    else if (ent.cancelAtPeriodEnd) body = <p>Cancelled. Pro until {fmt(ent.until)}.</p>;
    else body = <p>Renews on {fmt(ent.until)}.</p>;

    const canCancel = ent.source === 'subscription' && !ent.cancelAtPeriodEnd;
    return (
        <div className={c.modal} role="dialog" aria-modal="true" aria-labelledby="billing-title">
            <div className={c.modalCard}>
                <div className="flex items-start justify-between">
                    <h2 id="billing-title" className={c.title}>Billing</h2>
                    <button type="button" className={c.link} onClick={onClose}>Close</button>
                </div>
                {body}
                {error && <div role="alert" className={c.error}>{error}</div>}
                {canCancel && !confirming && (
                    <button type="button" className={c.secondary} onClick={() => setConfirming(true)}>Cancel subscription</button>
                )}
                {canCancel && confirming && (
                    <div className="flex flex-col gap-2">
                        <p className={c.subtitle}>You keep Pro until {fmt(ent.until)}. No further charges.</p>
                        <button type="button" className={c.secondary} disabled={busy} onClick={cancel}>Yes, cancel</button>
                        <button type="button" className={c.link} onClick={() => setConfirming(false)}>Keep Pro</button>
                    </div>
                )}
            </div>
        </div>
    );
}
