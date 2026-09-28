import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntitlementContext } from './EntitlementProvider';
import UpgradeModal from './UpgradeModal';

const apiFetch = vi.fn();
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ apiFetch, profile: { full_name: 'Asha', email: 'a@x.in' } }) }));

function setup({ subscribe = { ok: true, data: { subscriptionId: 'sub_1', keyId: 'k' } }, outcome = { outcome: 'paid' }, statuses = [{ ok: true, data: { plan: 'pro' } }], loadFails = false } = {}) {
    apiFetch.mockReset();
    apiFetch.mockImplementation(async () => subscribe);
    const refresh = vi.fn(async () => statuses.shift() ?? { ok: true, data: { plan: 'free' } });
    const checkout = {
        loadCheckout: vi.fn(async () => { if (loadFails) throw new Error('x'); return function R() {}; }),
        openCheckout: vi.fn(async () => outcome),
    };
    const onClose = vi.fn();
    const utils = render(
        <EntitlementContext.Provider value={{ isPro: false, priceLabel: '₹499/month', refresh }}>
            <UpgradeModal onClose={onClose} checkout={checkout} pollIntervalMs={1} pollTimeoutMs={30} />
        </EntitlementContext.Provider>,
    );
    return { ...utils, refresh, checkout, onClose };
}

describe('UpgradeModal', () => {
    it('shows price and Pro features', () => {
        setup();
        expect(screen.getByText('₹499/month')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeInTheDocument();
    });
    it('happy path: subscribe → checkout → activating → success', async () => {
        const { checkout } = setup();
        await userEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));
        expect(await screen.findByText("You're on Pro. Enjoy!")).toBeInTheDocument();
        expect(apiFetch).toHaveBeenCalledWith('/api/billing/subscribe', { method: 'POST' });
        expect(checkout.openCheckout.mock.calls[0][1]).toMatchObject({ keyId: 'k', subscriptionId: 'sub_1', prefill: { name: 'Asha', email: 'a@x.in' } });
    });
    it('subscribe error shows the server message and stays idle', async () => {
        setup({ subscribe: { ok: false, status: 503, message: 'Payments unavailable, try later.' } });
        await userEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Payments unavailable, try later.');
        expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeEnabled();
    });
    it('checkout script failing to load shows a connection message', async () => {
        setup({ loadFails: true });
        await userEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the payment window');
    });
    it('dismissed checkout shows the reason, not charged', async () => {
        setup({ outcome: { outcome: 'dismissed', reason: 'UPI mandate declined' } });
        await userEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('UPI mandate declined');
    });
    it('activation timeout shows the pending message', async () => {
        setup({ statuses: [] });
        await userEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));
        expect(await screen.findByText(/activation pending/i)).toBeInTheDocument();
    });
    it('unmount stops polling', async () => {
        const { unmount, refresh } = setup({ statuses: [] });
        await userEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));
        await waitFor(() => expect(refresh).toHaveBeenCalled());
        unmount();
        const n = refresh.mock.calls.length;
        await new Promise((r) => setTimeout(r, 40));
        expect(refresh.mock.calls.length).toBeLessThanOrEqual(n + 1);
    });
    it('Close calls onClose', async () => {
        const { onClose } = setup();
        await userEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalled();
    });
});
