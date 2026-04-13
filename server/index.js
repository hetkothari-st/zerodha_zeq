// Production server for Railway (or any HTTPS host).
//
// Responsibilities:
//   1. Serve the built Vite SPA from ../dist
//   2. Expose a WebSocket route at /ws that transparently proxies frames
//      to the upstream broker at ws://115.242.15.134:19101
//
// Why the proxy exists:
//   The broker only offers plain ws:// (not wss://). Browsers block insecure
//   WebSocket connections from an HTTPS page (mixed content), so we terminate
//   TLS here on Railway and pipe the bytes onward to the broker over plain TCP.
//   No authentication logic lives here — the client still sends its own
//   {Type:"Login"} frame through us.

import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const UPSTREAM_WS = process.env.UPSTREAM_WS || 'ws://115.242.15.134:19101';
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

const app = express();
app.use(express.static(DIST_DIR));

// SPA fallback — any non-asset route returns index.html so React Router-style
// deep links still work.
app.get('*', (req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
});

const server = http.createServer(app);

// WebSocket proxy on /ws
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (client, req) => {
    const remote = req.socket.remoteAddress;
    console.log(`[ws-proxy] client connected from ${remote}, opening upstream -> ${UPSTREAM_WS}`);

    const upstream = new WebSocket(UPSTREAM_WS);

    // Buffer any frames the client sends before the upstream is open.
    const pending = [];
    let upstreamReady = false;

    const safeClose = (code, reason) => {
        try { client.close(code, reason); } catch {}
        try { upstream.close(code, reason); } catch {}
    };

    upstream.on('open', () => {
        upstreamReady = true;
        console.log('[ws-proxy] upstream open, flushing', pending.length, 'pending frame(s)');
        for (const frame of pending) {
            try { upstream.send(frame); } catch (e) { console.warn('[ws-proxy] flush send failed', e); }
        }
        pending.length = 0;
    });

    upstream.on('message', (data) => {
        if (client.readyState === WebSocket.OPEN) {
            // The broker sends Buffer objects. Forward as a UTF-8 string so
            // the browser receives a text frame (not binary/Blob), which lets
            // the client JSON.parse(event.data) work directly.
            const text = typeof data === 'string' ? data : data.toString('utf8');
            client.send(text);
        }
    });

    upstream.on('close', (code, reason) => {
        console.log('[ws-proxy] upstream closed', code, reason?.toString?.());
        safeClose(code, reason);
    });

    upstream.on('error', (err) => {
        console.warn('[ws-proxy] upstream error', err.message);
        safeClose(1011, 'upstream error');
    });

    client.on('message', (data) => {
        if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
            try { upstream.send(data); } catch (e) { console.warn('[ws-proxy] forward failed', e); }
        } else {
            pending.push(data);
        }
    });

    client.on('close', (code, reason) => {
        console.log('[ws-proxy] client closed', code, reason?.toString?.());
        safeClose(code, reason);
    });

    client.on('error', (err) => {
        console.warn('[ws-proxy] client error', err.message);
        safeClose(1011, 'client error');
    });
});

server.listen(PORT, async () => {
    console.log(`[server] listening on :${PORT}`);
    console.log(`[server] static dir: ${DIST_DIR}`);
    console.log(`[server] ws proxy:   /ws -> ${UPSTREAM_WS}`);

    // Log the outbound IP so it can be whitelisted at the broker
    try {
        const res = await fetch('https://api.ipify.org');
        const ip = await res.text();
        console.log(`[server] outbound IP: ${ip}`);
    } catch (e) {
        console.warn('[server] could not resolve outbound IP:', e.message);
    }
});
