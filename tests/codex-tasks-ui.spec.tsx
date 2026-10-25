// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CodexTask, CodexTaskOverview, CreateCodexTaskInput } from "../lib/codex-task-model";
import { CodexTasks } from "../app/components/CodexTasks";

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), pair: vi.fn(), cancel: vi.fn(), sync: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/codex-task-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/codex-task-api")>(),
  listCodexTasks: api.list, createCodexTask: api.create, generatePairCode: api.pair,
  cancelCodexTask: api.cancel, syncCodexTask: api.sync, revokeCodexDevice: api.revoke,
}));
const overview: CodexTaskOverview = {
  cloudEnabled: true, cloudProjects: [{ id: "board", label: "任务看板", isPublic: true }], tasks: [],
  devices: [
    { id: "windows-id", name: "我的 Windows", platform: "windows", projects: [{ id: "local", label: "本机项目" }], lastSeenAt: new Date().toISOString(), revokedAt: null, createdAt: "2026-10-25T00:00:00Z" },
    { id: "mac-id", name: "我的 Mac", platform: "macos", projects: [{ id: "mac-project", label: "Mac 项目" }], lastSeenAt: "2026-01-01T00:00:00Z", revokedAt: null, createdAt: "2026-10-25T00:00:00Z" },
  ],
};
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); vi.clearAllMocks();
  api.list.mockResolvedValue(structuredClone(overview));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(userId = "alice") { await act(async () => root.render(<CodexTasks userId={userId} />)); }
function field(label: string) { return container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)!; }
async function change(label: string, value: string) {
  const node = field(label);
  const descriptor = Object.getOwnPropertyDescriptor(node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!;
  await act(async () => { descriptor.set!.call(node, value); node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
async function submit() { await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }

test("publishes only to the explicitly chosen Windows device and its project", async () => {
  api.create.mockImplementation(async (input: CreateCodexTaskInput) => ({ ...input, id: "task-1", status: "queued", actualDeviceId: null, createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z", startedAt: null, completedAt: null, result: "", error: "", summary: "", sessionId: null, cloudUrl: null }));
  await render(); await change("执行位置", "windows-id"); await change("任务标题", "修复搜索"); await change("任务描述", "只修复搜索结果"); await submit();
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.create.mock.calls[0][0]).toMatchObject({ targetKind: "device", deviceId: "windows-id", projectId: "local", title: "修复搜索" });
  expect(container.textContent).toContain("我的 Windows");
  expect(container.textContent).toContain("等待设备接收");
});

test("offline Mac remains an explicit queue target and never falls back to cloud", async () => {
  await render(); await change("执行位置", "mac-id");
  expect(container.textContent).toContain("离线"); expect(container.textContent).toContain("排队");
  expect(field("执行位置").value).toBe("mac-id"); expect(field("项目").value).toBe("mac-project");
});

test("an uncertain publish retry retains the same request and original target", async () => {
  api.create.mockRejectedValue(new Error("连接中断，发布结果尚未确认"));
  await render(); await change("任务标题", "检查构建"); await change("任务描述", "运行构建检查"); await submit();
  const first = api.create.mock.calls[0][0];
  expect(field("执行位置").matches(":disabled")).toBe(true);
  await submit(); expect(api.create.mock.calls[1][0]).toEqual(first);
  expect(container.textContent).toContain("连接中断");
});

test("switching users does not carry private drafts into another account", async () => {
  await render(); await change("任务标题", "Alice private draft"); await render("bob");
  expect(field("任务标题").value).toBe(""); await render("alice"); expect(field("任务标题").value).toBe("Alice private draft");
});

test("pairing is explicit and returned one-time code can be read without exposing device credentials", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  api.pair.mockResolvedValue({ code: "one-time-code", expiresAt: "2026-10-25T10:10:00Z" });
  await render();
  const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes("生成配对码"))!;
  await act(async () => button.click()); expect(api.pair).toHaveBeenCalledTimes(1); expect(container.textContent).toContain("one-time-code");
  const copy = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === "复制配对码");
  expect(copy).toBeDefined();
  await act(async () => copy!.click());
  expect(writeText).toHaveBeenCalledWith("one-time-code");
  expect(container.textContent).toContain("公开");
});

test.each(["needs_attention", "submitted"] as const)("a PR link alone is not acknowledgement and cloud %s can close future dispatch", async (status) => {
  const task: CodexTask = { id: "cloud-1", requestId: crypto.randomUUID(), title: "云端待处理", prompt: "测试", acceptance: "", targetKind: "cloud", deviceId: null, projectId: "board", status: "needs_attention", actualDeviceId: null, createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z", startedAt: null, completedAt: null, summary: "", result: "", error: "暂未确认", sessionId: null, cloudUrl: "https://github.com/example/project/pull/1" };
  task.status = status;
  api.list.mockResolvedValue({ ...overview, tasks: [task] });
  api.cancel.mockResolvedValue({ ...task, status: status === "needs_attention" ? "cancelled" : "cancel_requested" });
  await render();
  await act(async () => Array.from(container.querySelectorAll("button")).find((node) => node.textContent?.includes(task.title))!.click());
  expect(container.textContent).toContain("尚未收到回执");
  expect(container.textContent).not.toContain("查看云端任务回执");
  const cancel = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === (status === "needs_attention" ? "取消任务" : "停止后续派发"));
  expect(cancel).toBeDefined();
  await act(async () => cancel!.click());
  expect(api.cancel).toHaveBeenCalledWith(task.id);
  expect(container.textContent).toContain(status === "needs_attention" ? "已取消" : "已停止后续派发");
  expect(container.textContent).not.toContain("正在请求停止");
});

test.each([
  { status: "succeeded", result: "任务已完成，检查通过。", error: "" },
  { status: "failed", result: "保留已完成的检查结果。", error: "构建检查失败。" },
  { status: "cancelled", result: "取消前已完成文件检查。", error: "" },
  { status: "needs_attention", result: "", error: "执行超时，请检查设备。" },
] as const)("device $status hides stale progress while preserving its receipt", async ({ status, result, error }) => {
  const task: CodexTask = { id: "device-1", requestId: crypto.randomUUID(), title: "设备任务", prompt: "运行项目检查", acceptance: "", targetKind: "device", deviceId: "windows-id", projectId: "local", status, actualDeviceId: "windows-id", createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:02:00Z", startedAt: "2026-10-25T00:00:30Z", completedAt: "2026-10-25T00:02:00Z", summary: "Codex is executing on the paired device; elapsed 65s.", result, error, sessionId: "session-1", cloudUrl: null };
  api.list.mockResolvedValue({ ...overview, tasks: [task] });
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>(".codex-task-toggle")!.click());

  expect(container.textContent).not.toContain("Codex is executing on the paired device; elapsed 65s.");
  if (result) expect(container.querySelector(".codex-detail pre")?.textContent).toBe(result);
  if (error) expect(container.querySelector(".codex-task-error")?.textContent).toBe(error);
});

test.each([
  ["device", "running", "Codex is executing on the paired device; elapsed 65s."],
  ["device", "cancel_requested", "Codex is stopping on the paired device."],
  ["cloud", "cancel_requested", "已停止后续派发；已运行的云端任务仍可能继续，请到云端核对。"],
  ["cloud", "cancelled", "已取消后续派发，请保留云端回执。"],
  ["cloud", "needs_attention", "云端接收情况需要核对。"],
] as const)("%s %s preserves its current summary", async (targetKind, status, summary) => {
  const task: CodexTask = { id: "task-summary", requestId: crypto.randomUUID(), title: "摘要任务", prompt: "运行项目检查", acceptance: "", targetKind, deviceId: targetKind === "device" ? "windows-id" : null, projectId: targetKind === "device" ? "local" : "board", status, actualDeviceId: targetKind === "device" ? "windows-id" : null, createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:02:00Z", startedAt: "2026-10-25T00:00:30Z", completedAt: null, summary, result: "", error: "", sessionId: null, cloudUrl: null };
  api.list.mockResolvedValue({ ...overview, tasks: [task] });
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>(".codex-task-toggle")!.click());

  expect(container.querySelector(".codex-detail")?.textContent).toContain(summary);
});
