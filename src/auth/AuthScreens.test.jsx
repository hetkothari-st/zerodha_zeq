import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./theme', () => ({
    theme: { productName: 'Funnel Test', tagline: 't', Wordmark: () => <span>WM</span>, classes: new Proxy({}, { get: () => '' }) },
}));
vi.mock('./panels/MarketPanel', () => ({ default: () => <div data-testid="panel" /> }));

let auth;
vi.mock('./AuthProvider', () => ({ useAuth: () => auth }));

const ok = () => Promise.resolve({ error: null, code: null });
beforeEach(() => {
    auth = {
        screen: 'signIn', user: { email: 'a@b.in' }, profile: {},
        signInWithGoogle: vi.fn(ok), signInWithPassword: vi.fn(ok), signUpWithEmail: vi.fn(ok), resendSignupEmail: vi.fn(ok),
        sendPhoneOtp: vi.fn(ok), verifyPhoneOtp: vi.fn(ok), addEmail: vi.fn(ok), resendEmailVerification: vi.fn(ok),
        refreshUser: vi.fn(ok), startAddMobile: vi.fn(ok), verifyAddMobile: vi.fn(ok), sendPasswordReset: vi.fn(ok),
        updatePassword: vi.fn(ok), signOut: vi.fn(ok), signOutHere: vi.fn(ok), refreshProfile: vi.fn(ok), clearLinkError: vi.fn(),
    };
});

const { default: AuthScreens } = await import('./AuthScreens');

test('view resets to signIn when the screen changes', async () => {
    const { rerender } = render(<AuthScreens />);
    await userEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument();

    auth = { ...auth, screen: 'addEmail' };
    rerender(<AuthScreens />);
    expect(screen.getByRole('heading', { name: 'A few more details' })).toBeInTheDocument();

    auth = { ...auth, screen: 'signIn' };
    rerender(<AuthScreens />);
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
});
