import React, { useState } from 'react';
import { useAuth } from '../AuthProvider';
import { Title, Field, PrimaryButton, Notice, TextButton } from '../ui';
import { isEmail } from '../core/validators';

export default function AddEmail() {
    const auth = useAuth();
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    async function onSubmit(e) {
        e.preventDefault();
        if (!name.trim()) { setError('Enter your name.'); return; }
        if (!isEmail(email)) { setError('Enter a valid email address.'); return; }
        setBusy(true); setError(null);
        try {
            const r = await auth.addEmail({ name: name.trim(), email: email.trim() });
            if (r.error) setError(r.error);
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
            <Title title="A few more details" subtitle="We'll send a link to verify your email." />
            <Field id="addemail-name" label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            <Field id="addemail-email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Notice>{error}</Notice>
            <PrimaryButton busy={busy}>Continue</PrimaryButton>
            <TextButton onClick={() => auth.signOut()}>Sign out</TextButton>
        </form>
    );
}
