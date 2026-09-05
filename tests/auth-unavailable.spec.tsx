// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const unavailable = vi.hoisted(() => {
  const client = { auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signInWithPassword: async () => ({ data: { session: null }, error: null }),
    resetPasswordForEmail: async () => ({ error: null }),
    updateUser: async () => ({ error: null }),
    signOut: async () => ({ error: null }),
    dispose: async () => undefined,
  } };
  return { client, configureCalls: 0 };
});

vi.mock("@/lib/supabase-client", () => ({
  supabase: null,
  getSupabaseAuthMode: () => "persistent",
  getSupabaseAuthError: () => new Error("浏览器会话存储不可用，请允许站点存储后重试"),
  configureSupabaseAuthMode: async () => {
    unavailable.configureCalls += 1;
    return unavailable.client;
  },
}));
vi.mock("@/lib/supabase-board", () => ({ clearAttachmentUrlCache() {} }));
vi.mock("@/app/components/IdeaBoard", () => ({ IdeaBoard: () => <div>board</div> }));

import App from "@/src/App";

const container = document.createElement("div");
document.body.append(container);
let root: ReturnType<typeof createRoot>;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container.replaceChildren();
  unavailable.configureCalls = 0;
});

test("storage initialization failure is visible and can retry client creation", async () => {
  root = createRoot(container);
  await act(async () => root.render(<App />));
  expect(container.textContent).toContain("浏览器会话存储不可用");
  const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.includes("重试"));
  expect(retry).toBeDefined();

  await act(async () => {
    retry!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(unavailable.configureCalls).toBe(1);
  expect(container.querySelector(".auth-card")).not.toBeNull();
});
