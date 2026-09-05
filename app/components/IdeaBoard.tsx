"use client";

import {
  Archive,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Cloud,
  CloudOff,
  Download,
  FilePenLine,
  FileText,
  GripVertical,
  Image as ImageIcon,
  LayoutGrid,
  List,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountPanel } from "@/app/components/AccountPanel";
import type { SignOutRequest } from "@/app/components/AccountPanel";
import { AttachmentMedia, ImageViewer } from "@/app/components/AttachmentMedia";
import { IdeaOrganizer } from "@/app/components/IdeaOrganizer";
import type { OrganizerAdoption } from "@/app/components/IdeaOrganizer";
import { applyCardPatch, getDoneBoardSlice, groupArchiveCards, matchesCard, nextStageSortOrder, replaceBoardCard, restoreStage } from "@/lib/board-model";
import {
  AttachmentDeleteError,
  createBoardCard,
  deleteBoardAttachment,
  getBoardAttachmentUrl,
  listBoardCards,
  reconcileBoardAttachments,
  reorderBoardAttachments,
  updateBoardCard,
  uploadBoardAttachment,
  validateBoardAttachment,
} from "@/lib/supabase-board";
import {
  clearCardDraft,
  readBoardCache,
  readCardDraft,
  withTimeout,
  writeBoardCache,
  writeCardDraft,
} from "@/lib/local-state";
import { OperationCoordinator, waitForInitialOutcome } from "@/lib/operation-state";
import type { AuthStorageMode } from "@/lib/supabase-client";
import type { AttachmentRecord, CardCreateDetails, CardDraft, CardPatch, CardRecord, CardSaveResult, Stage, SyncState } from "@/lib/types";
import { useModalFocus } from "@/lib/use-modal-focus";

const STAGE_META: Record<Stage, { label: string; hint: string }> = {
  idea: { label: "构思", hint: "先记下来，不急着做" },
  todo: { label: "待完成", hint: "已经明确，等待开始" },
  doing: { label: "进行中", hint: "保持克制，只推进少量内容" },
  done: { label: "已完成", hint: "结果与经验留档" },
};
const STAGES = Object.keys(STAGE_META) as Stage[];

function activateFromKeyboard(event: React.KeyboardEvent<HTMLElement>, action: () => void) {
  if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
    event.preventDefault();
    action();
  }
}
const LOAD_TIMEOUT = 15_000;
const SAVE_TIMEOUT = 12_000;
const UNDO_DURATION = 6_000;

type View = "board" | "list" | "archive" | "account";
type SelectedCard = CardRecord | "new" | null;
type UndoAction = { cardId: number; title: string; stage: Exclude<Stage, "done"> };
type CardMutation = { version: number; patch: CardPatch; pendingConfirmation: boolean };
type CardMutationChain = { base: CardRecord; operations: Map<number, CardMutation> };
const EDITOR_DRAFT_FIELDS = new Set<keyof CardPatch>([
  "title", "stage", "criteria", "result", "originalText", "organizedText",
  "aiAnalysis", "aiModel", "aiPromptVersion", "aiOrganizedAt",
]);
const CARD_PROJECTION_FIELDS = [
  "title", "stage", "criteria", "result", "originalText", "organizedText",
  "aiAnalysis", "aiModel", "aiPromptVersion", "aiOrganizedAt", "originalTextUpdatedAt",
  "focus", "archived", "reference", "sortOrder", "completedAt", "previousStage",
  "updatedAt", "attachments",
] as const satisfies readonly (keyof CardRecord)[];

function fieldsOwnedByPatch(patch: CardPatch): Set<keyof CardRecord> {
  const fields = new Set<keyof CardRecord>(Object.keys(patch) as (keyof CardPatch)[]);
  fields.add("updatedAt");
  if (patch.stage !== undefined) {
    fields.add("completedAt");
    fields.add("previousStage");
    fields.add("focus");
    fields.add("sortOrder");
  }
  if (patch.archived !== undefined) fields.add("focus");
  if (patch.originalText !== undefined) fields.add("originalTextUpdatedAt");
  return fields;
}

function nextStage(stage: Stage): Stage | null {
  const index = STAGES.indexOf(stage);
  return index < STAGES.length - 1 ? STAGES[index + 1] : null;
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

function syncLabel(state: SyncState): { label: string; icon: React.ReactNode } {
  if (state === "syncing") return { label: "同步中", icon: <RefreshCw size={13} className="spin" /> };
  if (state === "checking") return { label: "正在核对", icon: <RefreshCw size={13} className="spin" /> };
  if (state === "offline") return { label: "离线", icon: <CloudOff size={13} /> };
  if (state === "error") return { label: "同步失败", icon: <CircleAlert size={13} /> };
  if (state === "draft") return { label: "本机草稿", icon: <FilePenLine size={13} /> };
  return { label: "已同步", icon: <Cloud size={13} /> };
}

export function IdeaBoard({ userId, displayName, authMode, isIdentityActive, onUpdatePassword, onSignOut }: {
  userId: string;
  displayName: string;
  authMode: AuthStorageMode;
  isIdentityActive: () => boolean;
  onUpdatePassword: (password: string) => Promise<void>;
  onSignOut: (request: SignOutRequest) => Promise<void>;
}) {
  const [initialComposerDraft] = useState(() => readCardDraft(userId, "composer"));
  const [cards, setCards] = useState<CardRecord[]>(() => readBoardCache(userId));
  const [view, setView] = useState<View>("board");
  const [mobileStage, setMobileStage] = useState<Stage>("idea");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SelectedCard>(null);
  const [viewer, setViewer] = useState<{ attachments: AttachmentRecord[]; index: number } | null>(null);
  const [loading, setLoading] = useState(() => readBoardCache(userId).length === 0);
  const [activeOperations, setActiveOperations] = useState(0);
  const [operationCoordinator] = useState(() => new OperationCoordinator(setActiveOperations));
  const [syncState, setSyncState] = useState<SyncState>(() => navigator.onLine ? "syncing" : "offline");
  const [error, setError] = useState("");
  const [composer, setComposer] = useState(() => initialComposerDraft?.title ?? "");
  const [composerRequestId, setComposerRequestId] = useState(() => initialComposerDraft?.clientRequestId ?? crypto.randomUUID());
  const [editorDraftPresent, setEditorDraftPresent] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const cardsRef = useRef(cards);
  const mutationChainsRef = useRef(new Map<number, CardMutationChain>());
  const mutationQueuesRef = useRef(new Map<number, Promise<void>>());
  const localProjectionRevisionRef = useRef(0);
  const localFieldRevisionsRef = useRef(new Map<number, Map<keyof CardRecord, number>>());
  const attachmentDeletionRevisionsRef = useRef(new Map<number, Map<string, number>>());
  const loadGenerationRef = useRef(0);
  const identityActiveRef = useRef(isIdentityActive);
  useEffect(() => { identityActiveRef.current = isIdentityActive; }, [isIdentityActive]);
  const activeIdentity = useCallback(() => identityActiveRef.current(), []);
  const saving = activeOperations > 0;
  const beginOperation = useCallback(() => operationCoordinator.beginOperation(), [operationCoordinator]);

  const commitCards = useCallback((next: CardRecord[]) => {
    if (!activeIdentity()) return;
    cardsRef.current = next;
    setCards(next);
    writeBoardCache(userId, next);
  }, [activeIdentity, userId]);

  const markLocalFields = useCallback((cardId: number, fields: Iterable<keyof CardRecord>) => {
    const revision = localProjectionRevisionRef.current + 1;
    localProjectionRevisionRef.current = revision;
    const revisions = localFieldRevisionsRef.current.get(cardId) ?? new Map<keyof CardRecord, number>();
    for (const field of fields) revisions.set(field, revision);
    localFieldRevisionsRef.current.set(cardId, revisions);
  }, []);

  const markAttachmentDeleted = useCallback((cardId: number, attachmentId: string) => {
    const revision = localProjectionRevisionRef.current + 1;
    localProjectionRevisionRef.current = revision;
    const revisions = attachmentDeletionRevisionsRef.current.get(cardId) ?? new Map<string, number>();
    revisions.set(attachmentId, revision);
    attachmentDeletionRevisionsRef.current.set(cardId, revisions);
  }, []);

  const commitCard = useCallback((
    card: CardRecord,
    updateSelection = true,
    localFields: Iterable<keyof CardRecord> = CARD_PROJECTION_FIELDS,
  ) => {
    markLocalFields(card.id, localFields);
    commitCards(replaceBoardCard(cardsRef.current, card));
    if (updateSelection) {
      setSelected((current) => current && current !== "new" && current.id === card.id ? card : current);
    }
  }, [commitCards, markLocalFields]);

  const projectMutationChain = useCallback((chain: CardMutationChain): CardRecord => {
    const operations = [...chain.operations.values()].sort((left, right) => left.version - right.version);
    const projected = operations.reduce(
      (current, operation) => applyCardPatch(current, operation.patch),
      chain.base,
    );
    return {
      ...projected,
      mutationVersion: operations.at(-1)?.version,
      pendingConfirmation: operations.some((operation) => operation.pendingConfirmation),
    };
  }, []);

  const settleCardMutation = useCallback((
    cardId: number,
    version: number,
    outcome: { state: "confirmed"; card: CardRecord } | { state: "failed" },
  ): { card: CardRecord; remaining: CardMutation[] } | null => {
    const chain = mutationChainsRef.current.get(cardId);
    if (!chain?.operations.has(version)) return null;
    if (outcome.state === "confirmed") {
      const attachments = cardsRef.current.find((card) => card.id === cardId)?.attachments
        ?? chain.base.attachments;
      const confirmedOperations = [...chain.operations.values()]
        .filter((operation) => operation.version <= version);
      const confirmedFields: Partial<CardRecord> = {};
      for (const operation of confirmedOperations) {
        for (const field of Object.keys(operation.patch) as (keyof CardPatch)[]) {
          Object.assign(confirmedFields, { [field]: outcome.card[field] });
        }
      }
      const ownsStage = confirmedOperations.some((operation) => operation.patch.stage !== undefined);
      const ownsOriginalText = confirmedOperations.some((operation) => operation.patch.originalText !== undefined);
      const ownsArchive = confirmedOperations.some((operation) => operation.patch.archived !== undefined);
      chain.base = {
        ...chain.base,
        ...confirmedFields,
        attachments,
        updatedAt: outcome.card.updatedAt,
        completedAt: ownsStage ? outcome.card.completedAt : chain.base.completedAt,
        previousStage: ownsStage ? outcome.card.previousStage : chain.base.previousStage,
        originalTextUpdatedAt: ownsOriginalText
          ? outcome.card.originalTextUpdatedAt
          : chain.base.originalTextUpdatedAt,
        focus: ownsStage || ownsArchive ? outcome.card.focus : (confirmedFields.focus ?? chain.base.focus),
        mutationVersion: version,
        pendingConfirmation: false,
      };
      for (const operationVersion of chain.operations.keys()) {
        if (operationVersion <= version) chain.operations.delete(operationVersion);
      }
    } else {
      chain.operations.delete(version);
    }
    const remaining = [...chain.operations.values()];
    if (!remaining.length) {
      mutationChainsRef.current.delete(cardId);
      return {
        card: { ...chain.base, mutationVersion: version, pendingConfirmation: false },
        remaining,
      };
    }
    return { card: projectMutationChain(chain), remaining };
  }, [projectMutationChain]);

  const load = useCallback(async () => {
    const lifecycle = operationCoordinator.lifecycleId;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    const localRevision = localProjectionRevisionRef.current;
    const isCurrentLoad = () => activeIdentity()
      && operationCoordinator.isActiveLifecycle(lifecycle)
      && loadGenerationRef.current === generation;
    if (!isCurrentLoad()) return cardsRef.current;
    if (!navigator.onLine) {
      const cached = readBoardCache(userId);
      if (cached.length) commitCards(cached);
      setSyncState("offline");
      setLoading(false);
      return cached;
    }
    setSyncState("syncing");
    try {
      try {
        await reconcileBoardAttachments();
      } catch (reason) {
        // Ready rows are still safe to load; stale operations stay hidden and
        // will be retried on the next synchronization.
        console.warn("未完成的截图操作暂未恢复，将在下次同步重试。", reason);
      }
      const data = await withTimeout(listBoardCards(), LOAD_TIMEOUT, "同步超时，请检查网络后重试");
      if (!isCurrentLoad()) return cardsRef.current;
      const currentById = new Map(cardsRef.current.map((card) => [card.id, card]));
      const changedAfterLoad = (cardId: number, field?: keyof CardRecord) => {
        const revisions = localFieldRevisionsRef.current.get(cardId);
        if (field) return (revisions?.get(field) ?? 0) > localRevision;
        return [...(revisions?.values() ?? [])].some((revision) => revision > localRevision);
      };
      const mergeLocalChanges = (serverCard: CardRecord): CardRecord => {
        const current = currentById.get(serverCard.id);
        if (!current) return serverCard;
        const merged = { ...serverCard };
        for (const field of CARD_PROJECTION_FIELDS) {
          if (changedAfterLoad(serverCard.id, field)) {
            Object.assign(merged, { [field]: current[field] });
          }
        }
        const deletedAttachments = attachmentDeletionRevisionsRef.current.get(serverCard.id);
        merged.attachments = merged.attachments.filter((attachment) => (
          (deletedAttachments?.get(attachment.id) ?? 0) <= localRevision
        ));
        return merged;
      };
      const serverIds = new Set(data.map((card) => card.id));
      const next = data.map((card) => {
        const merged = mergeLocalChanges(card);
        const chain = mutationChainsRef.current.get(card.id);
        if (!chain?.operations.size) return merged;
        // A pending card mutation owns only its patch fields. Attachments and
        // unrelated fields continue to come from the latest server projection.
        chain.base = { ...merged, mutationVersion: undefined, pendingConfirmation: false };
        return projectMutationChain(chain);
      });
      for (const [cardId, chain] of mutationChainsRef.current) {
        if (!serverIds.has(cardId) && chain.operations.size) next.push(projectMutationChain(chain));
      }
      for (const current of currentById.values()) {
        if (!serverIds.has(current.id)
          && !mutationChainsRef.current.get(current.id)?.operations.size
          && changedAfterLoad(current.id)) {
          next.push(current);
        }
      }
      commitCards(next);
      setSelected((current) => {
        if (!current || current === "new") return current;
        const nextCard = next.find((card) => card.id === current.id);
        if (!nextCard) return null;
        const chain = mutationChainsRef.current.get(current.id);
        if (!chain) return nextCard;
        const selectedCard = { ...nextCard };
        const draftFields = new Set([...chain.operations.values()]
          .flatMap((operation) => Object.keys(operation.patch) as (keyof CardPatch)[])
          .filter((field) => EDITOR_DRAFT_FIELDS.has(field)));
        for (const field of draftFields) {
          Object.assign(selectedCard, { [field]: current[field] });
        }
        return selectedCard;
      });
      setError("");
      setSyncState(next.some((card) => card.pendingConfirmation) ? "checking" : "synced");
      return next;
    } catch (reason) {
      if (!isCurrentLoad()) return cardsRef.current;
      const message = reason instanceof Error ? reason.message : "加载失败";
      const cached = readBoardCache(userId);
      if (cached.length) commitCards(cached);
      setError(cached.length ? `${message}，正在显示最近一次同步内容。` : message);
      setSyncState(navigator.onLine ? "error" : "offline");
      return cached;
    } finally {
      if (isCurrentLoad()) setLoading(false);
    }
  }, [activeIdentity, commitCards, operationCoordinator, projectMutationChain, userId]);

  useEffect(() => {
    const lifecycle = operationCoordinator.activate();
    const mutationChains = mutationChainsRef.current;
    const mutationQueues = mutationQueuesRef.current;
    const localFieldRevisions = localFieldRevisionsRef.current;
    const attachmentDeletionRevisions = attachmentDeletionRevisionsRef.current;
    return () => {
      operationCoordinator.dispose(lifecycle);
      mutationChains.clear();
      mutationQueues.clear();
      localFieldRevisions.clear();
      attachmentDeletionRevisions.clear();
    };
  }, [operationCoordinator]);
  useEffect(() => {
    // Initial cloud synchronization is intentionally owned by the board shell.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useEffect(() => {
    const online = () => { void load(); };
    const offline = () => setSyncState("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
  }, [load]);
  useEffect(() => {
    if (!activeIdentity()) return;
    if (composer.trim()) writeCardDraft(userId, "composer", {
      title: composer,
      criteria: "",
      result: "",
      originalText: "",
      organizedText: "",
      aiAnalysis: null,
      aiModel: null,
      aiPromptVersion: null,
      aiOrganizedAt: null,
      stage: "idea",
      clientRequestId: composerRequestId,
    });
    else clearCardDraft(userId, "composer");
  }, [activeIdentity, composer, composerRequestId, userId]);
  useEffect(() => {
    if (!undoAction) return;
    const timer = setTimeout(() => setUndoAction(null), UNDO_DURATION);
    return () => clearTimeout(timer);
  }, [undoAction]);
  useEffect(() => {
    if (!selected && !viewer) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [selected, viewer]);

  const mutate = useCallback(async (
    id: number,
    patch: CardPatch,
    clearDraftOnConfirm = false,
  ): Promise<CardSaveResult> => {
    const before = cardsRef.current.find((card) => card.id === id);
    if (!before) throw new Error("记录不存在，请刷新后重试");
    const effectivePatch = patch.stage !== undefined && patch.stage !== before.stage && patch.sortOrder === undefined
      ? { ...patch, sortOrder: nextStageSortOrder(cardsRef.current, patch.stage) }
      : patch;
    const lifecycle = operationCoordinator.lifecycleId;
    const operationActive = () => activeIdentity() && operationCoordinator.isActiveLifecycle(lifecycle);
    if (!operationActive()) throw new Error("登录状态已失效");
    const mutationVersion = operationCoordinator.nextMutationVersion(id);
    let chain = mutationChainsRef.current.get(id);
    if (!chain) {
      chain = {
        base: { ...before, mutationVersion: undefined, pendingConfirmation: false },
        operations: new Map(),
      };
      mutationChainsRef.current.set(id, chain);
    }
    chain.operations.set(mutationVersion, {
      version: mutationVersion,
      patch: effectivePatch,
      pendingConfirmation: false,
    });
    const optimistic = projectMutationChain(chain);
    const localFields = fieldsOwnedByPatch(effectivePatch);
    // Keep the editor's original card prop until the server confirms the write.
    // This prevents its local draft from being cleared during an in-flight save.
    commitCard(optimistic, false, localFields);
    const finishOperation = beginOperation();
    let finishesInBackground = false;
    let releaseQueue: (() => void) | undefined;
    setSyncState(navigator.onLine ? "syncing" : "offline");
    try {
      if (!navigator.onLine) throw new Error("当前处于离线状态，联网后再保存");
      // Mutation versions are meaningful only when the database sees the same
      // order. Keep optimistic rendering concurrent, but serialize delivery per card.
      const previous = mutationQueuesRef.current.get(id) ?? Promise.resolve();
      const queueTail = new Promise<void>((resolve) => { releaseQueue = resolve; });
      mutationQueuesRef.current.set(id, queueTail);
      const completion = previous.then(() => {
        if (!operationActive()) {
          throw new Error("保存已因页面切换取消");
        }
        const knownCard = mutationChainsRef.current.get(id)?.base
          ?? cardsRef.current.find((card) => card.id === id);
        if (!knownCard) throw new Error("记录不存在，请刷新后重试");
        return updateBoardCard(id, effectivePatch, knownCard);
      });
      void queueTail.then(() => {
        if (mutationQueuesRef.current.get(id) === queueTail) mutationQueuesRef.current.delete(id);
      });
      const initial = await waitForInitialOutcome(completion, SAVE_TIMEOUT);
      if (initial.state === "pending") {
        const pendingOperation = mutationChainsRef.current.get(id)?.operations.get(mutationVersion);
        if (pendingOperation) pendingOperation.pendingConfirmation = true;
        const pendingChain = mutationChainsRef.current.get(id);
        const pendingCard = pendingChain ? projectMutationChain(pendingChain) : optimistic;
        if (operationActive() && pendingOperation) {
          commitCard(pendingCard, false, localFields);
          setError("保存结果待核对，内容和本机草稿已保留；不会自动重复提交。");
          setSyncState("checking");
        }
        finishesInBackground = true;
        void completion.then((card) => {
          if (!operationActive()) return;
          const settled = settleCardMutation(id, mutationVersion, { state: "confirmed", card });
          if (!settled) return;
          commitCard(settled.card, settled.remaining.length === 0, localFields);
          if (clearDraftOnConfirm) clearCardDraft(userId, id);
          if (!settled.remaining.length) setError("");
          setSyncState(settled.remaining.some((operation) => operation.pendingConfirmation)
            ? "checking"
            : settled.remaining.length ? "syncing" : "synced");
          if (before.stage !== "done" && patch.stage === "done") {
            setUndoAction({ cardId: id, title: before.title, stage: before.stage });
          }
        }, (reason: unknown) => {
          if (!operationActive()) return;
          const settled = settleCardMutation(id, mutationVersion, { state: "failed" });
          if (!settled) return;
          commitCard(settled.card, settled.remaining.length === 0, localFields);
          setError(reason instanceof Error ? reason.message : "保存失败");
          setSyncState(settled.remaining.some((operation) => operation.pendingConfirmation)
            ? "checking"
            : settled.remaining.length ? "syncing" : navigator.onLine ? "error" : "offline");
        }).finally(() => {
          releaseQueue?.();
          finishOperation();
        });
        return { card: pendingCard, state: "pending" };
      }
      const lifecycleActive = operationActive();
      const settled = lifecycleActive
        ? settleCardMutation(id, mutationVersion, { state: "confirmed", card: initial.value })
        : null;
      if (settled) {
        commitCard(settled.card, settled.remaining.length === 0, localFields);
        if (clearDraftOnConfirm) clearCardDraft(userId, id);
        if (!settled.remaining.length) setError("");
        setSyncState(settled.remaining.some((operation) => operation.pendingConfirmation)
          ? "checking"
          : settled.remaining.length ? "syncing" : "synced");
        if (before.stage !== "done" && patch.stage === "done") {
          setUndoAction({ cardId: id, title: before.title, stage: before.stage });
        }
      }
      return {
        card: settled?.card ?? initial.value,
        state: lifecycleActive && settled ? "confirmed" : "pending",
      };
    } catch (reason) {
      const settled = operationActive()
        ? settleCardMutation(id, mutationVersion, { state: "failed" })
        : null;
      if (settled) {
        commitCard(settled.card, settled.remaining.length === 0, localFields);
        setError(reason instanceof Error ? reason.message : "保存失败");
        setSyncState(settled.remaining.some((operation) => operation.pendingConfirmation)
          ? "checking"
          : settled.remaining.length ? "syncing" : navigator.onLine ? "error" : "offline");
      }
      throw reason;
    } finally {
      if (!finishesInBackground) {
        releaseQueue?.();
        finishOperation();
      }
    }
  }, [activeIdentity, beginOperation, commitCard, operationCoordinator, projectMutationChain, settleCardMutation, userId]);

  const uploadFiles = useCallback(async (cardId: number, files: File[]) => {
    const lifecycle = operationCoordinator.lifecycleId;
    const operationActive = () => activeIdentity() && operationCoordinator.isActiveLifecycle(lifecycle);
    if (!operationActive()) return files;
    const failed: File[] = [];
    const messages: string[] = [];
    const finishOperation = beginOperation();
    setSyncState(navigator.onLine ? "syncing" : "offline");
    try {
      if (!navigator.onLine) {
        setError("当前处于离线状态，联网后再上传截图");
        return files;
      }
      for (const file of files) {
        try {
          await uploadBoardAttachment(cardId, file);
          if (!operationActive()) return files;
        } catch (reason) {
          if (!operationActive()) return files;
          failed.push(file);
          messages.push(`${file.name}：${reason instanceof Error ? reason.message : "上传失败"}`);
        }
      }
      await load();
      if (operationActive() && messages.length) {
        setError(`部分截图未上传：${messages.join("；")}`);
        setSyncState("error");
      }
      return failed;
    } finally {
      finishOperation();
    }
  }, [activeIdentity, beginOperation, load, operationCoordinator]);

  const create = useCallback(async (
    title: string,
    stage: Stage = "idea",
    files: File[] = [],
    details: CardCreateDetails = {},
    clientRequestId: string,
  ) => {
    const clean = title.trim();
    if (!clean && !details.originalText?.trim()) return undefined;
    let createdCard: CardRecord | undefined;
    const lifecycle = operationCoordinator.lifecycleId;
    const operationActive = () => activeIdentity() && operationCoordinator.isActiveLifecycle(lifecycle);
    if (!operationActive()) return undefined;
    const finishOperation = beginOperation();
    setSyncState(navigator.onLine ? "syncing" : "offline");
    try {
      if (!navigator.onLine) throw new Error("当前处于离线状态，联网后再创建");
      files.forEach(validateBoardAttachment);
      // Creation is intentionally not force-timed-out: an insert can still finish after a
      // client timeout, and an automatic retry could otherwise create a duplicate memo.
      createdCard = await createBoardCard(clean, stage, details, clientRequestId, nextStageSortOrder(cardsRef.current, stage));
      if (!operationActive()) return undefined;
      const failed: string[] = [];
      for (const file of files) {
        try {
          await uploadBoardAttachment(createdCard.id, file);
          if (!operationActive()) return undefined;
        }
        catch (reason) {
          if (!operationActive()) return undefined;
          failed.push(`${file.name}：${reason instanceof Error ? reason.message : "上传失败"}`);
        }
      }
      if (files.length) {
        const data = await load();
        createdCard = data.find((item) => item.id === createdCard?.id) ?? createdCard;
      } else {
        commitCard(createdCard);
        setSyncState("synced");
      }
      if (!operationActive()) return undefined;
      if (failed.length) setError(`构思已保存，部分截图未上传：${failed.join("；")}`);
      return createdCard;
    } catch (reason) {
      if (!operationActive()) return undefined;
      setError(reason instanceof Error ? reason.message : "创建失败");
      setSyncState(navigator.onLine ? "error" : "offline");
      if (createdCard) commitCard(createdCard);
      return undefined;
    } finally {
      finishOperation();
    }
  }, [activeIdentity, beginOperation, commitCard, load, operationCoordinator]);

  const createFromComposer = useCallback(async () => {
    const created = await create(composer, "idea", [], {}, composerRequestId);
    if (created && activeIdentity()) {
      setComposer("");
      clearCardDraft(userId, "composer");
      setComposerRequestId(crypto.randomUUID());
    }
  }, [activeIdentity, composer, composerRequestId, create, userId]);

  const hideAttachmentProjection = useCallback((attachmentId: string) => {
    const hide = (card: CardRecord): CardRecord => ({
      ...card,
      attachments: card.attachments.filter((item) => item.id !== attachmentId),
    });
    for (const card of cardsRef.current) {
      if (card.attachments.some((item) => item.id === attachmentId)) markAttachmentDeleted(card.id, attachmentId);
    }
    commitCards(cardsRef.current.map(hide));
    setSelected((current) => current && current !== "new" ? hide(current) : current);
    setViewer((current) => {
      if (!current?.attachments.some((item) => item.id === attachmentId)) return current;
      const attachments = current.attachments.filter((item) => item.id !== attachmentId);
      return attachments.length ? { attachments, index: Math.min(current.index, attachments.length - 1) } : null;
    });
  }, [commitCards, markAttachmentDeleted]);

  const removeAttachment = useCallback(async (attachment: AttachmentRecord) => {
    const lifecycle = operationCoordinator.lifecycleId;
    const operationActive = () => activeIdentity() && operationCoordinator.isActiveLifecycle(lifecycle);
    if (!operationActive()) return;
    const finishOperation = beginOperation();
    setSyncState(navigator.onLine ? "syncing" : "offline");
    try {
      if (!navigator.onLine) throw new Error("当前处于离线状态，联网后再删除截图");
      await deleteBoardAttachment(attachment);
      if (!operationActive()) return;
      hideAttachmentProjection(attachment.id);
      await load();
    }
    catch (reason) {
      if (!operationActive()) return;
      const message = reason instanceof Error ? reason.message : "截图删除失败";
      if (reason instanceof AttachmentDeleteError && reason.projection === "hidden") {
        hideAttachmentProjection(attachment.id);
      }
      if (navigator.onLine) await load();
      if (!operationActive()) return;
      // load() clears its own notice on success, so restore the mutation error last.
      setError(message);
      setSyncState(navigator.onLine ? "error" : "offline");
    }
    finally { finishOperation(); }
  }, [activeIdentity, beginOperation, hideAttachmentProjection, load, operationCoordinator]);

  const reorderAttachments = useCallback(async (cardId: number, ids: string[]) => {
    const lifecycle = operationCoordinator.lifecycleId;
    const operationActive = () => activeIdentity() && operationCoordinator.isActiveLifecycle(lifecycle);
    if (!operationActive()) return;
    const finishOperation = beginOperation();
    setSyncState(navigator.onLine ? "syncing" : "offline");
    try { if (!navigator.onLine) throw new Error("当前处于离线状态，联网后再调整截图"); await reorderBoardAttachments(cardId, ids); if (!operationActive()) return; await load(); }
    catch (reason) { if (operationActive()) { setError(reason instanceof Error ? reason.message : "截图排序失败"); setSyncState(navigator.onLine ? "error" : "offline"); } }
    finally { finishOperation(); }
  }, [activeIdentity, beginOperation, load, operationCoordinator]);

  const restore = useCallback(async (card: CardRecord) => {
    try { await mutate(card.id, { stage: restoreStage(card), archived: false }); }
    catch { /* The board notice already explains the failed restore. */ }
  }, [mutate]);

  const undoCompletion = useCallback(async () => {
    if (!undoAction) return;
    const action = undoAction;
    setUndoAction(null);
    try { await mutate(action.cardId, { stage: action.stage, archived: false }); }
    catch { /* Keep the cloud error visible without creating an unhandled rejection. */ }
  }, [mutate, undoAction]);

  const searchedCards = useMemo(() => cards.filter((card) => matchesCard(card, query)), [cards, query]);
  const activeCards = useMemo(() => searchedCards.filter((card) => !card.archived), [searchedCards]);
  const listCards = useMemo(() => activeCards.filter((card) => card.stage !== "done"), [activeCards]);
  const archiveGroups = useMemo(() => groupArchiveCards(searchedCards), [searchedCards]);
  const focusCards = cards.filter((card) => card.focus && card.stage !== "done" && !card.archived);
  const hasPendingConfirmation = cards.some((card) => card.pendingConfirmation);
  const effectiveSyncState: SyncState = hasPendingConfirmation
    ? "checking"
    : activeOperations > 0 && navigator.onLine
      ? "syncing"
      : syncState === "synced" && (composer.trim() || editorDraftPresent)
        ? "draft"
        : syncState;
  const sync = syncLabel(effectiveSyncState);
  const visibleDoneCount = getDoneBoardSlice(cards).cards.length;

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Sparkles size={16} /></span><span>云端构思板</span></div>
      <nav className="desktop-nav" aria-label="主导航">
        <NavButton active={view === "board"} onClick={() => setView("board")} icon={<LayoutGrid size={16} />}>看板</NavButton>
        <NavButton active={view === "list"} onClick={() => setView("list")} icon={<List size={16} />}>清单</NavButton>
        <NavButton active={view === "archive"} onClick={() => setView("archive")} icon={<Archive size={16} />}>档案库</NavButton>
        <NavButton active={view === "account"} onClick={() => setView("account")} icon={<UserRound size={16} />}>账号</NavButton>
      </nav>
      <div className={`account sync-${effectiveSyncState}`}><button type="button" className="sync-status" onClick={() => { if (effectiveSyncState === "error" || effectiveSyncState === "checking") void load(); }} disabled={effectiveSyncState !== "error" && effectiveSyncState !== "checking"}>{sync.icon}{sync.label}</button><button type="button" className="avatar" onClick={() => setView("account")} aria-label="打开个人账号">{(displayName || "我").slice(0, 1)}</button><button className="signout desktop-only" onClick={() => setView("account")}>账号</button><button className="mobile-menu-button" onClick={() => setMobileMenu((value) => !value)} aria-label="打开导航" aria-expanded={mobileMenu} aria-controls="mobile-main-menu"><Menu size={17} /></button></div>
      {mobileMenu && <nav id="mobile-main-menu" className="mobile-menu" aria-label="移动端主导航"><button aria-current={view === "board" ? "page" : undefined} onClick={() => { setView("board"); setMobileMenu(false); }}><LayoutGrid size={15} />看板</button><button aria-current={view === "list" ? "page" : undefined} onClick={() => { setView("list"); setMobileMenu(false); }}><List size={15} />清单</button><button aria-current={view === "archive" ? "page" : undefined} onClick={() => { setView("archive"); setMobileMenu(false); }}><Archive size={15} />档案库</button><button aria-current={view === "account" ? "page" : undefined} onClick={() => { setView("account"); setMobileMenu(false); }}><UserRound size={15} />账号</button></nav>}
    </header>

    {view === "board" && <div className="mobile-tabs" aria-label="阶段筛选">
      {STAGES.map((stage) => <button type="button" aria-pressed={mobileStage === stage} className={mobileStage === stage ? "active" : ""} key={stage} onClick={() => setMobileStage(stage)}><span className={`stage-dot ${stage}`} />{STAGE_META[stage].label}<b>{stage === "done" ? visibleDoneCount : cards.filter((card) => card.stage === stage && !card.archived).length}</b></button>)}
    </div>}

    {view === "account" ? <section className="workspace account-workspace"><AccountPanel email={displayName} authMode={authMode} onUpdatePassword={onUpdatePassword} onSignOut={onSignOut} /></section> : <section className="workspace">
      <div className="heading-row"><div><p className="eyebrow">PERSONAL MEMO BOARD</p><h1>{view === "archive" ? "完成与档案" : view === "list" ? "待处理清单" : "我的构思"}</h1><p>{view === "archive" ? "完成的内容按时间自然沉淀，也可以随时恢复。" : "记录、处理、完成，再从结果里回看。"}</p></div><button className="primary desktop-only" onClick={() => setSelected("new")}><Plus size={17} />记一个构思</button></div>
      {view !== "archive" && <FocusStrip cards={focusCards} onOpen={setSelected} />}
      <div className="toolbar"><label className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文字、编号或截图名称" /></label><span className="result-count">{view === "archive" ? archiveGroups.reduce((count, group) => count + group.cards.length, 0) : view === "list" ? listCards.length : activeCards.length} 条记录</span></div>
      {error && <div className="notice" role="alert"><CircleAlert size={16} /><span>{error}</span>{(syncState === "error" || effectiveSyncState === "checking") && <button className="notice-retry" onClick={() => void load()}><RefreshCw size={14} />{effectiveSyncState === "checking" ? "重新核对" : "重试"}</button>}<button onClick={() => setError("")} aria-label="关闭"><X size={15} /></button></div>}
      {loading ? <LoadingState /> : view === "board" ? <Board cards={activeCards} mobileStage={mobileStage} onOpen={setSelected} onMove={(card, stage) => { void mutate(card.id, { stage }).catch(() => undefined); }} onOpenImage={(card, index) => setViewer({ attachments: card.attachments, index })} onOpenArchive={() => setView("archive")} /> : view === "archive" ? <ArchiveView groups={archiveGroups} onOpen={setSelected} onRestore={(card) => void restore(card)} onOpenImage={(card, index) => setViewer({ attachments: card.attachments, index })} /> : <ListView cards={listCards} onOpen={setSelected} />}
    </section>}

    {view !== "account" && <form className="mobile-composer" onSubmit={(event) => { event.preventDefault(); void createFromComposer(); }}><input value={composer} onChange={(event) => { const next = event.target.value; if (composer.trim() && !next.trim()) setComposerRequestId(crypto.randomUUID()); setComposer(next); }} placeholder="记录一个新构思…" maxLength={240} /><button disabled={saving || !composer.trim()} aria-label="添加构思"><ArrowRight size={19} /></button></form>}
    {undoAction && <div className="undo-toast" role="status"><Check size={16} /><span>“{undoAction.title}”已完成</span><button onClick={() => void undoCompletion()}><RotateCcw size={14} />撤销</button></div>}
    {selected && <Editor key={selected === "new" ? "new" : selected.id} userId={userId} card={selected === "new" ? null : selected} saving={saving} obscured={Boolean(viewer)} isIdentityActive={activeIdentity} onClose={() => setSelected(null)} onCreate={create} onSave={mutate} onUploadFiles={uploadFiles} onReorder={reorderAttachments} onDeleteAttachment={removeAttachment} onViewImage={(attachments, index) => setViewer({ attachments, index })} onDraftStateChange={setEditorDraftPresent} />}
    {viewer && <ImageViewer attachments={viewer.attachments} initialIndex={viewer.index} onClose={() => setViewer(null)} />}
  </main>;
}

function NavButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return <button className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={onClick}>{icon}{children}</button>;
}

function FocusStrip({ cards, onOpen }: { cards: CardRecord[]; onOpen: (card: CardRecord) => void }) {
  return <section className="focus-strip"><div className="focus-label"><Star size={15} fill="currentColor" /><span>今日焦点</span><small>{cards.length}/3</small></div><div className="focus-items">{cards.length ? cards.map((card) => <button id={`focus-card-opener-${card.id}`} key={card.id} onClick={() => onOpen(card)}><span>#{String(card.id).padStart(4, "0")}</span>{card.title}<ChevronRight size={14} /></button>) : <p>把最重要的事放在这里，今天会更清楚。</p>}</div></section>;
}

function Board({ cards, mobileStage, onOpen, onMove, onOpenImage, onOpenArchive }: { cards: CardRecord[]; mobileStage: Stage; onOpen: (card: CardRecord) => void; onMove: (card: CardRecord, stage: Stage) => void; onOpenImage: (card: CardRecord, index: number) => void; onOpenArchive: () => void }) {
  const doneSlice = getDoneBoardSlice(cards);
  const cardsForStage = (stage: Stage) => stage === "done" ? doneSlice.cards : cards.filter((card) => card.stage === stage);
  return <>
    <div className="board desktop-board">{STAGES.map((stage) => {
      const stageCards = cardsForStage(stage);
      return <section className={`column column-${stage}`} key={stage} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const card = cards.find((item) => item.id === Number(event.dataTransfer.getData("card-id"))); if (card && card.stage !== stage) onMove(card, stage); }}><ColumnHeader stage={stage} count={stageCards.length} doneMode={doneSlice.mode} /><div className="column-body">{stageCards.map((card) => <TaskCard key={card.id} surface="desktop" card={card} onOpen={onOpen} onOpenImage={onOpenImage} />)}{stage === "done" && doneSlice.hiddenCount > 0 && <CompletedOverflow count={doneSlice.hiddenCount} onOpen={onOpenArchive} />}{!stageCards.length && <div className="empty-column">暂时没有记录</div>}</div></section>;
    })}</div>
    <section className={`mobile-board-panel column-${mobileStage}`}><ColumnHeader stage={mobileStage} count={cardsForStage(mobileStage).length} doneMode={doneSlice.mode} /><div className="mobile-card-list">{cardsForStage(mobileStage).map((card) => <TaskCard key={card.id} surface="mobile" card={card} onOpen={onOpen} onOpenImage={onOpenImage} />)}{mobileStage === "done" && doneSlice.hiddenCount > 0 && <CompletedOverflow count={doneSlice.hiddenCount} onOpen={onOpenArchive} />}{!cardsForStage(mobileStage).length && <div className="empty-column">暂时没有记录</div>}</div></section>
  </>;
}

function ColumnHeader({ stage, count, doneMode }: { stage: Stage; count: number; doneMode: "today" | "recent" }) {
  return <header className="column-header"><div><span className={`stage-dot ${stage}`} /><h2>{STAGE_META[stage].label}</h2><b>{count}</b></div><p>{stage === "done" ? doneMode === "today" ? "今天完成，最多展示 3 条" : "最近完成的 3 条记录" : STAGE_META[stage].hint}</p></header>;
}

function CompletedOverflow({ count, onOpen }: { count: number; onOpen: () => void }) {
  return <button className="completed-overflow" onClick={onOpen}><Archive size={14} /><span>其余 {count} 条在完成与档案</span><ChevronRight size={14} /></button>;
}

function TaskCard({ card, surface, onOpen, onOpenImage }: { card: CardRecord; surface: "desktop" | "mobile"; onOpen: (card: CardRecord) => void; onOpenImage: (card: CardRecord, index: number) => void }) {
  const cover = card.attachments[0];
  return <article className="task-card" draggable onDragStart={(event) => event.dataTransfer.setData("card-id", String(card.id))}>
    <button id={`card-opener-${surface}-${card.id}`} data-modal-focus-id={`card-${card.id}`} type="button" className="task-card-main" onClick={() => onOpen(card)}><div className="card-meta"><span>#{String(card.id).padStart(4, "0")}</span><span>{card.pendingConfirmation ? "待核对" : shortDate(card.completedAt ?? card.updatedAt)}</span></div><h3>{card.title}</h3>{(card.organizedText || card.criteria) && <p className="card-note">{card.organizedText || card.criteria}</p>}</button>
    {cover && <div id={`attachment-opener-${surface}-${cover.id}`} data-modal-focus-id={`attachment-${cover.id}`} role="button" tabIndex={0} className="card-image-button" onClick={() => onOpenImage(card, 0)} onKeyDown={(event) => activateFromKeyboard(event, () => onOpenImage(card, 0))} aria-label={`查看 ${cover.filename}`}><AttachmentMedia key={cover.id} attachment={cover} className="card-image" allowRetry={false} />{card.attachments.length > 1 && <span className="image-count">+{card.attachments.length - 1}</span>}</div>}
    <footer><div>{card.focus && <span className="tag focus"><Star size={12} fill="currentColor" />焦点</span>}{card.attachments.length > 0 && <span className="tag"><ImageIcon size={12} />{card.attachments.length}</span>}</div><button id={`card-more-${surface}-${card.id}`} type="button" className="card-more" onClick={() => onOpen(card)} aria-label="打开记录"><MoreHorizontal size={17} /></button></footer>
  </article>;
}

function ListView({ cards, onOpen }: { cards: CardRecord[]; onOpen: (card: CardRecord) => void }) {
  if (!cards.length) return <EmptyState archived={false} />;
  return <div className="list-view"><div className="list-header"><span>记录</span><span>阶段</span><span>更新</span><span /></div>{cards.map((card) => <button id={`list-card-opener-${card.id}`} className="list-row" key={card.id} onClick={() => onOpen(card)}><span><b>{card.title}</b><small>#{String(card.id).padStart(4, "0")} · {card.attachments.length ? `${card.attachments.length} 张截图` : "纯文字"}</small></span><span className={`stage-chip ${card.stage}`}><i />{STAGE_META[card.stage].label}</span><time>{shortDate(card.updatedAt)}</time><ChevronRight size={16} /></button>)}</div>;
}

function ArchiveView({ groups, onOpen, onRestore, onOpenImage }: { groups: ReturnType<typeof groupArchiveCards>; onOpen: (card: CardRecord) => void; onRestore: (card: CardRecord) => void; onOpenImage: (card: CardRecord, index: number) => void }) {
  if (!groups.length) return <EmptyState archived />;
  return <div className="archive-groups">{groups.map((group) => <section className="archive-group" key={group.id}><header><h2>{group.label}</h2><span>{group.cards.length} 条</span></header><div>{group.cards.map((card) => <article className="archive-row" key={card.id}>{card.attachments[0] && <div id={`archive-attachment-opener-${card.attachments[0].id}`} role="button" tabIndex={0} className="archive-thumb" onClick={() => onOpenImage(card, 0)} onKeyDown={(event) => activateFromKeyboard(event, () => onOpenImage(card, 0))} aria-label="查看截图"><AttachmentMedia key={card.attachments[0].id} attachment={card.attachments[0]} allowRetry={false} /></div>}<button id={`archive-card-opener-${card.id}`} type="button" className="archive-row-main" onClick={() => onOpen(card)}><b>{card.title}</b><small>#{String(card.id).padStart(4, "0")} · {shortDate(card.completedAt ?? card.updatedAt)} · {card.attachments.length ? `${card.attachments.length} 张截图` : "纯文字"}</small></button><button type="button" className="restore-button" onClick={() => onRestore(card)}><RotateCcw size={14} />恢复</button></article>)}</div></section>)}</div>;
}

function EmptyState({ archived }: { archived: boolean }) {
  return <div className="empty-state"><span><Archive size={22} /></span><h2>{archived ? "完成与档案还是空的" : "这里还没有记录"}</h2><p>{archived ? "完成或归档后的构思会按日期收在这里。" : "先记下一个念头，之后再决定怎么推进。"}</p></div>;
}

function LoadingState() {
  return <div className="loading-state" role="status" aria-live="polite"><LoaderCircle size={20} className="spin" />正在读取你的构思…</div>;
}

function PendingPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url] = useState(() => URL.createObjectURL(file));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <figure className="pending-preview">{url && <img src={url} alt={file.name} />}<figcaption title={file.name}>{file.name}</figcaption><button type="button" onClick={onRemove} aria-label={`移除 ${file.name}`}><X size={14} /></button></figure>;
}

function Editor({ userId, card, saving, obscured, isIdentityActive, onClose, onCreate, onSave, onUploadFiles, onReorder, onDeleteAttachment, onViewImage, onDraftStateChange }: {
  userId: string;
  card: CardRecord | null;
  saving: boolean;
  obscured: boolean;
  isIdentityActive: () => boolean;
  onClose: () => void;
  onCreate: (title: string, stage: Stage, files: File[], details: CardCreateDetails, clientRequestId: string) => Promise<CardRecord | undefined>;
  onSave: (id: number, patch: CardPatch, clearDraftOnConfirm?: boolean) => Promise<CardSaveResult>;
  onUploadFiles: (id: number, files: File[]) => Promise<File[]>;
  onReorder: (id: number, attachmentIds: string[]) => Promise<void>;
  onDeleteAttachment: (attachment: AttachmentRecord) => Promise<void>;
  onViewImage: (attachments: AttachmentRecord[], index: number) => void;
  onDraftStateChange: (present: boolean) => void;
}) {
  const draftId = card?.id ?? "new";
  const [restoredDraft] = useState<CardDraft | null>(() => readCardDraft(userId, draftId));
  const clientRequestIdRef = useRef(restoredDraft?.clientRequestId ?? crypto.randomUUID());
  const [title, setTitle] = useState(() => restoredDraft?.title ?? card?.title ?? "");
  const [criteria, setCriteria] = useState(() => restoredDraft?.criteria ?? card?.criteria ?? "");
  const [result, setResult] = useState(() => restoredDraft?.result ?? card?.result ?? "");
  const [originalText, setOriginalText] = useState(() => restoredDraft?.originalText ?? card?.originalText ?? "");
  const [organizedText, setOrganizedText] = useState(() => restoredDraft?.organizedText ?? card?.organizedText ?? "");
  const [aiAnalysis, setAiAnalysis] = useState(() => restoredDraft?.aiAnalysis ?? card?.aiAnalysis ?? null);
  const [aiModel, setAiModel] = useState(() => restoredDraft?.aiModel ?? card?.aiModel ?? null);
  const [aiPromptVersion, setAiPromptVersion] = useState(() => restoredDraft?.aiPromptVersion ?? card?.aiPromptVersion ?? null);
  const [aiOrganizedAt, setAiOrganizedAt] = useState(() => restoredDraft?.aiOrganizedAt ?? card?.aiOrganizedAt ?? null);
  const [stage, setStage] = useState<Stage>(() => restoredDraft?.stage ?? card?.stage ?? "idea");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [draggedAttachment, setDraggedAttachment] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useModalFocus({ containerRef: editorRef, initialFocusRef: titleRef, onClose, active: true });

  useEffect(() => {
    if (!isIdentityActive()) return;
    const dirty = title !== (card?.title ?? "")
      || criteria !== (card?.criteria ?? "")
      || result !== (card?.result ?? "")
      || originalText !== (card?.originalText ?? "")
      || organizedText !== (card?.organizedText ?? "")
      || aiAnalysis !== (card?.aiAnalysis ?? null)
      || aiModel !== (card?.aiModel ?? null)
      || aiPromptVersion !== (card?.aiPromptVersion ?? null)
      || aiOrganizedAt !== (card?.aiOrganizedAt ?? null)
      || stage !== (card?.stage ?? "idea");
    if (dirty) {
      writeCardDraft(userId, draftId, {
        title,
        criteria,
        result,
        originalText,
        organizedText,
        aiAnalysis,
        aiModel,
        aiPromptVersion,
        aiOrganizedAt,
        stage,
        clientRequestId: clientRequestIdRef.current,
      });
    } else clearCardDraft(userId, draftId);
    onDraftStateChange(dirty || pendingFiles.length > 0);
  }, [aiAnalysis, aiModel, aiOrganizedAt, aiPromptVersion, card, criteria, draftId, isIdentityActive, onDraftStateChange, originalText, organizedText, pendingFiles.length, result, stage, title, userId]);

  const addFiles = (files: File[]) => {
    const accepted: File[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try { validateBoardAttachment(file); accepted.push(file); }
      catch (reason) { errors.push(`${file.name}：${reason instanceof Error ? reason.message : "无法使用"}`); }
    }
    setPendingFiles((current) => {
      const signatures = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      return [...current, ...accepted.filter((file) => !signatures.has(`${file.name}:${file.size}:${file.lastModified}`))];
    });
    setAttachmentError(errors.join("；"));
  };
  const pasteAttachment = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (!files.length) return;
    if (window.matchMedia("(max-width: 720px)").matches) {
      setAttachmentError("手机端暂不支持粘贴图片，请点“选择截图”上传。");
      return;
    }
    event.preventDefault();
    addFiles(files);
  };
  const adoptOrganization = (adoption: OrganizerAdoption) => {
    if (adoption.title) setTitle(adoption.title);
    setOrganizedText(adoption.organizedText);
    setAiAnalysis(adoption.aiAnalysis);
    setAiModel(adoption.aiModel);
    setAiPromptVersion(adoption.aiPromptVersion);
    setAiOrganizedAt(adoption.aiOrganizedAt);
  };
  const persist = async (targetStage = stage) => {
    if (!title.trim() && !originalText.trim()) return;
    const fallbackTitle = Array.from(originalText.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "未命名想法").slice(0, 40).join("");
    const cleanTitle = title.trim() || fallbackTitle;
    const details: CardCreateDetails = { criteria, result, originalText, organizedText, aiAnalysis, aiModel, aiPromptVersion, aiOrganizedAt };
    try {
      if (!card) {
        const creation = onCreate(cleanTitle, targetStage, pendingFiles, details, clientRequestIdRef.current);
        if (pendingFiles.length === 0) onClose();
        const created = await creation;
        if (!created || !isIdentityActive()) return;
      } else {
        const patch: CardPatch = {};
        if (cleanTitle !== card.title) patch.title = cleanTitle;
        if (criteria !== card.criteria) patch.criteria = criteria;
        if (result !== card.result) patch.result = result;
        if (originalText !== card.originalText) patch.originalText = originalText;
        if (organizedText !== card.organizedText) patch.organizedText = organizedText;
        if (aiAnalysis !== card.aiAnalysis) patch.aiAnalysis = aiAnalysis;
        if (aiModel !== card.aiModel) patch.aiModel = aiModel;
        if (aiPromptVersion !== card.aiPromptVersion) patch.aiPromptVersion = aiPromptVersion;
        if (aiOrganizedAt !== card.aiOrganizedAt) patch.aiOrganizedAt = aiOrganizedAt;
        if (targetStage !== card.stage) patch.stage = targetStage;
        const save = await onSave(card.id, patch, true);
        if (save.state === "pending" || !isIdentityActive()) return;
        if (pendingFiles.length) {
          const failed = await onUploadFiles(card.id, pendingFiles);
          if (!isIdentityActive()) return;
          if (failed.length) { setPendingFiles(failed); return; }
        }
      }
      if (!isIdentityActive()) return;
      clearCardDraft(userId, draftId);
      onDraftStateChange(false);
      onClose();
    } catch {
      // The board shell presents the cloud error; the local draft remains available for retry.
    }
  };
  const cancel = () => {
    if (!isIdentityActive()) return;
    if (!card && (title.trim() || originalText.trim())) {
      writeCardDraft(userId, draftId, {
        title, criteria, result, originalText, organizedText, aiAnalysis, aiModel,
        aiPromptVersion, aiOrganizedAt, stage, clientRequestId: crypto.randomUUID(),
      });
    }
    onClose();
  };
  const moveAttachment = async (id: string, direction: -1 | 1) => {
    if (!card) return;
    const ids = card.attachments.map((attachment) => attachment.id);
    const index = ids.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await onReorder(card.id, ids);
  };
  const dropAttachment = async (targetId: string) => {
    if (!card || !draggedAttachment || draggedAttachment === targetId) return;
    const ids = card.attachments.map((attachment) => attachment.id);
    const from = ids.indexOf(draggedAttachment);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setDraggedAttachment(null);
    await onReorder(card.id, ids);
  };
  const downloadAttachment = async (attachment: AttachmentRecord) => {
    try {
      const url = await getBoardAttachmentUrl(attachment, true);
      if (!isIdentityActive()) return;
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.filename;
      anchor.rel = "noreferrer";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (reason) { if (isIdentityActive()) setAttachmentError(reason instanceof Error ? reason.message : "下载失败"); }
  };
  const advance = nextStage(stage);

  return <div className="editor-backdrop"><aside ref={editorRef} className="editor" role="dialog" aria-modal={obscured ? undefined : true} aria-hidden={obscured ? true : undefined} inert={obscured} aria-labelledby="editor-dialog-title" onPaste={pasteAttachment} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); } }}>
    <header><div><span className={`stage-dot ${stage}`} /><p id="editor-dialog-title">{card ? `编辑记录 #${String(card.id).padStart(4, "0")}` : "新建构思"}</p></div><button onClick={cancel} aria-label="关闭"><X size={19} /></button></header>
    <div className="editor-scroll">
      {restoredDraft && <div className="draft-restored"><FilePenLine size={14} />已恢复上次未保存的文字</div>}
      <label className="field title-field"><span>标题</span><textarea ref={titleRef} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="记下你正在想的事…" maxLength={240} rows={2} /></label>
      <fieldset className="stage-picker"><legend>所处阶段</legend>{STAGES.map((item) => <button type="button" key={item} className={stage === item ? "active" : ""} onClick={() => setStage(item)}><span className={`stage-dot ${item}`} />{STAGE_META[item].label}</button>)}</fieldset>
      <IdeaOrganizer originalText={originalText} acceptedOrganizedText={organizedText} onOriginalTextChange={setOriginalText} onAdopt={adoptOrganization} />
      {organizedText && <label className="field organized-field"><span>整理稿 <small>可继续修改</small></span><textarea value={organizedText} onChange={(event) => setOrganizedText(event.target.value)} maxLength={20_000} rows={5} /></label>}
      <label className="field"><span>完成标准 <small>可选</small></span><textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="做到什么程度，就算完成？" maxLength={4000} rows={3} /></label>
      {(stage === "done" || result) && <label className="field"><span>结果记录 <small>可选</small></span><textarea value={result} onChange={(event) => setResult(event.target.value)} placeholder="留下结果、链接或一句复盘。" maxLength={4000} rows={3} /></label>}
      <section className="attachments"><div className="section-title"><span>参考截图</span><small>{(card?.attachments.length ?? 0) + pendingFiles.length} 张</small></div>
        {card?.attachments.length ? <div className="attachment-grid">{card.attachments.map((attachment, index) => <figure key={attachment.id} draggable onDragStart={() => setDraggedAttachment(attachment.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => void dropAttachment(attachment.id)}><div id={`editor-attachment-opener-${attachment.id}`} role="button" tabIndex={0} className="attachment-preview" onClick={() => onViewImage(card.attachments, index)} onKeyDown={(event) => activateFromKeyboard(event, () => onViewImage(card.attachments, index))} aria-label={`查看 ${attachment.filename}`}><AttachmentMedia attachment={attachment} allowRetry={false} />{index === 0 && <span className="cover-badge">封面</span>}</div><figcaption title={attachment.filename}><GripVertical size={12} />{attachment.filename}</figcaption><div className="attachment-actions desktop-only"><button type="button" onClick={() => void moveAttachment(attachment.id, -1)} disabled={index === 0} aria-label="向前移动"><ChevronLeft size={14} /></button><button type="button" onClick={() => void moveAttachment(attachment.id, 1)} disabled={index === card.attachments.length - 1} aria-label="向后移动"><ChevronRight size={14} /></button><button type="button" onClick={() => void downloadAttachment(attachment)} aria-label="下载截图"><Download size={14} /></button><button type="button" onClick={() => { if (window.confirm("删除这张截图？此操作无法撤销。")) void onDeleteAttachment(attachment); }} aria-label="删除截图"><Trash2 size={14} /></button></div></figure>)}</div> : null}
        {pendingFiles.length > 0 && <div className="pending-grid">{pendingFiles.map((file, index) => <PendingPreview key={`${file.name}:${file.size}:${file.lastModified}`} file={file} onRemove={() => setPendingFiles((current) => current.filter((_item, itemIndex) => itemIndex !== index))} />)}</div>}
        {!card?.attachments.length && !pendingFiles.length && <div className="no-attachment"><ImageIcon size={20} /><span>还没有参考截图</span><small className="desktop-only">可粘贴、拖入或选择多张截图</small><small className="mobile-only">可点“选择截图”上传</small></div>}
        {attachmentError && <p className="attachment-error" role="alert">{attachmentError}</p>}
        <input id="editor-attachment-input" name="attachments" aria-label="选择参考截图" tabIndex={-1} className="visually-hidden" ref={inputRef} type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
        <button type="button" className="upload-button" aria-controls="editor-attachment-input" onClick={() => inputRef.current?.click()}><Upload size={15} /><span className="desktop-only">粘贴、拖入或选择截图</span><span className="mobile-only">选择截图</span><small>JPG / PNG / WebP</small></button>
      </section>
      {card && <div className="editor-options">{card.stage !== "done" && !card.archived && <button onClick={() => { void onSave(card.id, { focus: !card.focus }).catch(() => undefined); }}><Star size={16} fill={card.focus ? "currentColor" : "none"} />{card.focus ? "移出今日焦点" : "设为今日焦点"}</button>}<button onClick={() => { void onSave(card.id, { reference: !card.reference }).catch(() => undefined); }}><FileText size={16} />{card.reference ? "取消参考" : "标记为参考"}</button>{(card.stage === "done" || card.archived) ? <button onClick={() => { void onSave(card.id, { stage: restoreStage(card), archived: false }).catch(() => undefined); }}><RotateCcw size={16} />恢复处理</button> : <button onClick={() => { void onSave(card.id, { archived: true }).catch(() => undefined); }}><Archive size={16} />归档</button>}</div>}
    </div>
    <footer><button className="secondary" onClick={cancel}>关闭</button>{card && advance && <button className="advance desktop-only" onClick={() => void persist(advance)}><span>保存并推进至</span>{STAGE_META[advance].label}<ChevronRight size={15} /></button>}<button className="primary" disabled={saving || (!title.trim() && !originalText.trim())} onClick={() => void persist()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存</button></footer>
  </aside></div>;
}
