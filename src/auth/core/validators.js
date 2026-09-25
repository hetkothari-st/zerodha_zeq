export function toIndianE164(input) {
    const digits = String(input ?? '').replace(/\D/g, '');
    let local = digits;
    if (digits.length === 12 && digits.startsWith('91')) local = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith('0')) local = digits.slice(1);
    return /^[6-9]\d{9}$/.test(local) ? `+91${local}` : null;
}

export function passwordProblem(password) {
    if (!password || password.length < 8) return 'Use at least 8 characters.';
    if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return 'Use both letters and numbers.';
    return null;
}

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s ?? '').trim());
export const isOtp = (s) => /^\d{6}$/.test(String(s ?? '').trim());

// Reads the Supabase session id from an access token without verifying it (display/bookkeeping only).
export function sessionIdOf(accessToken) {
    try {
        const part = accessToken.split('.')[1];
        const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
        return JSON.parse(atob(b64)).session_id || null;
    } catch {
        return null;
    }
}
