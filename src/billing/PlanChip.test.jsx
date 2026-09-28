import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntitlementContext } from './EntitlementProvider';
import PlanChip from './PlanChip';

const apiFetch = vi.fn();
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ apiFetch }) }));

function renderChip(ent) {
    const value = { isPro: false, plan: 'free', billingEnabled: true, openUpgrade: vi.fn(), refresh: vi.fn(async () => ({ ok: true })), ...ent };
    render(<EntitlementContext.Provider value={value}><PlanChip /></EntitlementContext.Provider>);
    return value;
}

describe('PlanChip', () => {
    it('Free: shows Upgrade and opens the upgrade modal', async () => {
        const ent = renderChip();
        await userEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
        expect(ent.openUpgrade).toHaveBeenCalled();
    });
    it('renders nothing when billing is off', () => {
        const { container } = render(<EntitlementContext.Provider value={{ billingEnabled: false, isPro: true }}><PlanChip /></EntitlementContext.Provider>);
        expect(container).toBeEmptyDOMElement();
    });
    it('Comp: label only, no billing controls', async () => {
        renderChip({ isPro: true, plan: 'pro', source: 'comp' });
        await userEvent.click(screen.getByRole('button', { name: 'Pro' }));
        expect(screen.getByText('Pro (complimentary)')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Cancel subscription' })).toBeNull();
    });
    it('Subscription: shows renewal date, cancel needs in-modal confirm', async () => {
        apiFetch.mockResolvedValueOnce({ ok: true, data: { ok: true, until: '2026-10-28T00:00:00.000Z' } });
        const ent = renderChip({ isPro: true, plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z', status: 'active', cancelAtPeriodEnd: false });
        await userEvent.click(screen.getByRole('button', { name: 'Pro' }));
        expect(screen.getByText(/Renews on 28 Oct 2026/)).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
        expect(apiFetch).not.toHaveBeenCalled();
        await userEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }));
        expect(apiFetch).toHaveBeenCalledWith('/api/billing/cancel', { method: 'POST' });
        expect(ent.refresh).toHaveBeenCalled();
    });
    it('Cancelled: shows "Pro until" and no cancel button', async () => {
        renderChip({ isPro: true, plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z', status: 'active', cancelAtPeriodEnd: true });
        await userEvent.click(screen.getByRole('button', { name: 'Pro' }));
        expect(screen.getByText(/Pro until 28 Oct 2026/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Cancel subscription' })).toBeNull();
    });
    it('Cancel failure shows the message', async () => {
        apiFetch.mockResolvedValueOnce({ ok: false, message: 'Payments unavailable, try later.' });
        renderChip({ isPro: true, plan: 'pro', source: 'subscription', until: '2026-10-28T00:00:00.000Z', status: 'active' });
        await userEvent.click(screen.getByRole('button', { name: 'Pro' }));
        await userEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
        await userEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Payments unavailable, try later.');
    });
});
