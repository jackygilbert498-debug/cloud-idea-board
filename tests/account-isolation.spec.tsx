// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import App from "@/src/App";
import { draftKey } from "@/lib/local-state";

const auth = vi.hoisted(() => ({
  listener: null as null | ((event: AuthChangeEvent, session: Session | null) => void),
  session: null as Session | null,
}));
// Only the remote auth boundary is replaced; App, IdeaBoard and storage are real.
vi.mock("@/lib/supabase-client", () => ({
  supabase: { auth: {
    getSession: async () => ({ data: { session: auth.session }, error: null }),
    onAuthStateChange: (listener: typeof auth.listener) => {
      auth.listener = listener;
      return { data: { subscription: { unsubscribe() {} } } };
    },
  } },
  requireSupabase: () => { throw new Error("Unexpected network access in offline test"); },
}));

function session(id: string): Session {
  return { access_token: "test-only", refresh_token: "test-only", expires_in: 3600, token_type: "bearer",
    user: { id, email: `${id}@example.com`, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } };
}
const container = document.createElement("div");
document.body.append(container);
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  localStorage.clear();
  vi.unstubAllGlobals();
});

test("switching accounts does not copy the previous user's composer into the new user's draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  localStorage.setItem(draftKey("alice", "composer"), JSON.stringify({ title: "Alice private draft" }));
  localStorage.setItem(draftKey("bob", "composer"), JSON.stringify({ title: "Bob own draft" }));
  auth.session = session("alice");
  root = createRoot(container);
  await act(async () => root.render(<App />));
  const composer = () => container.querySelector<HTMLInputElement>(".mobile-composer input")!;
  expect(composer().value).toBe("Alice private draft");
  await act(async () => auth.listener!("SIGNED_IN", session("bob")));
  expect(composer().value).toBe("Bob own draft");
  expect(JSON.parse(localStorage.getItem(draftKey("bob", "composer"))!).title).toBe("Bob own draft");
  expect(JSON.parse(localStorage.getItem(draftKey("alice", "composer"))!).title).toBe("Alice private draft");
  // Refreshing the same identity must not remount and interrupt active input.
  const before = composer();
  await act(async () => auth.listener!("TOKEN_REFRESHED", session("bob")));
  expect(composer()).toBe(before);
});
