import { ChevronLeft, ChevronRight, Download, LoaderCircle, Minus, Plus, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { clearAttachmentUrlCache, getBoardAttachmentUrl } from "@/lib/supabase-board";
import type { AttachmentRecord } from "@/lib/types";

export function AttachmentMedia({ attachment, className = "", eager = false }: { attachment: AttachmentRecord; className?: string; eager?: boolean }) {
  const [url, setUrl] = useState(attachment.url ?? "");
  const [status, setStatus] = useState<"loading" | "ready" | "error">(attachment.url ? "ready" : "loading");
  const [attempt, setAttempt] = useState(0);

  const retry = () => {
    clearAttachmentUrlCache(attachment.objectKey);
    setUrl("");
    setStatus("loading");
    setAttempt((value) => value + 1);
  };

  useEffect(() => {
    let active = true;
    if (attachment.url) return () => { active = false; };
    void getBoardAttachmentUrl(attachment)
      .then((nextUrl) => {
        if (!active) return;
        setUrl(nextUrl);
        setStatus("ready");
      })
      .catch(() => { if (active) setStatus("error"); });
    return () => { active = false; };
  }, [attachment, attempt]);

  if (status === "error") {
    return <div className={`remote-image remote-image-error ${className}`}><span>截图加载失败</span><button type="button" onClick={(event) => { event.stopPropagation(); retry(); }}><RefreshCw size={13} />重试</button></div>;
  }
  if (status === "loading" || !url) {
    return <div className={`remote-image remote-image-loading ${className}`}><LoaderCircle size={17} className="spin" /><span>读取截图</span></div>;
  }
  return <div className={`remote-image ${className}`}><img src={url} alt={attachment.filename} loading={eager ? "eager" : "lazy"} onError={() => setStatus("error")} /></div>;
}

export function ImageViewer({ attachments, initialIndex, onClose }: { attachments: AttachmentRecord[]; initialIndex: number; onClose: () => void }) {
  const [index, setIndex] = useState(Math.min(Math.max(initialIndex, 0), Math.max(attachments.length - 1, 0)));
  const [zoom, setZoom] = useState(1);
  const [downloadError, setDownloadError] = useState("");
  const touchStartX = useRef<number | null>(null);
  const pinchStart = useRef<{ distance: number; zoom: number } | null>(null);
  const attachment = attachments[index];
  const go = useCallback((nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= attachments.length) return;
    setIndex(nextIndex);
    setZoom(1);
    setDownloadError("");
  }, [attachments.length]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") go(index - 1);
      if (event.key === "ArrowRight") go(index + 1);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [go, index, onClose]);

  if (!attachment) return null;
  const download = async () => {
    try {
      setDownloadError("");
      const url = await getBoardAttachmentUrl(attachment, true);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.filename;
      anchor.rel = "noreferrer";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (reason) {
      setDownloadError(reason instanceof Error ? reason.message : "截图下载失败");
    }
  };
  const touchDistance = (touches: React.TouchList): number => {
    if (touches.length < 2) return 0;
    return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  };

  return <div className="image-viewer" role="dialog" aria-modal="true" aria-label="查看截图">
    <header><span>{index + 1} / {attachments.length}</span><strong title={attachment.filename}>{attachment.filename}</strong><div><button type="button" className="viewer-download desktop-only" onClick={() => void download()} aria-label="下载截图"><Download size={17} /></button><button type="button" onClick={onClose} aria-label="关闭截图"><X size={20} /></button></div></header>
    <div className="viewer-stage"
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null;
        if (event.touches.length === 2) pinchStart.current = { distance: touchDistance(event.touches), zoom };
      }}
      onTouchMove={(event) => {
        if (event.touches.length !== 2 || !pinchStart.current) return;
        const ratio = touchDistance(event.touches) / Math.max(pinchStart.current.distance, 1);
        setZoom(Math.min(4, Math.max(1, pinchStart.current.zoom * ratio)));
      }}
      onTouchEnd={(event) => {
        const wasPinching = pinchStart.current !== null;
        pinchStart.current = null;
        if (wasPinching) { touchStartX.current = null; return; }
        const endX = event.changedTouches[0]?.clientX;
        if (zoom !== 1 || touchStartX.current === null || endX === undefined) return;
        const distance = endX - touchStartX.current;
        if (Math.abs(distance) > 55) go(distance > 0 ? index - 1 : index + 1);
      }}>
      <div className="viewer-image-scale" style={{ transform: `scale(${zoom})` }}><AttachmentMedia key={attachment.id} attachment={attachment} eager className="viewer-image" /></div>
    </div>
    {index > 0 && <button type="button" className="viewer-arrow previous" onClick={() => go(index - 1)} aria-label="上一张"><ChevronLeft size={25} /></button>}
    {index < attachments.length - 1 && <button type="button" className="viewer-arrow next" onClick={() => go(index + 1)} aria-label="下一张"><ChevronRight size={25} /></button>}
    <footer>{downloadError && <p className="viewer-error" role="alert">{downloadError}</p>}<button type="button" onClick={() => setZoom((value) => Math.max(1, value - .5))} disabled={zoom <= 1} aria-label="缩小"><Minus size={17} /></button><span>{Math.round(zoom * 100)}%</span><button type="button" onClick={() => setZoom((value) => Math.min(4, value + .5))} disabled={zoom >= 4} aria-label="放大"><Plus size={17} /></button></footer>
  </div>;
}
