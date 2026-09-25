import React, { useState } from 'react';
import { useAuth } from '../AuthProvider';
import { Title, Field, PrimaryButton, Notice, TextButton } from '../ui';
import { isEmail } from '../core/validators';

export default function ForgotPassword({ onBack }) {
    const auth = useAuth();
    const [email, setEmail] = useState('');
    const [error, setError] = useState(null);
    const [sent, setSent] = useState(false);
    const [busy, setBusy] = useState(false);

    async function onSubmit(e) {
        e.preventDefault();
        if (!isEmail(email)) { setError('Enter a valid email address.'); return; }
        setBusy(true); setError(null);
        try {
            const r = await auth.sendPasswordReset(email.trim());
            if (r.error) setError(r.error); else setSent(true);
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
            <Title title="Reset your password" subtitle="We'll email you a link to set a new one." />
            {sent ? (
                <Notice kind="info">If an account exists for {email.trim()}, a reset link is on its way.</Notice>
            ) : (
                <>
                    <Field id="forgot-email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                    <Notice>{error}</Notice>
                    <PrimaryButton busy={busy}>Send reset link</PrimaryButton>
                </>
            )}
            <TextButton onClick={onBack}>Back to sign in</TextButton>
        </form>
    );
}
