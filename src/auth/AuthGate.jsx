import React from 'react';
import { useAuth } from './AuthProvider';
import AuthLayout from './AuthLayout';
import AuthScreens from './AuthScreens';
import DisplacedModal from './DisplacedModal';

export function AuthGate({ children }) {
    const { screen, displaced } = useAuth();
    if (screen === 'app') {
        return (
            <>
                {children}
                {displaced && <DisplacedModal />}
            </>
        );
    }
    return <AuthLayout><AuthScreens /></AuthLayout>;
}
