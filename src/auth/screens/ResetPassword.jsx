import React, { useState } from 'react';
import { useAuth } from '../AuthProvider';
import { Title, Field, PrimaryButton, Notice } from '../ui';
import { passwordProblem } from '../core/validators';

export default function ResetPassword() {
    const auth = useAuth();
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    async function onSubmit(e) {
        e.preventDefault();
        const problem = passwordProblem(password);
        if (problem) { setError(problem); return; }
        if (password !== confirm) { setError("Passwords don't match."); return; }
        setBusy(true); setError(null);
        try {
            const r = await auth.updatePassword(password);
            if (r.error) setError(r.error);
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
            <Title title="Set a new password" subtitle="At least 8 characters, with letters and numbers." />
            <Field id="reset-password" label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Field id="reset-confirm" label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <Notice>{error}</Notice>
            <PrimaryButton busy={busy}>Save password</PrimaryButton>
        </form>
    );
}
