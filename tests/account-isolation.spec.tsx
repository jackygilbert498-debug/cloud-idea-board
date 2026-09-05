// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import App from "@/src/App";
import { boardCacheKey, draftKey } from "@/lib/local-state";
import type { AttachmentRecord, CardPatch, CardRecord } from "@/lib/types";

const auth = vi.hoisted(() => ({
  listener: null as null | ((event: AuthChangeEvent, session: Session | null) => void),
  session: null as Session | null,
}));
const board = vi.hoisted(() => ({
  cards: [] as CardRecord[],
  list: null as null | (() => Promise<CardRecord[]>),
  update: null as null | ((id: number, patch: CardPatch, known?: CardRecord) => Promise<CardRecord>),
  updateCalls: 0,
  updatePatches: [] as CardPatch[],
}));
// Remote boundaries are replaced; App, IdeaBoard and the local draft/cache path are real.
vi.mock("@/lib/supabase-client", () => ({
  supabase: { auth: {
    getSession: async () => ({ data: { session: auth.session }, error: null }),
    onAuthStateChange: (listener: typeof auth.listener) => {
      auth.listener = listener;
      return { data: { subscription: { unsubscribe() {} } } };
    },
  } },
  requireSupabase: () => { throw new Error("Unexpected network access in offline test"); },
}));
vi.mock("@/lib/supabase-board", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/supabase-board")>();
  return {
    ...original,
    listBoardCards: async () => board.list ? board.list() : board.cards,
    reconcileBoardAttachments: async () => undefined,
    updateBoardCard: async (id: number, patch: CardPatch, known?: CardRecord) => {
      board.updateCalls += 1;
      board.updatePatches.push(patch);
      if (board.update) return board.update(id, patch, known);
      if (!known) throw new Error("missing card fixture");
      return { ...known, ...patch, updatedAt: "2026-09-06T02:00:00Z" };
    },
  };
});

function session(id: string): Session {
  return { access_token: "test-only", refresh_token: "test-only", expires_in: 3600, token_type: "bearer",
    user: { id, email: `${id}@example.com`, aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } };
}
const container = document.createElement("div");
document.body.append(container);
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  board.cards = [];
  board.list = null;
  board.update = null;
  board.updateCalls = 0;
  board.updatePatches = [];
  auth.listener = null;
  auth.session = null;
});

function card(patch: Partial<CardRecord> = {}): CardRecord {
  return {
    id: 1,
    title: "原始标题",
    stage: "idea",
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
    sortOrder: 1,
    completedAt: null,
    previousStage: null,
    createdAt: "2026-09-06T01:00:00Z",
    updatedAt: "2026-09-06T01:00:00Z",
    attachments: [],
    ...patch,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function attachment(id: string, sortOrder: number): AttachmentRecord {
  return {
    id,
    cardId: 1,
    objectKey: `alice/1/${id}.png`,
    filename: `${id}.png`,
    contentType: "image/png",
    size: 100,
    sortOrder,
    state: "ready",
    createdAt: `2026-09-06T01:0${sortOrder}:00Z`,
  };
}

async function renderOnlineBoard() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  auth.session = session("alice");
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await act(async () => { await Promise.resolve(); });
}

function changeTextarea(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function dropCardOn(selector: string, cardId = 1) {
  const event = new Event("drop", { bubbles: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { getData: () => String(cardId) },
  });
  container.querySelector<HTMLElement>(selector)!.dispatchEvent(event);
}

test("switching accounts does not copy the previous user's composer into the new user's draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  localStorage.setItem(draftKey("alice", "composer"), JSON.stringify({ title: "Alice private draft" }));
  localStorage.setItem(draftKey("bob", "composer"), JSON.stringify({ title: "Bob own draft" }));
  auth.session = session("alice");
  root = createRoot(container);
  await act(async () => root.render(<App />));
  const composer = () => container.querySelector<HTMLInputElement>(".mobile-composer input")!;
  expect(composer().value).toBe("Alice private draft");
  await act(async () => auth.listener!("SIGNED_IN", session("bob")));
  expect(composer().value).toBe("Bob own draft");
  expect(JSON.parse(localStorage.getItem(draftKey("bob", "composer"))!).title).toBe("Bob own draft");
  expect(JSON.parse(localStorage.getItem(draftKey("alice", "composer"))!).title).toBe("Alice private draft");
  // Refreshing the same identity must not remount and interrupt active input.
  const before = composer();
  await act(async () => auth.listener!("TOKEN_REFRESHED", session("bob")));
  expect(composer()).toBe(before);
});

test("a confirmed editor save clears its draft and closes the editor", async () => {
  board.cards = [card()];
  const completion = deferred<CardRecord>();
  board.update = () => completion.promise;
  await renderOnlineBoard();

  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  const title = container.querySelector<HTMLTextAreaElement>(".title-field textarea")!;
  await act(async () => changeTextarea(title, "已保存标题"));
  const save = container.querySelector<HTMLButtonElement>(".editor footer .primary")!;
  await act(async () => save.click());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();

  await act(async () => {
    completion.resolve(card({ title: "已保存标题", updatedAt: "2026-09-06T02:00:00Z" }));
    await Promise.resolve();
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(localStorage.getItem(draftKey("alice", 1))).toBeNull();
});

test("an ambiguous timeout keeps the optimistic card and draft, then late failure rolls back without resubmitting", async () => {
  board.cards = [card()];
  const completion = deferred<CardRecord>();
  board.update = () => completion.promise;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  const title = container.querySelector<HTMLTextAreaElement>(".title-field textarea")!;
  await act(async () => changeTextarea(title, "待核对标题"));
  vi.useFakeTimers();
  await act(async () => container.querySelector<HTMLButtonElement>(".editor footer .primary")!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(12_001); });

  expect(container.querySelector(".sync-status")?.textContent).toContain("正在核对");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("待核对");
  expect(container.querySelector(".task-card-main h3")?.textContent).toBe("待核对标题");
  expect(localStorage.getItem(draftKey("alice", 1))).not.toBeNull();
  expect((JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[])[0].pendingConfirmation).toBe(true);
  expect(board.updateCalls).toBe(1);

  await act(async () => {
    completion.reject(new Error("最终确认保存失败"));
    await Promise.resolve();
  });
  expect(container.querySelector(".task-card-main h3")?.textContent).toBe("原始标题");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("最终确认保存失败");
  expect(localStorage.getItem(draftKey("alice", 1))).not.toBeNull();
  expect(board.updateCalls).toBe(1);
});

test("rechecking a pending save only reloads and the original promise can still confirm it", async () => {
  board.cards = [card()];
  const completion = deferred<CardRecord>();
  board.update = () => completion.promise;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  await act(async () => changeTextarea(
    container.querySelector<HTMLTextAreaElement>(".title-field textarea")!,
    "晚到成功标题",
  ));
  vi.useFakeTimers();
  await act(async () => container.querySelector<HTMLButtonElement>(".editor footer .primary")!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(12_001); });

  await act(async () => container.querySelector<HTMLButtonElement>(".notice-retry")!.click());
  expect(board.updateCalls).toBe(1);
  expect(container.querySelector(".task-card-main h3")?.textContent).toBe("晚到成功标题");

  await act(async () => {
    completion.resolve(card({ title: "晚到成功标题", updatedAt: "2026-09-06T03:00:00Z" }));
    await Promise.resolve();
  });
  expect(localStorage.getItem(draftKey("alice", 1))).toBeNull();
  const cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(cached[0].title).toBe("晚到成功标题");
  expect(cached[0].pendingConfirmation).toBe(false);
  expect(board.updateCalls).toBe(1);
});

test("late success from an unmounted Alice board cannot clear Alice's newer draft or rewrite caches", async () => {
  board.cards = [card()];
  const completion = deferred<CardRecord>();
  board.update = () => completion.promise;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  await act(async () => changeTextarea(container.querySelector<HTMLTextAreaElement>(".title-field textarea")!, "Alice 旧保存"));
  vi.useFakeTimers();
  await act(async () => container.querySelector<HTMLButtonElement>(".editor footer .primary")!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(12_001); });
  const aliceCache = localStorage.getItem(boardCacheKey("alice"));

  board.cards = [card({ title: "Bob 卡片" })];
  await act(async () => auth.listener!("SIGNED_IN", session("bob")));
  localStorage.setItem(draftKey("alice", 1), JSON.stringify({ title: "Alice 切换后新草稿" }));
  await act(async () => {
    completion.resolve(card({ title: "Alice 旧保存" }));
    await Promise.resolve();
  });

  expect(JSON.parse(localStorage.getItem(draftKey("alice", 1))!).title).toBe("Alice 切换后新草稿");
  expect(localStorage.getItem(boardCacheKey("alice"))).toBe(aliceCache);
  expect((JSON.parse(localStorage.getItem(boardCacheKey("bob"))!) as CardRecord[])[0].title).toBe("Bob 卡片");
});

test("confirmation before the timeout still cannot resume an unmounted editor and clear its user's new draft", async () => {
  board.cards = [card()];
  const completion = deferred<CardRecord>();
  board.update = () => completion.promise;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  await act(async () => changeTextarea(container.querySelector<HTMLTextAreaElement>(".title-field textarea")!, "Alice 保存中"));
  await act(async () => container.querySelector<HTMLButtonElement>(".editor footer .primary")!.click());

  board.cards = [card({ title: "Bob 卡片" })];
  await act(async () => auth.listener!("SIGNED_IN", session("bob")));
  localStorage.setItem(draftKey("alice", 1), JSON.stringify({ title: "Alice 切换后新草稿" }));
  await act(async () => {
    completion.resolve(card({ title: "Alice 保存中" }));
    await Promise.resolve();
  });

  expect(JSON.parse(localStorage.getItem(draftKey("alice", 1))!).title).toBe("Alice 切换后新草稿");
});

test("late failure from an unmounted Alice board cannot roll back Alice's cache", async () => {
  board.cards = [card()];
  const completion = deferred<CardRecord>();
  board.update = () => completion.promise;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  await act(async () => changeTextarea(container.querySelector<HTMLTextAreaElement>(".title-field textarea")!, "Alice 待核对"));
  vi.useFakeTimers();
  await act(async () => container.querySelector<HTMLButtonElement>(".editor footer .primary")!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(12_001); });
  const aliceCache = localStorage.getItem(boardCacheKey("alice"));

  board.cards = [card({ title: "Bob 卡片" })];
  await act(async () => auth.listener!("SIGNED_IN", session("bob")));
  await act(async () => {
    completion.reject(new Error("Alice 旧请求晚到失败"));
    await Promise.resolve();
  });

  expect(localStorage.getItem(boardCacheKey("alice"))).toBe(aliceCache);
  expect((JSON.parse(localStorage.getItem(boardCacheKey("bob"))!) as CardRecord[])[0].title).toBe("Bob 卡片");
});

test("two rejected mutations restore the last confirmed card instead of the first optimistic card", async () => {
  board.cards = [card()];
  const first = deferred<CardRecord>();
  const second = deferred<CardRecord>();
  const completions = [first, second];
  board.update = () => completions.shift()!.promise;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  const optionButtons = Array.from(container.querySelectorAll<HTMLButtonElement>(".editor-options button"));
  await act(async () => optionButtons.find((button) => button.textContent?.includes("参考"))!.click());
  await act(async () => optionButtons.find((button) => button.textContent?.includes("归档"))!.click());

  await act(async () => {
    first.reject(new Error("参考失败"));
    await Promise.resolve();
  });
  await act(async () => {
    second.reject(new Error("归档失败"));
    await Promise.resolve();
  });

  const cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(cached[0].reference).toBe(false);
  expect(cached[0].archived).toBe(false);
});

test("pending reload merges only mutation fields and keeps the latest server attachment projection", async () => {
  const originalAttachment = attachment("old", 1);
  const newAttachment = attachment("new", 0);
  board.cards = [card({ attachments: [originalAttachment] })];
  const completion = deferred<CardRecord>();
  board.update = () => completion.promise;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  await act(async () => changeTextarea(container.querySelector<HTMLTextAreaElement>(".title-field textarea")!, "本地待核对标题"));
  vi.useFakeTimers();
  await act(async () => container.querySelector<HTMLButtonElement>(".editor footer .primary")!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(12_001); });

  board.cards = [card({ reference: true, attachments: [newAttachment, originalAttachment] })];
  await act(async () => container.querySelector<HTMLButtonElement>(".notice-retry")!.click());
  let cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(cached[0].title).toBe("本地待核对标题");
  expect(cached[0].reference).toBe(true);
  expect(cached[0].attachments.map((item) => item.id)).toEqual(["new", "old"]);
  expect(container.querySelector(".attachments .section-title small")?.textContent).toBe("2 张");

  await act(async () => {
    completion.resolve(card({ title: "本地待核对标题", attachments: [originalAttachment] }));
    await Promise.resolve();
  });
  cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(cached[0].reference).toBe(true);
  expect(cached[0].attachments.map((item) => item.id)).toEqual(["new", "old"]);
});

test("a title-only pending patch updates server-owned editor fields without clearing the draft", async () => {
  board.cards = [card()];
  const completion = deferred<CardRecord>();
  board.update = () => completion.promise;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  await act(async () => changeTextarea(container.querySelector<HTMLTextAreaElement>(".title-field textarea")!, "仅标题待核对"));
  vi.useFakeTimers();
  await act(async () => container.querySelector<HTMLButtonElement>(".editor footer .primary")!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(12_001); });
  expect(board.updatePatches).toEqual([{ title: "仅标题待核对" }]);

  board.cards = [card({ reference: true, focus: true })];
  await act(async () => container.querySelector<HTMLButtonElement>(".notice-retry")!.click());
  const cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(cached[0].title).toBe("仅标题待核对");
  expect(cached[0].reference).toBe(true);
  expect(cached[0].focus).toBe(true);
  expect(container.querySelector(".editor-options")?.textContent).toContain("取消参考");
  expect(container.querySelector(".editor-options")?.textContent).toContain("移出今日焦点");
  expect(localStorage.getItem(draftKey("alice", 1))).not.toBeNull();
});

test("a delayed load snapshot cannot overwrite a late save confirmation", async () => {
  board.cards = [card()];
  const completion = deferred<CardRecord>();
  board.update = () => completion.promise;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  await act(async () => changeTextarea(container.querySelector<HTMLTextAreaElement>(".title-field textarea")!, "最终确认标题"));
  vi.useFakeTimers();
  await act(async () => container.querySelector<HTMLButtonElement>(".editor footer .primary")!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(12_001); });

  const delayedLoad = deferred<CardRecord[]>();
  board.list = () => delayedLoad.promise;
  await act(async () => container.querySelector<HTMLButtonElement>(".notice-retry")!.click());
  await act(async () => {
    completion.resolve(card({ title: "最终确认标题", updatedAt: "2026-09-06T04:00:00Z" }));
    await Promise.resolve();
  });
  expect(localStorage.getItem(draftKey("alice", 1))).toBeNull();

  await act(async () => {
    delayedLoad.resolve([card()]);
    await Promise.resolve();
  });
  const cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(cached[0].title).toBe("最终确认标题");
  expect(container.querySelector(".task-card-main h3")?.textContent).toBe("最终确认标题");
  expect(container.querySelector(".sync-status")?.textContent).toContain("已同步");
});

test("same-card requests are applied in mutation order for different fields and a third mutation", async () => {
  board.cards = [card()];
  const releaseFirst = deferred<void>();
  let serverCard = card();
  board.update = async (_id, patch) => {
    if (board.updateCalls === 1) await releaseFirst.promise;
    if (patch.archived === true) throw new Error("归档未落库");
    serverCard = { ...serverCard, ...patch, updatedAt: `2026-09-06T0${board.updateCalls}:00:00Z` };
    return serverCard;
  };
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  const optionButtons = Array.from(container.querySelectorAll<HTMLButtonElement>(".editor-options button"));
  await act(async () => optionButtons.find((button) => button.textContent?.includes("参考"))!.click());
  await act(async () => optionButtons.find((button) => button.textContent?.includes("归档"))!.click());
  await act(async () => optionButtons.find((button) => button.textContent?.includes("焦点"))!.click());
  expect(board.updateCalls).toBe(1);

  await act(async () => {
    releaseFirst.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(serverCard.reference).toBe(true);
  expect(serverCard.archived).toBe(false);
  expect(serverCard.focus).toBe(true);
  expect(cached[0].reference).toBe(true);
  expect(cached[0].archived).toBe(false);
  expect(cached[0].focus).toBe(true);
  expect(board.updateCalls).toBe(3);
});

test("same-field stage mutations wait for the prior request to apply", async () => {
  board.cards = [card()];
  const releaseFirst = deferred<void>();
  let serverCard = card();
  board.update = async (_id, patch) => {
    if (board.updateCalls === 1) await releaseFirst.promise;
    serverCard = { ...serverCard, ...patch, updatedAt: `2026-09-06T0${board.updateCalls}:00:00Z` };
    return serverCard;
  };
  await renderOnlineBoard();
  await act(async () => dropCardOn(".column-todo"));
  await act(async () => dropCardOn(".column-doing"));
  expect(board.updateCalls).toBe(1);

  await act(async () => {
    releaseFirst.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(serverCard.stage).toBe("doing");
  expect(cached[0].stage).toBe("doing");
});

test("queued mutations preserve confirmed fields and activity remains busy until both finish", async () => {
  board.cards = [card()];
  const first = deferred<CardRecord>();
  const second = deferred<CardRecord>();
  const completions = [first, second];
  board.update = () => completions.shift()!.promise;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  const optionButtons = Array.from(container.querySelectorAll<HTMLButtonElement>(".editor-options button"));
  await act(async () => optionButtons.find((button) => button.textContent?.includes("参考"))!.click());
  await act(async () => optionButtons.find((button) => button.textContent?.includes("归档"))!.click());
  const save = container.querySelector<HTMLButtonElement>(".editor footer .primary")!;
  expect(save.disabled).toBe(true);

  await act(async () => {
    first.resolve(card({ reference: true }));
    await Promise.resolve();
  });
  expect(save.disabled).toBe(true);

  await act(async () => {
    second.resolve(card({ archived: true }));
    await Promise.resolve();
  });
  expect(save.disabled).toBe(false);
  const cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(cached[0].archived).toBe(true);
  expect(cached[0].reference).toBe(true);
});
