import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const AUTH_MODE_KEY = "cloud-memo-board:v2:auth-mode";
const AUTH_TAB_ID_KEY = "cloud-memo-board:v2:auth-tab-id";
const STORAGE_PROBE_KEY = "cloud-memo-board:v2:auth-storage-probe";

export type AuthStorageMode = "persistent" | "session";

export class AuthStorageUnavailableError extends Error {
  override readonly name = "AuthStorageUnavailableError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

type AuthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storageFailure(label: string, reason: unknown): AuthStorageUnavailableError {
  return reason instanceof AuthStorageUnavailableError
    ? reason
    : new AuthStorageUnavailableError(`${label}不可用，请允许站点存储后重试`, { cause: reason });
}

function rawStorage(mode: AuthStorageMode): Storage {
  if (typeof window === "undefined") throw new AuthStorageUnavailableError("浏览器存储不可用，请在浏览器中重试");
  const label = mode === "persistent" ? "浏览器本机存储" : "浏览器会话存储";
  try {
    return mode === "persistent" ? window.localStorage : window.sessionStorage;
  } catch (reason) {
    throw storageFailure(label, reason);
  }
}

function checkedStorage(mode: AuthStorageMode): { safe: AuthStorage } {
  const storage = rawStorage(mode);
  const label = mode === "persistent" ? "浏览器本机存储" : "浏览器会话存储";
  try {
    const previous = storage.getItem(STORAGE_PROBE_KEY);
    storage.setItem(STORAGE_PROBE_KEY, "1");
    if (previous === null) storage.removeItem(STORAGE_PROBE_KEY);
    else storage.setItem(STORAGE_PROBE_KEY, previous);
  } catch (reason) {
    try { storage.removeItem(STORAGE_PROBE_KEY); } catch { /* Best-effort probe cleanup. */ }
    throw storageFailure(label, reason);
  }
  return {
    safe: {
      getItem(key) {
        try { return storage.getItem(key); }
        catch (reason) { throw storageFailure(label, reason); }
      },
      setItem(key, value) {
        try { storage.setItem(key, value); }
        catch (reason) { throw storageFailure(label, reason); }
      },
      removeItem(key) {
        try { storage.removeItem(key); }
        catch (reason) { throw storageFailure(label, reason); }
      },
    },
  };
}

function readInitialAuthMode(): AuthStorageMode {
  const { safe } = checkedStorage("session");
  return safe.getItem(AUTH_MODE_KEY) === "session" ? "session" : "persistent";
}

function projectRef(): string {
  try {
    const ref = new URL(supabaseUrl).hostname.split(".")[0];
    if (!ref) throw new Error("missing project ref");
    return ref;
  } catch (reason) {
    throw new Error("Supabase 项目地址无效", { cause: reason });
  }
}

function sessionStorageKey(storage: AuthStorage): string {
  let tabId = storage.getItem(AUTH_TAB_ID_KEY);
  if (!tabId) {
    try { tabId = crypto.randomUUID(); }
    catch (reason) { throw new AuthStorageUnavailableError("无法创建当前标签页会话标识，请重试", { cause: reason }); }
    storage.setItem(AUTH_TAB_ID_KEY, tabId);
  }
  return `sb-${projectRef()}-auth-token-session-${tabId}`;
}

function sessionRuntimeKey(): string {
  let instanceId: string;
  try { instanceId = crypto.randomUUID(); }
  catch (reason) { throw new AuthStorageUnavailableError("无法创建当前页面会话通道，请重试", { cause: reason }); }
  return `sb-${projectRef()}-auth-token-session-runtime-${instanceId}`;
}

/**
 * Auth-js derives its BroadcastChannel identity from `storageKey`. A copied
 * tab inherits sessionStorage, so the SDK key must be unique per client while
 * token reads and writes still map to the stable per-tab snapshot namespace.
 */
function mappedSessionStorage(storage: AuthStorage, runtimeKey: string, stableKey: string): AuthStorage {
  const mapKey = (key: string) => key === runtimeKey || key.startsWith(`${runtimeKey}-`)
    ? `${stableKey}${key.slice(runtimeKey.length)}`
    : key;
  return {
    getItem: (key) => storage.getItem(mapKey(key)),
    setItem: (key, value) => storage.setItem(mapKey(key), value),
    removeItem: (key) => storage.removeItem(mapKey(key)),
  };
}

function authOptions(mode: AuthStorageMode): { storage: AuthStorage; storageKey?: string } {
  const { safe } = checkedStorage(mode);
  if (mode === "persistent") return { storage: safe };
  const stableKey = sessionStorageKey(safe);
  const runtimeKey = sessionRuntimeKey();
  return { storage: mappedSessionStorage(safe, runtimeKey, stableKey), storageKey: runtimeKey };
}

function createConfiguredClient(mode: AuthStorageMode): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) return null;
  const prepared = authOptions(mode);
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      ...prepared,
    },
  });
}

let activeMode: AuthStorageMode = "persistent";
let authError: Error | null = null;
export let supabase: SupabaseClient | null = null;

try {
  activeMode = readInitialAuthMode();
  supabase = createConfiguredClient(activeMode);
} catch (reason) {
  authError = reason instanceof Error ? reason : new Error("认证客户端初始化失败");
}

let configurationQueue: Promise<SupabaseClient | null> = Promise.resolve(supabase);

export function getSupabaseAuthMode(): AuthStorageMode {
  return activeMode;
}

export function getSupabaseAuthError(): Error | null {
  return authError;
}

/** Serializes replacement and never publishes a client after its disposal begins. */
export async function configureSupabaseAuthMode(mode: AuthStorageMode): Promise<SupabaseClient | null> {
  const switching = configurationQueue.then(async () => {
    if (mode === activeMode && supabase) return supabase;

    // Validate storage, key derivation and UUID generation before retiring the
    // current SDK instance. No token data is read or copied between modes.
    const prepared = authOptions(mode);
    const modeStorage = checkedStorage("session").safe;
    const previous = supabase;
    let next: SupabaseClient | null = null;
    try {
      supabase = null;
      if (previous) await previous.auth.dispose();
      if (!supabaseUrl || !supabaseAnonKey) return null;
      next = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          ...prepared,
        },
      });
      if (mode === "session") modeStorage.setItem(AUTH_MODE_KEY, mode);
      else modeStorage.removeItem(AUTH_MODE_KEY);
      activeMode = mode;
      authError = null;
      supabase = next;
      return next;
    } catch (reason) {
      if (next) {
        try { await next.auth.dispose(); } catch { /* The primary replacement error remains authoritative. */ }
      }
      supabase = null;
      authError = reason instanceof Error ? reason : new Error("认证客户端切换失败");
      throw authError;
    }
  });
  // This attempt still rejects for its caller, while a later explicit retry
  // starts from a settled queue and can create a fresh client.
  configurationQueue = switching.catch(() => supabase);
  return switching;
}

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw authError ?? new Error("尚未配置 Supabase，请检查 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY。");
  return supabase;
}
