import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { theme } from '../auth/theme';
import { useEntitlement } from './EntitlementProvider';
import { loadCheckout, openCheckout } from './razorpayCheckout';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function UpgradeModal({ onClose, pollIntervalMs = 2000, pollTimeoutMs = 30000, checkout = { loadCheckout, openCheckout } }) {
    const { apiFetch, profile } = useAuth();
    const { priceLabel, refresh } = useEntitlement();
    const c = theme.classes;
    const [phase, setPhase] = useState('idle'); // idle | starting | checkout | activating | success | timeout
    const [message, setMessage] = useState(null);
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const fail = (text) => { if (!alive.current) return; setPhase('idle'); setMessage(text); };

    async function pay() {
        setPhase('starting'); setMessage(null);
        const r = await apiFetch('/api/billing/subscribe', { method: 'POST' });
        if (!alive.current) return;
        if (!r.ok) return fail(r.message);
        let Razorpay;
        try {
            Razorpay = await checkout.loadCheckout();
        } catch {
            return fail('Could not load the payment window. Check your connection and try again.');
        }
        if (!alive.current) return;
        setPhase('checkout');
        let result;
        try {
            result = await checkout.openCheckout(Razorpay, {
                keyId: r.data.keyId,
                subscriptionId: r.data.subscriptionId,
                name: theme.productName,
                description: 'Pro — monthly',
                prefill: { name: profile?.full_name || '', email: profile?.email || '' },
                color: theme.accent,
            });
        } catch {
            return fail('Could not open the payment window. Please try again.');
        }
        if (!alive.current) return;
        if (result.outcome !== 'paid') return fail(result.reason || 'Payment cancelled. You have not been charged.');
        if (!alive.current) return;
        setPhase('activating');
        const deadline = Date.now() + pollTimeoutMs;
        while (alive.current && Date.now() < deadline) {
            const s = await refresh();
            if (!alive.current) return;
            if (s?.ok && s.data?.plan === 'pro') { setPhase('success'); return; }
            await sleep(pollIntervalMs);
        }
        if (alive.current) setPhase('timeout');
    }

    const busy = phase === 'starting' || phase === 'checkout' || phase === 'activating';
    return (
        <div className={c.modal} role="dialog" aria-modal="true" aria-labelledby="upgrade-title">
            <div className={c.modalCard}>
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2 id="upgrade-title" className={c.title}>{theme.productName} Pro</h2>
                        {priceLabel && <p className={c.subtitle}>{priceLabel}</p>}
                    </div>
                    <button type="button" className={c.link} onClick={onClose} disabled={phase === 'activating'}>Close</button>
                </div>
                <ul className="flex flex-col gap-1.5 text-sm">
                    {theme.proFeatures.map((f) => <li key={f}>✓ {f}</li>)}
                </ul>
                {message && <div role="alert" className={c.error}>{message}</div>}
                {phase === 'activating' && <div className={c.info}>Activating your subscription…</div>}
                {phase === 'success' && <div className={c.info}>You're on Pro. Enjoy!</div>}
                {phase === 'timeout' && <div className={c.info}>Payment received, activation pending — refresh in a minute.</div>}
                {phase === 'success' || phase === 'timeout' ? (
                    <button type="button" className={c.primary} onClick={onClose}>Done</button>
                ) : (
                    <button type="button" className={c.primary} onClick={pay} disabled={busy}>
                        {busy ? 'Please wait…' : 'Upgrade to Pro'}
                    </button>
                )}
                <p className={c.muted}>Renews monthly via UPI AutoPay or card. Cancel anytime; Pro stays until the period ends.</p>
            </div>
        </div>
    );
}
