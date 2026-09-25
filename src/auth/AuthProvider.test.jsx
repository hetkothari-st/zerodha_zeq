import { test, expect, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthProvider';
import { createFakeSupabase, jwtWithSession } from '../test/fakeSupabase';

const fullUser = { id: 'u1', email: 'a@b.in', email_confirmed_at: 't', phone_confirmed_at: 't' };
const sessionFor = (sid, user = fullUser) => ({ access_token: jwtWithSession(sid), user });

function Probe() {
    const a = useAuth();
    return <div data-testid="screen">{a.screen}{a.displaced ? ' displaced' : ''}</div>;
}
const renderWith = (client) => render(<AuthProvider client={client}><Probe /></AuthProvider>);

test('no session → signIn', async () => {
    renderWith(createFakeSupabase());
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('signIn'));
});

test('approved user → app', async () => {
    renderWith(createFakeSupabase({ session: sessionFor('s1'), profile: { id: 'u1', status: 'approved', role: 'user' } }));
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('app'));
});

test('SIGNED_IN claims the session and signs out other devices', async () => {
    const client = createFakeSupabase({ profile: { id: 'u1', status: 'approved' } });
    renderWith(client);
    await act(async () => { client.emit('SIGNED_IN', sessionFor('s-new')); });
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('claim_session'));
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    expect(localStorage.getItem('funnel_claimed_session')).toBe('s-new');
});

test('does not re-claim an already-claimed session (reload of a displaced device)', async () => {
    localStorage.setItem('funnel_claimed_session', 's-old');
    const client = createFakeSupabase({ profile: { id: 'u1', status: 'approved' } });
    renderWith(client);
    await act(async () => { client.emit('SIGNED_IN', sessionFor('s-old')); });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.auth.signOut).not.toHaveBeenCalled();
});

test('profile load error → unavailable', async () => {
    renderWith(createFakeSupabase({ session: sessionFor('s1'), profileError: { message: 'down' } }));
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('unavailable'));
});

test('PASSWORD_RECOVERY → resetPassword', async () => {
    const client = createFakeSupabase();
    renderWith(client);
    await act(async () => { client.emit('PASSWORD_RECOVERY', sessionFor('s1')); });
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('resetPassword'));
});

test('expired email link in the URL hash → linkExpired', async () => {
    window.history.replaceState(null, '', '/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid');
    renderWith(createFakeSupabase());
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('linkExpired'));
    window.history.replaceState(null, '', '/');
});

test('actions return friendly errors', async () => {
    const client = createFakeSupabase();
    client.auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } });
    let api;
    function Grab() { api = useAuth(); return null; }
    render(<AuthProvider client={client}><Grab /></AuthProvider>);
    await waitFor(() => expect(api.loading).toBe(false));
    expect(await api.signInWithPassword(' a@b.in ', 'x')).toEqual({ error: 'Wrong email or password.', code: 'invalid_credentials' });
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.in', password: 'x' });
});

test('apiFetch 401 signed_in_elsewhere marks displaced', async () => {
    const client = createFakeSupabase({ session: sessionFor('s1'), profile: { id: 'u1', status: 'approved' } });
    const realFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'signed_in_elsewhere', message: 'x' }), { status: 401 }));
    try {
        let api;
        function Grab() { api = useAuth(); return <Probe />; }
        render(<AuthProvider client={client}><Grab /></AuthProvider>);
        await waitFor(() => expect(api.screen).toBe('app'));
        await act(async () => { await api.apiFetch('/api/admin/users'); });
        expect(screen.getByTestId('screen')).toHaveTextContent('displaced');
    } finally {
        global.fetch = realFetch;
    }
});

test('PASSWORD_RECOVERY also claims the session and signs out other devices', async () => {
    const client = createFakeSupabase();
    renderWith(client);
    await act(async () => { client.emit('PASSWORD_RECOVERY', sessionFor('s-recover')); });
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('claim_session'));
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'others' });
    expect(localStorage.getItem('funnel_claimed_session')).toBe('s-recover');
});

test('while claiming the screen is loading; becomes app once the claim resolves', async () => {
    const client = createFakeSupabase({ profile: { id: 'u1', status: 'approved' } });
    let resolveRpc;
    client.rpc.mockImplementationOnce(() => new Promise((res) => { resolveRpc = res; }));
    renderWith(client);
    await act(async () => { client.emit('SIGNED_IN', sessionFor('s-new')); });
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('loading'));
    await act(async () => { resolveRpc({ data: {}, error: null }); });
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('app'));
});

test('a claim rpc error clears claiming without persisting the claim or signing others out', async () => {
    const client = createFakeSupabase({ profile: { id: 'u1', status: 'approved' } });
    client.rpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    renderWith(client);
    await act(async () => { client.emit('SIGNED_IN', sessionFor('s-err')); });
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('claim_session'));
    expect(localStorage.getItem('funnel_claimed_session')).toBeNull();
    expect(client.auth.signOut).not.toHaveBeenCalledWith({ scope: 'others' });
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('app'));
});

test('onSignedInElsewhere is ignored while a claim is in flight', async () => {
    const client = createFakeSupabase({ session: sessionFor('s1'), profile: { id: 'u1', status: 'approved' } });
    let resolveRpc;
    client.rpc.mockImplementationOnce(() => new Promise((res) => { resolveRpc = res; }));
    const realFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'signed_in_elsewhere', message: 'x' }), { status: 401 }));
    try {
        let api;
        function Grab() { api = useAuth(); return <Probe />; }
        render(<AuthProvider client={client}><Grab /></AuthProvider>);
        await waitFor(() => expect(api.screen).toBe('app'));
        await act(async () => { client.emit('SIGNED_IN', sessionFor('s-new')); });
        await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('loading'));
        await act(async () => { await api.apiFetch('/api/admin/users'); });
        expect(screen.getByTestId('screen')).not.toHaveTextContent('displaced');
        await act(async () => { resolveRpc({ data: {}, error: null }); });
        await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('app'));
    } finally {
        global.fetch = realFetch;
    }
});

test('signOut removes the claimed-session key and resolves ok on success', async () => {
    localStorage.setItem('funnel_claimed_session', 's1');
    const client = createFakeSupabase();
    let api;
    function Grab() { api = useAuth(); return null; }
    render(<AuthProvider client={client}><Grab /></AuthProvider>);
    await waitFor(() => expect(api.loading).toBe(false));
    const r = await api.signOut();
    expect(r).toEqual({ error: null, code: null });
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(localStorage.getItem('funnel_claimed_session')).toBeNull();
});

test('signOutHere removes the claimed-session key and resolves ok on success', async () => {
    localStorage.setItem('funnel_claimed_session', 's1');
    const client = createFakeSupabase();
    let api;
    function Grab() { api = useAuth(); return null; }
    render(<AuthProvider client={client}><Grab /></AuthProvider>);
    await waitFor(() => expect(api.loading).toBe(false));
    const r = await api.signOutHere();
    expect(r).toEqual({ error: null, code: null });
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(localStorage.getItem('funnel_claimed_session')).toBeNull();
});

test('signOut failure keeps the claimed-session key and returns a friendly error', async () => {
    localStorage.setItem('funnel_claimed_session', 's1');
    const client = createFakeSupabase();
    client.auth.signOut.mockResolvedValueOnce({ data: {}, error: { code: 'session_not_found', message: 'gone' } });
    let api;
    function Grab() { api = useAuth(); return null; }
    render(<AuthProvider client={client}><Grab /></AuthProvider>);
    await waitFor(() => expect(api.loading).toBe(false));
    const r = await api.signOut();
    expect(r).toEqual({ error: 'Your session ended. Please sign in again.', code: 'session_not_found' });
    expect(localStorage.getItem('funnel_claimed_session')).toBe('s1');
});

test('getSession rejecting at startup → unavailable', async () => {
    const client = createFakeSupabase();
    client.auth.getSession.mockRejectedValueOnce(new Error('boom'));
    renderWith(client);
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('unavailable'));
});

test('SIGNED_OUT clears the recovery flag', async () => {
    const client = createFakeSupabase();
    renderWith(client);
    await act(async () => { client.emit('PASSWORD_RECOVERY', sessionFor('s1')); });
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('resetPassword'));
    await act(async () => { client.emit('SIGNED_OUT', null); });
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('signIn'));
});

test('a missing profile row (no error) is treated as unavailable', async () => {
    renderWith(createFakeSupabase({ session: sessionFor('s1'), profile: null, profileError: null }));
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('unavailable'));
});

test('expired email link in the URL query string → linkExpired', async () => {
    window.history.replaceState(null, '', '/?error_code=otp_expired&error_description=Email+link+is+invalid');
    renderWith(createFakeSupabase());
    await waitFor(() => expect(screen.getByTestId('screen')).toHaveTextContent('linkExpired'));
    window.history.replaceState(null, '', '/');
});

test('resendEmailVerification includes the redirect for a pending email change', async () => {
    const changingUser = { ...fullUser, email: '', new_email: 'n@b.in', email_confirmed_at: null };
    const client = createFakeSupabase({ session: sessionFor('s1', changingUser) });
    let api;
    function Grab() { api = useAuth(); return null; }
    render(<AuthProvider client={client}><Grab /></AuthProvider>);
    await waitFor(() => expect(api.loading).toBe(false));
    await api.resendEmailVerification();
    expect(client.auth.resend).toHaveBeenCalledWith({ type: 'email_change', email: 'n@b.in', options: { emailRedirectTo: expect.any(String) } });
});
