import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EntitlementContext } from './EntitlementProvider';
import BillingBanner from './BillingBanner';

const renderWith = (ent) => render(<EntitlementContext.Provider value={{ billingEnabled: true, openUpgrade: () => {}, ...ent }}><BillingBanner /></EntitlementContext.Provider>);

describe('BillingBanner', () => {
    it('pending: failed payment with update link', () => {
        renderWith({ status: 'pending', manageUrl: 'https://rzp.io/i/x' });
        expect(screen.getByText('Payment failed — update payment')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Update payment' })).toHaveAttribute('href', 'https://rzp.io/i/x');
    });
    it('halted: offers to subscribe again', () => {
        renderWith({ status: 'halted' });
        expect(screen.getByRole('button', { name: 'Subscribe again' })).toBeInTheDocument();
    });
    it('active or none: renders nothing', () => {
        const { container } = renderWith({ status: 'active' });
        expect(container).toBeEmptyDOMElement();
    });
});
