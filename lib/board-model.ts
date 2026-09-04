import type { ActiveStage, CardPatch, CardRecord } from "./types.ts";

export function applyCardPatch(card: CardRecord, patch: CardPatch, now = new Date()): CardRecord {
  const nextStage = patch.stage ?? card.stage;
  const movedToDone = card.stage !== "done" && nextStage === "done";
  const movedFromDone = card.stage === "done" && nextStage !== "done";
  const archived = patch.archived ?? card.archived;

  return {
    ...card,
    ...patch,
    title: patch.title?.trim() ?? card.title,
    criteria: patch.criteria?.trim() ?? card.criteria,
    result: patch.result?.trim() ?? card.result,
    stage: nextStage,
    focus: archived || nextStage === "done" ? false : (patch.focus ?? card.focus),
    completedAt: movedToDone ? now.toISOString() : movedFromDone ? null : card.completedAt,
    previousStage: movedToDone ? card.stage as ActiveStage : card.previousStage,
    updatedAt: now.toISOString(),
  };
}

export function replaceBoardCard(cards: CardRecord[], card: CardRecord): CardRecord[] {
  const found = cards.some((item) => item.id === card.id);
  const next = found ? cards.map((item) => item.id === card.id ? card : item) : [...cards, card];
  return next.sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);
}

export function nextStageSortOrder(cards: CardRecord[], stage: CardRecord["stage"]): number {
  return cards.reduce((maximum, card) => {
    if (card.stage !== stage || card.archived) return maximum;
    return Math.max(maximum, card.sortOrder);
  }, 0) + 1;
}

export const DONE_BOARD_LIMIT = 3;

export type DoneBoardSlice = {
  cards: CardRecord[];
  hiddenCount: number;
  mode: "today" | "recent";
};

export type ArchiveGroup = {
  id: "today" | "yesterday" | "week" | "earlier";
  label: string;
  cards: CardRecord[];
};

function validDate(value: string | null | undefined): Date {
  const parsed = value ? new Date(value) : new Date(0);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function startOfWeek(value: Date): Date {
  const day = startOfDay(value);
  const weekday = day.getDay() || 7;
  day.setDate(day.getDate() - weekday + 1);
  return day;
}

export function cardActivityDate(card: CardRecord): Date {
  return validDate(card.completedAt ?? card.updatedAt);
}

export function sortByRecentActivity(cards: CardRecord[]): CardRecord[] {
  return [...cards].sort((left, right) => {
    const dateDifference = cardActivityDate(right).getTime() - cardActivityDate(left).getTime();
    return dateDifference || right.id - left.id;
  });
}

export function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export function getDoneBoardSlice(cards: CardRecord[], now = new Date()): DoneBoardSlice {
  const completed = sortByRecentActivity(cards.filter((card) => card.stage === "done" && !card.archived));
  const completedToday = completed.filter((card) => isSameLocalDay(cardActivityDate(card), now));
  const source = completedToday.length ? completedToday : completed;
  return {
    cards: source.slice(0, DONE_BOARD_LIMIT),
    hiddenCount: Math.max(0, completed.length - Math.min(source.length, DONE_BOARD_LIMIT)),
    mode: completedToday.length ? "today" : "recent",
  };
}

export function groupArchiveCards(cards: CardRecord[], now = new Date()): ArchiveGroup[] {
  const todayStart = startOfDay(now);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = startOfWeek(now);
  const groups: ArchiveGroup[] = [
    { id: "today", label: "今天", cards: [] },
    { id: "yesterday", label: "昨天", cards: [] },
    { id: "week", label: "本周", cards: [] },
    { id: "earlier", label: "更早", cards: [] },
  ];

  for (const card of sortByRecentActivity(cards.filter((item) => item.stage === "done" || item.archived))) {
    const date = cardActivityDate(card);
    if (date >= todayStart) groups[0].cards.push(card);
    else if (date >= yesterdayStart) groups[1].cards.push(card);
    else if (date >= weekStart) groups[2].cards.push(card);
    else groups[3].cards.push(card);
  }
  return groups.filter((group) => group.cards.length > 0);
}

export function matchesCard(card: CardRecord, query: string): boolean {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return true;
  return [
    card.title,
    card.criteria,
    card.result,
    card.originalText,
    card.organizedText,
    String(card.id).padStart(4, "0"),
    ...card.attachments.map((attachment) => attachment.filename),
  ].join(" ").toLocaleLowerCase().includes(term);
}

export function restoreStage(card: CardRecord): ActiveStage {
  return card.previousStage ?? (card.stage === "done" ? "todo" : card.stage as ActiveStage);
}
