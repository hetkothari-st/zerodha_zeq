import React, { useCallback } from 'react';
import { useEntitlement } from './EntitlementProvider';

export function ProBadge({ className = '' }) {
    return (
        <span className={`inline-flex items-center rounded bg-amber-400 px-1.5 py-px text-[9px] font-black uppercase tracking-wider text-black ${className}`}>
            Pro
        </span>
    );
}

// Free users see the feature greyed and inert; clicking it opens the upgrade modal.
export function ProGate({ label, children, className = '' }) {
    const { isPro, openUpgrade } = useEntitlement();
    if (isPro) return children;
    return (
        <div className={`relative ${className}`}>
            <div aria-hidden="true" inert="" className="pointer-events-none select-none opacity-30 grayscale">{children}</div>
            <button type="button" onClick={openUpgrade} aria-label={`${label} is a Pro feature — upgrade`}
                className="absolute inset-0 flex items-center justify-center bg-black/10">
                <ProBadge className="text-[11px]" />
            </button>
        </div>
    );
}

export function useProAction(fn) {
    const { isPro, openUpgrade } = useEntitlement();
    return useCallback((...args) => (isPro ? fn(...args) : openUpgrade()), [isPro, fn, openUpgrade]);
}
