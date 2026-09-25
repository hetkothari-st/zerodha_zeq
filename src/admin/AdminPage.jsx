import React from 'react';
import { useAuth } from '../auth/AuthProvider';
import { theme } from '../auth/theme';
import UsersSection from './UsersSection';
import ZerodhaSection from './ZerodhaSection';

export default function AdminPage() {
    const auth = useAuth();
    const c = theme.classes;
    if (auth.profile?.role !== 'admin') {
        return (
            <div className={c.adminPage}>
                <div className="mx-auto flex max-w-md flex-col gap-4">
                    <theme.Wordmark />
                    <p>You don't have access to this page.</p>
                    <a className={c.link} href="/">Back to {theme.productName}</a>
                </div>
            </div>
        );
    }
    return (
        <div className={c.adminPage}>
            <div className="mx-auto flex max-w-5xl flex-col gap-6">
                <header className="flex items-center justify-between">
                    <div className="flex items-baseline gap-3"><theme.Wordmark /><span className={c.muted}>Admin</span></div>
                    <div className="flex items-center gap-4">
                        <a className={c.link} href="/">Open app</a>
                        <button type="button" className={c.link} onClick={() => auth.signOut()}>Sign out</button>
                    </div>
                </header>
                <UsersSection apiFetch={auth.apiFetch} />
                <ZerodhaSection apiFetch={auth.apiFetch} />
            </div>
        </div>
    );
}
