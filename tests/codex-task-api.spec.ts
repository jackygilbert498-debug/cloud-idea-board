import { beforeEach, expect, test, vi } from "vitest";
const auth = vi.hoisted(() => ({ token: "test-user-token" }));
vi.mock("@/lib/supabase-client", () => ({ requireSupabase: () => ({ auth: { getSession: async () => ({ error: null, data: { session: auth.token ? { access_token: auth.token } : null } }) } }) }));
import { createCodexTask, listCodexTasks } from "../lib/codex-task-api";
beforeEach(() => { auth.token = "test-user-token"; vi.unstubAllGlobals(); });
test("missing user session never attempts an external dispatch", async () => {
  auth.token = ""; const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(listCodexTasks()).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 }); expect(fetcher).not.toHaveBeenCalled();
});
test("the broker receives the stable request and current user Bearer without device credentials", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ task: { id: "saved" } })); vi.stubGlobal("fetch", fetcher);
  const input = { requestId: "stable-id", title: "Fix search", prompt: "Keep data", acceptance: "Pass tests", targetKind: "device" as const, deviceId: "windows", projectId: "board" };
  await expect(createCodexTask(input)).resolves.toEqual({ id: "saved" });
  const [url, options] = fetcher.mock.calls[0]; expect(url).toBe("/api/codex-tasks"); expect(options.headers.Authorization).toBe("Bearer test-user-token"); expect(JSON.parse(options.body)).toEqual({ ...input, action: "create" });
});
test("a non-JSON deployment error produces a safe actionable failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>gateway unavailable</html>", { status: 503 })));
  await expect(listCodexTasks()).rejects.toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
});
