import React from 'react';
import { useAuth } from '../AuthProvider';
import { theme } from '../theme';
import { Title, TextButton } from '../ui';

export default function Rejected() {
    const auth = useAuth();
    return (
        <div className="flex flex-col gap-4">
            <Title title="We can't approve your account right now" subtitle={`Thanks for your interest in ${theme.productName}. We'll be in touch if that changes.`} />
            <TextButton onClick={() => auth.signOut()}>Sign out</TextButton>
        </div>
    );
}
