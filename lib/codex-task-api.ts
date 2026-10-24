import { requireSupabase } from "@/lib/supabase-client";
import type { CodexTask, CodexTaskOverview, CreateCodexTaskInput } from "./codex-task-model";

export class CodexApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}

/** Only the current user's session goes to the same-origin broker, never a device credential. */
async function request<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await requireSupabase().auth.getSession();
  if (error || !data.session?.access_token) throw new CodexApiError("登录已失效，请重新登录。", "UNAUTHENTICATED", 401);
  let response: Response;
  try {
    response = await fetch("/api/codex-tasks", {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ ...body, action }),
    });
  } catch {
    throw new CodexApiError("连接中断，发布结果尚未确认。请重试核对原任务。", "RESULT_UNKNOWN", 0);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new CodexApiError(payload?.error?.message || "任务服务暂时不可用，请稍后重试。", payload?.error?.code || "SERVICE_UNAVAILABLE", response.status);
  }
  if (!payload || typeof payload !== "object") throw new CodexApiError("任务服务返回内容不完整，请刷新重试。", "INVALID_RESPONSE", 502);
  return payload as T;
}

export function listCodexTasks() { return request<CodexTaskOverview>("list"); }
export async function createCodexTask(input: CreateCodexTaskInput) { return (await request<{task: CodexTask}>("create", { ...input })).task; }
export function generatePairCode() { return request<{code: string; expiresAt: string}>("pair-code"); }
export async function cancelCodexTask(taskId: string) { return (await request<{task: CodexTask}>("cancel", { taskId })).task; }
export async function syncCodexTask(taskId: string) { return (await request<{task: CodexTask}>("sync", { taskId })).task; }
export function revokeCodexDevice(deviceId: string) { return request<{ok: boolean}>("revoke-device", { deviceId }); }
