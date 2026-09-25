import React from 'react';
import { useAuth } from '../AuthProvider';
import { Title, PrimaryButton } from '../ui';

export default function LinkExpired() {
    const auth = useAuth();
    return (
        <div className="flex flex-col gap-4">
            <Title title="That link has expired" subtitle="Links work once and expire after a while. Sign in to get a new one." />
            <PrimaryButton type="button" onClick={() => auth.clearLinkError()}>Back to sign in</PrimaryButton>
        </div>
    );
}
