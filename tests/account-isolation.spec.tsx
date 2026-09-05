// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import App from "@/src/App";
import { boardCacheKey, draftKey } from "@/lib/local-state";
import { AttachmentDeleteError } from "@/lib/supabase-board";
import type { AttachmentRecord, CardPatch, CardRecord } from "@/lib/types";

const auth = vi.hoisted(() => ({
  listener: null as null | ((event: AuthChangeEvent, session: Session | null) => void),
  session: null as Session | null,
  signOutCalls: [] as Array<{ scope: "local" | "global" }>,
}));
const board = vi.hoisted(() => ({
  cards: [] as CardRecord[],
  list: null as null | (() => Promise<CardRecord[]>),
  listCalls: 0,
  reconcile: null as null | (() => Promise<void>),
  reconcileCalls: 0,
  update: null as null | ((id: number, patch: CardPatch, known?: CardRecord) => Promise<CardRecord>),
  updateCalls: 0,
  updatePatches: [] as CardPatch[],
  upload: null as null | ((cardId: number, file: File) => Promise<void>),
  uploadCalls: 0,
  reorder: null as null | ((cardId: number, ids: string[]) => Promise<void>),
  remove: null as null | ((attachment: AttachmentRecord) => Promise<void>),
  create: null as null | (() => Promise<CardRecord>),
  createCalls: 0,
}));
// Remote boundaries are replaced; App, IdeaBoard and the local draft/cache path are real.
vi.mock("@/lib/supabase-client", () => {
  const client = { auth: {
    getSession: async () => ({ data: { session: auth.session }, error: null }),
    onAuthStateChange: (listener: typeof auth.listener) => {
      auth.listener = listener;
      return { data: { subscription: { unsubscribe() {} } } };
    },
    updateUser: async () => ({ error: null }),
    signOut: async (request: { scope: "local" | "global" }) => {
      auth.signOutCalls.push(request);
      auth.listener?.("SIGNED_OUT", null);
      return { error: null };
    },
    dispose: async () => undefined,
  } };
  return {
    supabase: client,
    getSupabaseAuthMode: () => "persistent",
    getSupabaseAuthError: () => null,
    configureSupabaseAuthMode: async () => client,
    requireSupabase: () => { throw new Error("Unexpected network access in offline test"); },
  };
});
vi.mock("@/lib/supabase-board", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/supabase-board")>();
  return {
    ...original,
    listBoardCards: async () => {
      board.listCalls += 1;
      return board.list ? board.list() : board.cards;
    },
    reconcileBoardAttachments: async () => {
      board.reconcileCalls += 1;
      if (board.reconcile) await board.reconcile();
    },
    updateBoardCard: async (id: number, patch: CardPatch, known?: CardRecord) => {
      board.updateCalls += 1;
      board.updatePatches.push(patch);
      if (board.update) return board.update(id, patch, known);
      if (!known) throw new Error("missing card fixture");
      return { ...known, ...patch, updatedAt: "2026-09-06T02:00:00Z" };
    },
    uploadBoardAttachment: async (cardId: number, file: File) => {
      board.uploadCalls += 1;
      if (board.upload) await board.upload(cardId, file);
    },
    reorderBoardAttachments: async (cardId: number, ids: string[]) => {
      if (board.reorder) await board.reorder(cardId, ids);
    },
    deleteBoardAttachment: async (attachment: AttachmentRecord) => {
      if (board.remove) await board.remove(attachment);
    },
    createBoardCard: async () => {
      board.createCalls += 1;
      return board.create ? board.create() : card();
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
  board.listCalls = 0;
  board.reconcile = null;
  board.reconcileCalls = 0;
  board.update = null;
  board.updateCalls = 0;
  board.updatePatches = [];
  board.upload = null;
  board.uploadCalls = 0;
  board.reorder = null;
  board.remove = null;
  board.create = null;
  board.createCalls = 0;
  auth.listener = null;
  auth.session = null;
  auth.signOutCalls = [];
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
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  auth.session = session("alice");
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await act(async () => { await Promise.resolve(); });
}

test("a never-settling attachment recovery cannot block the ready board projection", async () => {
  board.cards = [card({ title: "云端可见卡片" })];
  board.reconcile = () => new Promise(() => undefined);

  await renderOnlineBoard();

  await vi.waitFor(() => {
    expect(container.querySelector(".task-card-main h3")?.textContent).toBe("云端可见卡片");
  }, { timeout: 500 });
  expect(board.reconcileCalls).toBe(1);
  expect(board.listCalls).toBe(1);
  expect(container.querySelector(".sync-status")?.textContent).toContain("已同步");

  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(board.listCalls).toBe(2));
  expect(board.reconcileCalls).toBe(1);
});

test("a late recovery rejection after an account switch cannot pollute either board cache", async () => {
  const recovery = deferred<void>();
  board.cards = [card({ title: "Alice 卡片" })];
  board.reconcile = () => recovery.promise;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await renderOnlineBoard();
  await vi.waitFor(() => expect(container.querySelector(".task-card-main h3")?.textContent).toBe("Alice 卡片"));
  const aliceCache = localStorage.getItem(boardCacheKey("alice"));

  board.cards = [card({ title: "Bob 卡片" })];
  await act(async () => auth.listener!("SIGNED_IN", session("bob")));
  await vi.waitFor(() => expect(container.querySelector(".task-card-main h3")?.textContent).toBe("Bob 卡片"));
  const bobCache = localStorage.getItem(boardCacheKey("bob"));

  await act(async () => {
    recovery.reject(new Error("迟到的恢复失败"));
    await Promise.resolve();
  });

  expect(localStorage.getItem(boardCacheKey("alice"))).toBe(aliceCache);
  expect(localStorage.getItem(boardCacheKey("bob"))).toBe(bobCache);
  expect(warning).toHaveBeenCalled();
});

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

test("the account page is a fourth main view with the current identity and session mode", async () => {
  await renderOnlineBoard();
  const accountButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".desktop-nav button"))
    .find((button) => button.textContent?.includes("账号"));
  expect(accountButton).toBeDefined();

  await act(async () => accountButton!.click());
  expect(container.querySelector(".account-panel")?.textContent).toContain("alice@example.com");
  expect(container.querySelector(".account-panel")?.textContent).toContain("此设备保持登录");
  expect(container.textContent).not.toContain("团队成员");
});

test("a create promise finishing after clear-device logout cannot restore cache or clear a newer draft", async () => {
  const creation = deferred<CardRecord>();
  board.create = () => creation.promise;
  await renderOnlineBoard();
  const composer = container.querySelector<HTMLInputElement>(".mobile-composer input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(composer, "迟到的构思");
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLFormElement>(".mobile-composer")!.requestSubmit();
    await Promise.resolve();
  });
  expect(board.createCalls).toBe(1);

  const accountButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".desktop-nav button"))
    .find((button) => button.textContent?.includes("账号"))!;
  await act(async () => accountButton.click());
  const clearButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".account-panel button"))
    .find((button) => button.textContent?.includes("退出并清除本机数据"))!;
  await act(async () => {
    clearButton.click();
    await Promise.resolve();
  });
  const newerDraft = JSON.stringify({ title: "Alice 登录后的新草稿" });
  localStorage.setItem(draftKey("alice", "composer"), newerDraft);

  await act(async () => {
    creation.resolve(card({ title: "迟到的构思" }));
    await Promise.resolve();
  });
  expect(localStorage.getItem(boardCacheKey("alice"))).toBeNull();
  expect(localStorage.getItem(draftKey("alice", "composer"))).toBe(newerDraft);
  expect(auth.signOutCalls).toEqual([{ scope: "local" }]);
});

test("a load snapshot finishing after clear-device logout cannot restore the cleared board", async () => {
  localStorage.setItem(boardCacheKey("alice"), JSON.stringify([card()]));
  const listing = deferred<CardRecord[]>();
  board.list = () => listing.promise;
  await renderOnlineBoard();
  const accountButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".desktop-nav button"))
    .find((button) => button.textContent?.includes("账号"))!;
  await act(async () => accountButton.click());
  const clearButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".account-panel button"))
    .find((button) => button.textContent?.includes("退出并清除本机数据"))!;
  await act(async () => {
    clearButton.click();
    await Promise.resolve();
  });

  await act(async () => {
    listing.resolve([card({ title: "退出前的旧快照" })]);
    await Promise.resolve();
  });
  expect(localStorage.getItem(boardCacheKey("alice"))).toBeNull();
});

test("an upload finishing after clear-device logout cannot start a reload that restores cache", async () => {
  board.cards = [card()];
  const upload = deferred<void>();
  board.upload = () => upload.promise;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["png"], "late.png", { type: "image/png" })],
  });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await act(async () => container.querySelector<HTMLButtonElement>(".editor footer .primary")!.click());
  await vi.waitFor(() => expect(board.uploadCalls).toBe(1));
  await act(async () => container.querySelector<HTMLButtonElement>('.editor [aria-label="关闭"]')!.click());
  const accountButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".desktop-nav button"))
    .find((button) => button.textContent?.includes("账号"))!;
  await act(async () => accountButton.click());
  const clearButton = Array.from(container.querySelectorAll<HTMLButtonElement>(".account-panel button"))
    .find((button) => button.textContent?.includes("退出并清除本机数据"))!;
  await act(async () => {
    clearButton.click();
    await Promise.resolve();
  });

  await act(async () => {
    upload.resolve();
    await Promise.resolve();
  });
  expect(localStorage.getItem(boardCacheKey("alice"))).toBeNull();
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

test("a queued focus request revalidates the limit after the prior optimistic focus fails", async () => {
  board.cards = [
    card(),
    card({ id: 2, title: "焦点二", focus: true, sortOrder: 2 }),
    card({ id: 3, title: "焦点三", focus: true, sortOrder: 3 }),
    card({ id: 4, title: "焦点四", focus: true, sortOrder: 4 }),
  ];
  const first = deferred<CardRecord>();
  board.update = async (_id, patch, known) => {
    if (board.updateCalls === 1) return first.promise;
    if (patch.focus === true) {
      if (known?.stage === "done") throw new Error("已完成记录不能设为今日焦点");
      if (!known?.focus) throw new Error("今日焦点最多保留 3 条");
    }
    return { ...known!, ...patch, updatedAt: "2026-09-06T05:00:00Z" };
  };
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  const focus = Array.from(container.querySelectorAll<HTMLButtonElement>(".editor-options button"))
    .find((button) => button.textContent?.includes("今日焦点"))!;
  await act(async () => focus.click());
  await act(async () => focus.click());
  expect(board.updateCalls).toBe(1);

  await act(async () => {
    first.reject(new Error("首次焦点保存失败"));
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(board.updateCalls).toBe(2));

  const cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(cached.find((item) => item.id === 1)?.focus).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("今日焦点最多保留 3 条");
});

test("a queued focus request uses the restored active stage after a failed move to done", async () => {
  board.cards = [card()];
  const first = deferred<CardRecord>();
  board.update = async (_id, patch, known) => {
    if (board.updateCalls === 1) return first.promise;
    if (patch.focus === true && known?.stage === "done") {
      throw new Error("已完成记录不能设为今日焦点");
    }
    return { ...known!, ...patch, updatedAt: "2026-09-06T05:30:00Z" };
  };
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());
  const focus = Array.from(container.querySelectorAll<HTMLButtonElement>(".editor-options button"))
    .find((button) => button.textContent?.includes("今日焦点"))!;
  await act(async () => dropCardOn(".column-done"));
  await act(async () => focus.click());
  expect(board.updateCalls).toBe(1);

  await act(async () => {
    first.reject(new Error("推进完成失败"));
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(board.updateCalls).toBe(2));

  const cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(cached[0].stage).toBe("idea");
  expect(cached[0].focus).toBe(true);
  expect(container.querySelector('[role="alert"]')).toBeNull();
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

test("a reorder load merges server attachments and another card while preserving a confirmed reference", async () => {
  const firstAttachment = attachment("first", 0);
  const secondAttachment = attachment("second", 1);
  board.cards = [
    card({ attachments: [firstAttachment, secondAttachment] }),
    card({ id: 2, title: "另一张旧卡", sortOrder: 2 }),
  ];
  board.reorder = async () => undefined;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());

  const delayedLoad = deferred<CardRecord[]>();
  board.list = () => delayedLoad.promise;
  const priorListCalls = board.listCalls;
  const moveForward = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="向前移动"]'))
    .find((button) => !button.disabled)!;
  await act(async () => moveForward.click());
  await vi.waitFor(() => expect(board.listCalls).toBe(priorListCalls + 1));
  const reference = Array.from(container.querySelectorAll<HTMLButtonElement>(".editor-options button"))
    .find((button) => button.textContent?.includes("参考"))!;
  await act(async () => reference.click());
  await vi.waitFor(() => expect(board.updateCalls).toBe(1));

  await act(async () => {
    delayedLoad.resolve([
      card({ reference: false, attachments: [
        { ...secondAttachment, sortOrder: 0 },
        { ...firstAttachment, sortOrder: 1 },
      ] }),
      card({ id: 2, title: "另一张服务端新卡", sortOrder: 2 }),
    ]);
    await Promise.resolve();
  });

  const cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(cached.find((item) => item.id === 1)?.reference).toBe(true);
  expect(cached.find((item) => item.id === 1)?.attachments.map((item) => item.id)).toEqual(["second", "first"]);
  expect(cached.find((item) => item.id === 2)?.title).toBe("另一张服务端新卡");
  expect(Array.from(container.querySelectorAll(".attachment-grid figcaption"), (item) => item.textContent)).toEqual([
    "second.png",
    "first.png",
  ]);
  expect(Array.from(container.querySelectorAll(".task-card-main h3"), (item) => item.textContent)).toContain("另一张服务端新卡");
});

test("a later local attachment deletion filters only that item from an incoming reordered list", async () => {
  const firstAttachment = attachment("first", 0);
  const secondAttachment = attachment("second", 1);
  const thirdAttachment = attachment("third", 2);
  board.cards = [card({ attachments: [firstAttachment, secondAttachment, thirdAttachment] })];
  board.reorder = async () => undefined;
  board.remove = async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    throw new AttachmentDeleteError("删除结果已确认，但刷新暂不可用", "hidden");
  };
  vi.stubGlobal("confirm", () => true);
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());

  const delayedLoad = deferred<CardRecord[]>();
  board.list = () => delayedLoad.promise;
  const priorListCalls = board.listCalls;
  const moveForward = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="向前移动"]'))
    .find((button) => !button.disabled)!;
  await act(async () => moveForward.click());
  await vi.waitFor(() => expect(board.listCalls).toBe(priorListCalls + 1));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="删除截图"]')!.click());

  await act(async () => {
    delayedLoad.resolve([card({ attachments: [
      { ...thirdAttachment, sortOrder: 0 },
      { ...firstAttachment, sortOrder: 1 },
      { ...secondAttachment, sortOrder: 2 },
    ] })]);
    await Promise.resolve();
  });

  const cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(cached[0].attachments.map((item) => item.id)).toEqual(["third", "second"]);
  expect(Array.from(container.querySelectorAll(".attachment-grid figcaption"), (item) => item.textContent)).toEqual([
    "third.png",
    "second.png",
  ]);
});

test("an upload load merges the ready attachment while preserving a concurrent confirmed reference", async () => {
  const originalAttachment = attachment("old", 0);
  const uploadedAttachment = attachment("uploaded", 1);
  board.cards = [card({ attachments: [originalAttachment] })];
  board.upload = async () => undefined;
  await renderOnlineBoard();
  await act(async () => container.querySelector<HTMLButtonElement>(".task-card-main")!.click());

  const delayedLoad = deferred<CardRecord[]>();
  board.list = () => delayedLoad.promise;
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["png"], "uploaded.png", { type: "image/png" })],
  });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  const priorListCalls = board.listCalls;
  await act(async () => container.querySelector<HTMLButtonElement>(".editor footer .primary")!.click());
  await vi.waitFor(() => expect(board.listCalls).toBe(priorListCalls + 1));
  const reference = Array.from(container.querySelectorAll<HTMLButtonElement>(".editor-options button"))
    .find((button) => button.textContent?.includes("参考"))!;
  await act(async () => reference.click());
  await vi.waitFor(() => expect(board.updateCalls).toBe(2));

  await act(async () => {
    delayedLoad.resolve([card({ reference: false, attachments: [originalAttachment, uploadedAttachment] })]);
    await Promise.resolve();
  });

  const cached = JSON.parse(localStorage.getItem(boardCacheKey("alice"))!) as CardRecord[];
  expect(cached[0].reference).toBe(true);
  expect(cached[0].attachments.map((item) => item.id)).toEqual(["old", "uploaded"]);
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
