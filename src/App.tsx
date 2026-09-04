import { KeyRound, LoaderCircle, LockKeyhole, Mail, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { IdeaBoard } from "@/app/components/IdeaBoard";
import { withTimeout } from "@/lib/local-state";
import { supabase } from "@/lib/supabase-client";

export default function App() {
  const client = supabase;
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(client));
  const [authError, setAuthError] = useState("");
  const [recovery, setRecovery] = useState(false);

  const loadSession = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setAuthError("");
    try {
      const { data, error } = await withTimeout(client.auth.getSession(), 10_000, "登录状态检查超时");
      if (error) throw error;
      setSession(data.session);
    } catch (reason) {
      setAuthError(reason instanceof Error ? reason.message : "无法确认登录状态");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    // Initial auth restoration must run when the configured client becomes available.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSession();
    const { data: listener } = client.auth.onAuthStateChange((event: AuthChangeEvent, nextSession) => {
      setSession(nextSession);
      setLoading(false);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
    });
    return () => listener.subscription.unsubscribe();
  }, [client, loadSession]);

  if (!client) return <ConfigurationNeeded />;
  if (loading) return <AuthLoading />;
  if (authError && !session) return <AuthFailure message={authError} onRetry={() => void loadSession()} />;
  if (recovery && session) return <UpdatePassword client={client} onDone={() => setRecovery(false)} />;
  if (!session) return <SignIn client={client} />;
  return <IdeaBoard
    // Reset private component state only when identity changes, not on token refresh.
    key={session.user.id}
    userId={session.user.id}
    displayName={session.user.email ?? "我"}
    onSignOut={() => void client.auth.signOut()}
  />;
}

function SignIn({ client }: { client: NonNullable<typeof supabase> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setSending(true);
    setMessage("");
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    setSending(false);
    if (error) setMessage(error.message === "Invalid login credentials" ? "邮箱或密码不正确" : error.message);
  };
  const resetPassword = async () => {
    if (!email.trim()) {
      setMessage("请先填写邮箱，再发送重置链接。");
      return;
    }
    setSending(true);
    setMessage("");
    const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    setSending(false);
    setMessage(error ? error.message : "密码重置链接已发送，请在邮箱中打开。");
  };

  return <main className="auth-shell"><section className="auth-card" aria-label="云端构思板">
    <div className="auth-mark"><Sparkles size={20} /></div>
    <p className="eyebrow">PERSONAL MEMO BOARD</p><h1>云端构思板</h1>
    <p>用管理员分配的邮箱和密码继续。</p><div className="auth-note">账号由管理员创建，无需邮件确认。</div>
    <form onSubmit={submit}>
      <label><span>邮箱</span><div className="auth-input"><Mail size={16} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" required /></div></label>
      <label><span>密码</span><div className="auth-input"><LockKeyhole size={16} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入密码" autoComplete="current-password" required /></div></label>
      <button className="primary" disabled={sending}>{sending ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}登录</button>
      <button className="auth-link" type="button" disabled={sending} onClick={() => void resetPassword()}>忘记密码</button>
    </form>{message && <p className="auth-message" role="status">{message}</p>}
  </section></main>;
}

function UpdatePassword({ client, onDone }: { client: NonNullable<typeof supabase>; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 8) { setMessage("密码至少需要 8 个字符。"); return; }
    if (password !== confirmation) { setMessage("两次输入的密码不一致。"); return; }
    setSaving(true);
    const { error } = await client.auth.updateUser({ password });
    setSaving(false);
    if (error) setMessage(error.message);
    else onDone();
  };
  return <main className="auth-shell"><section className="auth-card"><div className="auth-mark"><KeyRound size={20} /></div><h1>设置新密码</h1><p>更新后即可继续使用云端构思板。</p><form onSubmit={submit}><label><span>新密码</span><div className="auth-input"><LockKeyhole size={16} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required /></div></label><label><span>再次输入</span><div className="auth-input"><LockKeyhole size={16} /><input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" required /></div></label><button className="primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : "保存新密码"}</button></form>{message && <p className="auth-message" role="status">{message}</p>}</section></main>;
}

function AuthLoading() {
  return <div className="auth-shell"><LoaderCircle className="spin" size={21} />正在确认登录状态…</div>;
}

function AuthFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <main className="auth-shell"><section className="auth-card"><div className="auth-mark"><RefreshCw size={20} /></div><h1>暂时无法连接</h1><p>{message}</p><button className="primary auth-retry" onClick={onRetry}><RefreshCw size={16} />重新连接</button></section></main>;
}

function ConfigurationNeeded() {
  return <main className="auth-shell"><section className="auth-card"><div className="auth-mark"><Sparkles size={20} /></div><h1>等待 Supabase 配置</h1><p>请在 Netlify 环境变量中填写 Supabase 项目地址和匿名密钥，然后重新部署。</p></section></main>;
}
