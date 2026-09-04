"use client";

import { ChevronDown, LoaderCircle, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { organizeIdea } from "@/lib/idea-organizer";
import type { IdeaAnalysis, IdeaOrganizationResult } from "@/lib/types";

export type OrganizerAdoption = {
  title?: string;
  organizedText: string;
  aiAnalysis: IdeaAnalysis;
  aiModel: string;
  aiPromptVersion: string;
  aiOrganizedAt: string;
};

export function IdeaOrganizer({
  originalText,
  acceptedOrganizedText,
  onOriginalTextChange,
  onAdopt,
}: {
  originalText: string;
  acceptedOrganizedText: string;
  onOriginalTextChange: (value: string) => void;
  onAdopt: (value: OrganizerAdoption) => void;
}) {
  const [expanded, setExpanded] = useState(() => !acceptedOrganizedText);
  const [preview, setPreview] = useState<IdeaOrganizationResult | null>(null);
  const [organizedDraft, setOrganizedDraft] = useState("");
  const [useSuggestedTitle, setUseSuggestedTitle] = useState(true);
  const [organizing, setOrganizing] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
    requestId.current += 1;
  }, []);

  const discardPreview = () => {
    requestId.current += 1;
    setPreview(null);
    setOrganizedDraft("");
    setError("");
    setOrganizing(false);
  };

  const changeOriginal = (value: string) => {
    if (preview || organizing) discardPreview();
    onOriginalTextChange(value);
  };

  const runOrganizer = async () => {
    if (!originalText.trim() || organizing) return;
    const currentRequest = ++requestId.current;
    setOrganizing(true);
    setError("");
    try {
      const result = await organizeIdea(originalText);
      if (!mounted.current || currentRequest !== requestId.current) return;
      setPreview(result);
      setOrganizedDraft(result.organizedText);
      setUseSuggestedTitle(true);
    } catch (reason) {
      if (!mounted.current || currentRequest !== requestId.current) return;
      setError(reason instanceof Error ? reason.message : "AI 梳理失败，请重试。");
    } finally {
      if (mounted.current && currentRequest === requestId.current) setOrganizing(false);
    }
  };

  const adopt = () => {
    if (!preview || !organizedDraft.trim()) return;
    onAdopt({
      ...(useSuggestedTitle && preview.suggestedTitle.trim()
        ? { title: preview.suggestedTitle.trim() }
        : {}),
      organizedText: organizedDraft.trim(),
      aiAnalysis: preview.analysis,
      aiModel: preview.meta.model,
      aiPromptVersion: preview.meta.promptVersion,
      aiOrganizedAt: new Date().toISOString(),
    });
    discardPreview();
    setExpanded(false);
  };

  return <section className="idea-organizer" aria-label="AI 梳理">
    <div className="original-head">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <ChevronDown size={14} className={expanded ? "open" : ""} />
        {expanded ? "收起原始想法" : "查看原始想法"}
        <small>{originalText.length} 字{acceptedOrganizedText ? " · 已整理" : ""}</small>
      </button>
    </div>
    {expanded && <label className="field original-field">
      <span>原始想法</span>
      <textarea
        value={originalText}
        onChange={(event) => changeOriginal(event.target.value)}
        placeholder="把口述、碎片和还没想清楚的内容先原样记下来……"
        maxLength={20_000}
        rows={5}
      />
    </label>}
    <div className="organizer-trigger">
      <div><b><Sparkles size={14} />AI 梳理</b><p>只发送本卡片的原始想法；不会发送账号、其他卡片或截图。</p></div>
      <button type="button" className="ai-button" disabled={organizing || !originalText.trim()} onClick={() => void runOrganizer()}>
        {organizing ? <><LoaderCircle className="spin" size={14} />正在梳理…</> : <><Sparkles size={14} />AI 梳理</>}
      </button>
    </div>
    <div className="organizer-status" aria-live="polite">
      {error && <p className="organizer-error">{error} <button type="button" onClick={() => void runOrganizer()}>重试</button></p>}
    </div>
    {preview && <div className="organizer-preview">
      <div className="preview-label"><span>整理预览</span><small>采用前可以继续修改</small></div>
      <label className="title-choice">
        <input type="checkbox" checked={useSuggestedTitle} onChange={(event) => setUseSuggestedTitle(event.target.checked)} />
        <span>采用建议标题</span>
        <input aria-label="建议标题" value={preview.suggestedTitle} onChange={(event) => setPreview({ ...preview, suggestedTitle: event.target.value })} maxLength={240} />
      </label>
      <label className="field"><span>整理稿</span><textarea aria-label="整理稿" value={organizedDraft} onChange={(event) => setOrganizedDraft(event.target.value)} maxLength={20_000} rows={7} /></label>
      <AnalysisGrid analysis={preview.analysis} />
      <div className="preview-actions">
        <button type="button" className="quiet" onClick={() => void runOrganizer()}><RefreshCw size={14} />重新梳理</button>
        <button type="button" className="quiet" onClick={discardPreview}><Trash2 size={14} />放弃结果</button>
        <button type="button" className="primary" disabled={!organizedDraft.trim()} onClick={adopt}>采用整理稿</button>
      </div>
    </div>}
  </section>;
}

function AnalysisGrid({ analysis }: { analysis: IdeaAnalysis }) {
  const sections: Array<[string, string[]]> = [
    ["行动", analysis.actions.map((item) => item.text)],
    ["时间", analysis.times.map((item) => `${item.text}${item.certainty === "uncertain" ? " · 待确认" : ""}`)],
    ["人物", analysis.people.map((item) => `${item.text}${item.certainty === "uncertain" ? " · 待确认" : ""}`)],
    ["阻碍", analysis.blockers.map((item) => item.text)],
    ["待确认", analysis.uncertainties],
  ].filter((section) => section[1].length > 0) as Array<[string, string[]]>;
  const priority = analysis.priority.value
    ? { high: "高", medium: "中", low: "低" }[analysis.priority.value]
    : null;
  if (!sections.length && !priority) return null;
  return <div className="analysis-grid">
    {sections.map(([label, items]) => <section key={label}><b>{label}</b>{items.map((item) => <span key={item}>{item}</span>)}</section>)}
    {priority && <section><b>优先级</b><span>{priority}{analysis.priority.certainty === "inferred" ? " · AI 推测" : ""}</span>{analysis.priority.reason && <span>{analysis.priority.reason}</span>}</section>}
  </div>;
}
