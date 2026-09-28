import { defineConfig, devices } from '@playwright/test';
import { readE2EEnv } from './support/env.js';

const env = readE2EEnv();

export default defineConfig({
    testDir: '.',
    testMatch: /.*\.spec\.js/,
    timeout: 60_000,
    retries: 0,
    workers: 1,
    reporter: [['list']],
    use: { baseURL: env?.baseUrl, trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
});
