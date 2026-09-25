// Decides which screen the sign-in gate shows. Order matters (see spec §4.3).
export function screenFor({ loading, recovery, linkError, session, profile, profileError, startupError }) {
    if (loading) return 'loading';
    if (recovery) return 'resetPassword';
    if (linkError) return 'linkExpired';
    if (!session) return startupError ? 'unavailable' : 'signIn';
    const user = session.user || {};
    if (!user.email && !user.new_email) return 'addEmail';
    if (user.new_email || !user.email_confirmed_at) return 'verifyEmail';
    if (!user.phone_confirmed_at) return 'addMobile';
    if (profileError) return 'unavailable';
    if (!profile) return 'loading';
    if (profile.status === 'rejected') return 'rejected';
    if (profile.status !== 'approved') return 'waitlist';
    return 'app';
}
