import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    root: '.',
    server: {
        port: 5292,
        host: true,
        allowedHosts: true,
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/kite': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
        },
    },
})
