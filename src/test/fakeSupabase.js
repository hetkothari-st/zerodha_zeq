import { vi } from 'vitest';

// Minimal stand-in for the supabase-js client surface AuthProvider uses.
export function createFakeSupabase({ session = null, profile = null, profileError = null } = {}) {
    let listener = null;
    const state = { session, profile, profileError };
    const ok = (data = {}) => Promise.resolve({ data, error: null });
    const client = {
        state,
        emit(event, s) { state.session = s; listener?.(event, s); },
        auth: {
            getSession: vi.fn(() => ok({ session: state.session })),
            onAuthStateChange: vi.fn((cb) => { listener = cb; return { data: { subscription: { unsubscribe: vi.fn() } } }; }),
            signInWithOAuth: vi.fn(() => ok()),
            signInWithPassword: vi.fn(() => ok()),
            signUp: vi.fn(() => ok()),
            resend: vi.fn(() => ok()),
            signInWithOtp: vi.fn(() => ok()),
            verifyOtp: vi.fn(() => ok()),
            updateUser: vi.fn(() => ok()),
            refreshSession: vi.fn(() => ok({ session: state.session })),
            resetPasswordForEmail: vi.fn(() => ok()),
            signOut: vi.fn(() => ok()),
        },
        rpc: vi.fn(() => ok()),
        from: vi.fn(() => {
            const q = {
                select: () => q, eq: () => q, update: vi.fn(() => q),
                maybeSingle: () => Promise.resolve({ data: state.profile, error: state.profileError }),
                then: (res, rej) => Promise.resolve({ data: null, error: null }).then(res, rej),
            };
            return q;
        }),
    };
    return client;
}

export function jwtWithSession(sessionId) {
    const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${b64({ alg: 'ES256' })}.${b64({ session_id: sessionId })}.sig`;
}
