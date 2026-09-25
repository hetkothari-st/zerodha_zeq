// Per-user namespacing for localStorage.
//
// The app scatters localStorage calls across many components. Rather than thread a
// "current user" prop through every call site, we install a one-time patch on
// Storage.prototype that rewrites keys at the point of access: any key that starts
// with a known app prefix (mt_, vl_, nifty_baseline) is stored under `u:<namespace>:<key>`.
// Everything else (e.g. Supabase's own session keys) stays global.
//
// AuthProvider calls setUserNamespace(<user id>) when a user is signed in and
// setUserNamespace(null) when nobody is. migrateToUserNamespace() carries layouts saved
// before per-user-id namespacing (raw keys, or the old per-email namespace) across.

const APP_PREFIXES = ['mt_', 'vl_', 'nifty_baseline'];

let currentNamespace = null;
let installed = false;
let original = null; // the unpatched Storage methods, captured when the shim is installed

const sanitize = (ns) => String(ns).replace(/[^a-zA-Z0-9@._-]/g, '_');
const isAppKey = (key) => typeof key === 'string' && APP_PREFIXES.some((p) => key.startsWith(p));

const shouldNamespace = (key) => Boolean(currentNamespace) && isAppKey(key);

const rewrite = (key) => `u:${currentNamespace}:${key}`;

export function installUserStorageShim() {
    if (installed) return;
    if (typeof window === 'undefined' || !window.localStorage) return;

    const proto = Object.getPrototypeOf(window.localStorage);
    const rawGet = proto.getItem;
    const rawSet = proto.setItem;
    const rawRemove = proto.removeItem;
    original = { getItem: rawGet, setItem: rawSet };

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
    currentNamespace = ns ? sanitize(ns) : null;
}

export function getUserNamespace() {
    return currentNamespace;
}

// Copies (never moves) layouts saved before namespacing by user id into `u:<userId>:`:
// raw app keys and keys in the old `u:<email>:` namespace (the latter win). Does nothing
// once the user-id namespace holds any data, so it only ever runs effectively once.
export function migrateToUserNamespace(userId, email) {
    if (!userId || typeof window === 'undefined') return;
    try {
        const storage = window.localStorage;
        if (!storage) return;
        const proto = Object.getPrototypeOf(storage);
        const getItem = original?.getItem ?? proto.getItem;
        const setItem = original?.setItem ?? proto.setItem;

        const idPrefix = `u:${sanitize(userId)}:`;
        const keys = [];
        for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
        if (keys.some((k) => typeof k === 'string' && k.startsWith(idPrefix))) return;

        const emailPrefix = email ? `u:${sanitize(email)}:` : null;
        const copies = new Map();
        for (const k of keys) if (isAppKey(k)) copies.set(k, getItem.call(storage, k));
        if (emailPrefix) {
            for (const k of keys) {
                if (typeof k === 'string' && k.startsWith(emailPrefix) && k.length > emailPrefix.length) {
                    copies.set(k.slice(emailPrefix.length), getItem.call(storage, k));
                }
            }
        }
        for (const [name, value] of copies) {
            if (value !== null) setItem.call(storage, idPrefix + name, value);
        }
    } catch {
        // Storage unavailable or full — layouts simply start fresh.
    }
}
