// Per-user namespacing for localStorage.
//
// The app scatters localStorage calls across many components (App.jsx,
// MonitorDashboard, OriginalLayout, VerticalLayout, …). Rather than thread a
// "current user" prop through every one of those call sites, we install a
// one-time monkey-patch on Storage.prototype that rewrites keys at the point
// of access: any key that starts with a known app prefix (mt_, vl_, or
// nifty_baseline) is automatically stored under `u:<email>:<key>`.
//
// The auth key itself (funnel_eq_auth_user) is NOT on the prefix list, so it
// stays global and keeps working as the "who is logged in" pointer.
//
// Call setUserNamespace(user.email) when a user logs in and setUserNamespace(null)
// when they log out.

const APP_PREFIXES = ['mt_', 'vl_', 'nifty_baseline'];

let currentNamespace = null;
let installed = false;

const shouldNamespace = (key) => {
    if (!currentNamespace || typeof key !== 'string') return false;
    return APP_PREFIXES.some((p) => key.startsWith(p));
};

const rewrite = (key) => `u:${currentNamespace}:${key}`;

export function installUserStorageShim() {
    if (installed) return;
    if (typeof window === 'undefined' || !window.localStorage) return;

    const proto = Object.getPrototypeOf(window.localStorage);
    const rawGet = proto.getItem;
    const rawSet = proto.setItem;
    const rawRemove = proto.removeItem;

    proto.getItem = function (key) {
        if (shouldNamespace(key)) return rawGet.call(this, rewrite(key));
        return rawGet.call(this, key);
    };
    proto.setItem = function (key, value) {
        if (shouldNamespace(key)) return rawSet.call(this, rewrite(key), value);
        return rawSet.call(this, key, value);
    };
    proto.removeItem = function (key) {
        if (shouldNamespace(key)) return rawRemove.call(this, rewrite(key));
        return rawRemove.call(this, key);
    };

    installed = true;
}

export function setUserNamespace(ns) {
    // Sanitize — emails are fine as-is, but strip anything weird just in case.
    currentNamespace = ns ? String(ns).replace(/[^a-zA-Z0-9@._-]/g, '_') : null;
}

export function getUserNamespace() {
    return currentNamespace;
}
