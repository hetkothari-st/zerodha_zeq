import React, { useState } from 'react';
import { useAuth } from '../AuthProvider';
import { theme } from '../theme';
import { Title, Field, PrimaryButton, GoogleButton, Divider, Tabs, Notice, TextButton, Legal } from '../ui';
import PhoneOtpForm from '../PhoneOtpForm';
import { isEmail, passwordProblem } from '../core/validators';

export default function SignUp({ onSwitch }) {
    const auth = useAuth();
    const [tab, setTab] = useState('email');
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState(null);
    const [info, setInfo] = useState(null);
    const [sentTo, setSentTo] = useState(null);
    const [busy, setBusy] = useState(false);
    const [googleBusy, setGoogleBusy] = useState(false);

    async function onSubmit(e) {
        e.preventDefault();
        if (!name.trim()) { setError('Enter your name.'); return; }
        if (!isEmail(email)) { setError('Enter a valid email address.'); return; }
        const problem = passwordProblem(password);
        if (problem) { setError(problem); return; }
        setBusy(true); setError(null);
        try {
            const r = await auth.signUpWithEmail({ name: name.trim(), email: email.trim(), password });
            if (r.error) { setError(r.error); return; }
            setSentTo(email.trim());
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setBusy(false);
        }
    }

    async function onGoogle() {
        setGoogleBusy(true);
        try { await auth.signInWithGoogle(); } catch { /* redirect-based flow; nothing to show here */ } finally { setGoogleBusy(false); }
    }

    async function onResend() {
        try {
            const r = await auth.resendSignupEmail(sentTo);
            if (r.error) setError(r.error); else { setError(null); setInfo(`Sent again to ${sentTo}.`); }
        } catch {
            setError('Something went wrong. Please try again.');
        }
    }

    if (sentTo) {
        return (
            <div className="flex flex-col gap-4">
                <theme.Wordmark />
                <Title title="Check your inbox" subtitle={`We sent a verification link to ${sentTo}. Open it on this device to continue.`} />
                <Notice>{error}</Notice>
                <Notice kind="info">{info}</Notice>
                <TextButton onClick={onResend}>Resend email</TextButton>
                <TextButton onClick={() => onSwitch('signIn')}>Back to sign in</TextButton>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <theme.Wordmark />
            <Title title="Create your account" subtitle={`Join the ${theme.productName} waitlist.`} />
            <GoogleButton busy={googleBusy} onClick={onGoogle} />
            <Divider />
            <Tabs value={tab} onChange={(v) => { setTab(v); setError(null); }} options={[{ value: 'email', label: 'Email' }, { value: 'mobile', label: 'Mobile OTP' }]} />
            {tab === 'email' ? (
                <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
                    <Field id="signup-name" label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
                    <Field id="signup-email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                    <Field id="signup-password" label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                    <p className={theme.classes.muted}>At least 8 characters, with letters and numbers.</p>
                    <Notice>{error}</Notice>
                    <PrimaryButton busy={busy}>Create account</PrimaryButton>
                </form>
            ) : (
                <PhoneOtpForm idPrefix="signup"
                    sendCode={(phone) => auth.sendPhoneOtp(phone, { createUser: true })}
                    verifyCode={(phone, c) => auth.verifyPhoneOtp(phone, c)} />
            )}
            <p className={`${theme.classes.muted} text-center`}>
                Already have an account? <TextButton onClick={() => onSwitch('signIn')}>Sign in</TextButton>
            </p>
            <Legal />
        </div>
    );
}
