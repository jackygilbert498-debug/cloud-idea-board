import type {
  IdeaAnalysis,
  IdeaAnalysisItem,
  IdeaCertainty,
  IdeaOrganizationResult,
} from "./types.ts";

const CERTAINTIES = new Set<IdeaCertainty>(["explicit", "inferred", "uncertain"]);
const PRIORITIES = new Set(["high", "medium", "low"] as const);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function certainty(value: unknown, fallback: IdeaCertainty): IdeaCertainty {
  return typeof value === "string" && CERTAINTIES.has(value as IdeaCertainty)
    ? value as IdeaCertainty
    : fallback;
}

function analysisItems(value: unknown, fallback: IdeaCertainty = "explicit"): IdeaAnalysisItem[] {
  if (!Array.isArray(value)) return [];
  const items: IdeaAnalysisItem[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const item = record(entry);
    const text = cleanText(typeof entry === "string" ? entry : item?.text ?? item?.value, 300);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push({ text, certainty: certainty(item?.certainty, fallback) });
    if (items.length === 8) break;
  }
  return items;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => cleanText(entry, 300)).filter(Boolean))].slice(0, 8);
}

function normalizePriority(value: unknown): IdeaAnalysis["priority"] {
  const item = record(value);
  const rawValue = cleanText(item?.value ?? value, 20).toLocaleLowerCase();
  const mapped = rawValue === "高" ? "high" : rawValue === "中" ? "medium" : rawValue === "低" ? "low" : rawValue;
  return {
    value: PRIORITIES.has(mapped as "high" | "medium" | "low")
      ? mapped as "high" | "medium" | "low"
      : null,
    certainty: certainty(item?.certainty, "inferred"),
    reason: cleanText(item?.reason, 300),
  };
}

export function normalizeIdeaAnalysis(value: unknown): IdeaAnalysis {
  const input = record(value) ?? {};
  return {
    actions: analysisItems(input.actions),
    times: analysisItems(input.times, "uncertain"),
    people: analysisItems(input.people, "uncertain"),
    blockers: analysisItems(input.blockers),
    uncertainties: strings(input.uncertainties),
    priority: normalizePriority(input.priority),
  };
}

export function normalizeIdeaOrganization(
  value: unknown,
  fallbackMeta?: { model: string; promptVersion: string },
): IdeaOrganizationResult {
  const input = record(value);
  if (!input) throw new Error("AI 返回的梳理结果格式不正确，请重试。");
  const organizedText = cleanText(input.organizedText ?? input.organized_text ?? input.summary, 20_000);
  if (!organizedText) throw new Error("AI 没有返回可用的整理稿，请重试。");
  const meta = record(input.meta);
  const model = cleanText(meta?.model, 100) || fallbackMeta?.model || "unknown";
  const promptVersion = cleanText(meta?.promptVersion ?? meta?.prompt_version, 100)
    || fallbackMeta?.promptVersion
    || "unknown";
  return {
    suggestedTitle: cleanText(input.suggestedTitle ?? input.suggested_title ?? input.title, 240),
    organizedText,
    analysis: normalizeIdeaAnalysis(input.analysis),
    meta: { model, promptVersion },
  };
}
