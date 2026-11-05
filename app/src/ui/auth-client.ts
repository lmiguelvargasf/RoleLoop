import { createClient, type SupabaseClient } from "@supabase/supabase-js";
let cached: { url: string; key: string; client: SupabaseClient } | undefined;
export function getAuthClient(url: string, key: string) {
  if (!cached || cached.url !== url || cached.key !== key) {
    cached?.client.auth.stopAutoRefresh();
    cached = {
      url,
      key,
      client: createClient(url, key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: "roleloop-auth",
        },
      }),
    };
  }
  return cached.client;
}
