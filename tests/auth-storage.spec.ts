// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { boardCacheKey, clearUserLocalState, draftKey, LocalStateClearError, readRememberedEmail, setRememberedLogin } from "@/lib/local-state";

const sdk = vi.hoisted(() => ({
  clients: [] as Array<{ auth: { dispose: () => Promise<void> } }>,
  options: [] as Array<Record<string, unknown>>,
  factoryErrors: new Map<number, Error>(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: Record<string, unknown>) => {
    const call = sdk.options.length;
    sdk.options.push(options);
    const factoryError = sdk.factoryErrors.get(call);
    if (factoryError) throw factoryError;
    return sdk.clients[call] ?? { auth: { dispose: async () => undefined } };
  },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_SUPABASE_URL", "https://project-ref.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
  localStorage.clear();
  sessionStorage.clear();
  sdk.clients = [];
  sdk.options = [];
  sdk.factoryErrors = new Map();
});

afterEach(() => vi.restoreAllMocks());

test("persistent auth keeps the SDK default key while session auth uses a stable tab-specific key", async () => {
  const { configureSupabaseAuthMode } = await import("@/lib/supabase-client");
  const initialAuth = sdk.options[0].auth as Record<string, unknown>;
  expect(initialAuth.storage).toBeDefined();
  expect(await (initialAuth.storage as Storage).getItem("missing")).toBeNull();
  expect(initialAuth.storageKey).toBeUndefined();

  await configureSupabaseAuthMode("session");
  const firstSessionAuth = sdk.options[1].auth as Record<string, unknown>;
  expect(firstSessionAuth.storage).toBeDefined();
  expect(firstSessionAuth.storageKey).toMatch(/^sb-project-ref-auth-token-session-[0-9a-f-]+$/);
  const firstKey = firstSessionAuth.storageKey;

  await configureSupabaseAuthMode("persistent");
  await configureSupabaseAuthMode("session");
  expect((sdk.options[3].auth as Record<string, unknown>).storageKey).toBe(firstKey);
});

test("a target storage failure is detected before disposal and a later switch can retry", async () => {
  const initial = { auth: { dispose: vi.fn(async () => undefined) } };
  sdk.clients.push(initial);
  const module = await import("@/lib/supabase-client");
  const originalSetItem = Storage.prototype.setItem;
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (this === sessionStorage) throw new DOMException("opaque origin", "SecurityError");
    return originalSetItem.call(this, key, value);
  });

  await expect(module.configureSupabaseAuthMode("session")).rejects.toThrow("浏览器会话存储不可用");
  expect(initial.auth.dispose).not.toHaveBeenCalled();
  expect(module.supabase).toBe(initial);
  setItem.mockRestore();

  const next = await module.configureSupabaseAuthMode("session");
  expect(next).not.toBe(initial);
  expect(module.supabase).toBe(next);
  expect(module.getSupabaseAuthMode()).toBe("session");
});

test("a factory failure after disposal publishes no disposed client and does not poison retry", async () => {
  const initial = { auth: { dispose: vi.fn(async () => undefined) } };
  const valid = { auth: { dispose: vi.fn(async () => undefined) } };
  sdk.clients[0] = initial;
  sdk.clients[2] = valid;
  sdk.factoryErrors.set(1, new Error("client factory failed"));
  const module = await import("@/lib/supabase-client");

  await expect(module.configureSupabaseAuthMode("session")).rejects.toThrow("client factory failed");
  expect(initial.auth.dispose).toHaveBeenCalledTimes(1);
  expect(module.supabase).toBeNull();

  sdk.factoryErrors.delete(1);
  await expect(module.configureSupabaseAuthMode("session")).resolves.toBe(valid);
  expect(module.supabase).toBe(valid);
  expect(module.getSupabaseAuthMode()).toBe("session");
});

test("opaque browser storage does not make module initialization throw", async () => {
  vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
    throw new DOMException("opaque origin", "SecurityError");
  });
  const module = await import("@/lib/supabase-client");
  expect(module.supabase).toBeNull();
  expect(module.getSupabaseAuthError()?.message).toContain("浏览器会话存储不可用");
});

test("a random tab id failure becomes a visible initialization error", async () => {
  sessionStorage.setItem("cloud-memo-board:v2:auth-mode", "session");
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("uuid unavailable"); });
  const module = await import("@/lib/supabase-client");
  expect(module.supabase).toBeNull();
  expect(module.getSupabaseAuthError()?.message).toContain("无法创建当前标签页会话标识");
});

test("the SDK storage adapter translates later get, set and remove failures", async () => {
  await import("@/lib/supabase-client");
  const storage = (sdk.options[0].auth as { storage: Storage }).storage;
  for (const method of ["getItem", "setItem", "removeItem"] as const) {
    const failure = vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new DOMException(`${method} disabled`, "SecurityError");
    });
    const call = method === "getItem"
      ? () => storage.getItem("auth-key")
      : method === "setItem"
        ? () => storage.setItem("auth-key", "value")
        : () => storage.removeItem("auth-key");
    expect(call).toThrow("浏览器本机存储不可用");
    failure.mockRestore();
  }
});

test("remembered email helpers tolerate disabled local storage operations", () => {
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new DOMException("local storage disabled", "SecurityError");
  });
  expect(readRememberedEmail()).toBe("");
  expect(() => setRememberedLogin("alice@example.com", true)).not.toThrow();
});

test.each(["length", "key", "removeItem"] as const)(
  "clearUserLocalState reports a %s failure instead of claiming cleanup succeeded",
  (operation) => {
    localStorage.setItem(boardCacheKey("alice"), "alice-board");
    localStorage.setItem(draftKey("alice", 1), "alice-draft");
    localStorage.setItem(boardCacheKey("bob"), "bob-board");
    localStorage.setItem("sb-project-ref-auth-token", "auth-token");
    localStorage.setItem("unrelated", "keep");
    const failure = operation === "length"
      ? vi.spyOn(Storage.prototype, "length", "get").mockImplementation(() => {
          throw new DOMException("length disabled", "SecurityError");
        })
      : vi.spyOn(Storage.prototype, operation).mockImplementation(() => {
          throw new DOMException(`${operation} disabled`, "SecurityError");
        });

    let caught: unknown;
    try { clearUserLocalState("alice"); }
    catch (reason) { caught = reason; }
    expect(caught).toBeInstanceOf(LocalStateClearError);
    expect(caught).toMatchObject({
      name: "LocalStateClearError",
      message: expect.stringContaining("本机数据清除失败"),
    });
    failure.mockRestore();

    expect(localStorage.getItem(boardCacheKey("bob"))).toBe("bob-board");
    expect(localStorage.getItem("sb-project-ref-auth-token")).toBe("auth-token");
    expect(localStorage.getItem("unrelated")).toBe("keep");
  },
);

test("auth reconfiguration awaits disposal before constructing the replacement and does not migrate tokens", async () => {
  const disposal = deferred();
  sdk.clients.push({ auth: { dispose: () => disposal.promise } });
  localStorage.setItem("sb-project-ref-auth-token", "persistent-secret");
  const { configureSupabaseAuthMode } = await import("@/lib/supabase-client");

  const switching = configureSupabaseAuthMode("session");
  await Promise.resolve();
  expect(sdk.options).toHaveLength(1);
  expect(sessionStorage.getItem("sb-project-ref-auth-token")).toBeNull();

  disposal.resolve();
  await switching;
  expect(sdk.options).toHaveLength(2);
  expect(localStorage.getItem("sb-project-ref-auth-token")).toBe("persistent-secret");
});

test("remembered login trims email, can be disabled, and stores no password-shaped data", () => {
  setRememberedLogin("  alice@example.com  ", true);
  expect(readRememberedEmail()).toBe("alice@example.com");
  expect(JSON.stringify(localStorage)).not.toContain("password");
  expect(JSON.stringify(localStorage)).not.toContain("secret-value");

  setRememberedLogin("alice@example.com", false);
  expect(readRememberedEmail()).toBe("");
});

test("clearing Alice leaves Bob, prefix-similar users, remembered email, auth, and unrelated keys intact", () => {
  localStorage.setItem(boardCacheKey("alice"), "alice-board");
  localStorage.setItem(draftKey("alice", 1), "alice-draft");
  localStorage.setItem(draftKey("alice", "composer"), "alice-composer");
  localStorage.setItem(boardCacheKey("alice2"), "alice2-board");
  localStorage.setItem(draftKey("alice2", 1), "alice2-draft");
  localStorage.setItem(boardCacheKey("bob"), "bob-board");
  localStorage.setItem("sb-project-ref-auth-token", "auth-token");
  localStorage.setItem("cloud-memo-board:v2:remembered-email", "alice@example.com");
  localStorage.setItem("unrelated", "keep");

  clearUserLocalState("alice");

  expect(localStorage.getItem(boardCacheKey("alice"))).toBeNull();
  expect(localStorage.getItem(draftKey("alice", 1))).toBeNull();
  expect(localStorage.getItem(draftKey("alice", "composer"))).toBeNull();
  expect(localStorage.getItem(boardCacheKey("alice2"))).toBe("alice2-board");
  expect(localStorage.getItem(draftKey("alice2", 1))).toBe("alice2-draft");
  expect(localStorage.getItem(boardCacheKey("bob"))).toBe("bob-board");
  expect(localStorage.getItem("sb-project-ref-auth-token")).toBe("auth-token");
  expect(localStorage.getItem("cloud-memo-board:v2:remembered-email")).toBe("alice@example.com");
  expect(localStorage.getItem("unrelated")).toBe("keep");
});
