import { Check, Cloud, Download, Laptop, Link2, LoaderCircle, Monitor, RefreshCw, Send, Terminal, Unplug } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cancelCodexTask, CodexApiError, createCodexTask, generatePairCode, listCodexTasks, revokeCodexDevice, syncCodexTask } from "@/lib/codex-task-api";
import type { CodexDevice, CodexTask, CodexTaskOverview, CodexTaskStatus, CreateCodexTaskInput } from "@/lib/codex-task-model";

const STATUS: Record<CodexTaskStatus, string> = {
  queued: "等待设备接收", dispatching: "正在发布", submitted: "已发布，等待 Codex", acknowledged: "Codex 已响应", running: "执行中",
  succeeded: "执行完成", failed: "执行失败", cancel_requested: "正在请求停止", cancelled: "已取消", needs_attention: "需要处理", result_ready: "有结果，待验收", closed: "已关闭", merged: "已合并",
};
type Draft = { title: string; prompt: string; acceptance: string; target: string; projectId: string; pending?: CreateCodexTaskInput };
const EMPTY: Draft = { title: "", prompt: "", acceptance: "", target: "cloud", projectId: "" };
function storageKey(id: string) { return `cloud-memo-board:codex-draft:${id}`; }
function readDraft(id: string): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(id)) || "null");
    if (!value || typeof value !== "object") return { ...EMPTY };
    return { ...EMPTY, ...Object.fromEntries(Object.keys(EMPTY).map((key) => [key, typeof value[key] === "string" ? value[key] : EMPTY[key as keyof typeof EMPTY]])), pending: value.pending?.requestId ? value.pending : undefined };
  } catch { return { ...EMPTY }; }
}
function time(value: string | null) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN") : "尚未收到回执"; }
function online(device: CodexDevice) { return !device.revokedAt && !!device.lastSeenAt && Date.now() - Date.parse(device.lastSeenAt) < 90_000; }
function safeLink(value: string | null) {
  try { const url = new URL(value || ""); return url.protocol === "https:" && ["github.com", "chatgpt.com"].includes(url.hostname) ? url.href : null; } catch { return null; }
}

/** Identity is a component boundary so account changes cannot reuse a private draft or late response. */
export function CodexTasks({ userId }: { userId: string }) { return <TaskPanel key={userId} userId={userId} />; }

function TaskPanel({ userId }: { userId: string }) {
  const [overview, setOverview] = useState<CodexTaskOverview | null>(null);
  const [draft, setDraft] = useState<Draft>(() => readDraft(userId));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [pair, setPair] = useState<{code: string; expiresAt: string} | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const locked = useRef(false);
  const load = useCallback(async () => {
    const version = ++generation.current;
    try {
      const result = await listCodexTasks();
      if (alive.current && version === generation.current) setOverview(result);
    } catch (reason) {
      if (alive.current && version === generation.current) setError(reason instanceof Error ? reason.message : "无法读取任务。");
    } finally { if (alive.current && version === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    alive.current = true;
    // Session-backed I/O begins after mount; this is not a derived-state effect.
    queueMicrotask(() => { if (alive.current) void load(); });
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20_000);
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { alive.current = false; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [load]);
  useEffect(() => { try { localStorage.setItem(storageKey(userId), JSON.stringify(draft)); } catch { /* Disabled storage must not block dispatch. */ } }, [draft, userId]);

  const devices = overview?.devices.filter((device) => !device.revokedAt) ?? [];
  const targetDevice = devices.find((device) => device.id === draft.target);
  const projects = draft.target === "cloud" ? overview?.cloudProjects ?? [] : targetDevice?.projects ?? [];
  const projectId = projects.some((project) => project.id === draft.projectId) ? draft.projectId : projects[0]?.id ?? "";
  const project = projects.find((item) => item.id === projectId);
  const pending = !!draft.pending;
  const ready = !!overview && !!projectId && (draft.target === "cloud" ? overview.cloudEnabled : !!targetDevice);
  const update = (key: keyof Draft, value: string) => setDraft((previous) => ({ ...previous, [key]: value, ...(key === "target" ? { projectId: "" } : {}) }));
  const rememberTask = (task: CodexTask) => {
    if (!alive.current) return;
    // In-flight list requests predate this mutation and must not erase its receipt.
    generation.current++;
    setOverview((previous) => previous && ({ ...previous, tasks: [task, ...previous.tasks.filter((item) => item.id !== task.id)] }));
    setSelected(task.id);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (locked.current || (!draft.pending && (!ready || !draft.title.trim() || !draft.prompt.trim()))) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    const input = draft.pending ?? { requestId: crypto.randomUUID(), title: draft.title.trim(), prompt: draft.prompt.trim(), acceptance: draft.acceptance.trim(), targetKind: draft.target === "cloud" ? "cloud" as const : "device" as const, deviceId: draft.target === "cloud" ? null : draft.target, projectId };
    setDraft((previous) => ({ ...previous, pending: input }));
    try {
      const task = await createCodexTask(input);
      if (!alive.current) return;
      rememberTask(task);
      setDraft((previous) => ({ ...previous, title: "", prompt: "", acceptance: "", pending: undefined }));
      setNotice("任务已保存，执行位置已固定。");
    } catch (reason) {
      if (!alive.current) return;
      setError(reason instanceof Error ? reason.message : "发布结果尚未确认，请核对并重试。");
      // Explicit validation/auth rejections happened before enqueue; unknown results keep the original id and payload.
      if (reason instanceof CodexApiError && [400, 401, 403, 413, 422].includes(reason.status)) setDraft((previous) => ({ ...previous, pending: undefined }));
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  const action = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { await work(); } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "操作未完成，请重试。"); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  const deviceName = (id: string | null) => overview?.devices.find((device) => device.id === id)?.name ?? (id ? "已移除设备" : "未接收");

  return <section className="workspace codex-workspace" aria-label="Codex 任务">
    <div className="heading-row"><div><h1>交给 Codex</h1><p>选定执行位置，写清要求，随时回来查看结果。</p></div><button className="secondary" disabled={busy || loading} onClick={() => { setError(""); void load(); }}><RefreshCw size={15} />刷新任务</button></div>
    {error && <div className="notice" role="alert"><span>{error}</span></div>}
    {notice && <p className="codex-feedback" role="status"><Check size={15} />{notice}</p>}
    {loading && <p role="status"><LoaderCircle className="spin" size={16} /> 正在连接任务服务…</p>}
    <div className="codex-layout">
      <form className="codex-compose" onSubmit={(event) => void submit(event)}>
        <div className="codex-section-title"><Terminal size={18} /><h2>发布任务</h2></div>
        <fieldset disabled={busy || pending}>
          <label><span>执行位置</span><select aria-label="执行位置" value={draft.target} onChange={(event) => update("target", event.target.value)}>
            <option value="cloud">Codex 云端</option>
            {devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.platform === "windows" ? "Windows" : "Mac"}{online(device) ? " · 在线" : " · 离线排队"}</option>)}
            {!devices.some((device) => device.platform === "windows") && <option disabled>Windows · 尚未配对</option>}
            {!devices.some((device) => device.platform === "macos") && <option disabled>Mac · 尚未配对</option>}
          </select></label>
          <p className="codex-target-note">{draft.target === "cloud" ? <><Cloud size={16} />{overview?.cloudEnabled ? "云端执行，两台电脑关机也能继续。" : "云端委派尚未配置，请完成 GitHub 与 Codex 连接。"}</> : <><Monitor size={16} />{targetDevice ? online(targetDevice) ? `仅由 ${targetDevice.name} 接收，不会转交其他位置。` : `${targetDevice.name} 当前离线，任务会排队等待，不会转交云端。` : "设备不可用，请重新选择已配对设备。"}</>}</p>
          <label><span>项目</span><select aria-label="项目" value={projectId} onChange={(event) => update("projectId", event.target.value)}>{!projects.length && <option value="">请先配置目标项目</option>}{projects.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          {draft.target === "cloud" && project?.isPublic && <p className="codex-public-note">这是公开仓库，任务内容将发布到公开 GitHub PR。</p>}
          <label><span>任务标题</span><input aria-label="任务标题" required maxLength={240} value={draft.title} onChange={(event) => update("title", event.target.value)} placeholder="例如：修复手机端搜索问题" /></label>
          <label><span>任务描述</span><textarea aria-label="任务描述" required maxLength={20_000} rows={5} value={draft.prompt} onChange={(event) => update("prompt", event.target.value)} placeholder="希望完成什么？相关文件、问题表现和限制是什么？" /></label>
          <label><span>验收要求 <small>选填</small></span><textarea aria-label="验收要求" maxLength={4_000} rows={2} value={draft.acceptance} onChange={(event) => update("acceptance", event.target.value)} placeholder="做到什么程度算完成，需要运行哪些检查？" /></label>
        </fieldset>
        {pending && !busy && <p className="codex-public-note">上次发布结果尚未确认，重试会核对同一任务，避免重复执行。</p>}
        <button className="primary codex-publish" disabled={busy || (!pending && !ready)}>{busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{pending ? "核对并重试" : "发布任务"}</button>
      </form>
      <div className="codex-history">
        <div className="codex-section-title"><h2>任务记录</h2><span>{overview?.tasks.length ?? 0} 项</span></div>
        {!overview?.tasks.length && !loading && <div className="codex-empty"><Terminal size={25} /><p>把第一个任务交给 Codex。</p><small>接收位置、执行结果和需要你处理的问题都会留在这里。</small></div>}
        {overview?.tasks.map((task) => <article className="codex-task" key={task.id}>
          <button className="codex-task-toggle" aria-expanded={selected === task.id} onClick={() => setSelected(selected === task.id ? null : task.id)}><strong>{task.title}</strong><span className={`codex-status status-${task.status}`}>{task.targetKind === "cloud" && task.status === "cancel_requested" ? "已停止后续派发" : STATUS[task.status] ?? task.status}</span><small>{task.targetKind === "cloud" ? "Codex 云端" : deviceName(task.deviceId)} · {time(task.createdAt)}</small></button>
          {selected === task.id && <div className="codex-detail">
            <dl><dt>指定执行位置</dt><dd>{task.targetKind === "cloud" ? "Codex 云端" : deviceName(task.deviceId)}</dd><dt>实际接收</dt><dd>{task.actualDeviceId ? deviceName(task.actualDeviceId) : task.targetKind === "cloud" && task.cloudUrl && ["acknowledged", "result_ready"].includes(task.status) ? "查看云端任务回执" : "尚未收到回执"}</dd><dt>开始时间</dt><dd>{time(task.startedAt)}</dd><dt>最近更新</dt><dd>{time(task.updatedAt)}</dd></dl>
            <h3>任务要求</h3><p className="codex-preserve">{task.prompt}</p>{task.acceptance && <><h3>验收要求</h3><p className="codex-preserve">{task.acceptance}</p></>}
            {/* Device summaries contain heartbeat progress that can outlive execution; terminal receipts use result/error. */}
            {task.summary && !(task.targetKind === "device" && ["succeeded", "failed", "cancelled", "needs_attention"].includes(task.status)) && <p className="codex-preserve">{task.summary}</p>}{task.result && <><h3>执行结果</h3><pre>{task.result}</pre></>}{task.error && <p className="codex-task-error" role="status">{task.error}</p>}
            <div className="codex-task-actions">{safeLink(task.cloudUrl) && <a href={safeLink(task.cloudUrl)!} target="_blank" rel="noreferrer"><Link2 size={15} />打开任务 / PR</a>}{task.targetKind === "cloud" && <button className="secondary" disabled={busy} onClick={() => void action(async () => rememberTask(await syncCodexTask(task.id)))}>核对云端结果</button>}{(task.targetKind === "device" ? ["queued", "running"].includes(task.status) : ["queued", "dispatching", "submitted", "acknowledged", "result_ready", "needs_attention"].includes(task.status)) && <button className="secondary" disabled={busy} onClick={() => void action(async () => rememberTask(await cancelCodexTask(task.id)))}>{task.targetKind === "cloud" && !["queued", "needs_attention"].includes(task.status) ? "停止后续派发" : "取消任务"}</button>}</div>
          </div>}
        </article>)}
      </div>
    </div>
    <section className="codex-devices" aria-label="连接电脑"><div><h2>连接你的电脑</h2><p>Windows 和 Mac 各配对一次，使用该设备已登录的 Codex。项目路径只保存在对应电脑。</p></div>
      <div className="codex-device-actions"><a className="secondary" href="/codex-receiver.zip" download><Download size={16} />下载接收端安装包</a><button className="secondary" disabled={busy || !overview} onClick={() => void action(async () => { const result = await generatePairCode(); if (alive.current) setPair(result); })}><Laptop size={16} />生成配对码</button></div>
      {pair && <div className="codex-pair" role="status"><p>在需要接收任务的电脑上，按安装包里的说明输入此一次性配对码。</p><code>{pair.code}</code><button className="secondary" disabled={busy} onClick={() => void action(async () => { if (!navigator.clipboard) throw new Error("浏览器不支持复制，请手动选中配对码复制。"); await navigator.clipboard.writeText(pair.code); if (alive.current) setNotice("配对码已复制。"); })}>复制配对码</button><small>有效期至 {time(pair.expiresAt)}，不要发给其他人。</small></div>}
      {devices.map((device) => <div className="codex-device" key={device.id}><span>{device.platform === "windows" ? <Monitor size={17} /> : <Laptop size={17} />}{device.name}</span><small>{online(device) ? "在线" : "离线"} · 最近在线 {time(device.lastSeenAt)}</small><button className="secondary" disabled={busy} onClick={() => void action(async () => { await revokeCodexDevice(device.id); if (alive.current) { setNotice("设备已断开授权，不能再接收任务。"); await load(); } })}><Unplug size={14} />断开授权</button></div>)}
    </section>
  </section>;
}
