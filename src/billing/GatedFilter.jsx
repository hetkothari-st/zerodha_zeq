import React from 'react';
import { useEntitlement } from './EntitlementProvider';
import { ProBadge } from './ProGate';

// Wraps a Pro-only filter control that contains a native form element (e.g.
// a Timeframe or Volume-unit <select>). Free users must be able to click
// ANYWHERE in the filter — including directly on the control itself — and
// land on the upgrade modal.
//
// A `disabled` <select> does not dispatch a `click` event at all (browsers
// never fire click on a disabled form control), so it can't be relied on to
// bubble a click up to a wrapping button; a click that lands squarely on the
// select would simply go nowhere. Instead, following the same pattern as
// ProGate: for Free, the real content is rendered inert (pointer-events
// disabled, hidden from the accessibility tree, out of tab order) and an
// absolutely-positioned overlay button sits on top of it, so every click in
// the filter's bounds — select or not — is caught by the button.
export function GatedFilter({ label, className = '', children }) {
    const { isPro, openUpgrade } = useEntitlement();
    if (isPro) return <div className={className}>{children}</div>;
    return (
        <div className={`relative ${className}`}>
            <div aria-hidden="true" inert="" tabIndex={-1} className="pointer-events-none select-none">
                {children}
            </div>
            <button
                type="button"
                onClick={openUpgrade}
                aria-label={`${label} is a Pro feature — upgrade`}
                className="absolute inset-0 flex items-center justify-center bg-black/10 rounded"
            >
                <ProBadge className="text-[11px]" />
            </button>
        </div>
    );
}
