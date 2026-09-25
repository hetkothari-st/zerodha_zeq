import { test, expect } from 'vitest';
import { toIndianE164, passwordProblem, isEmail, isOtp, sessionIdOf } from './validators';

test('toIndianE164 accepts 10-digit Indian mobiles in common formats', () => {
    expect(toIndianE164('98765 43210')).toBe('+919876543210');
    expect(toIndianE164('+91 98765-43210')).toBe('+919876543210');
    expect(toIndianE164('919876543210')).toBe('+919876543210');
});
test('toIndianE164 rejects invalid numbers', () => {
    for (const bad of ['', '12345', '5876543210', '98765432109', 'abcdefghij']) expect(toIndianE164(bad)).toBeNull();
});
test('toIndianE164 accepts a leading 0 on an 11-digit number', () => {
    expect(toIndianE164('09876543210')).toBe('+919876543210');
});
test('passwordProblem', () => {
    expect(passwordProblem('short1')).toBe('Use at least 8 characters.');
    expect(passwordProblem('longpassword')).toBe('Use both letters and numbers.');
    expect(passwordProblem('12345678')).toBe('Use both letters and numbers.');
    expect(passwordProblem('abcd1234')).toBeNull();
});
test('isEmail / isOtp', () => {
    expect(isEmail(' a@b.in ')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
    expect(isOtp('123456')).toBe(true);
    expect(isOtp('12345')).toBe(false);
});
test('sessionIdOf reads session_id from a JWT payload, null on garbage', () => {
    const payload = btoa(JSON.stringify({ session_id: 'sid-1' })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect(sessionIdOf(`h.${payload}.s`)).toBe('sid-1');
    expect(sessionIdOf('garbage')).toBeNull();
    expect(sessionIdOf(undefined)).toBeNull();
});
