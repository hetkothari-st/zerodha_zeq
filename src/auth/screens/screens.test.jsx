import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../theme', () => ({
    theme: { productName: 'Funnel Test', tagline: 'Test tagline', Wordmark: () => <span>WM</span>, classes: new Proxy({}, { get: () => '' }) },
}));
vi.mock('../panels/MarketPanel', () => ({ default: () => <div data-testid="panel" /> }));

let auth;
vi.mock('../AuthProvider', () => ({ useAuth: () => auth }));

const ok = () => Promise.resolve({ error: null, code: null });
beforeEach(() => {
    auth = {
        screen: 'signIn', user: { email: 'a@b.in', phone: '919876543210' }, profile: { full_name: 'Asha', email: 'a@b.in', phone: '+919876543210' },
        signInWithGoogle: vi.fn(ok), signInWithPassword: vi.fn(ok), signUpWithEmail: vi.fn(ok), resendSignupEmail: vi.fn(ok),
        sendPhoneOtp: vi.fn(ok), verifyPhoneOtp: vi.fn(ok), addEmail: vi.fn(ok), resendEmailVerification: vi.fn(ok),
        refreshUser: vi.fn(ok), startAddMobile: vi.fn(ok), verifyAddMobile: vi.fn(ok), sendPasswordReset: vi.fn(ok),
        updatePassword: vi.fn(ok), signOut: vi.fn(ok), signOutHere: vi.fn(ok), refreshProfile: vi.fn(ok), clearLinkError: vi.fn(),
    };
});

const { default: SignIn } = await import('./SignIn');
const { default: SignUp } = await import('./SignUp');
const { default: AddMobile } = await import('./AddMobile');
const { default: ResetPassword } = await import('./ResetPassword');
const { default: Waitlist } = await import('./Waitlist');
const { default: VerifyEmail } = await import('./VerifyEmail');
const { default: AddEmail } = await import('./AddEmail');

test('SignIn email: submits trimmed email and shows server error', async () => {
    auth.signInWithPassword = vi.fn(() => Promise.resolve({ error: 'Wrong email or password.', code: 'invalid_credentials' }));
    render(<SignIn onSwitch={() => {}} onForgot={() => {}} />);
    await userEvent.type(screen.getByLabelText('Email'), ' a@b.in ');
    await userEvent.type(screen.getByLabelText('Password'), 'abcd1234');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(auth.signInWithPassword).toHaveBeenCalledWith('a@b.in', 'abcd1234');
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong email or password.');
});

test('SignIn email: unverified email offers a resend', async () => {
    auth.signInWithPassword = vi.fn(() => Promise.resolve({ error: 'Please verify your email first. Check your inbox.', code: 'email_not_confirmed' }));
    render(<SignIn onSwitch={() => {}} onForgot={() => {}} />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.in');
    await userEvent.type(screen.getByLabelText('Password'), 'abcd1234');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Resend verification email' }));
    expect(auth.resendSignupEmail).toHaveBeenCalledWith('a@b.in');
});

test('SignIn mobile: rejects an invalid number before any network call', async () => {
    render(<SignIn onSwitch={() => {}} onForgot={() => {}} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Mobile OTP' }));
    await userEvent.type(screen.getByLabelText('Mobile number'), '12345');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(auth.sendPhoneOtp).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid 10-digit Indian mobile number.');
});

test('SignIn mobile: sends code (no account creation) then verifies', async () => {
    render(<SignIn onSwitch={() => {}} onForgot={() => {}} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Mobile OTP' }));
    await userEvent.type(screen.getByLabelText('Mobile number'), '98765 43210');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(auth.sendPhoneOtp).toHaveBeenCalledWith('+919876543210', { createUser: false });
    await userEvent.type(await screen.findByLabelText('6-digit code'), '12345');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(auth.verifyPhoneOtp).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the 6-digit code.');
    await userEvent.type(screen.getByLabelText('6-digit code'), '6');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(auth.verifyPhoneOtp).toHaveBeenCalledWith('+919876543210', '123456');
});

test('SignUp email: enforces password rule, then shows check-your-inbox', async () => {
    render(<SignUp onSwitch={() => {}} />);
    await userEvent.type(screen.getByLabelText('Full name'), 'Asha');
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.in');
    await userEvent.type(screen.getByLabelText('Password'), 'weakpass');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(auth.signUpWithEmail).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Use both letters and numbers.');
    await userEvent.clear(screen.getByLabelText('Password'));
    await userEvent.type(screen.getByLabelText('Password'), 'abcd1234');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(auth.signUpWithEmail).toHaveBeenCalledWith({ name: 'Asha', email: 'a@b.in', password: 'abcd1234' });
    expect(await screen.findByText(/Check your inbox/)).toBeInTheDocument();
});

test('SignUp mobile: creates the account via OTP', async () => {
    render(<SignUp onSwitch={() => {}} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Mobile OTP' }));
    await userEvent.type(screen.getByLabelText('Mobile number'), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(auth.sendPhoneOtp).toHaveBeenCalledWith('+919876543210', { createUser: true });
});

test('AddMobile uses the phone-change flow', async () => {
    render(<AddMobile />);
    await userEvent.type(screen.getByLabelText('Mobile number'), '9876543210');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(auth.startAddMobile).toHaveBeenCalledWith('+919876543210');
    await userEvent.type(await screen.findByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(auth.verifyAddMobile).toHaveBeenCalledWith('+919876543210', '123456');
});

test('ResetPassword: mismatch is caught locally', async () => {
    render(<ResetPassword />);
    await userEvent.type(screen.getByLabelText('New password'), 'abcd1234');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'abcd12345');
    await userEvent.click(screen.getByRole('button', { name: 'Save password' }));
    expect(auth.updatePassword).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent("Passwords don't match.");
});

test('AddEmail submits name and email', async () => {
    render(<AddEmail />);
    await userEvent.type(screen.getByLabelText('Full name'), 'Asha');
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.in');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(auth.addEmail).toHaveBeenCalledWith({ name: 'Asha', email: 'a@b.in' });
});

test('VerifyEmail: resend and refresh', async () => {
    render(<VerifyEmail />);
    await userEvent.click(screen.getByRole('button', { name: "I've verified" }));
    expect(auth.refreshUser).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Resend email' }));
    expect(auth.resendEmailVerification).toHaveBeenCalled();
});

test('Waitlist polls the profile every 30 s', async () => {
    vi.useFakeTimers();
    render(<Waitlist />);
    expect(screen.getByText(/on the list/i)).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(auth.refreshProfile).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(auth.refreshProfile).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
});

test('Waitlist keeps a single 30 s interval when the auth object changes on rerender', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<Waitlist />);
    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(auth.refreshProfile).not.toHaveBeenCalled();
    const newRefreshProfile = vi.fn(ok);
    auth = { ...auth, refreshProfile: newRefreshProfile };
    rerender(<Waitlist />);
    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(newRefreshProfile).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
});

test('SignUp check-your-inbox: resend shows a server error, then a confirmation', async () => {
    auth.resendSignupEmail = vi.fn(() => Promise.resolve({ error: 'Too many requests.' }));
    render(<SignUp onSwitch={() => {}} />);
    await userEvent.type(screen.getByLabelText('Full name'), 'Asha');
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.in');
    await userEvent.type(screen.getByLabelText('Password'), 'abcd1234');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Resend email' }));
    expect(auth.resendSignupEmail).toHaveBeenCalledWith('a@b.in');
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests.');

    auth.resendSignupEmail = vi.fn(ok);
    await userEvent.click(screen.getByRole('button', { name: 'Resend email' }));
    expect(await screen.findByText('Sent again to a@b.in.')).toBeInTheDocument();
});

test('SignIn: a rejected sign-in re-enables the button and shows a generic error', async () => {
    auth.signInWithPassword = vi.fn(() => Promise.reject(new Error('network down')));
    render(<SignIn onSwitch={() => {}} onForgot={() => {}} />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.in');
    await userEvent.type(screen.getByLabelText('Password'), 'abcd1234');
    const button = screen.getByRole('button', { name: 'Sign in' });
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
    expect(button).not.toBeDisabled();
});

test('SignIn: the Google button is busy while the redirect is pending', async () => {
    let resolveGoogle;
    auth.signInWithGoogle = vi.fn(() => new Promise((res) => { resolveGoogle = res; }));
    render(<SignIn onSwitch={() => {}} onForgot={() => {}} />);
    const button = screen.getByRole('button', { name: 'Continue with Google' });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    await act(async () => { resolveGoogle({ error: null }); });
    expect(button).not.toBeDisabled();
});

test('VerifyEmail: buttons are guarded against double clicks', async () => {
    let resolveRefresh;
    auth.refreshUser = vi.fn(() => new Promise((res) => { resolveRefresh = res; }));
    render(<VerifyEmail />);
    const verifiedBtn = screen.getByRole('button', { name: "I've verified" });
    const resendBtn = screen.getByRole('button', { name: 'Resend email' });
    await userEvent.click(verifiedBtn);
    expect(resendBtn).toBeDisabled();
    await act(async () => { resolveRefresh({ error: null }); });
    expect(resendBtn).not.toBeDisabled();
});

test('SignIn: the inline resend button guards against double clicks', async () => {
    auth.signInWithPassword = vi.fn(() => Promise.resolve({ error: 'Please verify your email first. Check your inbox.', code: 'email_not_confirmed' }));
    let resolveResend;
    auth.resendSignupEmail = vi.fn(() => new Promise((res) => { resolveResend = res; }));
    render(<SignIn onSwitch={() => {}} onForgot={() => {}} />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.in');
    await userEvent.type(screen.getByLabelText('Password'), 'abcd1234');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const resendBtn = await screen.findByRole('button', { name: 'Resend verification email' });
    await userEvent.click(resendBtn);
    expect(resendBtn).toBeDisabled();
    await userEvent.click(resendBtn);
    await act(async () => { resolveResend({ error: null }); });
    expect(auth.resendSignupEmail).toHaveBeenCalledTimes(1);
});
