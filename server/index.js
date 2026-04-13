// Production server for Railway (or any HTTPS host).
//
// Responsibilities:
//   1. Serve the built Vite SPA from ../dist
//   2. Expose a WebSocket route at /ws that transparently proxies frames
//      to the upstream broker at ws://115.242.15.134:19101

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

app.get('*', (req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
});

const server = http.createServer(app);

// WebSocket proxy on /ws
const wss = new WebSocketServer({ server, path: '/ws' });

let connectionId = 0;

wss.on('connection', (client, req) => {
    const id = ++connectionId;
    const remote = req.socket.remoteAddress;
    console.log(`[ws-proxy #${id}] client connected from ${remote}, opening upstream -> ${UPSTREAM_WS}`);

    const upstream = new WebSocket(UPSTREAM_WS);

    const pending = [];
    let upstreamReady = false;
    let clientMsgCount = 0;
    let upstreamMsgCount = 0;
    const upstreamMsgTypes = {};

    const safeClose = (code, reason) => {
        try { client.close(code, reason); } catch {}
        try { upstream.close(code, reason); } catch {}
    };

    upstream.on('open', () => {
        upstreamReady = true;
        console.log(`[ws-proxy #${id}] upstream OPEN, flushing ${pending.length} pending frame(s)`);
        for (const frame of pending) {
            console.log(`[ws-proxy #${id}] flushing pending frame: ${frame.substring(0, 120)}`);
            try { upstream.send(frame); } catch (e) { console.warn(`[ws-proxy #${id}] flush send failed`, e.message); }
        }
        pending.length = 0;
    });

    upstream.on('message', (data) => {
        upstreamMsgCount++;
        const text = typeof data === 'string' ? data : data.toString('utf8');

        // Log first 5 messages and then every 100th for diagnostics
        if (upstreamMsgCount <= 5 || upstreamMsgCount % 100 === 0) {
            try {
                const parsed = JSON.parse(text);
                upstreamMsgTypes[parsed.Type] = (upstreamMsgTypes[parsed.Type] || 0) + 1;
                console.log(`[ws-proxy #${id}] upstream msg #${upstreamMsgCount} type=${parsed.Type} (totals: ${JSON.stringify(upstreamMsgTypes)})`);
            } catch {
                console.log(`[ws-proxy #${id}] upstream msg #${upstreamMsgCount} (non-JSON, ${text.length} bytes)`);
            }
        } else {
            try {
                const parsed = JSON.parse(text);
                upstreamMsgTypes[parsed.Type] = (upstreamMsgTypes[parsed.Type] || 0) + 1;
            } catch {}
        }

        if (client.readyState === WebSocket.OPEN) {
            client.send(text);
        } else {
            console.warn(`[ws-proxy #${id}] client not open (state=${client.readyState}), dropping upstream msg`);
        }
    });

    upstream.on('close', (code, reason) => {
        console.log(`[ws-proxy #${id}] upstream CLOSED code=${code} reason=${reason?.toString?.() || 'none'} (forwarded ${upstreamMsgCount} msgs, types: ${JSON.stringify(upstreamMsgTypes)})`);
        safeClose(code, reason);
    });

    upstream.on('error', (err) => {
        console.warn(`[ws-proxy #${id}] upstream ERROR: ${err.message}`);
        safeClose(1011, 'upstream error');
    });

    client.on('message', (data) => {
        clientMsgCount++;
        const text = typeof data === 'string' ? data : data.toString('utf8');

        // Log every client message (they're infrequent: Login, TokenRequest, Heartbeat)
        try {
            const parsed = JSON.parse(text);
            console.log(`[ws-proxy #${id}] client msg #${clientMsgCount} type=${parsed.Type} (upstream ready=${upstreamReady})`);
        } catch {
            console.log(`[ws-proxy #${id}] client msg #${clientMsgCount} (non-JSON, ${text.length} bytes)`);
        }

        if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
            try { upstream.send(text); } catch (e) { console.warn(`[ws-proxy #${id}] forward failed: ${e.message}`); }
        } else {
            console.log(`[ws-proxy #${id}] upstream not ready, buffering client msg #${clientMsgCount}`);
            pending.push(text);
        }
    });

    client.on('close', (code, reason) => {
        console.log(`[ws-proxy #${id}] client CLOSED code=${code} reason=${reason?.toString?.() || 'none'} (received ${clientMsgCount} client msgs, forwarded ${upstreamMsgCount} upstream msgs)`);
        safeClose(code, reason);
    });

    client.on('error', (err) => {
        console.warn(`[ws-proxy #${id}] client ERROR: ${err.message}`);
        safeClose(1011, 'client error');
    });
});

server.listen(PORT, async () => {
    console.log(`[server] listening on :${PORT}`);
    console.log(`[server] static dir: ${DIST_DIR}`);
    console.log(`[server] ws proxy:   /ws -> ${UPSTREAM_WS}`);
    console.log(`[server] node version: ${process.version}`);

    try {
        const res = await fetch('https://api.ipify.org');
        const ip = await res.text();
        console.log(`[server] outbound IP: ${ip}  <-- WHITELIST THIS AT THE BROKER`);
    } catch (e) {
        console.warn('[server] could not resolve outbound IP:', e.message);
    }
});
