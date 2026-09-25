import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
    cleanup();
    try { localStorage.clear(); } catch {}
});

// jsdom lacks matchMedia; default to "motion allowed".
if (!window.matchMedia) {
    window.matchMedia = (query) => ({
        matches: false, media: query, onchange: null,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    });
}
