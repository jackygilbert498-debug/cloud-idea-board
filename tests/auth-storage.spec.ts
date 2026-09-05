// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";
import { boardCacheKey, clearUserLocalState, draftKey, readRememberedEmail, setRememberedLogin } from "@/lib/local-state";

const sdk = vi.hoisted(() => ({
  clients: [] as Array<{ auth: { dispose: () => Promise<void> } }>,
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: Record<string, unknown>) => {
    sdk.options.push(options);
    return sdk.clients[sdk.options.length - 1] ?? { auth: { dispose: async () => undefined } };
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
});

test("persistent auth keeps the SDK default key while session auth uses a stable tab-specific key", async () => {
  const { configureSupabaseAuthMode } = await import("@/lib/supabase-client");
  const initialAuth = sdk.options[0].auth as Record<string, unknown>;
  expect(initialAuth.storage).toBe(localStorage);
  expect(initialAuth.storageKey).toBeUndefined();

  await configureSupabaseAuthMode("session");
  const firstSessionAuth = sdk.options[1].auth as Record<string, unknown>;
  expect(firstSessionAuth.storage).toBe(sessionStorage);
  expect(firstSessionAuth.storageKey).toMatch(/^cloud-memo-board:v2:auth:session:[0-9a-f-]+$/);
  const firstKey = firstSessionAuth.storageKey;

  await configureSupabaseAuthMode("persistent");
  await configureSupabaseAuthMode("session");
  expect((sdk.options[3].auth as Record<string, unknown>).storageKey).toBe(firstKey);
});

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
