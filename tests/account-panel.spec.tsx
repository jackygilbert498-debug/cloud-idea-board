// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { AccountPanel } from "@/app/components/AccountPanel";
import type { SignOutRequest } from "@/app/components/AccountPanel";
import App from "@/src/App";
import { boardCacheKey, draftKey } from "@/lib/local-state";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const appAuth = vi.hoisted(() => {
  const sessionFor = (id: string) => ({ access_token: "test-only", refresh_token: "test-only", expires_in: 3600, token_type: "bearer",
    user: { id, email: `${id}@example.com`, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } }) as Session;
  const makeClient = (name: string) => {
    const state = {
      name,
      listener: null as null | ((event: AuthChangeEvent, session: Session | null) => void),
      unsubscribeCalls: 0,
      getSession: async () => ({ data: { session: null as Session | null }, error: null as Error | null }),
      signInCalls: [] as Array<{ email: string; password: string }>,
      signIn: null as null | ((credentials: { email: string; password: string }) => Promise<{ data: { session: Session | null }; error: Error | null }>),
      signOutCalls: [] as Array<{ scope: "local" | "global" }>,
      signOut: null as null | ((request: { scope: "local" | "global" }) => Promise<{ error: Error | null }>),
    };
    const client = { auth: {
      getSession: () => state.getSession(),
      onAuthStateChange: (listener: typeof state.listener) => {
        state.listener = listener;
        return { data: { subscription: { unsubscribe: () => { state.unsubscribeCalls += 1; } } } };
      },
      signInWithPassword: async (credentials: { email: string; password: string }) => {
        state.signInCalls.push(credentials);
        if (state.signIn) return state.signIn(credentials);
        return { data: { session: sessionFor(name) }, error: null };
      },
      resetPasswordForEmail: async () => ({ error: null }),
      updateUser: async () => ({ error: null }),
      signOut: async (request: { scope: "local" | "global" }) => {
        state.signOutCalls.push(request);
        return state.signOut ? state.signOut(request) : { error: null };
      },
      dispose: async () => undefined,
    } };
    return { state, client };
  };
  const initial = makeClient("alice");
  const replacement = makeClient("bob");
  return {
    initial,
    replacement,
    configuredModes: [] as string[],
    unsubscribedBeforeConfigure: [] as boolean[],
    clearUrlCalls: 0,
    boardMounts: 0,
    configuration: null as null | ((mode: string) => Promise<unknown>),
    activeClient: initial.client as unknown,
    mode: "persistent" as "persistent" | "session",
  };
});

vi.mock("@/lib/supabase-client", () => ({
  get supabase() { return appAuth.activeClient; },
  getSupabaseAuthMode: () => appAuth.mode,
  getSupabaseAuthError: () => null,
  configureSupabaseAuthMode: async (mode: string) => {
    appAuth.configuredModes.push(mode);
    appAuth.unsubscribedBeforeConfigure.push(appAuth.initial.state.unsubscribeCalls > 0);
    const next = appAuth.configuration
      ? await appAuth.configuration(mode)
      : appAuth.replacement.client;
    appAuth.activeClient = next;
    return next;
  },
}));

vi.mock("@/lib/supabase-board", () => ({
  clearAttachmentUrlCache: () => { appAuth.clearUrlCalls += 1; },
}));

vi.mock("@/app/components/IdeaBoard", () => ({
  IdeaBoard: (props: { userId: string; onSignOut: (request: SignOutRequest) => Promise<void> }) => {
    appAuth.boardMounts += 1;
    return <div data-testid="board" data-user={props.userId}>
      <button onClick={() => void props.onSignOut({ scope: "local", clearLocalData: true }).catch(() => undefined)}>测试退出并清理</button>
    </div>;
  },
}));

function testSession(id: string): Session {
  return { access_token: "test-only", refresh_token: "test-only", expires_in: 3600, token_type: "bearer",
    user: { id, email: `${id}@example.com`, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } };
}

const container = document.createElement("div");
document.body.append(container);
let root: ReturnType<typeof createRoot>;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  appAuth.initial.state.listener = null;
  appAuth.initial.state.unsubscribeCalls = 0;
  appAuth.initial.state.getSession = async () => ({ data: { session: null }, error: null });
  appAuth.initial.state.signInCalls = [];
  appAuth.initial.state.signIn = null;
  appAuth.initial.state.signOutCalls = [];
  appAuth.initial.state.signOut = null;
  appAuth.replacement.state.listener = null;
  appAuth.replacement.state.unsubscribeCalls = 0;
  appAuth.replacement.state.getSession = async () => ({ data: { session: null }, error: null });
  appAuth.replacement.state.signInCalls = [];
  appAuth.replacement.state.signIn = null;
  appAuth.replacement.state.signOutCalls = [];
  appAuth.replacement.state.signOut = null;
  appAuth.configuredModes = [];
  appAuth.unsubscribedBeforeConfigure = [];
  appAuth.clearUrlCalls = 0;
  appAuth.boardMounts = 0;
  appAuth.configuration = null;
  appAuth.activeClient = appAuth.initial.client;
  appAuth.mode = "persistent";
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function renderPanel(overrides: Partial<React.ComponentProps<typeof AccountPanel>> = {}, strict = false) {
  const props: React.ComponentProps<typeof AccountPanel> = {
    email: "alice@example.com",
    authMode: "session",
    onUpdatePassword: async () => undefined,
    onSignOut: async () => undefined,
    ...overrides,
  };
  root = createRoot(container);
  await act(async () => root.render(strict
    ? <StrictMode><AccountPanel {...props} /></StrictMode>
    : <AccountPanel {...props} />));
}

function changeInput(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function renderApp() {
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await act(async () => { await Promise.resolve(); });
}

function storageEntries(storage: Storage): Array<[string, string | null]> {
  return Array.from({ length: storage.length }, (_item, index) => {
    const key = storage.key(index)!;
    return [key, storage.getItem(key)];
  });
}

test("account panel shows the personal session and validates a browser-managed password change", async () => {
  const passwords: string[] = [];
  await renderPanel({ onUpdatePassword: async (password) => { passwords.push(password); } });
  expect(container.textContent).toContain("alice@example.com");
  expect(container.textContent).toContain("仅当前浏览器会话");
  const password = container.querySelector<HTMLInputElement>('[aria-label="新密码"]')!;
  const confirmation = container.querySelector<HTMLInputElement>('[aria-label="确认新密码"]')!;
  expect(password.autocomplete).toBe("new-password");
  expect(confirmation.autocomplete).toBe("new-password");

  await act(async () => {
    changeInput(password, "short");
    changeInput(confirmation, "short");
    container.querySelector<HTMLFormElement>(".account-password-form")!.requestSubmit();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("至少需要 8 个字符");
  expect(passwords).toEqual([]);

  await act(async () => {
    changeInput(password, "new-password");
    changeInput(confirmation, "different-password");
    container.querySelector<HTMLFormElement>(".account-password-form")!.requestSubmit();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("两次输入的密码不一致");

  await act(async () => {
    changeInput(confirmation, "new-password");
    container.querySelector<HTMLFormElement>(".account-password-form")!.requestSubmit();
    await Promise.resolve();
  });
  expect(passwords).toEqual(["new-password"]);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("密码已更新");
});

test("the three logout entries send explicit scope and local cleanup requests", async () => {
  const requests: SignOutRequest[] = [];
  await renderPanel({ onSignOut: async (request) => { requests.push(request); } });

  for (const label of ["退出当前设备", "退出所有设备", "退出并清除本机数据"]) {
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.includes(label))!.click();
      await Promise.resolve();
    });
  }

  expect(requests).toEqual([
    { scope: "local", clearLocalData: false },
    { scope: "global", clearLocalData: false },
    { scope: "local", clearLocalData: true },
  ]);
});

test("a pending logout ignores duplicate clicks and reports a thrown failure", async () => {
  let reject!: (reason: unknown) => void;
  const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
  let calls = 0;
  await renderPanel({ onSignOut: () => { calls += 1; return pending; } });
  const logout = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.includes("退出当前设备"))!;
  await act(async () => {
    logout.click();
    logout.click();
  });
  expect(calls).toBe(1);

  await act(async () => {
    reject(new Error("远端退出失败"));
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("远端退出失败");
});

test("StrictMode keeps password success mounted and restores the action button", async () => {
  await renderPanel({}, true);
  const password = container.querySelector<HTMLInputElement>('[aria-label="新密码"]')!;
  const confirmation = container.querySelector<HTMLInputElement>('[aria-label="确认新密码"]')!;
  const submit = container.querySelector<HTMLButtonElement>(".account-password-form button")!;
  await act(async () => {
    changeInput(password, "new-password");
    changeInput(confirmation, "new-password");
    submit.click();
    await Promise.resolve();
  });
  expect(container.querySelector('[role="status"]')?.textContent).toContain("密码已更新");
  expect(submit.disabled).toBe(false);
});

test("StrictMode shows password and logout failures and restores their buttons", async () => {
  await renderPanel({
    onUpdatePassword: async () => { throw new Error("密码远端失败"); },
    onSignOut: async () => { throw new Error("退出远端失败"); },
  }, true);
  const password = container.querySelector<HTMLInputElement>('[aria-label="新密码"]')!;
  const confirmation = container.querySelector<HTMLInputElement>('[aria-label="确认新密码"]')!;
  const passwordButton = container.querySelector<HTMLButtonElement>(".account-password-form button")!;
  await act(async () => {
    changeInput(password, "new-password");
    changeInput(confirmation, "new-password");
    passwordButton.click();
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("密码远端失败");
  expect(passwordButton.disabled).toBe(false);

  const logout = Array.from(container.querySelectorAll<HTMLButtonElement>(".account-actions button"))
    .find((button) => button.textContent?.includes("退出当前设备"))!;
  await act(async () => {
    logout.click();
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("退出远端失败");
  expect(logout.disabled).toBe(false);
});

test("sign in defaults to remembered persistent login and unchecked mode uses the replacement client without storing password", async () => {
  localStorage.setItem("cloud-memo-board:v2:remembered-email", "remembered@example.com");
  await renderApp();
  const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  const remember = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(email.value).toBe("remembered@example.com");
  expect(password.autocomplete).toBe("current-password");
  expect(remember.checked).toBe(true);

  await act(async () => {
    changeInput(email, "  next@example.com  ");
    changeInput(password, "browser-owned-secret");
    remember.click();
    container.querySelector<HTMLFormElement>(".auth-card form")!.requestSubmit();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(appAuth.configuredModes).toEqual(["session"]);
  expect(appAuth.unsubscribedBeforeConfigure).toEqual([true]);
  expect(appAuth.initial.state.signInCalls).toEqual([]);
  expect(appAuth.replacement.state.signInCalls).toEqual([{ email: "next@example.com", password: "browser-owned-secret" }]);
  expect(localStorage.getItem("cloud-memo-board:v2:remembered-email")).toBeNull();
  expect(JSON.stringify(storageEntries(localStorage))).not.toContain("browser-owned-secret");
  expect(JSON.stringify(storageEntries(sessionStorage))).not.toContain("browser-owned-secret");
});

test("a deferred mode switch keeps the sign-in form mounted and shows invalid credentials", async () => {
  const switching = deferred<unknown>();
  appAuth.configuration = () => switching.promise;
  appAuth.replacement.state.signIn = async () => ({ data: { session: null }, error: new Error("Invalid login credentials") });
  await renderApp();
  const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  const remember = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => {
    changeInput(email, "alice@example.com");
    changeInput(password, "wrong-password");
    remember.click();
    container.querySelector<HTMLFormElement>(".auth-card form")!.requestSubmit();
    await Promise.resolve();
  });
  expect(container.querySelector(".auth-card")).not.toBeNull();
  expect(container.textContent).not.toContain("正在确认登录状态");

  await act(async () => {
    switching.resolve(appAuth.replacement.client);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.querySelector(".auth-card")?.textContent).toContain("邮箱或密码不正确");
  expect(container.querySelector<HTMLButtonElement>(".auth-card .primary")?.disabled).toBe(false);
});

test("a rejected mode switch returns to the sign-in form with a retryable error", async () => {
  const switching = deferred<unknown>();
  appAuth.configuration = () => switching.promise;
  await renderApp();
  const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  const remember = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => {
    changeInput(email, "alice@example.com");
    changeInput(password, "password-123");
    remember.click();
    container.querySelector<HTMLFormElement>(".auth-card form")!.requestSubmit();
    await Promise.resolve();
  });
  await act(async () => {
    switching.reject(new Error("会话存储不可用，请重试"));
    await Promise.resolve();
  });
  expect(container.querySelector(".auth-card")?.textContent).toContain("会话存储不可用，请重试");
  expect(container.querySelector<HTMLButtonElement>(".auth-card .primary")?.disabled).toBe(false);
  expect(container.textContent).not.toContain("正在确认登录状态");
});

test("a post-dispose replacement failure retries the requested mode and signs in with the fresh client", async () => {
  let attempts = 0;
  appAuth.configuration = async () => {
    attempts += 1;
    if (attempts === 1) {
      appAuth.activeClient = null;
      throw new Error("client factory failed");
    }
    return appAuth.replacement.client;
  };
  await renderApp();
  const fillAndSubmit = async () => {
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    changeInput(email, "bob@example.com");
    changeInput(password, "password-123");
    const remember = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    if (remember.checked) remember.click();
    container.querySelector<HTMLFormElement>(".auth-card form")!.requestSubmit();
    await Promise.resolve();
  };
  await act(fillAndSubmit);
  expect(container.textContent).toContain("client factory failed");

  const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.includes("重试初始化"))!;
  await act(async () => {
    retry.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(appAuth.configuredModes).toEqual(["session", "session"]);
  await act(fillAndSubmit);
  await vi.waitFor(() => expect(container.querySelector('[data-testid="board"]')?.getAttribute("data-user")).toBe("bob"));
  expect(appAuth.replacement.state.signInCalls).toHaveLength(1);
});

test("a late getSession result cannot overwrite a newer auth event", async () => {
  let resolveSession!: (value: { data: { session: Session | null }; error: Error | null }) => void;
  appAuth.initial.state.getSession = () => new Promise((resolve) => { resolveSession = resolve; });
  await renderApp();
  const listener = appAuth.initial.state.listener!;

  await act(async () => listener("SIGNED_IN", testSession("alice")));
  expect(container.querySelector('[data-testid="board"]')?.getAttribute("data-user")).toBe("alice");
  await act(async () => {
    resolveSession({ data: { session: null }, error: null });
    await Promise.resolve();
  });
  expect(container.querySelector('[data-testid="board"]')?.getAttribute("data-user")).toBe("alice");
});

test("events from the disposed client cannot replace the replacement client's identity", async () => {
  await renderApp();
  const oldListener = appAuth.initial.state.listener!;
  const remember = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    changeInput(email, "bob@example.com");
    changeInput(password, "password-123");
    remember.click();
    container.querySelector<HTMLFormElement>(".auth-card form")!.requestSubmit();
    await Promise.resolve();
    await Promise.resolve();
  });
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="board"]')?.getAttribute("data-user")).toBe("bob");
  });

  await act(async () => oldListener("SIGNED_IN", testSession("alice")));
  expect(container.querySelector('[data-testid="board"]')?.getAttribute("data-user")).toBe("bob");
});

test.each([
  ["returned error", async () => ({ error: new Error("远端返回退出失败") }), "远端返回退出失败"],
  ["thrown error", async () => { throw new Error("远端抛出退出失败"); }, "远端抛出退出失败"],
])("SIGNED_OUT followed by a %s keeps app data and exposes the error", async (_label, signOut, message) => {
  appAuth.initial.state.getSession = async () => ({ data: { session: testSession("alice") }, error: null });
  appAuth.initial.state.signOut = async (request) => {
    appAuth.initial.state.listener!("SIGNED_OUT", null);
    void request;
    return signOut();
  };
  localStorage.setItem(boardCacheKey("alice"), "alice-board");
  localStorage.setItem(draftKey("alice", 1), "alice-draft");
  await renderApp();

  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain(message);
  expect(localStorage.getItem(boardCacheKey("alice"))).toBe("alice-board");
  expect(localStorage.getItem(draftKey("alice", 1))).toBe("alice-draft");
  expect(appAuth.clearUrlCalls).toBe(0);
});

test("successful local cleanup removes only the signed-out user and clears signed URL memory", async () => {
  appAuth.initial.state.getSession = async () => ({ data: { session: testSession("alice") }, error: null });
  appAuth.initial.state.signOut = async () => {
    appAuth.initial.state.listener!("SIGNED_OUT", null);
    return { error: null };
  };
  localStorage.setItem(boardCacheKey("alice"), "alice-board");
  localStorage.setItem(draftKey("alice", 1), "alice-draft");
  localStorage.setItem(boardCacheKey("bob"), "bob-board");
  await renderApp();

  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(appAuth.initial.state.signOutCalls).toEqual([{ scope: "local" }]);
  expect(localStorage.getItem(boardCacheKey("alice"))).toBeNull();
  expect(localStorage.getItem(draftKey("alice", 1))).toBeNull();
  expect(localStorage.getItem(boardCacheKey("bob"))).toBe("bob-board");
  expect(appAuth.clearUrlCalls).toBe(1);
});

test.each(["length", "key", "removeItem"] as const)(
  "session logout keeps a retryable top-level cleanup warning when localStorage %s fails",
  async (operation) => {
    appAuth.mode = "session";
    appAuth.initial.state.getSession = async () => ({ data: { session: testSession("alice") }, error: null });
    appAuth.initial.state.signOut = async () => {
      appAuth.initial.state.listener!("SIGNED_OUT", null);
      return { error: null };
    };
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
    await renderApp();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("已退出，但本机数据尚未清除");
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("重试清除本机数据"));
    expect(retry).toBeDefined();
    expect(appAuth.initial.state.signOutCalls).toEqual([{ scope: "local" }]);
    expect(appAuth.clearUrlCalls).toBe(0);
    expect([
      localStorage.getItem(boardCacheKey("alice")),
      localStorage.getItem(draftKey("alice", 1)),
    ].some((value) => value !== null)).toBe(true);
    failure.mockRestore();

    await act(async () => {
      retry!.click();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("本机数据尚未清除");
    expect(container.querySelector(".auth-card")).not.toBeNull();
    expect(localStorage.getItem(boardCacheKey("alice"))).toBeNull();
    expect(localStorage.getItem(draftKey("alice", 1))).toBeNull();
    expect(localStorage.getItem(boardCacheKey("bob"))).toBe("bob-board");
    expect(localStorage.getItem("sb-project-ref-auth-token")).toBe("auth-token");
    expect(localStorage.getItem("unrelated")).toBe("keep");
    expect(appAuth.initial.state.signOutCalls).toEqual([{ scope: "local" }]);
    expect(appAuth.clearUrlCalls).toBe(1);
  },
);

test("SIGNED_OUT resets recovery so a later sign-in does not reopen password recovery", async () => {
  appAuth.initial.state.getSession = async () => ({ data: { session: testSession("alice") }, error: null });
  await renderApp();
  const listener = appAuth.initial.state.listener!;
  await act(async () => listener("PASSWORD_RECOVERY", testSession("alice")));
  expect(container.textContent).toContain("设置新密码");
  await act(async () => listener("SIGNED_OUT", null));
  await act(async () => listener("SIGNED_IN", testSession("alice")));
  expect(container.querySelector('[data-testid="board"]')).not.toBeNull();
  expect(container.textContent).not.toContain("设置新密码");
});
