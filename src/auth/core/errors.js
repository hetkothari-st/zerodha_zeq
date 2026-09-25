const BY_CODE = {
    invalid_credentials: 'Wrong email or password.',
    email_not_confirmed: 'Please verify your email first. Check your inbox.',
    otp_expired: 'That code is wrong or has expired. Send a new one.',
    over_email_send_rate_limit: 'Too many emails sent. Please wait a minute and try again.',
    over_sms_send_rate_limit: 'Too many codes sent. Please wait a minute and try again.',
    over_request_rate_limit: 'Too many attempts. Please wait a minute and try again.',
    user_already_exists: 'An account with this email already exists. Sign in instead.',
    email_exists: 'An account with this email already exists. Sign in instead.',
    phone_exists: 'This mobile number is already linked to another account.',
    weak_password: 'Use at least 8 characters with letters and numbers.',
    same_password: 'Choose a password different from your current one.',
    signup_disabled: 'Sign-ups are closed right now.',
    otp_disabled: 'No account with this mobile number. Create an account first.',
    sms_send_failed: "We couldn't send the SMS. Check the number and try again.",
    validation_failed: 'Please check the details and try again.',
    email_address_invalid: 'Enter a valid email address.',
    session_not_found: 'Your session ended. Please sign in again.',
};

export const NETWORK_MESSAGE = "Can't reach the sign-in service. Check your connection and try again.";
export const FALLBACK_MESSAGE = 'Something went wrong. Please try again.';
export const RATE_LIMIT_MESSAGE = 'Too many attempts. Please wait a minute and try again.';

export function friendlyError(err) {
    if (!err) return null;
    if (err.code && BY_CODE[err.code]) return BY_CODE[err.code];
    if (err.status === 429) return RATE_LIMIT_MESSAGE;
    if (err.name === 'AuthRetryableFetchError' || err.status === 0 || /fetch|network/i.test(err.message || '')) return NETWORK_MESSAGE;
    return FALLBACK_MESSAGE;
}
