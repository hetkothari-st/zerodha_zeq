import React from 'react';
import { AuthGate } from './auth/AuthGate';
import AdminPage from './admin/AdminPage';

// No router: two top-level pages. /reset-password is handled by the gate (PASSWORD_RECOVERY).
export default function Root({ App }) {
    const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin';
    return <AuthGate>{isAdmin ? <AdminPage /> : <App />}</AuthGate>;
}
