import { isStage } from "@/lib/types";
import type { AttachmentRecord, CardDraft, CardRecord, IdeaAnalysis, IdeaAnalysisItem } from "@/lib/types";

const STORAGE_PREFIX = "cloud-memo-board:v2";
const REMEMBERED_EMAIL_KEY = `${STORAGE_PREFIX}:remembered-email`;

function appStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; }
  catch { return null; }
}

function readJson(key: string): unknown {
  const storage = appStorage();
  if (!storage) return null;
  try {
    const value = storage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const storage = appStorage();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or disabled storage area must never prevent cloud saves.
  }
}

export function boardCacheKey(userId: string): string {
  return `${STORAGE_PREFIX}:cards:${userId}`;
}

export function draftKey(userId: string, cardId: number | "new" | "composer"): string {
  return `${STORAGE_PREFIX}:draft:${userId}:${cardId}`;
}

export function readRememberedEmail(): string {
  const storage = appStorage();
  if (!storage) return "";
  try { return storage.getItem(REMEMBERED_EMAIL_KEY)?.trim() ?? ""; }
  catch { return ""; }
}

export function setRememberedLogin(email: string, remember: boolean): void {
  const storage = appStorage();
  if (!storage) return;
  const cleanEmail = email.trim();
  try {
    if (!remember || !cleanEmail) storage.removeItem(REMEMBERED_EMAIL_KEY);
    else storage.setItem(REMEMBERED_EMAIL_KEY, cleanEmail);
  } catch { /* Remembering an email must never block authentication. */ }
}

/** Removes only one exact user's application projection; auth and preferences are separate namespaces. */
export function clearUserLocalState(userId: string): void {
  const storage = appStorage();
  if (!storage) return;
  const boardKey = boardCacheKey(userId);
  const userDraftPrefix = `${STORAGE_PREFIX}:draft:${userId}:`;
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key === boardKey || key?.startsWith(userDraftPrefix)) storage.removeItem(key);
    }
  } catch { /* Storage policy changes must not turn logout into a crash. */ }
}

export function readBoardCache(userId: string): CardRecord[] {
  const wire = readJson(boardCacheKey(userId));
  if (!Array.isArray(wire)) return [];
  return wire.map(parseCachedCard).filter((card): card is CardRecord => card !== null);
}

export function writeBoardCache(userId: string, cards: CardRecord[]): void {
  const safeCards = cards.map((card) => ({
    ...card,
    attachments: card.attachments.filter((attachment) => attachment.state === "ready").map((attachment) => {
      const safeAttachment = { ...attachment };
      delete safeAttachment.url;
      return safeAttachment;
    }),
  }));
  writeJson(boardCacheKey(userId), safeCards);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isCertainty(value: unknown): value is IdeaAnalysisItem["certainty"] {
  return value === "explicit" || value === "inferred" || value === "uncertain";
}

function isPriority(value: unknown): value is IdeaAnalysis["priority"]["value"] {
  return value === "high" || value === "medium" || value === "low" || value === null;
}

function isPreviousStage(value: unknown): value is CardRecord["previousStage"] {
  return value === null || value === "idea" || value === "todo" || value === "doing";
}

function parseAnalysisItem(value: unknown): IdeaAnalysisItem | null {
  if (!isObject(value) || typeof value.text !== "string") return null;
  if (!isCertainty(value.certainty)) return null;
  return { text: value.text, certainty: value.certainty };
}

function parseAnalysisItems(value: unknown): IdeaAnalysisItem[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map(parseAnalysisItem);
  return items.every((item): item is IdeaAnalysisItem => item !== null) ? items : null;
}

function parseIdeaAnalysis(value: unknown): IdeaAnalysis | null {
  if (!isObject(value) || !isObject(value.priority) || !Array.isArray(value.uncertainties)) return null;
  const actions = parseAnalysisItems(value.actions);
  const times = parseAnalysisItems(value.times);
  const people = parseAnalysisItems(value.people);
  const blockers = parseAnalysisItems(value.blockers);
  const priorityValue = value.priority.value;
  const priorityCertainty = value.priority.certainty;
  if (!actions || !times || !people || !blockers
    || !value.uncertainties.every((item): item is string => typeof item === "string")
    || !isPriority(priorityValue)
    || !isCertainty(priorityCertainty)
    || typeof value.priority.reason !== "string") return null;
  return {
    actions,
    times,
    people,
    blockers,
    uncertainties: value.uncertainties,
    priority: {
      value: priorityValue,
      certainty: priorityCertainty,
      reason: value.priority.reason,
    },
  };
}

function parseCachedAttachment(value: unknown): AttachmentRecord | null {
  if (!isObject(value)) return null;
  const state = value.state === undefined ? "ready" : value.state;
  if (state !== "ready" || typeof value.id !== "string" || !isFiniteNumber(value.cardId)
    || typeof value.filename !== "string" || typeof value.contentType !== "string"
    || !isFiniteNumber(value.size) || !isFiniteNumber(value.sortOrder) || typeof value.createdAt !== "string"
    || (value.objectKey !== undefined && typeof value.objectKey !== "string")) return null;
  return {
    id: value.id,
    cardId: value.cardId,
    objectKey: value.objectKey,
    filename: value.filename,
    contentType: value.contentType,
    size: value.size,
    sortOrder: value.sortOrder,
    state,
    createdAt: value.createdAt,
  };
}

function parseCachedCard(value: unknown): CardRecord | null {
  if (!isObject(value) || !isFiniteNumber(value.id) || typeof value.title !== "string" || !isStage(value.stage)
    || typeof value.criteria !== "string" || typeof value.result !== "string"
    || typeof value.originalText !== "string" || typeof value.organizedText !== "string"
    || !isNullableString(value.aiModel) || !isNullableString(value.aiPromptVersion)
    || !isNullableString(value.aiOrganizedAt) || !isNullableString(value.originalTextUpdatedAt)
    || typeof value.focus !== "boolean" || typeof value.archived !== "boolean" || typeof value.reference !== "boolean"
    || !isFiniteNumber(value.sortOrder) || !isNullableString(value.completedAt)
    || !isPreviousStage(value.previousStage)
    || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" || !Array.isArray(value.attachments)
    || (value.mutationVersion !== undefined && !isFiniteNumber(value.mutationVersion))
    || (value.pendingConfirmation !== undefined && typeof value.pendingConfirmation !== "boolean")) return null;
  const analysis = value.aiAnalysis === null ? null : parseIdeaAnalysis(value.aiAnalysis);
  if (value.aiAnalysis !== null && analysis === null) return null;
  return {
    id: value.id,
    title: value.title,
    stage: value.stage,
    criteria: value.criteria,
    result: value.result,
    originalText: value.originalText,
    organizedText: value.organizedText,
    aiAnalysis: analysis,
    aiModel: value.aiModel,
    aiPromptVersion: value.aiPromptVersion,
    aiOrganizedAt: value.aiOrganizedAt,
    originalTextUpdatedAt: value.originalTextUpdatedAt,
    focus: value.focus,
    archived: value.archived,
    reference: value.reference,
    sortOrder: value.sortOrder,
    completedAt: value.completedAt,
    previousStage: value.previousStage,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    attachments: value.attachments.map(parseCachedAttachment).filter((item): item is AttachmentRecord => item !== null),
    mutationVersion: value.mutationVersion,
    pendingConfirmation: value.pendingConfirmation,
  };
}

export function readCardDraft(userId: string, cardId: number | "new" | "composer"): CardDraft | null {
  return parseCardDraft(readJson(draftKey(userId, cardId)));
}

export function writeCardDraft(userId: string, cardId: number | "new" | "composer", draft: Omit<CardDraft, "savedAt">): void {
  writeJson(draftKey(userId, cardId), { ...draft, savedAt: new Date().toISOString() });
}

export function clearCardDraft(userId: string, cardId: number | "new" | "composer"): void {
  const storage = appStorage();
  if (!storage) return;
  try { storage.removeItem(draftKey(userId, cardId)); }
  catch { /* Cloud state stays authoritative when local storage is unavailable. */ }
}

export function hasCardDraft(userId: string, cardId: number | "new" | "composer"): boolean {
  const storage = appStorage();
  if (!storage) return false;
  try { return storage.getItem(draftKey(userId, cardId)) !== null; }
  catch { return false; }
}

function parseCardDraft(value: unknown): CardDraft | null {
  if (!isObject(value) || typeof value.title !== "string"
    || (value.clientRequestId !== undefined && typeof value.clientRequestId !== "string")) return null;
  const analysis = value.aiAnalysis === undefined || value.aiAnalysis === null ? null : parseIdeaAnalysis(value.aiAnalysis);
  if (value.aiAnalysis !== undefined && value.aiAnalysis !== null && analysis === null) return null;
  return {
    title: value.title,
    criteria: typeof value.criteria === "string" ? value.criteria : "",
    result: typeof value.result === "string" ? value.result : "",
    originalText: typeof value.originalText === "string" ? value.originalText : "",
    organizedText: typeof value.organizedText === "string" ? value.organizedText : "",
    aiAnalysis: analysis,
    aiModel: isNullableString(value.aiModel) ? value.aiModel : null,
    aiPromptVersion: isNullableString(value.aiPromptVersion) ? value.aiPromptVersion : null,
    aiOrganizedAt: isNullableString(value.aiOrganizedAt) ? value.aiOrganizedAt : null,
    stage: isStage(value.stage) ? value.stage : "idea",
    clientRequestId: value.clientRequestId,
    savedAt: typeof value.savedAt === "string" ? value.savedAt : "",
  };
}

export async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
