import { applyCardPatch, nextStageSortOrder } from "../../lib/board-model.ts";
import type { AttachmentRecord, CardCreateDetails, CardPatch, CardRecord, IdeaOrganizationResult, Stage } from "../../lib/types.ts";

const timestamp = new Date().toISOString();
const screenshot = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="440" viewBox="0 0 800 440"><rect width="800" height="440" fill="#eef1f5"/><rect x="32" y="28" width="736" height="384" rx="12" fill="white"/><path d="M32 74H768" stroke="#e2e6ec"/><circle cx="55" cy="52" r="5" fill="#a4adbc"/><rect x="71" y="48" width="90" height="7" rx="3" fill="#dde2ea"/><rect x="56" y="98" width="456" height="230" rx="6" fill="#dce5e3"/><path d="M56 250L160 154 260 210 340 150 512 263V328H56Z" fill="#b7c9c4"/><path d="M208 98V328M360 98V328M56 175H512M56 250H512" stroke="white" stroke-opacity=".8" stroke-dasharray="4 5"/><circle cx="397" cy="142" r="23" fill="#f4eee1"/><rect x="536" y="105" width="162" height="9" rx="4" fill="#ced5df"/><rect x="536" y="131" width="128" height="6" rx="3" fill="#e5e9ef"/><rect x="536" y="164" width="184" height="47" rx="6" fill="#f1f4f8"/><rect x="536" y="224" width="184" height="47" rx="6" fill="#f1f4f8"/><rect x="56" y="351" width="310" height="7" rx="3" fill="#dce2e9"/><rect x="56" y="369" width="199" height="6" rx="3" fill="#e8ecf1"/></svg>')}`;

function memo(id: number, title: string, stage: Stage, patch: Partial<CardRecord> = {}): CardRecord {
  return { id, title, stage, criteria: "", result: "", originalText: "", organizedText: "", aiAnalysis: null, aiModel: null, aiPromptVersion: null, aiOrganizedAt: null, originalTextUpdatedAt: null, focus: false, archived: false, reference: false, sortOrder: id, completedAt: stage === "done" ? timestamp : null, previousStage: null, createdAt: timestamp, updatedAt: timestamp, attachments: [], ...patch };
}
function attachment(cardId: number, suffix = "参考"): AttachmentRecord {
  return { id: `${cardId}-${suffix}`, cardId, objectKey: `fixture/${cardId}/${suffix}`, filename: `构图${suffix}.png`, contentType: "image/png", size: 4096, sortOrder: 0, createdAt: timestamp, url: screenshot };
}
let cards = [
  memo(12, "视频分槽工具可以加参考线", "idea", { criteria: "在预览画面叠加三分线，辅助判断构图。", originalText: "剪视频时经常要检查人物的位置，可以在预览里放一个参考线开关。", focus: true, attachments: [attachment(12), attachment(12, "细节")] }),
  memo(13, "让随手记下的灵感更容易回看", "idea", { criteria: "不急着分类，先把零散的念头留住。" }),
  memo(19, "素材和参考放在一起", "idea", { criteria: "开工时直接找到需要的上下文，少翻几个文件夹。" }),
  memo(14, "按照自定义顺序排列备忘", "todo", { criteria: "拖动卡片调整顺序，手机与电脑保持一致。" }),
  memo(15, "文字和截图名称一起搜索", "todo", { criteria: "输入关键词就能找回之前存下的参考。" }),
  memo(16, "打磨手机上的截图查看", "doing", { criteria: "可以全屏查看、左右切换和缩放。", focus: true, attachments: [attachment(16)] }),
  memo(17, "确定采用云端同步", "done", { result: "电脑记录，手机随时回看。" }),
  memo(18, "保存时保留原始文字", "done", { completedAt: new Date(Date.now() - 86400000).toISOString(), result: "原始想法和整理稿分别保留。" }),
];

export async function listBoardCards() { return structuredClone(cards); }
export async function createBoardCard(title: string, stage: Stage, details: CardCreateDetails = {}, sortOrder = nextStageSortOrder(cards, stage)) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const card = memo(Math.max(...cards.map((item) => item.id)) + 1, title, stage, { ...details, sortOrder });
  cards.push(card);
  return structuredClone(card);
}
export async function updateBoardCard(id: number, patch: CardPatch) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const before = cards.find((card) => card.id === id);
  if (!before) throw new Error("示例记录不存在");
  const next = applyCardPatch(before, patch);
  cards = cards.map((card) => card.id === id ? next : card);
  return structuredClone(next);
}
export async function getBoardAttachmentUrl() { return screenshot; }
export function clearAttachmentUrlCache() {}
export function validateBoardAttachment(file: File) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("请选择截图");
}
export async function uploadBoardAttachment(cardId: number, file: File) {
  validateBoardAttachment(file);
  cards = cards.map((card) => card.id === cardId ? { ...card, attachments: [...card.attachments, { ...attachment(cardId, file.name), url: URL.createObjectURL(file) }] } : card);
}
export async function reorderBoardAttachments(cardId: number, ids: string[]) {
  cards = cards.map((card) => card.id === cardId ? { ...card, attachments: ids.map((id) => card.attachments.find((item) => item.id === id)!) } : card);
}
export async function deleteBoardAttachment(target: AttachmentRecord) {
  cards = cards.map((card) => ({ ...card, attachments: card.attachments.filter((item) => item.id !== target.id) }));
}
export async function organizeIdea(originalText: string): Promise<IdeaOrganizationResult> {
  return { suggestedTitle: "整理参考线的交互", organizedText: `保留原始想法：${originalText}`, analysis: { actions: [], times: [], people: [], blockers: [], uncertainties: [], priority: { value: null, certainty: "uncertain", reason: "" } }, meta: { model: "ui-fixture", promptVersion: "test" } };
}
