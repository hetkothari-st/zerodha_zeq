import { createClient } from '@supabase/supabase-js';

let client = null;

// Lazy so tests and builds without env vars don't crash at import time.
export function getSupabase() {
    if (!client) {
        client = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
        });
    }
    return client;
}
