// Short-lived cache in front of the profiles table so every request doesn't hit Supabase.
export function createProfileStore({ fetchProfile, ttlMs = 15000, now = Date.now }) {
    const cache = new Map();
    return {
        async get(userId) {
            const hit = cache.get(userId);
            if (hit && now() - hit.at < ttlMs) return hit.profile;
            const profile = await fetchProfile(userId);
            cache.set(userId, { profile, at: now() });
            return profile;
        },
        bust(userId) {
            cache.delete(userId);
        },
    };
}

export function supabaseProfileFetcher({ supabaseUrl, serviceKey, fetchImpl = fetch }) {
    return async (userId) => {
        const url = `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,status,role,current_session_id`;
        const res = await fetchImpl(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
        if (!res.ok) throw new Error(`profile lookup failed: ${res.status}`);
        const rows = await res.json();
        return rows[0] ?? null;
    };
}
