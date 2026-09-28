import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntitlementContext } from './EntitlementProvider';
import { ProGate, useProAction } from './ProGate';

function withEnt(ui, ent) {
    return render(<EntitlementContext.Provider value={{ isPro: false, openUpgrade: () => {}, ...ent }}>{ui}</EntitlementContext.Provider>);
}

describe('ProGate', () => {
    it('renders children normally for Pro', () => {
        withEnt(<ProGate label="Live Logs"><button>logs</button></ProGate>, { isPro: true });
        expect(screen.getByRole('button', { name: 'logs' })).toBeInTheDocument();
        expect(screen.queryByText('Pro')).toBeNull();
    });
    it('greys children, hides them from a11y, and opens upgrade for Free', async () => {
        const openUpgrade = vi.fn();
        withEnt(<ProGate label="Live Logs"><button>logs</button></ProGate>, { openUpgrade });
        expect(screen.queryByRole('button', { name: 'logs' })).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Live Logs is a Pro feature — upgrade' }));
        expect(openUpgrade).toHaveBeenCalled();
    });
});

describe('useProAction', () => {
    function Btn({ fn }) { const run = useProAction(fn); return <button onClick={() => run('x')}>go</button>; }
    it('runs the action for Pro', async () => {
        const fn = vi.fn();
        withEnt(<Btn fn={fn} />, { isPro: true });
        await userEvent.click(screen.getByText('go'));
        expect(fn).toHaveBeenCalledWith('x');
    });
    it('opens upgrade instead for Free', async () => {
        const fn = vi.fn(); const openUpgrade = vi.fn();
        withEnt(<Btn fn={fn} />, { openUpgrade });
        await userEvent.click(screen.getByText('go'));
        expect(fn).not.toHaveBeenCalled();
        expect(openUpgrade).toHaveBeenCalled();
    });
});
