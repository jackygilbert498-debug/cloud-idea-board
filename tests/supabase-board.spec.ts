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
type InsertFault = { phase: "before" | "after"; delivery: "error" | "throw"; error: FakeError };

const clientHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/supabase-client", () => ({
  requireSupabase: () => clientHolder.current,
}));

import {
  clearAttachmentUrlCache,
  createBoardCard,
  deleteBoardAttachment,
  getBoardAttachmentUrl,
  listBoardCards,
  reconcileBoardAttachments,
  reorderBoardAttachments,
  uploadBoardAttachment,
} from "@/lib/supabase-board";
import { IdeaBoard } from "@/app/components/IdeaBoard";
import { boardCacheKey, draftKey, readBoardCache, writeBoardCache } from "@/lib/local-state";
import type { AttachmentRecord } from "@/lib/types";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const boardProps: Parameters<typeof IdeaBoard>[0] = {
  userId: USER_ID,
  displayName: "测试",
  authMode: "persistent",
  isIdentityActive: () => true,
  onUpdatePassword: async () => undefined,
  onSignOut: async () => undefined,
};
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const A_ID = "10000000-0000-4000-8000-000000000001";
const B_ID = "10000000-0000-4000-8000-000000000002";
const REQUEST_ID = "20000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-05T12:00:00.000Z");
const STALE = "2026-09-05T11:30:00.000Z";
const FRESH = "2026-09-05T11:50:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

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
  private returnsRows = false;

  constructor(private readonly client: FakeSupabase, private readonly table: "cards" | "attachments") {}

  select(columns = "*", options?: { count?: string; head?: boolean }): this {
    this.selectedColumns = columns;
    this.returnsRows = true;
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
    if (this.operation === "select") {
      if (this.table === "cards" && this.client.cardSelectError) {
        return { data: null, error: this.client.cardSelectError };
      }
      const isAttachmentReread = this.table === "attachments"
        && this.filters.some((item) => item.column === "id" && item.operation === "eq");
      if (isAttachmentReread && this.client.attachmentReadErrorOnce) {
        const readError = this.client.attachmentReadErrorOnce;
        this.client.attachmentReadErrorOnce = null;
        return { data: null, error: readError };
      }
      return this.shape(this.visibleRows());
    }

    if (this.operation === "insert" && this.table === "cards") {
      const requestId = String(this.values.client_request_id);
      this.client.cardInsertAttempts.push(requestId);
      if (this.client.cardInsertThrowOnce === "before") {
        this.client.cardInsertThrowOnce = null;
        throw new Error("card insert threw before commit");
      }
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
      if (this.client.cardInsertThrowOnce === "after") {
        this.client.cardInsertThrowOnce = null;
        throw new Error("card insert threw after commit");
      }
      if (this.client.ambiguousCardInsertOnce) {
        this.client.ambiguousCardInsertOnce = false;
        return { data: null, error: error("connection closed before response") };
      }
      return this.shape([inserted]);
    }

    if (this.operation === "insert" && this.table === "attachments") {
      const attempt = ++this.client.attachmentInsertAttempts;
      const fault = this.client.attachmentInsertFaults.get(attempt);
      if (fault?.phase === "before") {
        this.client.attachmentInsertFaults.delete(attempt);
        if (fault.delivery === "throw") throw new Error(fault.error.message);
        return { data: null, error: fault.error };
      }
      const inserted = attachment(String(this.values.id), this.values.state as AttachmentState, {
        ...(this.values as Partial<FakeAttachment>),
        user_id: this.client.userId,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      });
      this.client.attachments.push(inserted);
      this.client.trace.push(`db:attachments:insert:${inserted.state}`);
      if (fault?.phase === "after") {
        this.client.attachmentInsertFaults.delete(attempt);
        if (fault.delivery === "throw") throw new Error(fault.error.message);
        return { data: null, error: fault.error };
      }
      return this.shape([inserted]);
    }

    if (this.operation === "update" && this.table === "attachments" && this.client.beforeAttachmentStateUpdateOnce) {
      const beforeUpdate = this.client.beforeAttachmentStateUpdateOnce;
      this.client.beforeAttachmentStateUpdateOnce = null;
      beforeUpdate();
    }
    const rows = this.visibleRows();
    if (this.operation === "update") {
      const state = this.values.state as AttachmentState | undefined;
      if (this.table === "attachments" && state && this.client.zeroAttachmentStateOnce === state) {
        this.client.zeroAttachmentStateOnce = null;
        this.client.onZeroAttachmentState?.(state);
        this.client.onZeroAttachmentState = null;
        return this.shape([]);
      }
      if (this.table === "attachments" && state && this.client.failAttachmentStateOnce === state) {
        this.client.failAttachmentStateOnce = null;
        return { data: null, error: error(`cannot mark ${state}`) };
      }
      for (const row of rows) {
        Object.assign(row, this.values, { updated_at: NOW.toISOString() });
      }
      if (this.table === "attachments" && state) this.client.trace.push(`db:attachments:update:${state}`);
      if (this.table === "attachments" && state && this.client.afterCommitAttachmentStateThrowOnce === state) {
        this.client.afterCommitAttachmentStateThrowOnce = null;
        throw new Error(`threw after marking ${state}`);
      }
      if (this.table === "attachments" && state && this.client.afterCommitAttachmentStateErrorOnce === state) {
        this.client.afterCommitAttachmentStateErrorOnce = null;
        return { data: null, error: error(`lost ${state} response`) };
      }
      return this.shape(rows);
    }

    if (this.table === "attachments" && this.client.zeroAttachmentDeleteOnce) {
      this.client.zeroAttachmentDeleteOnce = false;
      return this.returnsRows ? this.shape([]) : { data: null, error: null };
    }
    if (this.table === "attachments" && this.client.failAttachmentDeleteOnce) {
      this.client.failAttachmentDeleteOnce = false;
      return { data: null, error: error("metadata delete failed") };
    }
    if (this.table === "attachments" && this.client.throwAttachmentDeleteOnce) {
      this.client.throwAttachmentDeleteOnce = false;
      throw new Error("metadata delete threw");
    }
    const source = this.table === "cards" ? this.client.cards : this.client.attachments;
    for (const row of rows) {
      const index = source.indexOf(row as never);
      if (index >= 0) source.splice(index, 1);
    }
    if (this.table === "attachments") this.client.trace.push("db:attachments:delete");
    if (this.table === "attachments" && this.client.afterCommitAttachmentDeleteErrorOnce) {
      this.client.afterCommitAttachmentDeleteErrorOnce = false;
      return { data: null, error: error("lost metadata delete response") };
    }
    return this.returnsRows ? this.shape(rows) : { data: null, error: null };
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
  cardInsertThrowOnce: "before" | "after" | null = null;
  cardSelectError: FakeError | null = null;
  readonly cardInsertAttempts: string[] = [];
  uploadError: FakeError | null = null;
  uploadAfterCommitError: FakeError | null = null;
  attachmentInsertAttempts = 0;
  attachmentInsertFaults = new Map<number, InsertFault>();
  removeErrors = new Map<string, FakeError>();
  removeThrows = new Map<string, Error>();
  removeAfterCommitErrors = new Map<string, FakeError>();
  existsErrors = new Map<string, FakeError>();
  downloadErrors = new Map<string, FakeError>();
  failAttachmentStateOnce: AttachmentState | null = null;
  afterCommitAttachmentStateErrorOnce: AttachmentState | null = null;
  afterCommitAttachmentStateThrowOnce: AttachmentState | null = null;
  zeroAttachmentStateOnce: AttachmentState | null = null;
  onZeroAttachmentState: ((state: AttachmentState) => void) | null = null;
  beforeAttachmentStateUpdateOnce: (() => void) | null = null;
  attachmentReadErrorOnce: FakeError | null = null;
  failAttachmentDeleteOnce = false;
  throwAttachmentDeleteOnce = false;
  afterCommitAttachmentDeleteErrorOnce = false;
  zeroAttachmentDeleteOnce = false;
  rpcError: FakeError | null = null;
  beforeStorageRemoveOnce: (() => Promise<void>) | null = null;
  signedUrlCalls = 0;
  createSignedUrl: ((objectKey: string) => Promise<{ data: { signedUrl: string } | null; error: FakeError | null }>) | null = null;

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
          if (this.uploadAfterCommitError) return { data: null, error: this.uploadAfterCommitError };
          return { data: { path: objectKey }, error: null };
        },
        remove: async (objectKeys: string[]) => {
          const objectKey = objectKeys[0];
          this.trace.push(`storage:remove:${objectKey}`);
          const beforeRemove = this.beforeStorageRemoveOnce;
          this.beforeStorageRemoveOnce = null;
          if (beforeRemove) await beforeRemove();
          const thrown = this.removeThrows.get(objectKey);
          if (thrown) throw thrown;
          const configured = this.removeErrors.get(objectKey);
          if (configured) return { data: null, error: configured };
          if (!this.objects.has(objectKey)) {
            return { data: null, error: error("Object not found", { statusCode: "404" }) };
          }
          this.objects.delete(objectKey);
          const afterCommit = this.removeAfterCommitErrors.get(objectKey);
          if (afterCommit) return { data: null, error: afterCommit };
          return { data: [{ name: objectKey }], error: null };
        },
        exists: async (objectKey: string) => {
          this.trace.push(`storage:exists:${objectKey}`);
          const configured = this.existsErrors.get(objectKey);
          if (configured) throw new Error(configured.message);
          if (this.objects.has(objectKey)) return { data: true, error: null };
          return { data: false, error: error("Object not found", { statusCode: "404" }) };
        },
        download: async (objectKey: string) => {
          this.trace.push(`storage:download:${objectKey}`);
          const configured = this.downloadErrors.get(objectKey);
          if (configured) return { data: null, error: configured };
          return this.objects.has(objectKey)
            ? { data: new Blob(["test"], { type: "image/png" }), error: null }
            : { data: null, error: error("Object not found", { statusCode: "404" }) };
        },
        createSignedUrl: async (objectKey: string) => {
          this.signedUrlCalls += 1;
          if (this.createSignedUrl) return this.createSignedUrl(objectKey);
          return { data: { signedUrl: `https://signed.example/${this.signedUrlCalls}` }, error: null };
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
  test("clearing signed URLs prevents an older request from repopulating the cache", async () => {
    const request = deferred<{ data: { signedUrl: string }; error: null }>();
    fakeClient.createSignedUrl = () => request.promise;
    const record = asRecord(attachment(A_ID, "ready"));
    clearAttachmentUrlCache();
    const first = getBoardAttachmentUrl(record);
    await Promise.resolve();
    expect(fakeClient.signedUrlCalls).toBe(1);

    clearAttachmentUrlCache();
    request.resolve({ data: { signedUrl: "https://signed.example/stale" }, error: null });
    await expect(first).resolves.toBe("https://signed.example/stale");
    fakeClient.createSignedUrl = null;

    await expect(getBoardAttachmentUrl(record)).resolves.toBe("https://signed.example/2");
    expect(fakeClient.signedUrlCalls).toBe(2);
  });

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
    fakeClient.uploadError = error("上传失败", { statusCode: "413" });
    const image = new File(["test"], "image.png", { type: "image/png" });

    await expect(uploadBoardAttachment(7, image)).rejects.toThrow(/上传失败/);

    expect(fakeClient.attachments.filter((item) => item.state === "ready")).toHaveLength(0);
    expect(fakeClient.attachments).toHaveLength(0);
    expect(fakeClient.objects).toHaveLength(0);
  });

  test("an upload response lost after commit leaves object and pending metadata recoverable", async () => {
    fakeClient.uploadAfterCommitError = error("connection closed before response");
    const image = new File(["test"], "image.png", { type: "image/png" });

    await expect(uploadBoardAttachment(7, image)).rejects.toThrow("connection closed before response");

    expect(fakeClient.objects).toHaveLength(1);
    expect(fakeClient.attachments).toEqual([expect.objectContaining({ id: A_ID, state: "pending" })]);
  });

  test("a ready update response lost after commit is accepted after owner-scoped reread", async () => {
    fakeClient.afterCommitAttachmentStateErrorOnce = "ready";
    const image = new File(["test"], "image.png", { type: "image/png" });

    await uploadBoardAttachment(7, image);

    expect(fakeClient.objects).toHaveLength(1);
    expect(fakeClient.attachments).toEqual([expect.objectContaining({ id: A_ID, state: "ready" })]);
  });

  test("a zero-row ready CAS after stale cleanup recreates pending metadata instead of orphaning the object", async () => {
    fakeClient.zeroAttachmentStateOnce = "ready";
    fakeClient.onZeroAttachmentState = () => { fakeClient.attachments.splice(0); };
    const image = new File(["test"], "image.png", { type: "image/png" });

    await expect(uploadBoardAttachment(7, image)).rejects.toThrow(/截图状态/);

    expect(fakeClient.objects).toHaveLength(1);
    expect(fakeClient.attachments).toEqual([expect.objectContaining({ id: A_ID, state: "pending" })]);
  });

  test("a recovery insert rejected before commit removes the uploaded object", async () => {
    fakeClient.zeroAttachmentStateOnce = "ready";
    fakeClient.onZeroAttachmentState = () => { fakeClient.attachments.splice(0); };
    fakeClient.attachmentInsertFaults.set(2, {
      phase: "before",
      delivery: "error",
      error: error("recovery insert rejected"),
    });
    const image = new File(["test"], "image.png", { type: "image/png" });

    await expect(uploadBoardAttachment(7, image)).rejects.toThrow(/截图状态/);

    expect(fakeClient.attachments).toHaveLength(0);
    expect(fakeClient.objects).toHaveLength(0);
    expect(fakeClient.trace).toContain(`storage:remove:${USER_ID}/7/${A_ID}/image.png`);
    expect(fakeClient.trace).toContain(`storage:exists:${USER_ID}/7/${A_ID}/image.png`);
  });

  test("a recovery insert response lost after commit leaves pending metadata for reconcile", async () => {
    fakeClient.zeroAttachmentStateOnce = "ready";
    fakeClient.onZeroAttachmentState = () => { fakeClient.attachments.splice(0); };
    fakeClient.attachmentInsertFaults.set(2, {
      phase: "after",
      delivery: "error",
      error: error("lost recovery insert response"),
    });
    const image = new File(["test"], "image.png", { type: "image/png" });

    await expect(uploadBoardAttachment(7, image)).rejects.toThrow(/截图状态/);

    expect(fakeClient.objects).toHaveLength(1);
    expect(fakeClient.attachments).toEqual([expect.objectContaining({ id: A_ID, state: "pending" })]);
    expect(fakeClient.trace.some((item) => item.startsWith("storage:remove:"))).toBe(false);
  });

  test("an uncertain recovery cleanup recreates pending metadata instead of orphaning the object", async () => {
    const objectKey = `${USER_ID}/7/${A_ID}/image.png`;
    fakeClient.zeroAttachmentStateOnce = "ready";
    fakeClient.onZeroAttachmentState = () => { fakeClient.attachments.splice(0); };
    fakeClient.attachmentInsertFaults.set(2, {
      phase: "before",
      delivery: "error",
      error: error("recovery insert rejected"),
    });
    fakeClient.removeErrors.set(objectKey, error("remove response unknown"));
    fakeClient.existsErrors.set(objectKey, error("exists request timed out", { statusCode: "503" }));
    const image = new File(["test"], "image.png", { type: "image/png" });

    await expect(uploadBoardAttachment(7, image)).rejects.toThrow(/截图状态/);

    expect(fakeClient.objects.has(objectKey)).toBe(true);
    expect(fakeClient.attachments).toEqual([expect.objectContaining({ id: A_ID, state: "pending" })]);
    expect(fakeClient.trace).toContain(`storage:exists:${objectKey}`);
  });

  test("ready transition failure keeps the uploaded object with pending metadata", async () => {
    fakeClient.failAttachmentStateOnce = "ready";
    const image = new File(["test"], "image.png", { type: "image/png" });

    await expect(uploadBoardAttachment(7, image)).rejects.toThrow("cannot mark ready");

    expect(fakeClient.objects).toHaveLength(1);
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
    expect(fakeClient.trace.slice(0, 4)).toEqual([
      "db:attachments:update:deleting",
      `storage:remove:${row.object_key}`,
      `storage:exists:${row.object_key}`,
      "db:attachments:update:ready",
    ]);
  });

  test("a thrown object removal is probed and reports the confirmed ready projection", async () => {
    const row = attachment(A_ID, "ready");
    fakeClient.attachments.push(row);
    fakeClient.objects.add(row.object_key);
    fakeClient.removeThrows.set(row.object_key, new Error("remove fetch threw"));

    let failure: unknown;
    try { await deleteBoardAttachment(asRecord(row)); }
    catch (reason) { failure = reason; }

    expect(failure).toMatchObject({ message: "remove fetch threw", projection: "ready" });
    expect(row.state).toBe("ready");
    expect(fakeClient.objects.has(row.object_key)).toBe(true);
  });

  test("a second deleter cannot touch storage owned by the first claim", async () => {
    const row = attachment(A_ID, "ready");
    fakeClient.attachments.push(row);
    fakeClient.objects.add(row.object_key);
    fakeClient.removeErrors.set(row.object_key, error("storage unavailable", { statusCode: "503" }));
    let secondError: unknown;
    fakeClient.beforeStorageRemoveOnce = async () => {
      try { await deleteBoardAttachment(asRecord(row)); }
      catch (reason) { secondError = reason; }
    };

    await expect(deleteBoardAttachment(asRecord(row))).rejects.toThrow("storage unavailable");

    expect(secondError).toBeInstanceOf(Error);
    expect(fakeClient.trace.filter((item) => item === `storage:remove:${row.object_key}`)).toHaveLength(1);
    expect(row.state).toBe("ready");
    expect(fakeClient.objects.has(row.object_key)).toBe(true);
  });

  test("delete does not report success when both its CAS and final-state reread fail", async () => {
    const row = attachment(A_ID, "ready");
    fakeClient.attachments.push(row);
    fakeClient.objects.add(row.object_key);
    fakeClient.failAttachmentStateOnce = "deleting";
    fakeClient.attachmentReadErrorOnce = error("attachment reread unavailable");

    await expect(deleteBoardAttachment(asRecord(row))).rejects.toThrow("attachment reread unavailable");

    expect(fakeClient.objects.has(row.object_key)).toBe(true);
    expect(fakeClient.trace.some((item) => item.startsWith("storage:remove:"))).toBe(false);
  });

  test("a deleting CAS throw after commit is reread as hidden without touching storage", async () => {
    const row = attachment(A_ID, "ready");
    fakeClient.attachments.push(row);
    fakeClient.objects.add(row.object_key);
    fakeClient.afterCommitAttachmentStateThrowOnce = "deleting";

    let failure: unknown;
    try { await deleteBoardAttachment(asRecord(row)); }
    catch (reason) { failure = reason; }

    expect(failure).toMatchObject({ message: "threw after marking deleting", projection: "hidden" });
    expect(row.state).toBe("deleting");
    expect(fakeClient.objects.has(row.object_key)).toBe(true);
    expect(fakeClient.trace.some((item) => item.startsWith("storage:remove:"))).toBe(false);
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

  test("a metadata delete response lost after commit is accepted after owner-scoped reread", async () => {
    const row = attachment(A_ID, "ready");
    fakeClient.attachments.push(row);
    fakeClient.objects.add(row.object_key);
    fakeClient.afterCommitAttachmentDeleteErrorOnce = true;

    await deleteBoardAttachment(asRecord(row));

    expect(fakeClient.objects.has(row.object_key)).toBe(false);
    expect(fakeClient.attachments).toHaveLength(0);
  });

  test("a remove response lost after commit probes absence and completes metadata deletion", async () => {
    const row = attachment(A_ID, "ready");
    fakeClient.attachments.push(row);
    fakeClient.objects.add(row.object_key);
    fakeClient.removeAfterCommitErrors.set(row.object_key, error("connection closed before response"));

    await deleteBoardAttachment(asRecord(row));

    expect(fakeClient.objects.has(row.object_key)).toBe(false);
    expect(fakeClient.attachments).toHaveLength(0);
  });

  test("an indeterminate remove and indeterminate existence probe preserve deleting state", async () => {
    const row = attachment(A_ID, "ready");
    fakeClient.attachments.push(row);
    fakeClient.objects.add(row.object_key);
    fakeClient.removeErrors.set(row.object_key, error("Object not found after connection reset"));
    fakeClient.existsErrors.set(row.object_key, error("probe timed out", { statusCode: "503" }));

    await expect(deleteBoardAttachment(asRecord(row))).rejects.toThrow("Object not found after connection reset");

    expect(row.state).toBe("deleting");
    expect(fakeClient.objects.has(row.object_key)).toBe(true);
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

  test("reconcile does not claim a stale pending row touched by an active upload", async () => {
    const active = attachment(A_ID, "pending");
    fakeClient.attachments.push(active);
    fakeClient.beforeAttachmentStateUpdateOnce = () => { active.updated_at = FRESH; };

    await reconcileBoardAttachments();

    expect(active).toEqual(expect.objectContaining({ state: "pending", updated_at: FRESH }));
    expect(fakeClient.attachments).toContain(active);
    expect(fakeClient.trace.some((item) => item.startsWith("storage:"))).toBe(false);
  });

  test("reconcile never promotes deleting state owned by a concurrent delete", async () => {
    const activeDelete = attachment(A_ID, "pending");
    fakeClient.attachments.push(activeDelete);
    fakeClient.objects.add(activeDelete.object_key);
    fakeClient.beforeAttachmentStateUpdateOnce = () => {
      activeDelete.state = "deleting";
      activeDelete.updated_at = NOW.toISOString();
    };

    await reconcileBoardAttachments();

    expect(activeDelete.state).toBe("deleting");
    expect(fakeClient.objects.has(activeDelete.object_key)).toBe(true);
    expect(fakeClient.trace.some((item) => item.startsWith("storage:"))).toBe(false);
  });

  test("reconcile cannot remove an object from a stale deleting row reclaimed by an active delete", async () => {
    const activeDelete = attachment(A_ID, "deleting");
    fakeClient.attachments.push(activeDelete);
    fakeClient.objects.add(activeDelete.object_key);
    fakeClient.beforeAttachmentStateUpdateOnce = () => { activeDelete.updated_at = FRESH; };

    await reconcileBoardAttachments();

    expect(activeDelete).toEqual(expect.objectContaining({ state: "deleting", updated_at: FRESH }));
    expect(fakeClient.objects.has(activeDelete.object_key)).toBe(true);
    expect(fakeClient.trace.some((item) => item.startsWith("storage:remove:"))).toBe(false);
  });
});

describe("local attachment cache boundary", () => {
  test("legacy cache promotes missing state to ready and filters partial states", () => {
    const legacy = asRecord(attachment(A_ID, "ready"));
    const legacyWire: Record<string, unknown> = { ...legacy };
    delete legacyWire.state;
    const cached = { ...recordCard(7), attachments: [
      legacyWire,
      asRecord(attachment(B_ID, "pending")),
      asRecord(attachment("10000000-0000-4000-8000-000000000003", "deleting")),
    ] };
    localStorage.setItem(boardCacheKey(USER_ID), JSON.stringify([cached]));

    const [restored] = readBoardCache(USER_ID);

    expect(restored.attachments).toEqual([expect.objectContaining({ id: A_ID, state: "ready" })]);
  });

  test("cache writes only ready attachments and strips signed URLs", () => {
    const ready = { ...asRecord(attachment(A_ID, "ready")), url: "https://signed.example/secret" };
    const pending = asRecord(attachment(B_ID, "pending"));

    writeBoardCache(USER_ID, [recordCard(7, [ready, pending])]);

    const serialized = localStorage.getItem(boardCacheKey(USER_ID))!;
    expect(JSON.parse(serialized)).toEqual([
      expect.objectContaining({ attachments: [expect.objectContaining({ id: A_ID, state: "ready" })] }),
    ]);
    expect(serialized).not.toContain("signed.example");
    expect(serialized).not.toContain(B_ID);
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

  test("a card insert throw after commit resolves through the owner-scoped request lookup", async () => {
    fakeClient.cardInsertThrowOnce = "after";

    const created = await createBoardCard("异常后回查", "idea", {}, REQUEST_ID, 3);

    expect(created.id).toBe(1);
    expect(fakeClient.cards).toHaveLength(1);
    expect(fakeClient.cards[0]).toMatchObject({ user_id: USER_ID, client_request_id: REQUEST_ID });
  });

  test("a card insert throw before commit fails safely and the same UUID can be retried", async () => {
    fakeClient.cardInsertThrowOnce = "before";

    await expect(createBoardCard("未提交", "idea", {}, REQUEST_ID, 3)).rejects.toThrow("card insert threw before commit");
    expect(fakeClient.cards).toHaveLength(0);

    const retried = await createBoardCard("未提交", "idea", {}, REQUEST_ID, 3);
    expect(retried.id).toBe(1);
    expect(fakeClient.cards).toHaveLength(1);
    expect(fakeClient.cardInsertAttempts).toEqual([REQUEST_ID, REQUEST_ID]);
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

  test("mobile composer keeps one user-scoped UUID across remount after a failed submit", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.mocked(crypto.randomUUID).mockReturnValueOnce(REQUEST_ID).mockReturnValue(A_ID);
    fakeClient.cardInsertErrorOnce = error("temporary network failure");
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);

    await act(async () => {
      root.render(createElement(IdeaBoard, boardProps));
      await Promise.resolve();
      await Promise.resolve();
    });

    let input = container.querySelector<HTMLInputElement>(".mobile-composer input")!;
    let form = container.querySelector<HTMLFormElement>(".mobile-composer")!;
    await setComposerValue(input, "第一次构思");
    await submit(form);
    await act(async () => root.unmount());

    root = createRoot(container);
    await act(async () => {
      root.render(createElement(IdeaBoard, boardProps));
      await Promise.resolve();
      await Promise.resolve();
    });
    input = container.querySelector<HTMLInputElement>(".mobile-composer input")!;
    form = container.querySelector<HTMLFormElement>(".mobile-composer")!;
    expect(input.value).toBe("第一次构思");
    await submit(form);

    expect(localStorage.getItem(draftKey(USER_ID, "composer"))).toBeNull();
    await setComposerValue(input, "第二次构思");
    await submit(form);

    expect(fakeClient.cardInsertAttempts.slice(0, 2)).toEqual([REQUEST_ID, REQUEST_ID]);
    expect(fakeClient.cardInsertAttempts[2]).not.toBe(REQUEST_ID);
    await act(async () => root.unmount());
  });

  test("new-card editor keeps its user-scoped UUID across remount after a failed submit", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.mocked(crypto.randomUUID).mockReturnValueOnce(A_ID).mockReturnValueOnce(REQUEST_ID).mockReturnValue(B_ID);
    fakeClient.cardInsertErrorOnce = error("temporary network failure");
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);

    await renderBoard(root);
    await click(container.querySelector<HTMLButtonElement>("button.primary.desktop-only")!);
    let title = container.querySelector<HTMLTextAreaElement>(".editor .title-field textarea")!;
    await setTextAreaValue(title, "编辑器构思");
    await click(container.querySelector<HTMLButtonElement>(".editor footer button.primary")!);
    await act(async () => root.unmount());

    root = createRoot(container);
    await renderBoard(root);
    await click(container.querySelector<HTMLButtonElement>("button.primary.desktop-only")!);
    title = container.querySelector<HTMLTextAreaElement>(".editor .title-field textarea")!;
    expect(title.value).toBe("编辑器构思");
    await click(container.querySelector<HTMLButtonElement>(".editor footer button.primary")!);

    expect(fakeClient.cardInsertAttempts).toHaveLength(2);
    expect(fakeClient.cardInsertAttempts[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(fakeClient.cardInsertAttempts[1]).toBe(fakeClient.cardInsertAttempts[0]);
    expect(localStorage.getItem(draftKey(USER_ID, "new"))).toBeNull();
    await act(async () => root.unmount());
  });

  test("metadata delete failure reloads the ready projection without clearing the primary error", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const row = attachment(A_ID, "ready");
    fakeClient.cards.push(card(7));
    fakeClient.attachments.push(row);
    fakeClient.objects.add(row.object_key);
    fakeClient.failAttachmentDeleteOnce = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await renderBoard(root);
    await click(container.querySelector<HTMLButtonElement>(".task-card-main")!);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="删除截图"]')!);

    expect(container.querySelector(".attachment-grid")).toBeNull();
    expect(container.querySelector(".notice")?.textContent).toContain("metadata delete failed");
    expect(readBoardCache(USER_ID)[0].attachments).toHaveLength(0);
    await act(async () => root.unmount());
  });

  test("confirmed deleting projection stays hidden when metadata delete and list both fail", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const row = attachment(A_ID, "ready");
    fakeClient.cards.push(card(7));
    fakeClient.attachments.push(row);
    fakeClient.objects.add(row.object_key);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await renderBoard(root);
    fakeClient.throwAttachmentDeleteOnce = true;
    fakeClient.cardSelectError = error("list unavailable");
    await click(container.querySelector<HTMLButtonElement>(".task-card-main")!);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="删除截图"]')!);

    expect(container.querySelector(".attachment-grid")).toBeNull();
    expect(container.querySelector(".notice")?.textContent).toContain("metadata delete threw");
    expect(readBoardCache(USER_ID)[0].attachments).toHaveLength(0);
    await act(async () => root.unmount());
  });

  test.each([
    { label: "normal metadata success", afterCommit: false },
    { label: "metadata after-commit response loss", afterCommit: true },
  ])("successful delete hides cached attachment before a failed list: $label", async ({ afterCommit }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const row = attachment(A_ID, "ready");
    fakeClient.cards.push(card(7));
    fakeClient.attachments.push(row);
    fakeClient.objects.add(row.object_key);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await renderBoard(root);
    expect(readBoardCache(USER_ID)[0].attachments).toHaveLength(1);
    fakeClient.afterCommitAttachmentDeleteErrorOnce = afterCommit;
    fakeClient.cardSelectError = error("list unavailable after delete");
    await click(container.querySelector<HTMLButtonElement>(".task-card-main")!);
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="删除截图"]')!);

    expect(container.querySelector(".attachment-grid")).toBeNull();
    expect(readBoardCache(USER_ID)[0].attachments).toHaveLength(0);
    await act(async () => root.unmount());
  });
});

async function renderBoard(root: ReturnType<typeof createRoot>): Promise<void> {
  await act(async () => {
    root.render(createElement(IdeaBoard, boardProps));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function setComposerValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function setTextAreaValue(input: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
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

function recordCard(id: number, attachments: AttachmentRecord[] = []): import("@/lib/types").CardRecord {
  return {
    id,
    title: `记录 ${id}`,
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
    sortOrder: id,
    completedAt: null,
    previousStage: null,
    createdAt: STALE,
    updatedAt: STALE,
    attachments,
  };
}
