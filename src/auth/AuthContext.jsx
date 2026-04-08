// Minimal client-side auth gate.
//
// Stores a {email, name, picture, provider} object in localStorage once the
// user has either (a) signed in via Google or (b) typed the hardcoded
// Admin / Admin123 credentials. The rest of the app reads `useAuth()` to
// check whether the user is allowed through the login wall and to derive a
// stable loginId string for the WebSocket credential.
//
// Note on security: this is a gate, not a fortress. The Google ID token is
// decoded client-side without verifying its signature — that's fine for a
// "prove which email you own so we can show/hide the UI" check, but do NOT
// treat this as authorization for any sensitive backend call.

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { setUserNamespace } from './userStorage';

const STORAGE_KEY = 'funnel_eq_auth_user';

// Activate the per-user namespace immediately on module load — BEFORE any
// component mounts and reads localStorage. This covers the page-reload case:
// if a user is already persisted in localStorage, we set the namespace right
// now so that all subsequent mt_/vl_/nifty_baseline reads land in that user's
// bucket from the very first render.
try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
        const u = JSON.parse(raw);
        if (u?.email) setUserNamespace(u.email);
    }
} catch {}

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(() => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    });

    useEffect(() => {
        try {
            if (user) localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
            else localStorage.removeItem(STORAGE_KEY);
        } catch {}
    }, [user]);

    // Flip the storage namespace SYNCHRONOUSLY (before React re-renders) so
    // the new user's first render already reads from their own bucket.
    const login = useCallback((u) => {
        if (u?.email) setUserNamespace(u.email);
        setUser(u);
    }, []);

    // On logout we clear the namespace pointer. We do NOT wipe the logged-out
    // user's namespaced keys — they belong to that user and should be there
    // the next time they log back in. The shim + namespace switch is what
    // gives each user their own persistent, private session.
    const logout = useCallback(() => {
        setUserNamespace(null);
        setUser(null);
    }, []);

    return (
        <AuthContext.Provider value={{ user, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
    return ctx;
}

// Build a unique, text-safe WS credential from the authenticated user.
// Broker accepts any string for both LoginId and Password, and demands
// uniqueness across concurrent sessions — so we anchor on the user's
// identity and append a timestamp + random suffix every time this is
// called. The same string is used for both LoginId and Password, per
// the requirement.
export function buildWsCredential(user) {
    if (!user) return null;
    const raw = (user.email && user.email.split('@')[0]) || user.name || 'user';
    const base = String(raw).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) || 'user';
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 8);
    return `${base}_${ts}_${rnd}`;
}
