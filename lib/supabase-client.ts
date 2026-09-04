import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    : null;

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error("尚未配置 Supabase，请检查 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY。");
  return supabase;
}
