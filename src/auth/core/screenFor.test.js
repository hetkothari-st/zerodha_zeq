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
    ['no verified mobile, requireMobile on', { session: s(user({ phone_confirmed_at: null })), requireMobile: true }, 'addMobile'],
    ['no verified mobile, requireMobile off (default): sails through to the profile gate', { session: s(user({ phone_confirmed_at: null })), profile: approved }, 'app'],
    ['no verified mobile, requireMobile off, profile pending: waitlist', { session: s(user({ phone_confirmed_at: null })), profile: { status: 'pending' } }, 'waitlist'],
    ['profile failed to load', { session: s(user()), profileError: true }, 'unavailable'],
    ['profile still loading', { session: s(user()), profile: null }, 'loading'],
    ['rejected', { session: s(user()), profile: { status: 'rejected' } }, 'rejected'],
    ['pending', { session: s(user()), profile: { status: 'pending' } }, 'waitlist'],
    ['approved', { session: s(user()), profile: approved }, 'app'],
    ['no session, startup failed', { session: null, startupError: true }, 'unavailable'],
    ['claim failed', { session: s(user()), profile: approved, claimError: true }, 'unavailable'],
    ['claim failed but email still unverified', { session: s(user({ email_confirmed_at: null })), claimError: true }, 'verifyEmail'],
    ['claim failed but no verified mobile', { session: s(user({ phone_confirmed_at: null })), claimError: true, requireMobile: true }, 'addMobile'],
    ['claim failed beats a pending profile', { session: s(user()), profile: { status: 'pending' }, claimError: true }, 'unavailable'],
    ['recovery still beats a claim failure', { recovery: true, session: s(user()), claimError: true }, 'resetPassword'],
])('%s', (_name, state, expected) => {
    expect(screenFor(state)).toBe(expected);
});
