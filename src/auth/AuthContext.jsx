// Minimal client-side auth gate backed by server-side Supabase validation.
//
// Login flow:
//   1. User enters username + password on LoginPage
//   2. Frontend POSTs to /api/login on the server
//   3. Server validates against Supabase `app_users` table
//   4. Server checks no other active session exists for that user
//   5. Server returns {ok, user, sessionToken} or {ok:false, error}
//   6. Frontend stores user + sessionToken in localStorage
//
// Logout:
//   1. Frontend POSTs to /api/logout with the sessionToken
//   2. Server clears the active session
//   3. Frontend clears localStorage

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { setUserNamespace } from './userStorage';

const STORAGE_KEY = 'funnel_eq_auth_user';
const SESSION_KEY = 'funnel_eq_session_token';

// Activate per-user namespace on module load (covers page reload)
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

    const [sessionToken, setSessionToken] = useState(() => {
        try {
            return localStorage.getItem(SESSION_KEY) || null;
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

    useEffect(() => {
        try {
            if (sessionToken) localStorage.setItem(SESSION_KEY, sessionToken);
            else localStorage.removeItem(SESSION_KEY);
        } catch {}
    }, [sessionToken]);

    const login = useCallback((u, token) => {
        if (u?.email) setUserNamespace(u.email);
        setUser(u);
        setSessionToken(token || null);
    }, []);

    const logout = useCallback(async () => {
        // Tell server to release the session
        const token = sessionToken || localStorage.getItem(SESSION_KEY);
        if (token) {
            try {
                await fetch('/api/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionToken: token }),
                });
            } catch (e) {
                console.warn('[auth] logout request failed:', e.message);
            }
        }
        setUserNamespace(null);
        setUser(null);
        setSessionToken(null);
    }, [sessionToken]);

    return (
        <AuthContext.Provider value={{ user, sessionToken, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
    return ctx;
}

// WS credential — uses the Supabase username + a fixed 4-char suffix so each
// user has a stable, unique broker identity across all sessions. The suffix is
// derived from the username itself (not random), so it's the same every time.
export function buildWsCredential(user) {
    if (!user) return null;
    const name = user.name || (user.email && user.email.split('@')[0]) || 'user';
    // Generate a fixed 4-char suffix from the username
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    const suffix = Math.abs(hash).toString(36).slice(0, 4).padEnd(4, '0');
    return `${name}_${suffix}`;
}
