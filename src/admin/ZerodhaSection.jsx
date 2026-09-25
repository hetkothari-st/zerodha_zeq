import React, { useCallback, useEffect, useState } from 'react';
import { theme } from '../auth/theme';

// Indirection so tests can observe navigation (jsdom's location.assign cannot be spied on).
export const nav = { go: (url) => window.location.assign(url) };

const BANNERS = {
    connected: ['info', 'Zerodha connected.'],
    failed: ['error', 'Zerodha login failed. Try again.'],
    expired: ['error', 'That Zerodha login link expired. Start again.'],
};

export default function ZerodhaSection({ apiFetch }) {
    const c = theme.classes;
    const [configured, setConfigured] = useState(null);
    const [message, setMessage] = useState(() => {
        const kite = new URLSearchParams(window.location.search).get('kite');
        return BANNERS[kite] || null;
    });
    const [accessToken, setAccessToken] = useState('');
    const [requestToken, setRequestToken] = useState('');
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        const r = await apiFetch('/api/kite-config');
        if (r.ok) setConfigured(Boolean(r.data.configured)); else setMessage(['error', r.message]);
    }, [apiFetch]);

    useEffect(() => { refresh(); }, [refresh]);

    async function connect() {
        if (busy) return;
        setBusy(true);
        const r = await apiFetch('/api/admin/kite/login-url', { method: 'POST' });
        setBusy(false);
        if (r.ok && r.data.url) nav.go(r.data.url); else setMessage(['error', r.message]);
    }

    async function submit(path, body, clear) {
        if (busy) return;
        setBusy(true);
        const r = await apiFetch(path, { method: 'POST', body });
        setBusy(false);
        if (r.ok) { clear(''); setMessage(BANNERS.connected); refresh(); } else setMessage(['error', r.message]);
    }

    return (
        <section className={`${c.card} flex flex-col gap-4`}>
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">Zerodha</h2>
                <span className={c.muted}>{configured === null ? 'Checking…' : configured ? 'Connected' : 'Not connected'}</span>
            </div>
            {message && <div role={message[0] === 'error' ? 'alert' : 'status'} className={message[0] === 'error' ? c.error : c.info}>{message[1]}</div>}
            <button type="button" className={c.primary} onClick={connect} disabled={busy}>Connect Zerodha</button>
            <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (requestToken.trim()) submit('/api/exchange-token', { request_token: requestToken.trim() }, setRequestToken); }}>
                <label htmlFor="kite-rt" className="flex flex-1 flex-col gap-1"><span className={c.label}>Request token</span>
                    <input id="kite-rt" className={c.input} value={requestToken} onChange={(e) => setRequestToken(e.target.value)} /></label>
                <button type="submit" className={c.secondary} disabled={busy}>Exchange</button>
            </form>
            <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (accessToken.trim()) submit('/api/set-access-token', { access_token: accessToken.trim() }, setAccessToken); }}>
                <label htmlFor="kite-at" className="flex flex-1 flex-col gap-1"><span className={c.label}>Access token</span>
                    <input id="kite-at" className={c.input} value={accessToken} onChange={(e) => setAccessToken(e.target.value)} /></label>
                <button type="submit" className={c.secondary} disabled={busy}>Set token</button>
            </form>
        </section>
    );
}
