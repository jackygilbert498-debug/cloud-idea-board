import assert from "node:assert/strict";
import test from "node:test";
import { applyCardPatch, getDoneBoardSlice, groupArchiveCards, matchesCard, nextStageSortOrder, replaceBoardCard, restoreStage } from "../lib/board-model.ts";
import type { CardRecord, Stage } from "../lib/types.ts";

process.env.TZ = "Asia/Shanghai";

function card(id: number, stage: Stage, timestamp: string, patch: Partial<CardRecord> = {}): CardRecord {
  return {
    id,
    title: `记录 ${id}`,
    stage,
    criteria: "",
    result: "",
    originalText: "",
    organizedText: "",
    aiAnalysis: null,
    aiModel: null,
    aiPromptVersion: null,
    aiOrganizedAt: null,
    originalTextUpdatedAt: null,
    focus: false,
    archived: false,
    reference: false,
    sortOrder: id,
    completedAt: stage === "done" ? timestamp : null,
    previousStage: stage === "done" ? "doing" : null,
    createdAt: timestamp,
    updatedAt: timestamp,
    attachments: [],
    ...patch,
  };
}

test("done board shows at most three records completed today", () => {
  const now = new Date("2026-08-24T12:00:00+08:00");
  const result = getDoneBoardSlice([
    card(1, "done", "2026-08-24T08:00:00+08:00"),
    card(2, "done", "2026-08-24T09:00:00+08:00"),
    card(3, "done", "2026-08-24T10:00:00+08:00"),
    card(4, "done", "2026-08-24T11:00:00+08:00"),
    card(5, "done", "2026-08-23T18:00:00+08:00"),
  ], now);
  assert.equal(result.mode, "today");
  assert.deepEqual(result.cards.map((item) => item.id), [4, 3, 2]);
  assert.equal(result.hiddenCount, 2);
});

test("done board falls back to the three most recent records", () => {
  const now = new Date("2026-08-24T12:00:00+08:00");
  const result = getDoneBoardSlice([
    card(1, "done", "2026-08-20T08:00:00+08:00"),
    card(2, "done", "2026-08-21T08:00:00+08:00"),
    card(3, "done", "2026-08-22T08:00:00+08:00"),
    card(4, "done", "2026-08-23T08:00:00+08:00"),
  ], now);
  assert.equal(result.mode, "recent");
  assert.deepEqual(result.cards.map((item) => item.id), [4, 3, 2]);
  assert.equal(result.hiddenCount, 1);
});

test("archive groups records into today, yesterday, this week and earlier", () => {
  const now = new Date("2026-08-24T12:00:00+08:00");
  const groups = groupArchiveCards([
    card(1, "done", "2026-08-24T08:00:00+08:00"),
    card(2, "done", "2026-08-23T08:00:00+08:00"),
    card(3, "done", "2026-08-19T08:00:00+08:00"),
  ], now);
  assert.deepEqual(groups.map((group) => [group.label, group.cards.map((item) => item.id)]), [
    ["今天", [1]],
    ["昨天", [2]],
    ["更早", [3]],
  ]);
});

test("search includes padded number and attachment filename", () => {
  const item = card(12, "idea", "2026-08-24T08:00:00+08:00", {
    title: "视频分镜工具",
    attachments: [{ id: "a", cardId: 12, filename: "参考线.PNG", contentType: "image/png", size: 20, sortOrder: 0, createdAt: "2026-08-24T08:00:00+08:00" }],
  });
  assert.equal(matchesCard(item, "0012"), true);
  assert.equal(matchesCard(item, "参考线.png"), true);
  assert.equal(matchesCard(item, "不存在"), false);
});

test("search includes original and AI-organized text", () => {
  const item = card(7, "idea", "2026-08-24T08:00:00+08:00", {
    originalText: "先把碎片口述留住",
    organizedText: "制作一份可回看的整理稿",
  });
  assert.equal(matchesCard(item, "碎片口述"), true);
  assert.equal(matchesCard(item, "整理稿"), true);
});

test("restore returns a completed card to its previous stage", () => {
  assert.equal(restoreStage(card(1, "done", "2026-08-24T08:00:00+08:00", { previousStage: "idea" })), "idea");
  assert.equal(restoreStage(card(2, "done", "2026-08-24T08:00:00+08:00", { previousStage: null })), "todo");
});

test("optimistic patch preserves first-save text while moving stages", () => {
  const item = card(24, "idea", "2026-08-24T08:00:00+08:00");
  const updated = applyCardPatch(item, {
    title: "路径丢失",
    criteria: "首次保存不能丢失",
    originalText: "保留原始构思",
    organizedText: "保留整理稿",
    stage: "todo",
  }, new Date("2026-08-24T12:00:00+08:00"));
  assert.equal(updated.title, "路径丢失");
  assert.equal(updated.criteria, "首次保存不能丢失");
  assert.equal(updated.originalText, "保留原始构思");
  assert.equal(updated.organizedText, "保留整理稿");
  assert.equal(updated.stage, "todo");
});

test("optimistic completion can be rolled back with the original card", () => {
  const original = card(24, "doing", "2026-08-24T08:00:00+08:00", { focus: true });
  const optimistic = applyCardPatch(original, { stage: "done" }, new Date("2026-08-24T12:00:00+08:00"));
  assert.equal(optimistic.stage, "done");
  assert.equal(optimistic.focus, false);
  assert.equal(optimistic.previousStage, "doing");
  assert.deepEqual(replaceBoardCard([optimistic], original)[0], original);
});

test("next stage order is computed locally and ignores archived cards", () => {
  const cards = [
    card(1, "todo", "2026-08-24T08:00:00+08:00", { sortOrder: 4 }),
    card(2, "todo", "2026-08-24T08:00:00+08:00", { sortOrder: 12, archived: true }),
    card(3, "doing", "2026-08-24T08:00:00+08:00", { sortOrder: 20 }),
  ];
  assert.equal(nextStageSortOrder(cards, "todo"), 5);
  assert.equal(nextStageSortOrder(cards, "idea"), 1);
});
