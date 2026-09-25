import React from 'react';
import { useAuth } from '../AuthProvider';
import { Title, PrimaryButton, TextButton } from '../ui';

export default function Unavailable() {
    const auth = useAuth();
    return (
        <div className="flex flex-col gap-4">
            <Title title="Sign-in is temporarily unavailable" subtitle="Please try again in a moment." />
            <PrimaryButton type="button" onClick={() => auth.refreshProfile()}>Try again</PrimaryButton>
            <TextButton onClick={() => auth.signOut()}>Sign out</TextButton>
        </div>
    );
}
