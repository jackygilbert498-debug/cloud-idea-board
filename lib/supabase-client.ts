import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const AUTH_MODE_KEY = "cloud-memo-board:v2:auth-mode";
const AUTH_TAB_ID_KEY = "cloud-memo-board:v2:auth-tab-id";
const SESSION_STORAGE_KEY_PREFIX = "cloud-memo-board:v2:auth:session";

export type AuthStorageMode = "persistent" | "session";

function browserStorage(mode: AuthStorageMode): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  return mode === "persistent" ? window.localStorage : window.sessionStorage;
}

function initialAuthMode(): AuthStorageMode {
  if (typeof window === "undefined") return "persistent";
  return window.sessionStorage.getItem(AUTH_MODE_KEY) === "session" ? "session" : "persistent";
}

function sessionStorageKey(): string {
  if (typeof window === "undefined") return `${SESSION_STORAGE_KEY_PREFIX}:server`;
  let tabId = window.sessionStorage.getItem(AUTH_TAB_ID_KEY);
  if (!tabId) {
    tabId = crypto.randomUUID();
    window.sessionStorage.setItem(AUTH_TAB_ID_KEY, tabId);
  }
  return `${SESSION_STORAGE_KEY_PREFIX}:${tabId}`;
}

function createConfiguredClient(mode: AuthStorageMode): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  const auth = mode === "persistent"
    ? {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: browserStorage("persistent"),
      }
    : {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: browserStorage("session"),
        storageKey: sessionStorageKey(),
      };
  return createClient(supabaseUrl, supabaseAnonKey, { auth });
}

let activeMode = initialAuthMode();
export let supabase: SupabaseClient | null = createConfiguredClient(activeMode);
let configurationQueue: Promise<SupabaseClient | null> = Promise.resolve(supabase);

export function getSupabaseAuthMode(): AuthStorageMode {
  return activeMode;
}

/** Serializes client replacement so SDK listeners and BroadcastChannels never overlap. */
export async function configureSupabaseAuthMode(mode: AuthStorageMode): Promise<SupabaseClient | null> {
  const switching = configurationQueue.then(async () => {
    if (mode === activeMode && supabase) return supabase;
    const previous = supabase;
    if (previous) await previous.auth.dispose();
    if (typeof window !== "undefined") {
      if (mode === "session") window.sessionStorage.setItem(AUTH_MODE_KEY, mode);
      else window.sessionStorage.removeItem(AUTH_MODE_KEY);
    }
    activeMode = mode;
    supabase = createConfiguredClient(mode);
    return supabase;
  });
  // A rejected dispose must fail this switch, but must not permanently poison
  // later explicit retries.
  configurationQueue = switching.catch(() => supabase);
  return switching;
}

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error("尚未配置 Supabase，请检查 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY。");
  return supabase;
}
