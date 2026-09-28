import React from 'react';
import { useAuth } from './AuthProvider';
import AuthLayout from './AuthLayout';
import AuthScreens from './AuthScreens';
import DisplacedModal from './DisplacedModal';
import { EntitlementProvider } from '../billing/EntitlementProvider';

export function AuthGate({ children }) {
    const { screen, displaced } = useAuth();
    if (screen === 'app') {
        return (
            <EntitlementProvider>
                {children}
                {displaced && <DisplacedModal />}
            </EntitlementProvider>
        );
    }
    return <AuthLayout><AuthScreens /></AuthLayout>;
}
