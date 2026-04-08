// Login wall shown when no user is in the auth context.
//
// Two ways in:
//   1. Sign in with Google (OAuth, uses @react-oauth/google)
//   2. Hardcoded tester credentials: Admin / Admin123
//
// Both paths end by calling `login({email, name, picture, provider})` on
// the auth context, after which App.jsx renders the real application.

import React, { useState } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { jwtDecode } from 'jwt-decode';
import { Lock, User, AlertCircle } from 'lucide-react';
import { useAuth } from './AuthContext';

const ADMIN_USER = 'Admin';
const ADMIN_PASS = 'Admin123';

export default function LoginPage() {
    const { login } = useAuth();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');

    const handleAdminSubmit = (e) => {
        e.preventDefault();
        setError('');
        if (username === ADMIN_USER && password === ADMIN_PASS) {
            login({
                email: 'admin@funnel-eq.local',
                name: 'Admin',
                picture: null,
                provider: 'admin',
            });
        } else {
            setError('Invalid tester credentials.');
        }
    };

    const handleGoogleSuccess = (credentialResponse) => {
        setError('');
        try {
            const decoded = jwtDecode(credentialResponse.credential);
            login({
                email: decoded.email,
                name: decoded.name || decoded.given_name || decoded.email,
                picture: decoded.picture || null,
                provider: 'google',
            });
        } catch (err) {
            console.error('[auth] failed to decode Google credential', err);
            setError('Could not read Google sign-in response.');
        }
    };

    const handleGoogleError = () => {
        setError('Google sign-in failed. Please try again.');
    };

    return (
        <div className="min-h-screen w-full bg-[#0a0a0e] text-white flex items-center justify-center p-4">
            {/* Subtle grid background */}
            <div
                className="absolute inset-0 opacity-[0.03] pointer-events-none"
                style={{
                    backgroundImage:
                        'linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)',
                    backgroundSize: '24px 24px',
                }}
            />

            <div className="relative w-full max-w-sm">
                {/* Brand header */}
                <div className="text-center mb-6">
                    <div className="inline-flex items-center gap-2 mb-2">
                        <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="text-[10px] font-black text-emerald-400 uppercase tracking-[0.2em]">
                            Funnel EQ
                        </span>
                    </div>
                    <h1 className="text-2xl font-black text-white tracking-tight">
                        Sign in to continue
                    </h1>
                    <p className="text-[12px] text-white/40 mt-1">
                        Subscription-gated market monitor
                    </p>
                </div>

                <div className="bg-white/[0.03] border border-white/10 rounded-xl p-6 shadow-2xl">
                    {/* Google sign-in */}
                    <div className="flex justify-center">
                        <GoogleLogin
                            onSuccess={handleGoogleSuccess}
                            onError={handleGoogleError}
                            theme="filled_black"
                            text="signin_with"
                            shape="rectangular"
                            size="large"
                        />
                    </div>

                    {/* Divider */}
                    <div className="flex items-center gap-3 my-5">
                        <div className="flex-1 h-px bg-white/10" />
                        <span className="text-[9px] font-black text-white/30 uppercase tracking-widest">
                            or tester
                        </span>
                        <div className="flex-1 h-px bg-white/10" />
                    </div>

                    {/* Admin form */}
                    <form onSubmit={handleAdminSubmit} className="space-y-3">
                        <div className="flex items-center gap-2 bg-white/[0.04] border border-white/10 rounded px-3 h-10 focus-within:border-emerald-500/40 transition-colors">
                            <User size={14} className="text-white/30 flex-shrink-0" />
                            <input
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                placeholder="Username"
                                autoComplete="username"
                                className="bg-transparent border-none flex-1 text-[13px] text-white placeholder-white/20 focus:outline-none"
                            />
                        </div>
                        <div className="flex items-center gap-2 bg-white/[0.04] border border-white/10 rounded px-3 h-10 focus-within:border-emerald-500/40 transition-colors">
                            <Lock size={14} className="text-white/30 flex-shrink-0" />
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Password"
                                autoComplete="current-password"
                                className="bg-transparent border-none flex-1 text-[13px] text-white placeholder-white/20 focus:outline-none"
                            />
                        </div>

                        {error && (
                            <div className="flex items-center gap-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
                                <AlertCircle size={12} />
                                <span>{error}</span>
                            </div>
                        )}

                        <button
                            type="submit"
                            className="w-full bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 font-bold py-2 rounded text-[12px] uppercase tracking-wider transition-all"
                        >
                            Sign in as tester
                        </button>
                    </form>
                </div>

                <p className="text-center text-[10px] text-white/25 mt-4">
                    By signing in you agree to keep this build internal.
                </p>
            </div>
        </div>
    );
}
