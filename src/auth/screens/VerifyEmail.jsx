import React, { useState } from 'react';
import { useAuth } from '../AuthProvider';
import { Title, Notice, PrimaryButton, SecondaryButton, TextButton } from '../ui';

export default function VerifyEmail() {
    const auth = useAuth();
    const target = auth.user?.new_email || auth.user?.email;
    const [info, setInfo] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    async function onRefresh() {
        setBusy(true); setError(null);
        try {
            const r = await auth.refreshUser();
            if (r.error) setError(r.error); else setInfo('Still waiting for the link to be opened.');
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setBusy(false);
        }
    }
    async function onResend() {
        setBusy(true); setError(null);
        try {
            const r = await auth.resendEmailVerification();
            if (r.error) setError(r.error); else setInfo(`Sent again to ${target}.`);
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col gap-4">
            <Title title="Check your inbox" subtitle={`Open the verification link we sent to ${target}.`} />
            <Notice kind="info">{info}</Notice>
            <Notice>{error}</Notice>
            <PrimaryButton type="button" busy={busy} onClick={onRefresh}>I've verified</PrimaryButton>
            <SecondaryButton disabled={busy} onClick={onResend}>Resend email</SecondaryButton>
            <TextButton onClick={() => auth.signOut()}>Sign out</TextButton>
        </div>
    );
}
