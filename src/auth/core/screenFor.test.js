import { test, expect } from 'vitest';
import { screenFor } from './screenFor';

const user = (over = {}) => ({ id: 'u1', email: 'a@b.in', email_confirmed_at: 't', phone_confirmed_at: 't', ...over });
const approved = { status: 'approved' };
const s = (u) => ({ user: u });

test.each([
    ['loading first', { loading: true, session: s(user()), profile: approved }, 'loading'],
    ['recovery beats everything else', { recovery: true, linkError: { code: 'x' } }, 'resetPassword'],
    ['expired link', { linkError: { code: 'otp_expired' } }, 'linkExpired'],
    ['no session', { session: null }, 'signIn'],
    ['phone-first user without email', { session: s(user({ email: '', email_confirmed_at: null })) }, 'addEmail'],
    ['email change pending', { session: s(user({ email: '', new_email: 'n@b.in', email_confirmed_at: null })) }, 'verifyEmail'],
    ['email not confirmed', { session: s(user({ email_confirmed_at: null })) }, 'verifyEmail'],
    ['no verified mobile', { session: s(user({ phone_confirmed_at: null })) }, 'addMobile'],
    ['profile failed to load', { session: s(user()), profileError: true }, 'unavailable'],
    ['profile still loading', { session: s(user()), profile: null }, 'loading'],
    ['rejected', { session: s(user()), profile: { status: 'rejected' } }, 'rejected'],
    ['pending', { session: s(user()), profile: { status: 'pending' } }, 'waitlist'],
    ['approved', { session: s(user()), profile: approved }, 'app'],
    ['no session, startup failed', { session: null, startupError: true }, 'unavailable'],
])('%s', (_name, state, expected) => {
    expect(screenFor(state)).toBe(expected);
});
