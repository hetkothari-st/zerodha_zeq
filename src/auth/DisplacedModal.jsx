import React from 'react';
import { useAuth } from './AuthProvider';
import { theme } from './theme';
import { Title, PrimaryButton } from './ui';

export default function DisplacedModal() {
    const auth = useAuth();
    return (
        <div className={theme.classes.modal}>
            <div role="dialog" aria-modal="true" aria-labelledby="displaced-title" className={theme.classes.modalCard}>
                <div id="displaced-title"><Title title="You signed in on another device" subtitle={`${theme.productName} works on one device at a time.`} /></div>
                <PrimaryButton type="button" autoFocus onClick={() => auth.signOutHere()}>Sign in here</PrimaryButton>
            </div>
        </div>
    );
}
