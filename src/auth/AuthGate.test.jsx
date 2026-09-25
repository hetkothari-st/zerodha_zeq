import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./theme', () => ({
    theme: { productName: 'Funnel Test', tagline: 't', Wordmark: () => <span>WM</span>, classes: new Proxy({}, { get: () => '' }) },
}));
vi.mock('./panels/MarketPanel', () => ({ default: () => <div data-testid="panel" /> }));
let auth;
vi.mock('./AuthProvider', () => ({ useAuth: () => auth }));

const { AuthGate } = await import('./AuthGate');
const base = { signOut: vi.fn(), signOutHere: vi.fn(), refreshProfile: vi.fn(), clearLinkError: vi.fn(), user: { email: 'a@b.in' }, profile: {} };

test('app screen renders children', () => {
    auth = { ...base, screen: 'app', displaced: false };
    render(<AuthGate><p>the app</p></AuthGate>);
    expect(screen.getByText('the app')).toBeInTheDocument();
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
});

test('non-app screens render layout with the product panel', () => {
    auth = { ...base, screen: 'waitlist', displaced: false };
    render(<AuthGate><p>the app</p></AuthGate>);
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
    expect(screen.getByTestId('panel')).toBeInTheDocument();
});

test('displaced shows the modal over the app and "Sign in here" signs out locally', async () => {
    auth = { ...base, screen: 'app', displaced: true };
    render(<AuthGate><p>the app</p></AuthGate>);
    expect(screen.getByRole('dialog')).toHaveTextContent('You signed in on another device');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in here' }));
    expect(auth.signOutHere).toHaveBeenCalled();
});

test('displaced modal autofocuses the "Sign in here" button', () => {
    auth = { ...base, screen: 'app', displaced: true };
    render(<AuthGate><p>the app</p></AuthGate>);
    expect(screen.getByRole('button', { name: 'Sign in here' })).toHaveFocus();
});
