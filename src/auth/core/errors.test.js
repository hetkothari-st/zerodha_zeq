import { test, expect } from 'vitest';
import { friendlyError, NETWORK_MESSAGE, FALLBACK_MESSAGE } from './errors';

test('known codes map to friendly text', () => {
    expect(friendlyError({ code: 'invalid_credentials' })).toBe('Wrong email or password.');
    expect(friendlyError({ code: 'otp_expired' })).toBe('That code is wrong or has expired. Send a new one.');
    expect(friendlyError({ code: 'phone_exists' })).toBe('This mobile number is already linked to another account.');
});
test('network failures get the network message', () => {
    expect(friendlyError({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' })).toBe(NETWORK_MESSAGE);
    expect(friendlyError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(NETWORK_MESSAGE);
});
test('unknown errors never leak raw text', () => {
    expect(friendlyError({ code: 'weird', message: '{"raw":"json"}' })).toBe(FALLBACK_MESSAGE);
});
test('no error → null', () => {
    expect(friendlyError(null)).toBeNull();
});
test('more known codes map to friendly text', () => {
    expect(friendlyError({ code: 'email_address_invalid' })).toBe('Enter a valid email address.');
    expect(friendlyError({ code: 'session_not_found' })).toBe('Your session ended. Please sign in again.');
});
test('status 429 with no known code gets the rate-limit message', () => {
    expect(friendlyError({ status: 429, message: 'Too Many Requests' })).toBe('Too many attempts. Please wait a minute and try again.');
});
