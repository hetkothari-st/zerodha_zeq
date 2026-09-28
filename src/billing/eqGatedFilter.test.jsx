import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntitlementContext } from './EntitlementProvider';
import { GatedFilter } from './GatedFilter';

function withEnt(ui, ent) {
    return render(<EntitlementContext.Provider value={{ isPro: false, openUpgrade: () => {}, ...ent }}>{ui}</EntitlementContext.Provider>);
}

// Mirrors the real App.jsx call sites: the <select> is `disabled` exactly
// when the plan is not Pro — never hardcoded either way.
function filterFor(isPro) {
    return (
        <GatedFilter label="Timeframe" className="filter">
            <select data-testid="timeframe-select" disabled={!isPro}>
                <option value="5">5m</option>
            </select>
        </GatedFilter>
    );
}

describe('GatedFilter', () => {
    it('Pro: renders the control enabled, with no overlay', () => {
        withEnt(filterFor(true), { isPro: true });
        expect(screen.getByTestId('timeframe-select')).not.toBeDisabled();
        expect(screen.queryByRole('button', { name: 'Timeframe is a Pro feature — upgrade' })).toBeNull();
    });

    it('Free: clicking anywhere in the filter — including on the disabled select — opens the upgrade modal', async () => {
        const openUpgrade = vi.fn();
        withEnt(filterFor(false), { openUpgrade });
        const overlay = screen.getByRole('button', { name: 'Timeframe is a Pro feature — upgrade' });
        expect(overlay).toBeInTheDocument();
        await userEvent.click(overlay);
        expect(openUpgrade).toHaveBeenCalled();
    });
});
