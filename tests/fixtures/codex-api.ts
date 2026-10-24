import type { CodexTask, CodexTaskOverview, CreateCodexTaskInput } from "../../lib/codex-task-model";
export class CodexApiError extends Error { status = 0; }
const state: CodexTaskOverview = {
  cloudEnabled: true, cloudProjects: [{ id: "board", label: "任务看板", repository: "example/board", isPublic: true }], tasks: [],
  devices: [
    { id: "fixture-windows", name: "我的 Windows", platform: "windows", projects: [{ id: "board", label: "任务看板" }], lastSeenAt: new Date().toISOString(), revokedAt: null, createdAt: new Date().toISOString() },
    { id: "fixture-mac", name: "我的 Mac", platform: "macos", projects: [{ id: "board", label: "任务看板" }], lastSeenAt: "2026-09-01T00:00:00Z", revokedAt: null, createdAt: "2026-09-01T00:00:00Z" },
  ],
};
export async function listCodexTasks() { return structuredClone(state); }
export async function createCodexTask(input: CreateCodexTaskInput): Promise<CodexTask> {
  const existing = state.tasks.find((task) => task.requestId === input.requestId);
  if (existing) return structuredClone(existing);
  const now = new Date().toISOString();
  const task: CodexTask = { ...input, id: crypto.randomUUID(), status: input.targetKind === "cloud" ? "submitted" : "queued", actualDeviceId: null, createdAt: now, updatedAt: now, startedAt: null, completedAt: null, summary: "这是本地示例，尚未连接真实执行器。", result: "", error: "", sessionId: null, cloudUrl: null };
  state.tasks.unshift(task); return structuredClone(task);
}
export async function generatePairCode() { return { code: "preview-only-not-a-real-pairing-code", expiresAt: new Date(Date.now() + 600_000).toISOString() }; }
export async function cancelCodexTask(id: string) { const task = state.tasks.find((item) => item.id === id)!; task.status = "cancelled"; return structuredClone(task); }
export async function syncCodexTask(id: string) { return structuredClone(state.tasks.find((item) => item.id === id)!); }
export async function revokeCodexDevice(id: string) { const device = state.devices.find((item) => item.id === id)!; device.revokedAt = new Date().toISOString(); return { ok: true }; }
