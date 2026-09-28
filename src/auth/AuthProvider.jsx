import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getSupabase } from './supabaseClient';
import { friendlyError } from './core/errors';
import { sessionIdOf } from './core/validators';
import { screenFor } from './core/screenFor';
import { REQUIRE_MOBILE } from './core/featureFlags';
import { createApiFetch } from './core/apiFetch';
import { setUserNamespace, migrateToUserNamespace } from './userStorage';

const AuthContext = createContext(null);
const CLAIMED_KEY = 'funnel_claimed_session';
const PROFILE_FIELDS = 'id,full_name,email,phone,status,role';
const CLAIM_RETRY_MS = 1000;
const SESSION_WATCH_MS = 15000;
const MISSING_ENV_MESSAGE = '[auth] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set';
const NO_CLIENT_RESULT = { error: 'Sign-in is temporarily unavailable. Please try again in a moment.', code: 'startup_error' };
let missingEnvLogged = false;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function linkErrorFrom(paramString) {
    const params = new URLSearchParams(paramString);
    const code = params.get('error_code');
    return code ? { code, description: params.get('error_description') || '' } : null;
}

function readLinkError() {
    if (typeof window === 'undefined') return null;
    return linkErrorFrom(window.location.hash.replace(/^#/, '')) || linkErrorFrom(window.location.search.replace(/^\?/, ''));
}

// Set-password / reset emails link to /reset-password?token_hash=…&type=recovery. The app's
// client uses the PKCE flow, which can't consume the implicit-flow links a server-sent
// recovery email would otherwise carry, so the token hash is verified here instead.
function readRecoveryLink() {
    if (typeof window === 'undefined' || window.location.pathname !== '/reset-password') return null;
    const params = new URLSearchParams(window.location.search);
    const tokenHash = params.get('token_hash');
    return tokenHash && params.get('type') === 'recovery' ? tokenHash : null;
}

function removeRecoveryParams() {
    const url = new URL(window.location.href);
    url.searchParams.delete('token_hash');
    url.searchParams.delete('type');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

// One verification per client + token: a token hash works only once, so a re-run of the
// startup effect (e.g. React StrictMode) must reuse the first attempt, not burn the link.
const recoveryVerifications = new WeakMap();
function verifyRecoveryOnce(client, tokenHash) {
    let byToken = recoveryVerifications.get(client);
    if (!byToken) { byToken = new Map(); recoveryVerifications.set(client, byToken); }
    if (!byToken.has(tokenHash)) {
        byToken.set(tokenHash, Promise.resolve()
            .then(() => client.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' }))
            .catch((e) => ({ data: null, error: e || {} })));
    }
    return byToken.get(tokenHash);
}

const EXPIRED_LINK_DESCRIPTION = 'Email link is invalid or has expired';

const result = (error) => ({ error: friendlyError(error), code: error?.code ?? null });

export function AuthProvider({ children, client: clientProp, requireMobile = REQUIRE_MOBILE }) {
    const client = useMemo(() => {
        try {
            return clientProp ?? getSupabase();
        } catch {
            return null;
        }
    }, [clientProp]);
    const [session, setSession] = useState(null);
    const [loading, setLoading] = useState(true);
    const [profile, setProfile] = useState(null);
    const [profileError, setProfileError] = useState(false);
    const [recovery, setRecovery] = useState(false);
    const [linkError, setLinkError] = useState(readLinkError);
    const [displaced, setDisplaced] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [startupError, setStartupError] = useState(false);
    const [claimError, setClaimError] = useState(false);
    const sessionRef = useRef(null);
    const claimingRef = useRef(false);
    const claimingSidRef = useRef(null);
    const origin = typeof window !== 'undefined' ? window.location.origin : '';

    const adoptSession = useCallback((s) => {
        sessionRef.current = s;
        setSession(s);
        if (s) setStartupError(false); // a session arrived after all — the startup failure is over
    }, []);

    // One device at a time: a new session claims the account and signs out the others.
    // A failed claim is retried once; if that fails too, claimError puts up Unavailable
    // (whose "Try again" calls retryClaim) rather than silently leaving two devices signed in.
    const claimIfNew = useCallback(async (s) => {
        if (!client) return;
        const sid = sessionIdOf(s?.access_token);
        if (!sid) return;
        let claimed = null;
        try { claimed = localStorage.getItem(CLAIMED_KEY); } catch {}
        if (claimed === sid) return;
        if (claimingSidRef.current === sid) return; // this session's claim is already in flight
        claimingSidRef.current = sid;
        claimingRef.current = true;
        setClaiming(true);
        setClaimError(false);
        const claimOnce = async () => {
            try { return !(await client.rpc('claim_session')).error; } catch { return false; }
        };
        try {
            let ok = await claimOnce();
            if (!ok) { await wait(CLAIM_RETRY_MS); ok = await claimOnce(); }
            if (!ok) {
                // Only flag it if we're still on that session (not signed out / replaced meanwhile).
                if (sessionIdOf(sessionRef.current?.access_token) === sid) setClaimError(true);
                return;
            }
            try { localStorage.setItem(CLAIMED_KEY, sid); } catch {}
            await client.auth.signOut({ scope: 'others' });
        } catch {
            // signOut of the other devices failed; the claim itself stands.
        } finally {
            claimingSidRef.current = null;
            claimingRef.current = false;
            setClaiming(false);
        }
    }, [client]);

    const loadProfile = useCallback(async (userId) => {
        if (!client) { setProfileError(true); return; }
        const { data, error } = await client.from('profiles').select(PROFILE_FIELDS).eq('id', userId).maybeSingle();
        if (sessionRef.current?.user?.id !== userId) return; // stale response for a session we've moved on from
        if (error) { setProfileError(true); return; }
        if (!data) { setProfileError(true); return; }
        setProfileError(false);
        setProfile(data);
    }, [client]);

    useEffect(() => {
        if (!client) {
            if (!missingEnvLogged) { missingEnvLogged = true; console.error(MISSING_ENV_MESSAGE); }
            setStartupError(true);
            setLoading(false);
            return;
        }
        let active = true;
        // onAuthStateChange can fire (e.g. SIGNED_IN) before this initial snapshot resolves;
        // once that happens the event is the source of truth, so don't let a late, stale
        // getSession() result stomp a newer session.
        let authEventSeen = false;
        const { data: sub } = client.auth.onAuthStateChange((event, s) => {
            authEventSeen = true;
            adoptSession(s);
            if (event === 'PASSWORD_RECOVERY') setRecovery(true);
            if ((event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY') && s) claimIfNew(s);
            if (event === 'SIGNED_OUT') { setProfile(null); setDisplaced(false); setRecovery(false); setClaimError(false); }
        });
        // A set-password link is verified first (loading stays true meanwhile), then the
        // usual getSession snapshot runs, so the order is always the same.
        const verifyRecoveryLink = async (tokenHash) => {
            const { data, error } = await verifyRecoveryOnce(client, tokenHash);
            if (!active) return;
            removeRecoveryParams(); // a token hash works once; don't retry it on reload
            const s = data?.session ?? null;
            if (error || !s) {
                setLinkError({ code: error?.code || 'otp_expired', description: error?.message || EXPIRED_LINK_DESCRIPTION });
                return;
            }
            authEventSeen = true;
            adoptSession(s);
            setRecovery(true);
            claimIfNew(s);
        };
        const startup = async () => {
            const tokenHash = readRecoveryLink();
            if (tokenHash) await verifyRecoveryLink(tokenHash);
            if (!active) return;
            try {
                const { data, error } = await client.auth.getSession();
                if (!active) return;
                if (error) { setStartupError(true); setLoading(false); return; }
                if (!authEventSeen) adoptSession(data.session);
                setLoading(false);
            } catch {
                if (!active) return;
                setStartupError(true);
                setLoading(false);
            }
        };
        startup();
        return () => { active = false; sub.subscription.unsubscribe(); };
    }, [client, claimIfNew, adoptSession]);

    const userId = session?.user?.id ?? null;
    const phoneVerified = Boolean(session?.user?.phone_confirmed_at);
    useEffect(() => {
        if (userId) migrateToUserNamespace(userId, sessionRef.current?.user?.email ?? null);
        setUserNamespace(userId);
        if (userId) { setProfile(null); setProfileError(false); loadProfile(userId); }
        else { setProfile(null); setProfileError(false); }
    }, [userId, phoneVerified, loadProfile]);

    const refreshSessionState = useCallback(async () => {
        if (!client) return { code: 'startup_error' };
        const { data, error } = await client.auth.refreshSession();
        if (!error && data?.session) adoptSession(data.session);
        return error;
    }, [client, adoptSession]);

    const apiFetch = useMemo(() => createApiFetch({
        getAccessToken: async () => (client ? (await client.auth.getSession()).data.session?.access_token ?? null : null),
        onSignedInElsewhere: () => { if (!claimingRef.current) setDisplaced(true); },
        onUnauthenticated: () => { client?.auth.signOut({ scope: 'local' }); },
    }), [client]);

    const actions = useMemo(() => ({
        signInWithGoogle: async () => result((await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: origin } })).error),
        signInWithPassword: async (email, password) => result((await client.auth.signInWithPassword({ email: email.trim(), password })).error),
        signUpWithEmail: async ({ name, email, password }) => result((await client.auth.signUp({
            email: email.trim(), password, options: { data: { full_name: name.trim() }, emailRedirectTo: origin },
        })).error),
        resendSignupEmail: async (email) => result((await client.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: origin } })).error),
        sendPhoneOtp: async (phone, { createUser }) => result((await client.auth.signInWithOtp({ phone, options: { shouldCreateUser: createUser } })).error),
        verifyPhoneOtp: async (phone, code) => result((await client.auth.verifyOtp({ phone, token: code.trim(), type: 'sms' })).error),
        addEmail: async ({ name, email }) => {
            const { error } = await client.auth.updateUser({ email: email.trim(), data: { full_name: name.trim() } }, { emailRedirectTo: origin });
            if (error) return result(error);
            const uid = sessionRef.current?.user?.id;
            if (uid) await client.from('profiles').update({ full_name: name.trim() }).eq('id', uid);
            await refreshSessionState();
            return result(null);
        },
        resendEmailVerification: async () => {
            const u = sessionRef.current?.user;
            const r = u?.new_email
                ? await client.auth.resend({ type: 'email_change', email: u.new_email, options: { emailRedirectTo: origin } })
                : await client.auth.resend({ type: 'signup', email: u?.email ?? '', options: { emailRedirectTo: origin } });
            return result(r.error);
        },
        refreshUser: async () => result(await refreshSessionState()),
        startAddMobile: async (phone) => result((await client.auth.updateUser({ phone })).error),
        verifyAddMobile: async (phone, code) => {
            const { error } = await client.auth.verifyOtp({ phone, token: code.trim(), type: 'phone_change' });
            if (!error) await refreshSessionState();
            return result(error);
        },
        sendPasswordReset: async (email) => result((await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${origin}/reset-password` })).error),
        updatePassword: async (password) => {
            const { error } = await client.auth.updateUser({ password });
            if (!error) {
                setRecovery(false);
                if (typeof window !== 'undefined' && window.location.pathname === '/reset-password') window.history.replaceState(null, '', '/');
            }
            return result(error);
        },
        signOut: async () => {
            if (!client) return NO_CLIENT_RESULT;
            const { error } = await client.auth.signOut({ scope: 'global' });
            if (!error) {
                try { localStorage.removeItem(CLAIMED_KEY); } catch {}
                setDisplaced(false);
            }
            return result(error);
        },
        signOutHere: async () => {
            if (!client) return NO_CLIENT_RESULT;
            const { error } = await client.auth.signOut({ scope: 'local' });
            if (!error) {
                try { localStorage.removeItem(CLAIMED_KEY); } catch {}
                setDisplaced(false);
            }
            return result(error);
        },
        refreshProfile: async () => { const uid = sessionRef.current?.user?.id; if (uid) await loadProfile(uid); },
        clearLinkError: () => {
            setLinkError(null);
            if (typeof window !== 'undefined') window.history.replaceState(null, '', window.location.pathname);
        },
        // Ignored mid-claim: the claim itself signs the old session out, which the hub may report.
        markDisplaced: () => { if (!claimingRef.current) setDisplaced(true); },
        retryClaim: async () => {
            setClaimError(false);
            const s = sessionRef.current;
            if (s) await claimIfNew(s);
        },
    }), [client, origin, loadProfile, refreshSessionState, claimIfNew]);

    const screen = claiming ? 'loading' : screenFor({ loading, recovery, linkError, session, profile, profileError, startupError, claimError, requireMobile });
    const accessToken = session?.access_token ?? null;

    // Displacement normally arrives over the hub WebSocket or an API 401. When the socket is
    // off (market data disabled) neither fires, so while in the app we also check the
    // account's claimed session every 15 s.
    const watchSession = screen === 'app' && !displaced && Boolean(client) && Boolean(userId);
    useEffect(() => {
        if (!watchSession) return undefined;
        const mySid = sessionIdOf(accessToken);
        if (!mySid) return undefined;
        let active = true;
        const id = setInterval(async () => {
            try {
                const { data, error } = await client.from('profiles').select('current_session_id').eq('id', userId).maybeSingle();
                if (!active || error) return;
                const current = data?.current_session_id ?? null;
                if (current && current !== mySid && !claimingRef.current) setDisplaced(true);
            } catch {
                // Network hiccup — try again on the next tick.
            }
        }, SESSION_WATCH_MS);
        return () => { active = false; clearInterval(id); };
    }, [watchSession, client, userId, accessToken]);

    const value = useMemo(() => ({
        screen,
        loading, session, user: session?.user ?? null, profile, profileError, recovery, linkError, displaced, claimError,
        accessToken,
        apiFetch,
        ...actions,
    }), [screen, loading, recovery, linkError, session, profile, profileError, displaced, claimError, accessToken, apiFetch, actions]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
    return ctx;
}
