import React from 'react';
import { useEntitlement } from './EntitlementProvider';

export default function BillingBanner() {
    const { billingEnabled, status, manageUrl, openUpgrade } = useEntitlement();
    if (!billingEnabled) return null;
    if (status === 'pending') {
        return (
            <div role="status" className="flex items-center justify-center gap-3 bg-amber-500/15 px-3 py-1.5 text-[11px] font-bold text-amber-200">
                <span>Payment failed — update payment</span>
                {manageUrl && <a href={manageUrl} target="_blank" rel="noopener noreferrer" className="underline">Update payment</a>}
            </div>
        );
    }
    if (status === 'halted') {
        return (
            <div role="status" className="flex items-center justify-center gap-3 bg-red-500/15 px-3 py-1.5 text-[11px] font-bold text-red-200">
                <span>Your Pro subscription stopped after failed payments.</span>
                <button type="button" onClick={openUpgrade} className="underline">Subscribe again</button>
            </div>
        );
    }
    return null;
}
