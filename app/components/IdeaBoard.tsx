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
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AttachmentMedia, ImageViewer } from "@/app/components/AttachmentMedia";
import { IdeaOrganizer } from "@/app/components/IdeaOrganizer";
import type { OrganizerAdoption } from "@/app/components/IdeaOrganizer";
import { applyCardPatch, getDoneBoardSlice, groupArchiveCards, matchesCard, nextStageSortOrder, replaceBoardCard, restoreStage } from "@/lib/board-model";
import {
  createBoardCard,
  deleteBoardAttachment,
  getBoardAttachmentUrl,
  listBoardCards,
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
import type { AttachmentRecord, CardCreateDetails, CardDraft, CardPatch, CardRecord, Stage, SyncState } from "@/lib/types";

const STAGE_META: Record<Stage, { label: string; hint: string }> = {
  idea: { label: "构思", hint: "先记下来，不急着做" },
  todo: { label: "待完成", hint: "已经明确，等待开始" },
  doing: { label: "进行中", hint: "保持克制，只推进少量内容" },
  done: { label: "已完成", hint: "结果与经验留档" },
};
const STAGES = Object.keys(STAGE_META) as Stage[];
const LOAD_TIMEOUT = 15_000;
const SAVE_TIMEOUT = 12_000;
const UNDO_DURATION = 6_000;

type View = "board" | "list" | "archive";
type SelectedCard = CardRecord | "new" | null;
type UndoAction = { cardId: number; title: string; stage: Exclude<Stage, "done"> };

function nextStage(stage: Stage): Stage | null {
  const index = STAGES.indexOf(stage);
  return index < STAGES.length - 1 ? STAGES[index + 1] : null;
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

function syncLabel(state: SyncState): { label: string; icon: React.ReactNode } {
  if (state === "syncing") return { label: "同步中", icon: <RefreshCw size={13} className="spin" /> };
  if (state === "offline") return { label: "离线", icon: <CloudOff size={13} /> };
  if (state === "error") return { label: "同步失败", icon: <CircleAlert size={13} /> };
  if (state === "draft") return { label: "本机草稿", icon: <FilePenLine size={13} /> };
  return { label: "已同步", icon: <Cloud size={13} /> };
}

export function IdeaBoard({ userId, displayName, onSignOut }: { userId: string; displayName: string; onSignOut: () => void }) {
  const [cards, setCards] = useState<CardRecord[]>(() => readBoardCache(userId));
  const [view, setView] = useState<View>("board");
  const [mobileStage, setMobileStage] = useState<Stage>("idea");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SelectedCard>(null);
  const [viewer, setViewer] = useState<{ attachments: AttachmentRecord[]; index: number } | null>(null);
  const [loading, setLoading] = useState(() => readBoardCache(userId).length === 0);
  const [saving, setSaving] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>(() => navigator.onLine ? "syncing" : "offline");
  const [error, setError] = useState("");
  const [composer, setComposer] = useState(() => readCardDraft(userId, "composer")?.title ?? "");
  const [editorDraftPresent, setEditorDraftPresent] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const cardsRef = useRef(cards);
  const mutationVersionRef = useRef(new Map<number, number>());

  const commitCards = useCallback((next: CardRecord[]) => {
    cardsRef.current = next;
    setCards(next);
    writeBoardCache(userId, next);
  }, [userId]);

  const commitCard = useCallback((card: CardRecord, updateSelection = true) => {
    commitCards(replaceBoardCard(cardsRef.current, card));
    if (updateSelection) {
      setSelected((current) => current && current !== "new" && current.id === card.id ? card : current);
    }
  }, [commitCards]);

  const load = useCallback(async () => {
    if (!navigator.onLine) {
      const cached = readBoardCache(userId);
      if (cached.length) commitCards(cached);
      setSyncState("offline");
      setLoading(false);
      return cached;
    }
    setSyncState("syncing");
    try {
      const data = await withTimeout(listBoardCards(), LOAD_TIMEOUT, "同步超时，请检查网络后重试");
      commitCards(data);
      setSelected((current) => {
        if (!current || current === "new") return current;
        return data.find((card) => card.id === current.id) ?? null;
      });
      setError("");
      setSyncState("synced");
      return data;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "加载失败";
      const cached = readBoardCache(userId);
      if (cached.length) commitCards(cached);
      setError(cached.length ? `${message}，正在显示最近一次同步内容。` : message);
      setSyncState(navigator.onLine ? "error" : "offline");
      return cached;
    } finally {
      setLoading(false);
    }
  }, [commitCards, userId]);

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
    });
    else clearCardDraft(userId, "composer");
  }, [composer, userId]);
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

  const mutate = useCallback(async (id: number, patch: CardPatch) => {
    const before = cardsRef.current.find((card) => card.id === id);
    if (!before) throw new Error("记录不存在，请刷新后重试");
    const effectivePatch = patch.stage !== undefined && patch.stage !== before.stage && patch.sortOrder === undefined
      ? { ...patch, sortOrder: nextStageSortOrder(cardsRef.current, patch.stage) }
      : patch;
    const mutationVersion = (mutationVersionRef.current.get(id) ?? 0) + 1;
    mutationVersionRef.current.set(id, mutationVersion);
    // Keep the editor's original card prop until the server confirms the write.
    // This prevents its local draft from being cleared during an in-flight save.
    commitCard(applyCardPatch(before, effectivePatch), false);
    setSaving(true);
    setSyncState(navigator.onLine ? "syncing" : "offline");
    try {
      if (!navigator.onLine) throw new Error("当前处于离线状态，联网后再保存");
      const card = await withTimeout(
        updateBoardCard(id, effectivePatch, before),
        SAVE_TIMEOUT,
        "保存超时，内容已保留在本机草稿中",
      );
      if (mutationVersionRef.current.get(id) === mutationVersion) commitCard(card);
      setError("");
      setSyncState("synced");
      if (before.stage !== "done" && patch.stage === "done") {
        setUndoAction({ cardId: id, title: before.title, stage: before.stage });
      }
      return card;
    } catch (reason) {
      if (mutationVersionRef.current.get(id) === mutationVersion) commitCard(before);
      setError(reason instanceof Error ? reason.message : "保存失败");
      setSyncState(navigator.onLine ? "error" : "offline");
      throw reason;
    } finally {
      setSaving(false);
    }
  }, [commitCard]);

  const uploadFiles = useCallback(async (cardId: number, files: File[]) => {
    const failed: File[] = [];
    const messages: string[] = [];
    setSaving(true);
    setSyncState(navigator.onLine ? "syncing" : "offline");
    if (!navigator.onLine) {
      setSaving(false);
      setError("当前处于离线状态，联网后再上传截图");
      return files;
    }
    for (const file of files) {
      try {
        await uploadBoardAttachment(cardId, file);
      } catch (reason) {
        failed.push(file);
        messages.push(`${file.name}：${reason instanceof Error ? reason.message : "上传失败"}`);
      }
    }
    await load();
    setSaving(false);
    if (messages.length) {
      setError(`部分截图未上传：${messages.join("；")}`);
      setSyncState("error");
    }
    return failed;
  }, [load]);

  const create = useCallback(async (
    title: string,
    stage: Stage = "idea",
    files: File[] = [],
    details: CardCreateDetails = {},
  ) => {
    const clean = title.trim();
    if (!clean && !details.originalText?.trim()) return undefined;
    let createdCard: CardRecord | undefined;
    setSaving(true);
    setSyncState(navigator.onLine ? "syncing" : "offline");
    try {
      if (!navigator.onLine) throw new Error("当前处于离线状态，联网后再创建");
      files.forEach(validateBoardAttachment);
      // Creation is intentionally not force-timed-out: an insert can still finish after a
      // client timeout, and an automatic retry could otherwise create a duplicate memo.
      createdCard = await createBoardCard(clean, stage, details, nextStageSortOrder(cardsRef.current, stage));
      const failed: string[] = [];
      for (const file of files) {
        try { await uploadBoardAttachment(createdCard.id, file); }
        catch (reason) { failed.push(`${file.name}：${reason instanceof Error ? reason.message : "上传失败"}`); }
      }
      if (files.length) {
        const data = await load();
        createdCard = data.find((item) => item.id === createdCard?.id) ?? createdCard;
      } else {
        commitCard(createdCard);
        setSyncState("synced");
      }
      setComposer("");
      clearCardDraft(userId, "composer");
      if (failed.length) setError(`构思已保存，部分截图未上传：${failed.join("；")}`);
      return createdCard;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败");
      setSyncState(navigator.onLine ? "error" : "offline");
      if (createdCard) commitCard(createdCard);
      return undefined;
    } finally {
      setSaving(false);
    }
  }, [commitCard, load, userId]);

  const removeAttachment = useCallback(async (attachment: AttachmentRecord) => {
    setSaving(true);
    setSyncState(navigator.onLine ? "syncing" : "offline");
    try { if (!navigator.onLine) throw new Error("当前处于离线状态，联网后再删除截图"); await deleteBoardAttachment(attachment); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "截图删除失败"); setSyncState(navigator.onLine ? "error" : "offline"); }
    finally { setSaving(false); }
  }, [load]);

  const reorderAttachments = useCallback(async (cardId: number, ids: string[]) => {
    setSaving(true);
    setSyncState(navigator.onLine ? "syncing" : "offline");
    try { if (!navigator.onLine) throw new Error("当前处于离线状态，联网后再调整截图"); await reorderBoardAttachments(cardId, ids); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "截图排序失败"); setSyncState(navigator.onLine ? "error" : "offline"); }
    finally { setSaving(false); }
  }, [load]);

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
  const effectiveSyncState: SyncState = syncState === "synced" && (composer.trim() || editorDraftPresent) ? "draft" : syncState;
  const sync = syncLabel(effectiveSyncState);
  const visibleDoneCount = getDoneBoardSlice(cards).cards.length;

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Sparkles size={16} /></span><span>云端构思板</span></div>
      <nav className="desktop-nav" aria-label="主导航">
        <NavButton active={view === "board"} onClick={() => setView("board")} icon={<LayoutGrid size={16} />}>看板</NavButton>
        <NavButton active={view === "list"} onClick={() => setView("list")} icon={<List size={16} />}>清单</NavButton>
        <NavButton active={view === "archive"} onClick={() => setView("archive")} icon={<Archive size={16} />}>档案库</NavButton>
      </nav>
      <div className={`account sync-${effectiveSyncState}`}><button type="button" className="sync-status" onClick={() => { if (effectiveSyncState === "error") void load(); }} disabled={effectiveSyncState !== "error"}>{sync.icon}{sync.label}</button><span className="avatar">{(displayName || "我").slice(0, 1)}</span><button className="signout desktop-only" onClick={onSignOut}>退出</button><button className="mobile-menu-button" onClick={() => setMobileMenu((value) => !value)} aria-label="打开导航"><Menu size={17} /></button></div>
      {mobileMenu && <nav className="mobile-menu"><button onClick={() => { setView("board"); setMobileMenu(false); }}><LayoutGrid size={15} />看板</button><button onClick={() => { setView("list"); setMobileMenu(false); }}><List size={15} />清单</button><button onClick={() => { setView("archive"); setMobileMenu(false); }}><Archive size={15} />档案库</button><button onClick={onSignOut}>退出</button></nav>}
    </header>

    {view === "board" && <div className="mobile-tabs" role="tablist" aria-label="阶段">
      {STAGES.map((stage) => <button type="button" role="tab" aria-selected={mobileStage === stage} className={mobileStage === stage ? "active" : ""} key={stage} onClick={() => setMobileStage(stage)}><span className={`stage-dot ${stage}`} />{STAGE_META[stage].label}<b>{stage === "done" ? visibleDoneCount : cards.filter((card) => card.stage === stage && !card.archived).length}</b></button>)}
    </div>}

    <section className="workspace">
      <div className="heading-row"><div><p className="eyebrow">PERSONAL MEMO BOARD</p><h1>{view === "archive" ? "完成与档案" : view === "list" ? "待处理清单" : "我的构思"}</h1><p>{view === "archive" ? "完成的内容按时间自然沉淀，也可以随时恢复。" : "记录、处理、完成，再从结果里回看。"}</p></div><button className="primary desktop-only" onClick={() => setSelected("new")}><Plus size={17} />记一个构思</button></div>
      {view !== "archive" && <FocusStrip cards={focusCards} onOpen={setSelected} />}
      <div className="toolbar"><label className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文字、编号或截图名称" /></label><span className="result-count">{view === "archive" ? archiveGroups.reduce((count, group) => count + group.cards.length, 0) : view === "list" ? listCards.length : activeCards.length} 条记录</span></div>
      {error && <div className="notice" role="alert"><CircleAlert size={16} /><span>{error}</span>{syncState === "error" && <button className="notice-retry" onClick={() => void load()}><RefreshCw size={14} />重试</button>}<button onClick={() => setError("")} aria-label="关闭"><X size={15} /></button></div>}
      {loading ? <LoadingState /> : view === "board" ? <Board cards={activeCards} mobileStage={mobileStage} onOpen={setSelected} onMove={(card, stage) => { void mutate(card.id, { stage }).catch(() => undefined); }} onOpenImage={(card, index) => setViewer({ attachments: card.attachments, index })} onOpenArchive={() => setView("archive")} /> : view === "archive" ? <ArchiveView groups={archiveGroups} onOpen={setSelected} onRestore={(card) => void restore(card)} onOpenImage={(card, index) => setViewer({ attachments: card.attachments, index })} /> : <ListView cards={listCards} onOpen={setSelected} />}
    </section>

    <form className="mobile-composer" onSubmit={(event) => { event.preventDefault(); void create(composer); }}><input value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="记录一个新构思…" maxLength={240} /><button disabled={saving || !composer.trim()} aria-label="添加构思"><ArrowRight size={19} /></button></form>
    {undoAction && <div className="undo-toast" role="status"><Check size={16} /><span>“{undoAction.title}”已完成</span><button onClick={() => void undoCompletion()}><RotateCcw size={14} />撤销</button></div>}
    {selected && <Editor key={selected === "new" ? "new" : selected.id} userId={userId} card={selected === "new" ? null : selected} saving={saving} onClose={() => setSelected(null)} onCreate={create} onSave={mutate} onUploadFiles={uploadFiles} onReorder={reorderAttachments} onDeleteAttachment={removeAttachment} onViewImage={(attachments, index) => setViewer({ attachments, index })} onDraftStateChange={setEditorDraftPresent} />}
    {viewer && <ImageViewer attachments={viewer.attachments} initialIndex={viewer.index} onClose={() => setViewer(null)} />}
  </main>;
}

function NavButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return <button className={active ? "active" : ""} onClick={onClick}>{icon}{children}</button>;
}

function FocusStrip({ cards, onOpen }: { cards: CardRecord[]; onOpen: (card: CardRecord) => void }) {
  return <section className="focus-strip"><div className="focus-label"><Star size={15} fill="currentColor" /><span>今日焦点</span><small>{cards.length}/3</small></div><div className="focus-items">{cards.length ? cards.map((card) => <button key={card.id} onClick={() => onOpen(card)}><span>#{String(card.id).padStart(4, "0")}</span>{card.title}<ChevronRight size={14} /></button>) : <p>把最重要的事放在这里，今天会更清楚。</p>}</div></section>;
}

function Board({ cards, mobileStage, onOpen, onMove, onOpenImage, onOpenArchive }: { cards: CardRecord[]; mobileStage: Stage; onOpen: (card: CardRecord) => void; onMove: (card: CardRecord, stage: Stage) => void; onOpenImage: (card: CardRecord, index: number) => void; onOpenArchive: () => void }) {
  const doneSlice = getDoneBoardSlice(cards);
  const cardsForStage = (stage: Stage) => stage === "done" ? doneSlice.cards : cards.filter((card) => card.stage === stage);
  return <>
    <div className="board desktop-board">{STAGES.map((stage) => {
      const stageCards = cardsForStage(stage);
      return <section className={`column column-${stage}`} key={stage} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const card = cards.find((item) => item.id === Number(event.dataTransfer.getData("card-id"))); if (card && card.stage !== stage) onMove(card, stage); }}><ColumnHeader stage={stage} count={stageCards.length} doneMode={doneSlice.mode} /><div className="column-body">{stageCards.map((card) => <TaskCard key={card.id} card={card} onOpen={onOpen} onOpenImage={onOpenImage} />)}{stage === "done" && doneSlice.hiddenCount > 0 && <CompletedOverflow count={doneSlice.hiddenCount} onOpen={onOpenArchive} />}{!stageCards.length && <div className="empty-column">暂时没有记录</div>}</div></section>;
    })}</div>
    <section className={`mobile-board-panel column-${mobileStage}`}><ColumnHeader stage={mobileStage} count={cardsForStage(mobileStage).length} doneMode={doneSlice.mode} /><div className="mobile-card-list">{cardsForStage(mobileStage).map((card) => <TaskCard key={card.id} card={card} onOpen={onOpen} onOpenImage={onOpenImage} />)}{mobileStage === "done" && doneSlice.hiddenCount > 0 && <CompletedOverflow count={doneSlice.hiddenCount} onOpen={onOpenArchive} />}{!cardsForStage(mobileStage).length && <div className="empty-column">暂时没有记录</div>}</div></section>
  </>;
}

function ColumnHeader({ stage, count, doneMode }: { stage: Stage; count: number; doneMode: "today" | "recent" }) {
  return <header className="column-header"><div><span className={`stage-dot ${stage}`} /><h2>{STAGE_META[stage].label}</h2><b>{count}</b></div><p>{stage === "done" ? doneMode === "today" ? "今天完成，最多展示 3 条" : "最近完成的 3 条记录" : STAGE_META[stage].hint}</p></header>;
}

function CompletedOverflow({ count, onOpen }: { count: number; onOpen: () => void }) {
  return <button className="completed-overflow" onClick={onOpen}><Archive size={14} /><span>其余 {count} 条在完成与档案</span><ChevronRight size={14} /></button>;
}

function TaskCard({ card, onOpen, onOpenImage }: { card: CardRecord; onOpen: (card: CardRecord) => void; onOpenImage: (card: CardRecord, index: number) => void }) {
  const cover = card.attachments[0];
  return <article className="task-card" draggable onDragStart={(event) => event.dataTransfer.setData("card-id", String(card.id))}>
    <button type="button" className="task-card-main" onClick={() => onOpen(card)}><div className="card-meta"><span>#{String(card.id).padStart(4, "0")}</span><span>{shortDate(card.completedAt ?? card.updatedAt)}</span></div><h3>{card.title}</h3>{(card.organizedText || card.criteria) && <p className="card-note">{card.organizedText || card.criteria}</p>}</button>
    {cover && <div role="button" tabIndex={0} className="card-image-button" onClick={() => onOpenImage(card, 0)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpenImage(card, 0); }} aria-label={`查看 ${cover.filename}`}><AttachmentMedia key={cover.id} attachment={cover} className="card-image" />{card.attachments.length > 1 && <span className="image-count">+{card.attachments.length - 1}</span>}</div>}
    <footer><div>{card.focus && <span className="tag focus"><Star size={12} fill="currentColor" />焦点</span>}{card.attachments.length > 0 && <span className="tag"><ImageIcon size={12} />{card.attachments.length}</span>}</div><button type="button" className="card-more" onClick={() => onOpen(card)} aria-label="打开记录"><MoreHorizontal size={17} /></button></footer>
  </article>;
}

function ListView({ cards, onOpen }: { cards: CardRecord[]; onOpen: (card: CardRecord) => void }) {
  if (!cards.length) return <EmptyState archived={false} />;
  return <div className="list-view"><div className="list-header"><span>记录</span><span>阶段</span><span>更新</span><span /></div>{cards.map((card) => <button className="list-row" key={card.id} onClick={() => onOpen(card)}><span><b>{card.title}</b><small>#{String(card.id).padStart(4, "0")} · {card.attachments.length ? `${card.attachments.length} 张截图` : "纯文字"}</small></span><span className={`stage-chip ${card.stage}`}><i />{STAGE_META[card.stage].label}</span><time>{shortDate(card.updatedAt)}</time><ChevronRight size={16} /></button>)}</div>;
}

function ArchiveView({ groups, onOpen, onRestore, onOpenImage }: { groups: ReturnType<typeof groupArchiveCards>; onOpen: (card: CardRecord) => void; onRestore: (card: CardRecord) => void; onOpenImage: (card: CardRecord, index: number) => void }) {
  if (!groups.length) return <EmptyState archived />;
  return <div className="archive-groups">{groups.map((group) => <section className="archive-group" key={group.id}><header><h2>{group.label}</h2><span>{group.cards.length} 条</span></header><div>{group.cards.map((card) => <article className="archive-row" key={card.id}>{card.attachments[0] && <div role="button" tabIndex={0} className="archive-thumb" onClick={() => onOpenImage(card, 0)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpenImage(card, 0); }} aria-label="查看截图"><AttachmentMedia key={card.attachments[0].id} attachment={card.attachments[0]} /></div>}<button type="button" className="archive-row-main" onClick={() => onOpen(card)}><b>{card.title}</b><small>#{String(card.id).padStart(4, "0")} · {shortDate(card.completedAt ?? card.updatedAt)} · {card.attachments.length ? `${card.attachments.length} 张截图` : "纯文字"}</small></button><button type="button" className="restore-button" onClick={() => onRestore(card)}><RotateCcw size={14} />恢复</button></article>)}</div></section>)}</div>;
}

function EmptyState({ archived }: { archived: boolean }) {
  return <div className="empty-state"><span><Archive size={22} /></span><h2>{archived ? "完成与档案还是空的" : "这里还没有记录"}</h2><p>{archived ? "完成或归档后的构思会按日期收在这里。" : "先记下一个念头，之后再决定怎么推进。"}</p></div>;
}

function LoadingState() {
  return <div className="loading-state"><LoaderCircle size={20} className="spin" />正在读取你的构思…</div>;
}

function PendingPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url] = useState(() => URL.createObjectURL(file));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <figure className="pending-preview">{url && <img src={url} alt={file.name} />}<figcaption title={file.name}>{file.name}</figcaption><button type="button" onClick={onRemove} aria-label={`移除 ${file.name}`}><X size={14} /></button></figure>;
}

function Editor({ userId, card, saving, onClose, onCreate, onSave, onUploadFiles, onReorder, onDeleteAttachment, onViewImage, onDraftStateChange }: {
  userId: string;
  card: CardRecord | null;
  saving: boolean;
  onClose: () => void;
  onCreate: (title: string, stage?: Stage, files?: File[], details?: CardCreateDetails) => Promise<CardRecord | undefined>;
  onSave: (id: number, patch: CardPatch) => Promise<CardRecord>;
  onUploadFiles: (id: number, files: File[]) => Promise<File[]>;
  onReorder: (id: number, attachmentIds: string[]) => Promise<void>;
  onDeleteAttachment: (attachment: AttachmentRecord) => Promise<void>;
  onViewImage: (attachments: AttachmentRecord[], index: number) => void;
  onDraftStateChange: (present: boolean) => void;
}) {
  const draftId = card?.id ?? "new";
  const [restoredDraft] = useState<CardDraft | null>(() => readCardDraft(userId, draftId));
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

  useEffect(() => {
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
      });
    } else clearCardDraft(userId, draftId);
    onDraftStateChange(dirty || pendingFiles.length > 0);
  }, [aiAnalysis, aiModel, aiOrganizedAt, aiPromptVersion, card, criteria, draftId, onDraftStateChange, originalText, organizedText, pendingFiles.length, result, stage, title, userId]);

  const addFiles = (files: File[]) => {
    if (window.matchMedia("(max-width: 720px)").matches) return;
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
    const canSyncInBackground = pendingFiles.length === 0;
    try {
      if (!card) {
        const creation = onCreate(cleanTitle, targetStage, pendingFiles, details);
        if (canSyncInBackground) onClose();
        const created = await creation;
        if (!created) return;
      } else {
        const save = onSave(card.id, { title: cleanTitle, criteria, result, originalText, organizedText, aiAnalysis, aiModel, aiPromptVersion, aiOrganizedAt, stage: targetStage });
        if (canSyncInBackground) onClose();
        await save;
        if (pendingFiles.length) {
          const failed = await onUploadFiles(card.id, pendingFiles);
          if (failed.length) { setPendingFiles(failed); return; }
        }
      }
      clearCardDraft(userId, draftId);
      onDraftStateChange(false);
      if (!canSyncInBackground) onClose();
    } catch {
      // The board shell presents the cloud error; the local draft remains available for retry.
    }
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
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.filename;
      anchor.rel = "noreferrer";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (reason) { setAttachmentError(reason instanceof Error ? reason.message : "下载失败"); }
  };
  const advance = nextStage(stage);

  return <div className="editor-backdrop"><aside className="editor" role="dialog" aria-modal="true" aria-label={card ? "编辑记录" : "新建构思"} onPaste={pasteAttachment} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); } }}>
    <header><div><span className={`stage-dot ${stage}`} /><p>{card ? `#${String(card.id).padStart(4, "0")}` : "NEW IDEA"}</p></div><button onClick={onClose} aria-label="关闭"><X size={19} /></button></header>
    <div className="editor-scroll">
      {restoredDraft && <div className="draft-restored"><FilePenLine size={14} />已恢复上次未保存的文字</div>}
      <label className="field title-field"><span>标题</span><textarea value={title} onChange={(event) => setTitle(event.target.value)} placeholder="记下你正在想的事…" maxLength={240} rows={2} /></label>
      <fieldset className="stage-picker"><legend>所处阶段</legend>{STAGES.map((item) => <button type="button" key={item} className={stage === item ? "active" : ""} onClick={() => setStage(item)}><span className={`stage-dot ${item}`} />{STAGE_META[item].label}</button>)}</fieldset>
      <IdeaOrganizer originalText={originalText} acceptedOrganizedText={organizedText} onOriginalTextChange={setOriginalText} onAdopt={adoptOrganization} />
      {organizedText && <label className="field organized-field"><span>整理稿 <small>可继续修改</small></span><textarea value={organizedText} onChange={(event) => setOrganizedText(event.target.value)} maxLength={20_000} rows={5} /></label>}
      <label className="field"><span>完成标准 <small>可选</small></span><textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="做到什么程度，就算完成？" maxLength={4000} rows={3} /></label>
      {(stage === "done" || result) && <label className="field"><span>结果记录 <small>可选</small></span><textarea value={result} onChange={(event) => setResult(event.target.value)} placeholder="留下结果、链接或一句复盘。" maxLength={4000} rows={3} /></label>}
      <section className="attachments"><div className="section-title"><span>参考截图</span><small>{(card?.attachments.length ?? 0) + pendingFiles.length} 张</small></div>
        {card?.attachments.length ? <div className="attachment-grid">{card.attachments.map((attachment, index) => <figure key={attachment.id} draggable onDragStart={() => setDraggedAttachment(attachment.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => void dropAttachment(attachment.id)}><div role="button" tabIndex={0} className="attachment-preview" onClick={() => onViewImage(card.attachments, index)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onViewImage(card.attachments, index); }}><AttachmentMedia attachment={attachment} />{index === 0 && <span className="cover-badge">封面</span>}</div><figcaption title={attachment.filename}><GripVertical size={12} />{attachment.filename}</figcaption><div className="attachment-actions desktop-only"><button type="button" onClick={() => void moveAttachment(attachment.id, -1)} disabled={index === 0} aria-label="向前移动"><ChevronLeft size={14} /></button><button type="button" onClick={() => void moveAttachment(attachment.id, 1)} disabled={index === card.attachments.length - 1} aria-label="向后移动"><ChevronRight size={14} /></button><button type="button" onClick={() => void downloadAttachment(attachment)} aria-label="下载截图"><Download size={14} /></button><button type="button" onClick={() => { if (window.confirm("删除这张截图？此操作无法撤销。")) void onDeleteAttachment(attachment); }} aria-label="删除截图"><Trash2 size={14} /></button></div></figure>)}</div> : null}
        {pendingFiles.length > 0 && <div className="pending-grid">{pendingFiles.map((file, index) => <PendingPreview key={`${file.name}:${file.size}:${file.lastModified}`} file={file} onRemove={() => setPendingFiles((current) => current.filter((_item, itemIndex) => itemIndex !== index))} />)}</div>}
        {!card?.attachments.length && !pendingFiles.length && <div className="no-attachment"><ImageIcon size={20} /><span>还没有参考截图</span><small className="desktop-only">可直接按 ⌘V 或拖入多张截图</small><small className="mobile-only">手机端仅查看截图</small></div>}
        {attachmentError && <p className="attachment-error" role="alert">{attachmentError}</p>}
        <input className="visually-hidden" ref={inputRef} type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
        <button type="button" className="upload-button desktop-only" onClick={() => inputRef.current?.click()}><Upload size={15} />粘贴、拖入或选择截图<small>⌘V / JPG / PNG / WebP</small></button>
      </section>
      {card && <div className="editor-options">{card.stage !== "done" && !card.archived && <button onClick={() => { void onSave(card.id, { focus: !card.focus }).catch(() => undefined); }}><Star size={16} fill={card.focus ? "currentColor" : "none"} />{card.focus ? "移出今日焦点" : "设为今日焦点"}</button>}<button onClick={() => { void onSave(card.id, { reference: !card.reference }).catch(() => undefined); }}><FileText size={16} />{card.reference ? "取消参考" : "标记为参考"}</button>{(card.stage === "done" || card.archived) ? <button onClick={() => { void onSave(card.id, { stage: restoreStage(card), archived: false }).catch(() => undefined); }}><RotateCcw size={16} />恢复处理</button> : <button onClick={() => { void onSave(card.id, { archived: true }).catch(() => undefined); }}><Archive size={16} />归档</button>}</div>}
    </div>
    <footer><button className="secondary" onClick={onClose}>关闭</button>{card && advance && <button className="advance desktop-only" onClick={() => void persist(advance)}><span>保存并推进至</span>{STAGE_META[advance].label}<ChevronRight size={15} /></button>}<button className="primary" disabled={saving || (!title.trim() && !originalText.trim())} onClick={() => void persist()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存</button></footer>
  </aside></div>;
}
