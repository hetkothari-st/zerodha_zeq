// Uniform JSON errors: { code, message }. Status comes from the code.
const STATUS = {
    unauthenticated: 401,
    signed_in_elsewhere: 401,
    not_approved: 403,
    forbidden: 403,
    not_found: 404,
    bad_request: 400,
    rate_limited: 429,
    auth_unavailable: 503,
    kite_key_rejected: 503,
    kite_error: 502,
    internal: 500,
};

const MESSAGES = {
    unauthenticated: 'Please sign in.',
    signed_in_elsewhere: 'You signed in on another device.',
    not_approved: 'Your account is waiting for approval.',
    forbidden: 'You do not have access to this.',
    not_found: 'Not found.',
    bad_request: 'Invalid request.',
    rate_limited: 'Too many requests. Please wait a minute and try again.',
    auth_unavailable: 'Sign-in is temporarily unavailable.',
    kite_key_rejected: 'Zerodha rejected the Kite Connect API key.',
    kite_error: 'Zerodha request failed.',
    internal: 'Something went wrong.',
};

export function sendError(res, code, message) {
    return res.status(STATUS[code] ?? 500).json({ code, message: message ?? MESSAGES[code] ?? MESSAGES.internal });
}
