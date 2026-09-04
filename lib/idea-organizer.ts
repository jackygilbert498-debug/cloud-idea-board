import { requireSupabase } from "@/lib/supabase-client";
import { normalizeIdeaOrganization } from "@/lib/idea-organizer-model";
import type { IdeaOrganizationResult } from "@/lib/types";

const ORGANIZE_TIMEOUT = 45_000;

type ErrorPayload = { error?: { code?: string; message?: string } };

export class IdeaOrganizerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "IdeaOrganizerError";
    this.code = code;
    this.status = status;
  }
}

export async function organizeIdea(
  originalText: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IdeaOrganizationResult> {
  const clean = originalText.trim();
  if (!clean) throw new IdeaOrganizerError("EMPTY_TEXT", 400, "请先写下需要梳理的原始想法。");
  if (clean.length > 20_000) throw new IdeaOrganizerError("TEXT_TOO_LONG", 400, "原始想法不能超过 20,000 字。");

  const { data, error } = await requireSupabase().auth.getSession();
  if (error || !data.session?.access_token) {
    throw new IdeaOrganizerError("UNAUTHENTICATED", 401, "登录已失效，请重新登录。");
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), ORGANIZE_TIMEOUT);
  try {
    const response = await fetchImpl("/api/organize-idea", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ originalText: clean }),
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as ErrorPayload | null;
    if (!response.ok) {
      throw new IdeaOrganizerError(
        payload?.error?.code ?? "AI_REQUEST_FAILED",
        response.status,
        payload?.error?.message ?? "服务器暂时无法完成梳理，请稍后重试。",
      );
    }
    return normalizeIdeaOrganization(payload);
  } catch (reason) {
    if (reason instanceof IdeaOrganizerError) throw reason;
    if (controller.signal.aborted) {
      throw new IdeaOrganizerError("AI_TIMEOUT", 504, "AI 梳理超时，请稍后重试。");
    }
    throw new IdeaOrganizerError("AI_NETWORK_ERROR", 503, "暂时无法连接 AI 服务，请检查网络后重试。");
  } finally {
    window.clearTimeout(timer);
  }
}
