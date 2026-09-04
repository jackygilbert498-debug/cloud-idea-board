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

type DbAttachment = {
  id: string;
  card_id: number;
  object_key: string;
  filename: string;
  content_type: string;
  size: number;
  sort_order?: number;
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

function mapAttachment(row: DbAttachment): AttachmentRecord {
  return {
    id: row.id,
    cardId: row.card_id,
    objectKey: row.object_key,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    sortOrder: row.sort_order ?? 0,
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

  const bucket = requireSupabase().storage.from(SCREENSHOT_BUCKET);
  const { data, error } = download
    ? await bucket.createSignedUrl(attachment.objectKey, 5 * 60, { download: attachment.filename })
    : await bucket.createSignedUrl(attachment.objectKey, 60 * 60);
  if (error || !data?.signedUrl) fail(error, "无法读取截图");
  signedUrlCache.set(cacheKey, {
    url: data.signedUrl,
    expiresAt: Date.now() + (download ? 4 : 50) * 60 * 1000,
  });
  return data.signedUrl;
}

export function clearAttachmentUrlCache(objectKey?: string): void {
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
  knownSortOrder?: number,
): Promise<CardRecord> {
  const client = requireSupabase();
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
  const { data, error } = await client.from("cards").insert({
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
  if (error || !data) fail(error, "新构思创建失败");
  return mapCard(data as DbCard);
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
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) fail(lastError, "无法准备截图顺序");

  const attachmentId = crypto.randomUUID();
  const filename = (file.name.normalize("NFKC").replace(/[\\/\0\r\n]/g, "_").trim() || "screenshot").slice(0, 180);
  const objectKey = `${userData.user.id}/${cardId}/${attachmentId}/${filename}`;
  const { error: uploadError } = await client.storage.from(SCREENSHOT_BUCKET).upload(objectKey, file, {
    contentType: file.type,
    upsert: false,
  });
  if (uploadError) fail(uploadError, "截图上传失败");
  const { error: insertError } = await client.from("attachments").insert({
    id: attachmentId,
    card_id: cardId,
    object_key: objectKey,
    filename,
    content_type: file.type,
    size: file.size,
    sort_order: (last?.sort_order ?? -1) + 1,
  });
  if (insertError) {
    await client.storage.from(SCREENSHOT_BUCKET).remove([objectKey]);
    fail(insertError, "截图保存失败");
  }
}

export async function reorderBoardAttachments(cardId: number, attachmentIds: string[]): Promise<void> {
  const client = requireSupabase();
  for (const [sortOrder, id] of attachmentIds.entries()) {
    const { error } = await client.from("attachments")
      .update({ sort_order: sortOrder })
      .eq("id", id)
      .eq("card_id", cardId);
    if (error) fail(error, "截图排序保存失败");
  }
}

export async function deleteBoardAttachment(attachment: AttachmentRecord): Promise<void> {
  const client = requireSupabase();
  if (!attachment.objectKey) throw new Error("截图路径无效");
  const { error: storageError } = await client.storage.from(SCREENSHOT_BUCKET).remove([attachment.objectKey]);
  if (storageError) fail(storageError, "截图删除失败");
  const { error: metadataError } = await client.from("attachments").delete().eq("id", attachment.id);
  if (metadataError) fail(metadataError, "截图记录删除失败");
  clearAttachmentUrlCache(attachment.objectKey);
}
