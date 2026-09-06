"use client";

import { KeyRound, Laptop, LogOut, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AuthStorageMode } from "@/lib/supabase-client";

export type SignOutRequest = { scope: "local" | "global"; clearLocalData: boolean };

type AccountPanelProps = {
  email: string;
  authMode: AuthStorageMode;
  onUpdatePassword: (password: string) => Promise<void>;
  onSignOut: (request: SignOutRequest) => Promise<void>;
};

export function AccountPanel({ email, authMode, onUpdatePassword, onSignOut }: AccountPanelProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const actionInFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    // StrictMode intentionally runs setup -> cleanup -> setup in development.
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const updatePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (actionInFlight.current) return;
    if (password.length < 8) { setError("密码至少需要 8 个字符。"); return; }
    if (password !== confirmation) { setError("两次输入的密码不一致。"); return; }
    actionInFlight.current = true;
    setPendingAction("password");
    setError("");
    setMessage("");
    try {
      await onUpdatePassword(password);
      if (!mounted.current) return;
      setPassword("");
      setConfirmation("");
      setMessage("密码已更新。");
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "密码更新失败");
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setPendingAction("");
    }
  };

  const signOut = async (request: SignOutRequest, action: string) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setPendingAction(action);
    setError("");
    setMessage("");
    try {
      await onSignOut(request);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "退出失败");
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setPendingAction("");
    }
  };

  const busy = Boolean(pendingAction);
  const rawBuildSha = import.meta.env.VITE_BUILD_SHA?.trim() ?? "";
  const buildLabel = /^[0-9a-f]{7,64}$/i.test(rawBuildSha) ? `版本 ${rawBuildSha.slice(0, 7)}` : "开发版";
  return <div className="account-panel">
    <section className="account-summary">
      <span className="account-panel-icon"><Laptop size={19} /></span>
      <div><p className="eyebrow">PERSONAL ACCOUNT</p><h1>个人账号</h1><p>{email}</p><p>{buildLabel}</p></div>
      <span className="session-mode"><ShieldCheck size={14} />{authMode === "persistent" ? "此设备保持登录" : "仅当前浏览器会话"}</span>
    </section>

    <section className="account-section">
      <div><h2>修改密码</h2><p>密码交由浏览器密码管理器保存，本应用不会写入本机缓存。</p></div>
      <form className="account-password-form" onSubmit={updatePassword}>
        <label><span>新密码</span><input aria-label="新密码" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label><span>确认新密码</span><input aria-label="确认新密码" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <button className="primary" disabled={busy}><KeyRound size={15} />{pendingAction === "password" ? "正在更新…" : "更新密码"}</button>
      </form>
    </section>

    <section className="account-section signout-section">
      <div><h2>退出登录</h2><p>普通退出保留本机卡片缓存和草稿；清理入口只删除当前账号的数据。</p></div>
      <div className="account-actions">
        <button disabled={busy} onClick={() => void signOut({ scope: "local", clearLocalData: false }, "local")}><LogOut size={15} />退出当前设备</button>
        <button disabled={busy} onClick={() => void signOut({ scope: "global", clearLocalData: false }, "global")}><LogOut size={15} />退出所有设备</button>
        <button className="danger" disabled={busy} onClick={() => void signOut({ scope: "local", clearLocalData: true }, "clear")}><Trash2 size={15} />退出并清除本机数据</button>
      </div>
    </section>

    {error && <p className="account-panel-message error" role="alert">{error}</p>}
    {message && <p className="account-panel-message" role="status">{message}</p>}
  </div>;
}
