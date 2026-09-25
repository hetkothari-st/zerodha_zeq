import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../auth/theme', () => ({
    theme: { productName: 'Funnel Test', tagline: 't', Wordmark: () => <span>WM</span>, classes: new Proxy({}, { get: () => '' }) },
}));
let auth;
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => auth }));
const { default: AdminPage } = await import('./AdminPage');

const pendingUser = { id: '22222222-2222-4222-8222-222222222222', full_name: 'Asha', email: 'asha@example.com', phone: '+919876543210', signup_provider: 'google', created_at: '2026-09-25T10:00:00Z' };

function makeApi(overrides = {}) {
    return vi.fn(async (path, opts = {}) => {
        const key = `${opts.method || 'GET'} ${path}`;
        if (overrides[key]) return overrides[key];
        if (key.startsWith('GET /api/admin/users')) return { ok: true, status: 200, data: { users: [pendingUser] } };
        if (key === 'GET /api/kite-config') return { ok: true, status: 200, data: { configured: false } };
        return { ok: true, status: 200, data: { ok: true } };
    });
}

beforeEach(() => {
    window.history.replaceState(null, '', '/admin');
    auth = { profile: { role: 'admin', full_name: 'Admin' }, apiFetch: makeApi(), signOut: vi.fn() };
});

test('non-admins see no-access and no admin API calls are made', () => {
    auth.profile = { role: 'user' };
    render(<AdminPage />);
    expect(screen.getByText("You don't have access to this page.")).toBeInTheDocument();
    expect(auth.apiFetch).not.toHaveBeenCalled();
});

test('lists pending users and approves one', async () => {
    render(<AdminPage />);
    expect(await screen.findByText('Asha')).toBeInTheDocument();
    expect(auth.apiFetch).toHaveBeenCalledWith('/api/admin/users?status=pending');
    await userEvent.click(screen.getByRole('button', { name: 'Approve Asha' }));
    expect(auth.apiFetch).toHaveBeenCalledWith(`/api/admin/users/${pendingUser.id}/approve`, { method: 'POST' });
});

test('shows the server message when approval is refused', async () => {
    auth.apiFetch = makeApi({ [`POST /api/admin/users/${pendingUser.id}/approve`]: { ok: false, status: 400, code: 'bad_request', message: "This user hasn't verified a mobile number yet." } });
    render(<AdminPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve Asha' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("This user hasn't verified a mobile number yet.");
});

test('switching tab loads that status', async () => {
    render(<AdminPage />);
    await screen.findByText('Asha');
    await userEvent.click(screen.getByRole('tab', { name: /^Approved/ }));
    await waitFor(() => expect(auth.apiFetch).toHaveBeenCalledWith('/api/admin/users?status=approved'));
});

test('Zerodha: connect redirects to the Kite URL from the server', async () => {
    auth.apiFetch = makeApi({ 'POST /api/admin/kite/login-url': { ok: true, status: 200, data: { ok: true, url: 'https://kite.zerodha.com/connect/login?v=3&api_key=k' } } });
    const { nav } = await import('./ZerodhaSection');
    const go = vi.spyOn(nav, 'go').mockImplementation(() => {});
    render(<AdminPage />);
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect Zerodha' }));
    expect(go).toHaveBeenCalledWith('https://kite.zerodha.com/connect/login?v=3&api_key=k');
});

test('Zerodha: callback result banner from ?kite=', async () => {
    window.history.replaceState(null, '', '/admin?kite=expired');
    render(<AdminPage />);
    expect(await screen.findByText('That Zerodha login link expired. Start again.')).toBeInTheDocument();
});

test('Zerodha: paste access token', async () => {
    render(<AdminPage />);
    await screen.findByText('Not connected');
    await userEvent.type(screen.getByLabelText('Access token'), 'tok123');
    await userEvent.click(screen.getByRole('button', { name: 'Set token' }));
    expect(auth.apiFetch).toHaveBeenCalledWith('/api/set-access-token', { method: 'POST', body: { access_token: 'tok123' } });
});

test('a stale pending response does not overwrite the Approved tab after switching', async () => {
    const approvedUser = { id: '33333333-3333-4333-8333-333333333333', full_name: 'Bina', email: 'bina@example.com', phone: '+919876543211', signup_provider: 'email', created_at: '2026-09-25T10:00:00Z' };
    let resolvePending;
    const pendingPromise = new Promise((resolve) => { resolvePending = resolve; });
    auth.apiFetch = vi.fn(async (path, opts = {}) => {
        const key = `${opts.method || 'GET'} ${path}`;
        if (key === 'GET /api/admin/users?status=pending') return pendingPromise;
        if (key === 'GET /api/admin/users?status=approved') return { ok: true, status: 200, data: { users: [approvedUser] } };
        if (key === 'GET /api/kite-config') return { ok: true, status: 200, data: { configured: false } };
        return { ok: true, status: 200, data: { ok: true } };
    });
    render(<AdminPage />);
    await waitFor(() => expect(auth.apiFetch).toHaveBeenCalledWith('/api/admin/users?status=pending'));
    await userEvent.click(screen.getByRole('tab', { name: /^Approved/ }));
    expect(await screen.findByText('Bina')).toBeInTheDocument();
    // Resolve the stale pending request now that Approved is showing; it must not clobber the view.
    resolvePending({ ok: true, status: 200, data: { users: [pendingUser] } });
    await waitFor(() => {
        expect(screen.getByText('Bina')).toBeInTheDocument();
        expect(screen.queryByText('Asha')).not.toBeInTheDocument();
    });
});

test('double-clicking Approve only sends one approve request', async () => {
    render(<AdminPage />);
    const button = await screen.findByRole('button', { name: 'Approve Asha' });
    await userEvent.click(button);
    await userEvent.click(button);
    const approveCalls = auth.apiFetch.mock.calls.filter(([path]) => path === `/api/admin/users/${pendingUser.id}/approve`);
    expect(approveCalls.length).toBe(1);
});

test('Zerodha: two quick clicks on Connect Zerodha only call login-url once', async () => {
    let resolveLogin;
    const loginPromise = new Promise((resolve) => { resolveLogin = resolve; });
    auth.apiFetch = vi.fn(async (path, opts = {}) => {
        const key = `${opts.method || 'GET'} ${path}`;
        if (key === 'POST /api/admin/kite/login-url') return loginPromise;
        if (key.startsWith('GET /api/admin/users')) return { ok: true, status: 200, data: { users: [pendingUser] } };
        if (key === 'GET /api/kite-config') return { ok: true, status: 200, data: { configured: false } };
        return { ok: true, status: 200, data: { ok: true } };
    });
    const { nav } = await import('./ZerodhaSection');
    const go = vi.spyOn(nav, 'go').mockImplementation(() => {});
    render(<AdminPage />);
    const button = await screen.findByRole('button', { name: 'Connect Zerodha' });
    await userEvent.click(button);
    await userEvent.click(button);
    resolveLogin({ ok: true, status: 200, data: { ok: true, url: 'https://kite.zerodha.com/connect/login?v=3&api_key=k' } });
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    const loginCalls = auth.apiFetch.mock.calls.filter(([path]) => path === '/api/admin/kite/login-url');
    expect(loginCalls.length).toBe(1);
});

test('tabs show a count per status and the table scrolls horizontally', async () => {
    const approvedUser = { ...pendingUser, id: '33333333-3333-4333-8333-333333333333', full_name: 'Bina' };
    auth.apiFetch = makeApi({
        'GET /api/admin/users?status=pending': { ok: true, status: 200, data: { users: [pendingUser] } },
        'GET /api/admin/users?status=approved': { ok: true, status: 200, data: { users: [approvedUser, { ...approvedUser, id: 'x' }] } },
        'GET /api/admin/users?status=rejected': { ok: true, status: 200, data: { users: [] } },
    });
    const { container } = render(<AdminPage />);
    expect(await screen.findByRole('tab', { name: 'Pending (1)' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Approved (2)' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Rejected (0)' })).toBeInTheDocument();
    await screen.findByText('Asha');
    expect(container.querySelector('table').parentElement).toHaveClass('overflow-x-auto');
});

test('counts refresh after an approval', async () => {
    let pending = [pendingUser];
    const approved = [];
    auth.apiFetch = vi.fn(async (path, opts = {}) => {
        const key = `${opts.method || 'GET'} ${path}`;
        if (key === 'GET /api/admin/users?status=pending') return { ok: true, status: 200, data: { users: pending } };
        if (key === 'GET /api/admin/users?status=approved') return { ok: true, status: 200, data: { users: approved } };
        if (key === 'GET /api/admin/users?status=rejected') return { ok: true, status: 200, data: { users: [] } };
        if (key === `POST /api/admin/users/${pendingUser.id}/approve`) { pending = []; approved.push(pendingUser); return { ok: true, status: 200, data: { ok: true } }; }
        if (key === 'GET /api/kite-config') return { ok: true, status: 200, data: { configured: false } };
        return { ok: true, status: 200, data: { ok: true } };
    });
    render(<AdminPage />);
    expect(await screen.findByRole('tab', { name: 'Pending (1)' })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve Asha' }));
    expect(await screen.findByRole('tab', { name: 'Pending (0)' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Approved (1)' })).toBeInTheDocument();
});
