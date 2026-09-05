import { KeyRound, LoaderCircle, LockKeyhole, Mail, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthChangeEvent, Session, SupabaseClient } from "@supabase/supabase-js";
import type { SignOutRequest } from "@/app/components/AccountPanel";
import { IdeaBoard } from "@/app/components/IdeaBoard";
import { clearAttachmentUrlCache } from "@/lib/supabase-board";
import { clearUserLocalState, readRememberedEmail, setRememberedLogin, withTimeout } from "@/lib/local-state";
import { configureSupabaseAuthMode, getSupabaseAuthError, getSupabaseAuthMode, supabase } from "@/lib/supabase-client";
import type { AuthStorageMode } from "@/lib/supabase-client";

export default function App() {
  const [client, setClient] = useState<SupabaseClient | null>(() => supabase);
  const [authMode, setAuthMode] = useState<AuthStorageMode>(() => getSupabaseAuthMode());
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(client));
  const [authError, setAuthError] = useState(() => getSupabaseAuthError()?.message ?? "");
  const [configurationRetrying, setConfigurationRetrying] = useState(false);
  const [clientRevision, setClientRevision] = useState(0);
  const [recovery, setRecovery] = useState(false);
  const activeClientRef = useRef<SupabaseClient | null>(client);
  const authGenerationRef = useRef(0);
  const sessionRevisionRef = useRef(0);
  const identityGenerationRef = useRef(0);
  const [identityGeneration, setIdentityGeneration] = useState(0);
  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);
  const skipNextRestorationRef = useRef(false);

  const commitSession = useCallback((nextSession: Session | null) => {
    if (sessionRef.current?.user.id !== nextSession?.user.id) {
      identityGenerationRef.current += 1;
      setIdentityGeneration(identityGenerationRef.current);
    }
    sessionRef.current = nextSession;
    setSession(nextSession);
  }, []);

  const loadSession = useCallback(async () => {
    const target = activeClientRef.current;
    if (!target) return;
    // A direct sign-in or newer auth event is already authoritative. Starting a
    // restoration read afterwards would let its older snapshot clear that user.
    if (sessionRef.current) {
      setLoading(false);
      return;
    }
    const generation = authGenerationRef.current;
    const revision = sessionRevisionRef.current;
    setLoading(true);
    setAuthError("");
    try {
      const { data, error } = await withTimeout(target.auth.getSession(), 10_000, "登录状态检查超时");
      if (error) throw error;
      if (activeClientRef.current !== target
        || authGenerationRef.current !== generation
        || sessionRevisionRef.current !== revision) return;
      commitSession(data.session);
    } catch (reason) {
      if (activeClientRef.current === target
        && authGenerationRef.current === generation
        && sessionRevisionRef.current === revision) {
        setAuthError(reason instanceof Error ? reason.message : "无法确认登录状态");
      }
    } finally {
      if (activeClientRef.current === target && authGenerationRef.current === generation) setLoading(false);
    }
  }, [commitSession]);

  useEffect(() => {
    if (!client) return;
    const generation = authGenerationRef.current;
    const { data: listener } = client.auth.onAuthStateChange((event: AuthChangeEvent, nextSession) => {
      if (activeClientRef.current !== client || authGenerationRef.current !== generation) return;
      sessionRevisionRef.current += 1;
      if (event === "SIGNED_OUT") setRecovery(false);
      else if (nextSession?.user.id !== sessionRef.current?.user.id && event !== "PASSWORD_RECOVERY") setRecovery(false);
      commitSession(nextSession);
      setLoading(false);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
    });
    subscriptionRef.current = listener.subscription;
    // Explicit login-mode replacement keeps the current form mounted. The SDK
    // still delivers INITIAL_SESSION; only the initial app client needs this
    // additional bounded restoration read.
    if (skipNextRestorationRef.current) skipNextRestorationRef.current = false;
    else void loadSession();
    return () => {
      listener.subscription.unsubscribe();
      if (subscriptionRef.current === listener.subscription) subscriptionRef.current = null;
    };
  }, [client, clientRevision, commitSession, loadSession]);

  const selectAuthMode = useCallback(async (mode: AuthStorageMode) => {
    if (mode === authMode && activeClientRef.current) return activeClientRef.current;
    const generation = authGenerationRef.current + 1;
    authGenerationRef.current = generation;
    sessionRevisionRef.current += 1;
    subscriptionRef.current?.unsubscribe();
    subscriptionRef.current = null;
    commitSession(null);
    setRecovery(false);
    setAuthError("");
    try {
      const nextClient = await configureSupabaseAuthMode(mode);
      if (authGenerationRef.current !== generation) return nextClient;
      activeClientRef.current = nextClient;
      setAuthMode(mode);
      skipNextRestorationRef.current = true;
      setClient(nextClient);
      setLoading(false);
      return nextClient;
    } catch (reason) {
      if (authGenerationRef.current === generation) {
        activeClientRef.current = supabase;
        setLoading(false);
        if (supabase) {
          setClient(supabase);
          skipNextRestorationRef.current = true;
          setClientRevision((value) => value + 1);
        } else {
          // Preserve the user's requested mode so the explicit retry builds the
          // same kind of client rather than silently reverting persistence.
          setAuthMode(mode);
          setAuthError(reason instanceof Error ? reason.message : "认证客户端切换失败");
          setClient(null);
        }
      }
      throw reason;
    }
  }, [authMode, commitSession]);

  const retryConfiguration = useCallback(async () => {
    if (configurationRetrying) return;
    setConfigurationRetrying(true);
    setAuthError("");
    try {
      const nextClient = await configureSupabaseAuthMode(authMode);
      if (!nextClient) throw new Error("尚未配置 Supabase，请检查部署环境变量");
      authGenerationRef.current += 1;
      activeClientRef.current = nextClient;
      setClient(nextClient);
      setLoading(true);
    } catch (reason) {
      setAuthError(reason instanceof Error ? reason.message : "认证客户端初始化失败");
    } finally {
      setConfigurationRetrying(false);
    }
  }, [authMode, configurationRetrying]);

  const acceptSignedInSession = useCallback((source: SupabaseClient, nextSession: Session) => {
    if (activeClientRef.current !== source) return;
    sessionRevisionRef.current += 1;
    commitSession(nextSession);
    setAuthError("");
    setLoading(false);
  }, [commitSession]);

  const updatePassword = useCallback(async (password: string) => {
    const target = activeClientRef.current;
    if (!target) throw new Error("登录状态已失效");
    const { error } = await target.auth.updateUser({ password });
    if (error) throw error;
  }, []);

  const signOut = useCallback(async (request: SignOutRequest) => {
    const target = activeClientRef.current;
    const userId = sessionRef.current?.user.id;
    if (!target || !userId) throw new Error("登录状态已失效");
    const generation = authGenerationRef.current;
    setAuthError("");
    try {
      const { error } = await target.auth.signOut({ scope: request.scope });
      if (error) throw error;
      if (activeClientRef.current !== target || authGenerationRef.current !== generation) return;
      const currentUserId = sessionRef.current?.user.id;
      // A newer identity on the same client owns the UI now. Do not let the
      // earlier account's logout completion sign it out or clear its state.
      if (currentUserId && currentUserId !== userId) return;
      if (currentUserId === userId) {
        sessionRevisionRef.current += 1;
        setRecovery(false);
        commitSession(null);
      }
      if (request.clearLocalData) {
        clearUserLocalState(userId);
        clearAttachmentUrlCache();
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "退出失败";
      const currentUserId = sessionRef.current?.user.id;
      if (activeClientRef.current === target
        && authGenerationRef.current === generation
        && (!currentUserId || currentUserId === userId)) setAuthError(message);
      throw reason instanceof Error ? reason : new Error(message);
    }
  }, [commitSession]);

  if (!client) return <ConfigurationNeeded message={authError} retrying={configurationRetrying} onRetry={retryConfiguration} />;
  if (loading) return <AuthLoading />;
  if (authError && !session) return <AuthFailure message={authError} onRetry={() => void loadSession()} />;
  if (recovery && session) return <UpdatePassword client={client} onDone={() => setRecovery(false)} />;
  if (!session) return <SignIn client={client} authMode={authMode} onSelectMode={selectAuthMode} onSignedIn={acceptSignedInSession} />;
  const boardGeneration = identityGeneration;
  return <IdeaBoard
    // Reset private component state only when identity changes, not on token refresh.
    key={session.user.id}
    userId={session.user.id}
    displayName={session.user.email ?? "我"}
    authMode={authMode}
    isIdentityActive={() => identityGenerationRef.current === boardGeneration
      && sessionRef.current?.user.id === session.user.id}
    onUpdatePassword={updatePassword}
    onSignOut={signOut}
  />;
}

function SignIn({ client, authMode, onSelectMode, onSignedIn }: {
  client: SupabaseClient;
  authMode: AuthStorageMode;
  onSelectMode: (mode: AuthStorageMode) => Promise<SupabaseClient | null>;
  onSignedIn: (client: SupabaseClient, session: Session) => void;
}) {
  const rememberedEmail = readRememberedEmail();
  const [email, setEmail] = useState(rememberedEmail);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(() => authMode === "persistent");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setSending(true);
    setMessage("");
    try {
      const targetMode: AuthStorageMode = remember ? "persistent" : "session";
      const target = targetMode === authMode ? client : await onSelectMode(targetMode);
      if (!target) throw new Error("尚未配置 Supabase");
      const { data, error } = await target.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      setRememberedLogin(email, remember);
      if (data.session) onSignedIn(target, data.session);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "登录失败";
      setMessage(message === "Invalid login credentials" ? "邮箱或密码不正确" : message);
    } finally {
      setSending(false);
    }
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
      <label className="remember-login"><input type="checkbox" checked={remember} onChange={(event) => { const checked = event.target.checked; setRemember(checked); if (!checked) setRememberedLogin(email, false); }} /><span>在这台设备保持登录</span><small>仅建议在私人设备上启用</small></label>
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

function ConfigurationNeeded({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return <main className="auth-shell"><section className="auth-card"><div className="auth-mark"><Sparkles size={20} /></div><h1>{message ? "认证存储暂不可用" : "等待 Supabase 配置"}</h1><p>{message || "请在 Netlify 环境变量中填写 Supabase 项目地址和匿名密钥，然后重新部署。"}</p>{message && <button className="primary auth-retry" disabled={retrying} onClick={onRetry}>{retrying ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}重试初始化</button>}</section></main>;
}
