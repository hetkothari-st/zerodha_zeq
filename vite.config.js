import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During local development (`npm run dev`) the frontend connects to
// ws://localhost:5292/ws and Vite proxies that to the real broker.
// This mirrors the Node server's /ws route in production so the frontend
// doesn't need to know whether it's in dev or prod.
export default defineConfig({
    plugins: [react()],
    root: '.',
    server: {
        port: 5292,
        host: true,
        allowedHosts: true,
        proxy: {
            '/ws': {
                target: 'ws://115.242.15.134:19101',
                ws: true,
                changeOrigin: true,
                rewrite: (p) => p.replace(/^\/ws/, ''),
            },
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
        },
    },
})
