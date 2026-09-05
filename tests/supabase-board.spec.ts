// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type AttachmentState = "pending" | "ready" | "deleting";
type FakeError = { message: string; code?: string; statusCode?: string };

type FakeAttachment = {
  id: string;
  card_id: number;
  user_id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size: number;
  sort_order: number;
  state: AttachmentState;
  updated_at: string;
  created_at: string;
};

type FakeCard = {
  id: number;
  user_id: string;
  client_request_id: string | null;
  title: string;
  stage: "idea" | "todo" | "doing" | "done";
  criteria: string;
  result: string;
  original_text: string;
  organized_text: string;
  ai_analysis: null;
  ai_model: null;
  ai_prompt_version: null;
  ai_organized_at: null;
  focus: boolean;
  archived: boolean;
  reference: boolean;
  sort_order: number;
  completed_at: null;
  previous_stage: null;
  created_at: string;
  updated_at: string;
};

type FakeRow = FakeAttachment | FakeCard;
type QueryResult = { data: unknown; error: FakeError | null; count?: number | null };
type Filter = { column: string; operation: "eq" | "in" | "lt"; value: unknown };

const clientHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/supabase-client", () => ({
  requireSupabase: () => clientHolder.current,
}));

import {
  createBoardCard,
  deleteBoardAttachment,
  listBoardCards,
  reconcileBoardAttachments,
  reorderBoardAttachments,
  uploadBoardAttachment,
} from "@/lib/supabase-board";
import { IdeaBoard } from "@/app/components/IdeaBoard";
import type { AttachmentRecord } from "@/lib/types";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const A_ID = "10000000-0000-4000-8000-000000000001";
const B_ID = "10000000-0000-4000-8000-000000000002";
const REQUEST_ID = "20000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-05T12:00:00.000Z");
const STALE = "2026-09-05T11:30:00.000Z";
const FRESH = "2026-09-05T11:50:00.000Z";

function error(message: string, fields: Omit<FakeError, "message"> = {}): FakeError {
  return { message, ...fields };
}

function attachment(
  id: string,
  state: AttachmentState,
  patch: Partial<FakeAttachment> = {},
): FakeAttachment {
  return {
    id,
    card_id: 7,
    user_id: USER_ID,
    object_key: `${USER_ID}/7/${id}/image.png`,
    filename: "image.png",
    content_type: "image/png",
    size: 4,
    sort_order: 0,
    state,
    updated_at: STALE,
    created_at: STALE,
    ...patch,
  };
}

function card(id: number, patch: Partial<FakeCard> = {}): FakeCard {
  return {
    id,
    user_id: USER_ID,
    client_request_id: null,
    title: `记录 ${id}`,
    stage: "idea",
    criteria: "",
    result: "",
    original_text: "",
    organized_text: "",
    ai_analysis: null,
    ai_model: null,
    ai_prompt_version: null,
    ai_organized_at: null,
    focus: false,
    archived: false,
    reference: false,
    sort_order: id,
    completed_at: null,
    previous_stage: null,
    created_at: STALE,
    updated_at: STALE,
    ...patch,
  };
}

class FakeQuery implements PromiseLike<QueryResult> {
  private operation: "select" | "insert" | "update" | "delete" = "select";
  private values: Record<string, unknown> = {};
  private filters: Filter[] = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private maximum: number | undefined;
  private resultMode: "many" | "single" | "maybeSingle" = "many";
  private wantsCount = false;
  private head = false;
  private selectedColumns = "*";

  constructor(private readonly client: FakeSupabase, private readonly table: "cards" | "attachments") {}

  select(columns = "*", options?: { count?: string; head?: boolean }): this {
    this.selectedColumns = columns;
    this.wantsCount = options?.count === "exact";
    this.head = options?.head === true;
    return this;
  }

  insert(values: Record<string, unknown>): this {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.operation = "update";
    this.values = values;
    return this;
  }

  delete(): this {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, operation: "eq", value });
    return this;
  }

  in(column: string, value: unknown[]): this {
    this.filters.push({ column, operation: "in", value });
    return this;
  }

  lt(column: string, value: unknown): this {
    this.filters.push({ column, operation: "lt", value });
    return this;
  }

  order(column: string, options: { ascending: boolean }): this {
    this.orders.push({ column, ascending: options.ascending });
    return this;
  }

  limit(value: number): this {
    this.maximum = value;
    return this;
  }

  single(): Promise<QueryResult> {
    this.resultMode = "single";
    return this.execute();
  }

  maybeSingle(): Promise<QueryResult> {
    this.resultMode = "maybeSingle";
    return this.execute();
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private visibleRows(): FakeRow[] {
    const source: FakeRow[] = this.table === "cards" ? this.client.cards : this.client.attachments;
    return source.filter((row) => row.user_id === this.client.userId).filter((row) => this.filters.every((item) => {
      const actual = row[item.column as keyof FakeRow];
      if (item.operation === "eq") return actual === item.value;
      if (item.operation === "in") return (item.value as unknown[]).includes(actual);
      return String(actual) < String(item.value);
    }));
  }

  private shape(rows: FakeRow[]): QueryResult {
    // Keep projection state as part of the builder contract even though these
    // fixtures return complete rows, like PostgREST does for `select("*")`.
    void this.selectedColumns;
    let selected = [...rows];
    for (const order of [...this.orders].reverse()) {
      selected.sort((left, right) => {
        const a = left[order.column as keyof FakeRow];
        const b = right[order.column as keyof FakeRow];
        const comparison = String(a).localeCompare(String(b), undefined, { numeric: true });
        return order.ascending ? comparison : -comparison;
      });
    }
    if (this.maximum !== undefined) selected = selected.slice(0, this.maximum);
    const withRelations = selected.map((row) => this.table === "cards"
      ? { ...row, attachments: this.client.attachments.filter((item) => item.card_id === row.id && item.user_id === this.client.userId) }
      : { ...row });
    if (this.head) return { data: null, error: null, count: this.wantsCount ? withRelations.length : null };
    if (this.resultMode === "single") {
      return withRelations.length === 1
        ? { data: withRelations[0], error: null }
        : { data: null, error: error("Expected exactly one row") };
    }
    if (this.resultMode === "maybeSingle") {
      return withRelations.length <= 1
        ? { data: withRelations[0] ?? null, error: null }
        : { data: null, error: error("Expected at most one row") };
    }
    return { data: withRelations, error: null };
  }

  private async execute(): Promise<QueryResult> {
    if (this.operation === "select") return this.shape(this.visibleRows());

    if (this.operation === "insert" && this.table === "cards") {
      const requestId = String(this.values.client_request_id);
      this.client.cardInsertAttempts.push(requestId);
      if (this.client.cardInsertErrorOnce) {
        const insertError = this.client.cardInsertErrorOnce;
        this.client.cardInsertErrorOnce = null;
        return { data: null, error: insertError };
      }
      if (this.client.cards.some((item) => item.user_id === this.client.userId && item.client_request_id === requestId)) {
        return { data: null, error: error("duplicate key value", { code: "23505" }) };
      }
      const inserted = card(this.client.nextCardId++, {
        ...(this.values as Partial<FakeCard>),
        user_id: this.client.userId,
        client_request_id: requestId,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      });
      this.client.cards.push(inserted);
      this.client.trace.push(`db:cards:insert:${requestId}`);
      if (this.client.ambiguousCardInsertOnce) {
        this.client.ambiguousCardInsertOnce = false;
        return { data: null, error: error("connection closed before response") };
      }
      return this.shape([inserted]);
    }

    if (this.operation === "insert" && this.table === "attachments") {
      const inserted = attachment(String(this.values.id), this.values.state as AttachmentState, {
        ...(this.values as Partial<FakeAttachment>),
        user_id: this.client.userId,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      });
      this.client.attachments.push(inserted);
      this.client.trace.push(`db:attachments:insert:${inserted.state}`);
      return this.shape([inserted]);
    }

    const rows = this.visibleRows();
    if (this.operation === "update") {
      const state = this.values.state as AttachmentState | undefined;
      if (this.table === "attachments" && state && this.client.failAttachmentStateOnce === state) {
        this.client.failAttachmentStateOnce = null;
        return { data: null, error: error(`cannot mark ${state}`) };
      }
      for (const row of rows) {
        Object.assign(row, this.values, { updated_at: NOW.toISOString() });
      }
      if (this.table === "attachments" && state) this.client.trace.push(`db:attachments:update:${state}`);
      return this.shape(rows);
    }

    if (this.table === "attachments" && this.client.failAttachmentDeleteOnce) {
      this.client.failAttachmentDeleteOnce = false;
      return { data: null, error: error("metadata delete failed") };
    }
    const source = this.table === "cards" ? this.client.cards : this.client.attachments;
    for (const row of rows) {
      const index = source.indexOf(row as never);
      if (index >= 0) source.splice(index, 1);
    }
    if (this.table === "attachments") this.client.trace.push("db:attachments:delete");
    return { data: null, error: null };
  }
}

class FakeSupabase {
  readonly userId = USER_ID;
  readonly cards: FakeCard[] = [];
  readonly attachments: FakeAttachment[] = [];
  readonly objects = new Set<string>();
  readonly trace: string[] = [];
  readonly rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  nextCardId = 1;
  ambiguousCardInsertOnce = false;
  cardInsertErrorOnce: FakeError | null = null;
  readonly cardInsertAttempts: string[] = [];
  uploadError: FakeError | null = null;
  removeErrors = new Map<string, FakeError>();
  downloadErrors = new Map<string, FakeError>();
  failAttachmentStateOnce: AttachmentState | null = null;
  failAttachmentDeleteOnce = false;
  rpcError: FakeError | null = null;

  readonly auth = {
    getUser: async () => ({ data: { user: { id: this.userId } }, error: null }),
  };

  readonly storage = {
    from: (bucket: string) => {
      expect(bucket).toBe("screenshots");
      return {
        upload: async (objectKey: string) => {
          this.trace.push(`storage:upload:${objectKey}`);
          if (this.uploadError) return { data: null, error: this.uploadError };
          this.objects.add(objectKey);
          return { data: { path: objectKey }, error: null };
        },
        remove: async (objectKeys: string[]) => {
          const objectKey = objectKeys[0];
          this.trace.push(`storage:remove:${objectKey}`);
          const configured = this.removeErrors.get(objectKey);
          if (configured) return { data: null, error: configured };
          if (!this.objects.has(objectKey)) {
            return { data: null, error: error("Object not found", { statusCode: "404" }) };
          }
          this.objects.delete(objectKey);
          return { data: [{ name: objectKey }], error: null };
        },
        download: async (objectKey: string) => {
          this.trace.push(`storage:download:${objectKey}`);
          const configured = this.downloadErrors.get(objectKey);
          if (configured) return { data: null, error: configured };
          return this.objects.has(objectKey)
            ? { data: new Blob(["test"], { type: "image/png" }), error: null }
            : { data: null, error: error("Object not found", { statusCode: "404" }) };
        },
      };
    },
  };

  from(table: "cards" | "attachments"): FakeQuery {
    return new FakeQuery(this, table);
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<QueryResult> {
    this.rpcCalls.push({ name, args });
    return { data: null, error: this.rpcError };
  }
}

let fakeClient: FakeSupabase;

beforeEach(() => {
  fakeClient = new FakeSupabase();
  clientHolder.current = fakeClient;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(crypto, "randomUUID").mockReturnValue(A_ID);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.replaceChildren();
});

describe("attachment state machine", () => {
  test("list exposes only ready attachment metadata", async () => {
    fakeClient.cards.push(card(7));
    fakeClient.attachments.push(
      attachment(A_ID, "pending"),
      attachment(B_ID, "ready", { sort_order: 1 }),
      attachment("10000000-0000-4000-8000-000000000003", "deleting", { sort_order: 2 }),
    );

    const [listed] = await listBoardCards();

    expect(listed.attachments.map((item) => [item.id, item.state])).toEqual([[B_ID, "ready"]]);
  });

  test("upload persists pending metadata before the object and exposes it only after ready", async () => {
    const image = new File(["test"], "image.png", { type: "image/png" });

    await uploadBoardAttachment(7, image);

    expect(fakeClient.attachments).toHaveLength(1);
    expect(fakeClient.attachments[0].state).toBe("ready");
    expect(fakeClient.objects.has(fakeClient.attachments[0].object_key)).toBe(true);
    expect(fakeClient.trace.map((item) => item.split(":").slice(0, 3).join(":"))).toEqual([
      "db:attachments:insert",
      "storage:upload:00000000-0000-4000-8000-000000000001/7/10000000-0000-4000-8000-000000000001/image.png",
      "db:attachments:update",
    ]);
  });

  test("upload exposes no ready metadata and compensates a failed object write", async () => {
    fakeClient.uploadError = error("上传失败");
    const image = new File(["test"], "image.png", { type: "image/png" });

    await expect(uploadBoardAttachment(7, image)).rejects.toThrow(/上传失败/);

    expect(fakeClient.attachments.filter((item) => item.state === "ready")).toHaveLength(0);
    expect(fakeClient.attachments).toHaveLength(0);
    expect(fakeClient.objects).toHaveLength(0);
  });

  test("ready transition failure removes the uploaded object without hiding the primary error", async () => {
    fakeClient.failAttachmentStateOnce = "ready";
    fakeClient.failAttachmentDeleteOnce = true;
    const image = new File(["test"], "image.png", { type: "image/png" });

    await expect(uploadBoardAttachment(7, image)).rejects.toThrow("cannot mark ready");

    expect(fakeClient.objects).toHaveLength(0);
    expect(fakeClient.attachments).toEqual([
      expect.objectContaining({ id: A_ID, state: "pending" }),
    ]);
  });

  test("delete rolls state back to ready when object deletion fails", async () => {
    const row = attachment(A_ID, "ready");
    fakeClient.attachments.push(row);
    fakeClient.objects.add(row.object_key);
    fakeClient.removeErrors.set(row.object_key, error("storage unavailable", { statusCode: "503" }));

    await expect(deleteBoardAttachment(asRecord(row))).rejects.toThrow("storage unavailable");

    expect(row.state).toBe("ready");
    expect(fakeClient.objects.has(row.object_key)).toBe(true);
    expect(fakeClient.trace.slice(0, 3)).toEqual([
      "db:attachments:update:deleting",
      `storage:remove:${row.object_key}`,
      "db:attachments:update:ready",
    ]);
  });

  test("delete leaves deleting metadata when metadata removal fails", async () => {
    const row = attachment(A_ID, "ready");
    fakeClient.attachments.push(row);
    fakeClient.objects.add(row.object_key);
    fakeClient.failAttachmentDeleteOnce = true;

    await expect(deleteBoardAttachment(asRecord(row))).rejects.toThrow("metadata delete failed");

    expect(row.state).toBe("deleting");
    expect(fakeClient.objects.has(row.object_key)).toBe(false);
  });

  test("reconcile repairs only stale non-ready rows for the current user and tolerates storage 404", async () => {
    const pendingWithObject = attachment(A_ID, "pending");
    const pendingWithoutObject = attachment(B_ID, "pending", { sort_order: 1 });
    const deletingWithoutObject = attachment("10000000-0000-4000-8000-000000000003", "deleting");
    const deletingWithObject = attachment("10000000-0000-4000-8000-000000000004", "deleting");
    const freshPending = attachment("10000000-0000-4000-8000-000000000005", "pending", { updated_at: FRESH });
    const ready = attachment("10000000-0000-4000-8000-000000000006", "ready");
    const otherOwner = attachment("10000000-0000-4000-8000-000000000007", "pending", { user_id: OTHER_USER_ID });
    fakeClient.attachments.push(
      pendingWithObject,
      pendingWithoutObject,
      deletingWithoutObject,
      deletingWithObject,
      freshPending,
      ready,
      otherOwner,
    );
    fakeClient.objects.add(pendingWithObject.object_key);
    fakeClient.objects.add(deletingWithObject.object_key);

    await reconcileBoardAttachments();
    await reconcileBoardAttachments();

    expect(pendingWithObject.state).toBe("ready");
    expect(fakeClient.objects.has(pendingWithObject.object_key)).toBe(true);
    expect(fakeClient.attachments).toEqual(expect.arrayContaining([freshPending, ready, otherOwner]));
    expect(fakeClient.attachments.map((item) => item.id)).not.toContain(pendingWithoutObject.id);
    expect(fakeClient.attachments.map((item) => item.id)).not.toContain(deletingWithoutObject.id);
    expect(fakeClient.attachments.map((item) => item.id)).not.toContain(deletingWithObject.id);
    expect(fakeClient.objects.has(deletingWithObject.object_key)).toBe(false);
  });
});

describe("card creation and attachment ordering", () => {
  test("a lost insert response and repeated create with one request UUID produce one card", async () => {
    fakeClient.ambiguousCardInsertOnce = true;

    const first = await createBoardCard("可恢复构思", "idea", {}, REQUEST_ID, 3);
    const retry = await createBoardCard("可恢复构思", "idea", {}, REQUEST_ID, 3);

    expect(first.id).toBe(retry.id);
    expect(fakeClient.cards).toHaveLength(1);
    expect(fakeClient.cards[0]).toMatchObject({ client_request_id: REQUEST_ID, sort_order: 3 });
  });

  test("reorder is one atomic RPC and preserves input order", async () => {
    await reorderBoardAttachments(7, [A_ID, B_ID]);

    expect(fakeClient.rpcCalls).toEqual([{
      name: "reorder_attachments",
      args: { p_card_id: 7, p_attachment_ids: [A_ID, B_ID] },
    }]);
  });

  test("reorder propagates an RPC error instead of reporting local success", async () => {
    fakeClient.rpcError = error("附件集合不匹配");

    await expect(reorderBoardAttachments(7, [A_ID, B_ID])).rejects.toThrow("附件集合不匹配");
    expect(fakeClient.rpcCalls).toHaveLength(1);
  });

  test("mobile composer keeps one UUID across a failed retry and rotates it after success", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce(REQUEST_ID)
      .mockReturnValueOnce(A_ID)
      .mockReturnValueOnce(B_ID);
    fakeClient.cardInsertErrorOnce = error("temporary network failure");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(IdeaBoard, { userId: USER_ID, displayName: "测试", onSignOut: () => undefined }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>(".mobile-composer input")!;
    const form = container.querySelector<HTMLFormElement>(".mobile-composer")!;
    await setComposerValue(input, "第一次构思");
    await submit(form);
    await submit(form);
    await setComposerValue(input, "第二次构思");
    await submit(form);

    expect(fakeClient.cardInsertAttempts).toHaveLength(3);
    expect(fakeClient.cardInsertAttempts[0]).toBe(REQUEST_ID);
    expect(fakeClient.cardInsertAttempts[1]).toBe(REQUEST_ID);
    expect(fakeClient.cardInsertAttempts[2]).not.toBe(REQUEST_ID);
    await act(async () => root.unmount());
  });
});

async function setComposerValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function asRecord(row: FakeAttachment): AttachmentRecord {
  return {
    id: row.id,
    cardId: row.card_id,
    objectKey: row.object_key,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    sortOrder: row.sort_order,
    state: row.state,
    createdAt: row.created_at,
  };
}
