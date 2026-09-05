import { requireSupabase } from "@/lib/supabase-client";
import type {
  ActiveStage,
  AttachmentRecord,
  CardCreateDetails,
  CardPatch,
  CardRecord,
  IdeaAnalysis,
  Stage,
} from "@/lib/types";

const SCREENSHOT_BUCKET = "screenshots";
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
let signedUrlCacheGeneration = 0;
const ATTACHMENT_RECONCILE_AGE_MS = 15 * 60 * 1000;

type AttachmentState = AttachmentRecord["state"];
type ServiceError = {
  message: string;
  code?: string;
  status?: number | string;
  statusCode?: number | string;
  error?: string;
};

export type AttachmentDeleteProjection = "ready" | "hidden" | "unknown";

/** Carries the safest UI projection independently from the primary delete error. */
export class AttachmentDeleteError extends Error {
  constructor(message: string, readonly projection: AttachmentDeleteProjection) {
    super(message);
    this.name = "AttachmentDeleteError";
  }
}

type DbAttachment = {
  id: string;
  card_id: number;
  user_id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size: number;
  sort_order?: number;
  state: AttachmentState;
  updated_at: string;
  created_at: string;
};

type DbCard = {
  id: number;
  title: string;
  stage: Stage;
  criteria: string;
  result: string;
  original_text?: string;
  organized_text?: string;
  ai_analysis?: IdeaAnalysis | null;
  ai_model?: string | null;
  ai_prompt_version?: string | null;
  ai_organized_at?: string | null;
  original_text_updated_at?: string | null;
  focus: boolean;
  archived: boolean;
  reference: boolean;
  sort_order: number;
  completed_at?: string | null;
  previous_stage?: ActiveStage | null;
  created_at: string;
  updated_at: string;
  attachments?: DbAttachment[];
};

function fail(error: { message: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

function isStorageNotFound(error: ServiceError | null): boolean {
  if (!error) return false;
  return [error.status, error.statusCode, error.code].some((value) => String(value) === "404");
}

function storageStatus(error: ServiceError | null): number | null {
  if (!error) return null;
  for (const value of [error.status, error.statusCode]) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function isDefiniteUploadRejection(error: ServiceError): boolean {
  const status = storageStatus(error);
  return status !== null && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

function reportCompensationFailure(operation: string, error: ServiceError | null): void {
  if (error) console.warn(`${operation}，后台恢复流程稍后会重试：${error.message}`);
}

function serviceError(reason: unknown, fallback: string): ServiceError {
  return reason instanceof Error ? { message: reason.message } : { message: fallback };
}

type AttachmentSnapshot = Pick<DbAttachment, "id" | "user_id" | "object_key" | "state" | "updated_at">;

async function readAttachment(id: string, userId: string): Promise<{ data: AttachmentSnapshot | null; error: ServiceError | null }> {
  try {
    const { data, error } = await requireSupabase()
      .from("attachments")
      .select("id, user_id, object_key, state, updated_at")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    return { data: data as AttachmentSnapshot | null, error };
  } catch (reason) {
    return { data: null, error: serviceError(reason, "截图状态读取失败") };
  }
}

async function transitionAttachment(
  id: string,
  userId: string,
  from: AttachmentState,
  to: AttachmentState,
  expectedUpdatedAt?: string,
): Promise<{ data: AttachmentSnapshot | null; error: ServiceError | null; applied: boolean }> {
  let update = requireSupabase()
    .from("attachments")
    .update({ state: to })
    .eq("id", id)
    .eq("user_id", userId)
    .eq("state", from);
  if (expectedUpdatedAt !== undefined) update = update.eq("updated_at", expectedUpdatedAt);
  let data: unknown = null;
  let error: ServiceError | null = null;
  try {
    const result = await update.select("id, user_id, object_key, state, updated_at").maybeSingle();
    data = result.data;
    error = result.error;
  } catch (reason) {
    error = serviceError(reason, "截图状态更新失败");
  }
  if (!error && data) return { data: data as AttachmentSnapshot, error: null, applied: true };
  const current = await readAttachment(id, userId);
  return { data: current.data, error: current.error ?? error, applied: false };
}

async function deleteAttachmentMetadata(
  id: string,
  userId: string,
  state: AttachmentState,
): Promise<{ deleted: boolean; data: AttachmentSnapshot | null; error: ServiceError | null }> {
  let data: unknown = null;
  let error: ServiceError | null = null;
  try {
    const result = await requireSupabase()
      .from("attachments")
      .delete()
      .eq("id", id)
      .eq("user_id", userId)
      .eq("state", state)
      .select("id")
      .maybeSingle();
    data = result.data;
    error = result.error;
  } catch (reason) {
    error = serviceError(reason, "截图记录删除失败");
  }
  if (error) {
    const current = await readAttachment(id, userId);
    if (!current.error && current.data === null) return { deleted: true, data: null, error: null };
    return { deleted: false, data: current.data, error: current.error ?? error };
  }
  if (data) return { deleted: true, data: null, error: null };
  const current = await readAttachment(id, userId);
  return { deleted: current.data === null && current.error === null, ...current };
}

async function probeStorageObject(
  bucket: ReturnType<ReturnType<typeof requireSupabase>["storage"]["from"]>,
  objectKey: string,
): Promise<{ result: "exists" | "missing" | "unknown"; error: ServiceError | null }> {
  try {
    const { data, error } = await bucket.exists(objectKey);
    if (data === true && !error) return { result: "exists", error: null };
    if (data === false && error && [400, 404].includes(storageStatus(error) ?? -1)) {
      return { result: "missing", error: null };
    }
    return { result: "unknown", error };
  } catch (reason) {
    return {
      result: "unknown",
      error: reason instanceof Error ? { message: reason.message } : { message: "对象状态探测失败" },
    };
  }
}

async function removeStorageObject(
  bucket: ReturnType<ReturnType<typeof requireSupabase>["storage"]["from"]>,
  objectKey: string,
  verifyMissing = false,
): Promise<{ result: "missing" | "exists" | "unknown"; error: ServiceError | null }> {
  let removeError: ServiceError | null = null;
  try {
    const removed = await bucket.remove([objectKey]);
    removeError = removed.error;
  } catch (reason) {
    removeError = serviceError(reason, "对象清理失败");
  }
  if (!removeError || isStorageNotFound(removeError)) {
    if (!verifyMissing) return { result: "missing", error: null };
    return probeStorageObject(bucket, objectKey);
  }
  const probe = await probeStorageObject(bucket, objectKey);
  // The probe is compensation evidence; it must not replace the primary remove failure.
  return { result: probe.result, error: removeError };
}

async function insertRecoverableAttachment(
  row: Record<string, unknown>,
  id: string,
  userId: string,
): Promise<{ data: AttachmentSnapshot | null; error: ServiceError | null; definitelyMissing: boolean }> {
  let insertError: ServiceError | null = null;
  try {
    const result = await requireSupabase().from("attachments").insert(row);
    insertError = result.error;
  } catch (reason) {
    insertError = serviceError(reason, "待恢复截图记录重建失败");
  }
  const current = await readAttachment(id, userId);
  return {
    data: current.data,
    error: current.error ?? insertError,
    definitelyMissing: current.data === null && current.error === null,
  };
}

function deleteProjection(data: AttachmentSnapshot | null, error: ServiceError | null): AttachmentDeleteProjection {
  if (!data) return error ? "unknown" : "hidden";
  return data.state === "ready" ? "ready" : "hidden";
}

function failDelete(
  error: ServiceError | null,
  fallback: string,
  projection: AttachmentDeleteProjection,
): never {
  throw new AttachmentDeleteError(error?.message || fallback, projection);
}

function mapAttachment(row: DbAttachment): AttachmentRecord {
  return {
    id: row.id,
    cardId: row.card_id,
    objectKey: row.object_key,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    sortOrder: row.sort_order ?? 0,
    state: row.state,
    createdAt: row.created_at,
  };
}

function mapCard(row: DbCard): CardRecord {
  return {
    id: row.id,
    title: row.title,
    stage: row.stage,
    criteria: row.criteria,
    result: row.result,
    originalText: row.original_text ?? "",
    organizedText: row.organized_text ?? "",
    aiAnalysis: row.ai_analysis ?? null,
    aiModel: row.ai_model ?? null,
    aiPromptVersion: row.ai_prompt_version ?? null,
    aiOrganizedAt: row.ai_organized_at ?? null,
    originalTextUpdatedAt: row.original_text_updated_at ?? null,
    focus: row.focus,
    archived: row.archived,
    reference: row.reference,
    sortOrder: row.sort_order,
    completedAt: row.completed_at ?? null,
    previousStage: row.previous_stage ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments: (row.attachments ?? [])
      .filter((attachment) => attachment.state === "ready")
      .map(mapAttachment)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt)),
  };
}

export function validateBoardAttachment(file: File): void {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) throw new Error("仅支持 JPG、PNG 或 WebP 图片");
  if (!file.size || file.size > MAX_IMAGE_SIZE) throw new Error("单张截图不能超过 10 MB");
}

export async function listBoardCards(): Promise<CardRecord[]> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("cards")
    .select("*, attachments(*)")
    .order("archived", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });
  if (error) fail(error, "无法读取记录");
  return ((data ?? []) as DbCard[]).map(mapCard);
}

export async function getBoardAttachmentUrl(attachment: AttachmentRecord, download = false): Promise<string> {
  if (!attachment.objectKey) throw new Error("截图路径无效");
  const cacheKey = `${download ? "download" : "view"}:${attachment.objectKey}`;
  const cached = signedUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const cacheGeneration = signedUrlCacheGeneration;

  const bucket = requireSupabase().storage.from(SCREENSHOT_BUCKET);
  const { data, error } = download
    ? await bucket.createSignedUrl(attachment.objectKey, 5 * 60, { download: attachment.filename })
    : await bucket.createSignedUrl(attachment.objectKey, 60 * 60);
  if (error || !data?.signedUrl) fail(error, "无法读取截图");
  if (signedUrlCacheGeneration === cacheGeneration) {
    signedUrlCache.set(cacheKey, {
      url: data.signedUrl,
      expiresAt: Date.now() + (download ? 4 : 50) * 60 * 1000,
    });
  }
  return data.signedUrl;
}

export function clearAttachmentUrlCache(objectKey?: string): void {
  signedUrlCacheGeneration += 1;
  for (const key of signedUrlCache.keys()) {
    if (!objectKey || key.endsWith(`:${objectKey}`)) signedUrlCache.delete(key);
  }
}

function fallbackTitle(originalText: string): string {
  const line = originalText.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? "";
  return Array.from(line.replace(/\s+/g, " ")).slice(0, 40).join("");
}

export async function createBoardCard(
  title: string,
  stage: Stage,
  details: CardCreateDetails = {},
  clientRequestId: string,
  knownSortOrder?: number,
): Promise<CardRecord> {
  const client = requireSupabase();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) fail(userError, "登录状态已失效");
  const cleanTitle = title.trim() || fallbackTitle(details.originalText ?? "") || "未命名想法";
  let sortOrder = knownSortOrder;
  if (sortOrder === undefined) {
    const { data: last, error: lastError } = await client
      .from("cards")
      .select("sort_order")
      .eq("stage", stage)
      .eq("archived", false)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) fail(lastError, "无法准备新记录");
    sortOrder = (last?.sort_order ?? 0) + 1;
  }
  let inserted: DbCard | null = null;
  let insertError: ServiceError | null = null;
  try {
    const result = await client.from("cards").insert({
      client_request_id: clientRequestId,
      title: cleanTitle,
      stage,
      criteria: details.criteria?.trim() ?? "",
      result: details.result?.trim() ?? "",
      original_text: details.originalText ?? "",
      organized_text: details.organizedText ?? "",
      ai_analysis: details.aiAnalysis ?? null,
      ai_model: details.aiModel ?? null,
      ai_prompt_version: details.aiPromptVersion ?? null,
      ai_organized_at: details.aiOrganizedAt ?? null,
      sort_order: sortOrder,
    }).select("*").single();
    inserted = result.data as DbCard | null;
    insertError = result.error;
  } catch (reason) {
    insertError = serviceError(reason, "新构思创建失败");
  }
  if (!insertError && inserted) return mapCard(inserted);

  // Both a unique conflict and a lost insert response are resolved by the same
  // owner-scoped lookup. Never issue a second insert for this request ID.
  let existing: DbCard | null = null;
  let existingError: ServiceError | null = null;
  try {
    const result = await client
      .from("cards")
      .select("*")
      .eq("user_id", userData.user.id)
      .eq("client_request_id", clientRequestId)
      .maybeSingle();
    existing = result.data as DbCard | null;
    existingError = result.error;
  } catch (reason) {
    existingError = serviceError(reason, "新构思状态确认失败");
  }
  if (existing) return mapCard(existing as DbCard);
  if (insertError) fail(insertError, "新构思创建失败");
  fail(existingError, "新构思创建失败");
}

export async function updateBoardCard(id: number, patch: CardPatch, knownCard?: CardRecord): Promise<CardRecord> {
  const client = requireSupabase();
  const needsCurrent = !knownCard && (patch.focus === true || patch.stage !== undefined);
  let current = knownCard ?? null;
  if (needsCurrent) {
    const { data, error } = await client.from("cards").select("*, attachments(*)").eq("id", id).single();
    if (error || !data) fail(error, "记录不存在");
    current = mapCard(data as DbCard);
  }

  if (patch.focus === true) {
    const { count, error } = await client
      .from("cards")
      .select("id", { count: "exact", head: true })
      .eq("focus", true)
      .eq("archived", false);
    if (error) fail(error, "无法检查今日焦点");
    if (current?.stage === "done") throw new Error("已完成记录不能设为今日焦点");
    if (!current?.focus && (count ?? 0) >= 3) throw new Error("今日焦点最多保留 3 条");
  }

  const updates: Record<string, unknown> = {};
  if (patch.title !== undefined) updates.title = patch.title.trim();
  if (patch.stage !== undefined) updates.stage = patch.stage;
  if (patch.criteria !== undefined) updates.criteria = patch.criteria.trim();
  if (patch.result !== undefined) updates.result = patch.result.trim();
  if (patch.originalText !== undefined) updates.original_text = patch.originalText;
  if (patch.organizedText !== undefined) updates.organized_text = patch.organizedText;
  if (patch.aiAnalysis !== undefined) updates.ai_analysis = patch.aiAnalysis;
  if (patch.aiModel !== undefined) updates.ai_model = patch.aiModel;
  if (patch.aiPromptVersion !== undefined) updates.ai_prompt_version = patch.aiPromptVersion;
  if (patch.aiOrganizedAt !== undefined) updates.ai_organized_at = patch.aiOrganizedAt;
  if (patch.focus !== undefined) updates.focus = patch.focus;
  if (patch.archived !== undefined) updates.archived = patch.archived;
  if (patch.reference !== undefined) updates.reference = patch.reference;
  if (patch.sortOrder !== undefined) updates.sort_order = patch.sortOrder;
  if (patch.archived === true || patch.stage === "done") updates.focus = false;

  if (patch.stage !== undefined && patch.stage !== current?.stage && patch.sortOrder === undefined) {
    const { data: last, error: lastError } = await client
      .from("cards")
      .select("sort_order")
      .eq("stage", patch.stage)
      .eq("archived", false)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) fail(lastError, "无法更新排序");
    updates.sort_order = (last?.sort_order ?? 0) + 1;
  }
  if (!Object.keys(updates).length) {
    if (current) return current;
    const { data, error } = await client.from("cards").select("*, attachments(*)").eq("id", id).single();
    if (error || !data) fail(error, "记录不存在");
    return mapCard(data as DbCard);
  }
  const update = client
    .from("cards")
    .update(updates)
    .eq("id", id);
  const { data, error } = current
    ? await update.select("*").single()
    : await update.select("*, attachments(*)").single();
  if (error || !data) fail(error, "保存失败");
  const card = mapCard(data as unknown as DbCard);
  if (current) card.attachments = current.attachments;
  return card;
}

export async function uploadBoardAttachment(cardId: number, file: File): Promise<void> {
  validateBoardAttachment(file);
  const client = requireSupabase();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) fail(userError, "登录状态已失效");
  const { data: last, error: lastError } = await client
    .from("attachments")
    .select("sort_order")
    .eq("card_id", cardId)
    .eq("state", "ready")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) fail(lastError, "无法准备截图顺序");

  const attachmentId = crypto.randomUUID();
  const filename = (file.name.normalize("NFKC").replace(/[\\/\0\r\n]/g, "_").trim() || "screenshot").slice(0, 180);
  const objectKey = `${userData.user.id}/${cardId}/${attachmentId}/${filename}`;
  const pendingRow = {
    id: attachmentId,
    card_id: cardId,
    user_id: userData.user.id,
    object_key: objectKey,
    filename,
    content_type: file.type,
    size: file.size,
    sort_order: (last?.sort_order ?? -1) + 1,
    state: "pending" as const,
  };
  const { error: insertError } = await client.from("attachments").insert(pendingRow);
  if (insertError) fail(insertError, "截图保存失败");

  const { error: uploadError } = await client.storage.from(SCREENSHOT_BUCKET).upload(objectKey, file, {
    contentType: file.type,
    upsert: false,
  });
  if (uploadError) {
    if (isDefiniteUploadRejection(uploadError)) {
      const cleanup = await deleteAttachmentMetadata(attachmentId, userData.user.id, "pending");
      if (cleanup.data?.state === "ready") return;
      reportCompensationFailure("截图上传失败后的元数据清理也失败", cleanup.error);
    }
    fail(uploadError, "截图上传失败");
  }

  const ready = await transitionAttachment(attachmentId, userData.user.id, "pending", "ready");
  if (ready.data?.state === "ready") return;

  const primaryError = ready.error ?? { message: "截图状态保存冲突，请稍后重试" };
  if (ready.data === null && ready.error === null) {
    // A stale reconciler may have removed the pending row while this upload was
    // still in flight. Prefer a recoverable row; if that is definitely rejected,
    // converge the uploaded object to absence before returning the primary error.
    const recovery = await insertRecoverableAttachment(pendingRow, attachmentId, userData.user.id);
    if (recovery.data?.state === "ready") return;
    if (recovery.definitelyMissing) {
      const bucket = client.storage.from(SCREENSHOT_BUCKET);
      const cleanup = await removeStorageObject(bucket, objectKey, true);
      if (cleanup.result !== "missing") {
        // A lost remove response cannot justify abandoning the object. A second
        // insert handles the common single-fault case and leaves reconcile state.
        const retry = await insertRecoverableAttachment(pendingRow, attachmentId, userData.user.id);
        if (retry.data?.state === "ready") return;
        if (retry.definitelyMissing) {
          const finalCleanup = await removeStorageObject(bucket, objectKey, true);
          reportCompensationFailure("截图对象最终清理仍未确认", finalCleanup.error);
        } else {
          reportCompensationFailure("截图对象清理不确定，已重建待恢复元数据", retry.error);
        }
      }
    } else {
      reportCompensationFailure("截图状态冲突后的待恢复元数据重建失败", recovery.error);
    }
  }
  fail(primaryError, "截图状态保存失败");
}

export async function reorderBoardAttachments(cardId: number, attachmentIds: string[]): Promise<void> {
  const { error } = await requireSupabase().rpc("reorder_attachments", {
    p_card_id: cardId,
    p_attachment_ids: attachmentIds,
  });
  if (error) fail(error, "截图排序保存失败");
}

export async function deleteBoardAttachment(attachment: AttachmentRecord): Promise<void> {
  const client = requireSupabase();
  if (!attachment.objectKey) throw new Error("截图路径无效");
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) fail(userError, "登录状态已失效");
  const deleting = await transitionAttachment(attachment.id, userData.user.id, "ready", "deleting");
  if (!deleting.applied) {
    if (deleting.data === null && deleting.error === null) return;
    failDelete(
      deleting.error,
      deleting.data?.state === "deleting" ? "截图正在由另一项操作处理" : "截图状态已变化，请刷新后重试",
      deleteProjection(deleting.data, deleting.error),
    );
  }

  const removal = await removeStorageObject(client.storage.from(SCREENSHOT_BUCKET), attachment.objectKey);
  if (removal.result !== "missing") {
    if (removal.result === "exists") {
      const rollback = await transitionAttachment(attachment.id, userData.user.id, "deleting", "ready");
      if (rollback.data?.state !== "ready") reportCompensationFailure("截图对象删除失败后的状态回滚也失败", rollback.error);
      failDelete(removal.error, "截图删除失败", deleteProjection(rollback.data, rollback.error));
    }
    failDelete(removal.error, "截图删除结果暂时无法确认", "hidden");
  }
  clearAttachmentUrlCache(attachment.objectKey);
  const metadata = await deleteAttachmentMetadata(attachment.id, userData.user.id, "deleting");
  if (!metadata.deleted) failDelete(metadata.error, "截图记录删除失败", deleteProjection(metadata.data, metadata.error));
}

/** Repair stale interrupted attachment operations without exposing partial rows. */
export async function reconcileBoardAttachments(): Promise<void> {
  const client = requireSupabase();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) fail(userError, "登录状态已失效");
  const cutoff = new Date(Date.now() - ATTACHMENT_RECONCILE_AGE_MS).toISOString();
  const { data, error } = await client
    .from("attachments")
    .select("id, user_id, object_key, state, updated_at")
    .eq("user_id", userData.user.id)
    .in("state", ["pending", "deleting"])
    .lt("updated_at", cutoff);
  if (error) fail(error, "无法恢复未完成的截图操作");

  const failures: ServiceError[] = [];
  const bucket = client.storage.from(SCREENSHOT_BUCKET);
  for (const row of (data ?? []) as DbAttachment[]) {
    if (row.state === "pending") {
      // Claim the stale row before probing. A still-running uploader can only
      // observe deleting/missing afterwards and must not publish ready blindly.
      const claim = await transitionAttachment(row.id, userData.user.id, "pending", "deleting", row.updated_at);
      if (!claim.applied || claim.data?.state !== "deleting") {
        if (claim.error) failures.push(claim.error);
        continue;
      }
      const probe = await probeStorageObject(bucket, row.object_key);
      if (probe.result === "exists") {
        const ready = await transitionAttachment(row.id, userData.user.id, "deleting", "ready");
        if (ready.data?.state !== "ready") {
          const release = await transitionAttachment(row.id, userData.user.id, "deleting", "pending");
          failures.push(ready.error ?? release.error ?? { message: "截图恢复状态冲突" });
        }
      } else if (probe.result === "missing") {
        const cleanup = await deleteAttachmentMetadata(row.id, userData.user.id, "deleting");
        if (!cleanup.deleted) failures.push(cleanup.error ?? { message: "截图恢复清理冲突" });
      } else {
        const release = await transitionAttachment(row.id, userData.user.id, "deleting", "pending");
        failures.push(probe.error ?? release.error ?? { message: "截图对象状态无法确认" });
      }
      continue;
    }

    // Same-state CAS refreshes updated_at and proves this pass owns cleanup.
    const claim = await transitionAttachment(row.id, userData.user.id, "deleting", "deleting", row.updated_at);
    if (!claim.applied || claim.data?.state !== "deleting") {
      if (claim.error) failures.push(claim.error);
      continue;
    }

    const removal = await removeStorageObject(bucket, row.object_key);
    if (removal.result !== "missing") {
      failures.push(removal.error ?? { message: "截图对象删除结果无法确认" });
      continue;
    }
    const cleanup = await deleteAttachmentMetadata(row.id, userData.user.id, "deleting");
    if (!cleanup.deleted) failures.push(cleanup.error ?? { message: "截图删除恢复冲突" });
    else clearAttachmentUrlCache(row.object_key);
  }
  if (failures.length) fail(failures[0], "未完成的截图操作将在稍后重试");
}
