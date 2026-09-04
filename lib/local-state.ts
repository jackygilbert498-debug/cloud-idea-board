import type { CardDraft, CardRecord } from "@/lib/types";

const STORAGE_PREFIX = "cloud-memo-board:v2";

function storageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readJson<T>(key: string): T | null {
  if (!storageAvailable()) return null;
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (!storageAvailable()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
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

export function readBoardCache(userId: string): CardRecord[] {
  return readJson<CardRecord[]>(boardCacheKey(userId)) ?? [];
}

export function writeBoardCache(userId: string, cards: CardRecord[]): void {
  const safeCards = cards.map((card) => ({
    ...card,
    attachments: card.attachments.map((attachment) => {
      const safeAttachment = { ...attachment };
      delete safeAttachment.url;
      return safeAttachment;
    }),
  }));
  writeJson(boardCacheKey(userId), safeCards);
}

export function readCardDraft(userId: string, cardId: number | "new" | "composer"): CardDraft | null {
  return readJson<CardDraft>(draftKey(userId, cardId));
}

export function writeCardDraft(userId: string, cardId: number | "new" | "composer", draft: Omit<CardDraft, "savedAt">): void {
  writeJson(draftKey(userId, cardId), { ...draft, savedAt: new Date().toISOString() });
}

export function clearCardDraft(userId: string, cardId: number | "new" | "composer"): void {
  if (!storageAvailable()) return;
  window.localStorage.removeItem(draftKey(userId, cardId));
}

export function hasCardDraft(userId: string, cardId: number | "new" | "composer"): boolean {
  return storageAvailable() && window.localStorage.getItem(draftKey(userId, cardId)) !== null;
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
