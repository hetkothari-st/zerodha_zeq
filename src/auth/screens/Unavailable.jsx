import React from 'react';
import { useAuth } from '../AuthProvider';
import { Title, PrimaryButton, TextButton } from '../ui';

// Indirection so tests can observe the reload without navigating jsdom.
export const pageNav = { reload: () => window.location.reload() };

export default function Unavailable() {
    const auth = useAuth();
    const hasSession = Boolean(auth.session);

    function tryAgain() {
        if (!hasSession) pageNav.reload(); // startup failed: nothing to retry in-app, start over
        else if (auth.claimError) auth.retryClaim();
        else auth.refreshProfile();
    }

    return (
        <div className="flex flex-col gap-4">
            <Title title="Sign-in is temporarily unavailable" subtitle="Please try again in a moment." />
            <PrimaryButton type="button" onClick={tryAgain}>Try again</PrimaryButton>
            {hasSession && <TextButton onClick={() => auth.signOut()}>Sign out</TextButton>}
        </div>
    );
}
