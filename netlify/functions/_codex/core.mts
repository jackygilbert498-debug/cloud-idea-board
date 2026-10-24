import { createHash, randomBytes } from 'node:crypto';
import type { CodexProject, CreateCodexTaskInput } from '../../../lib/codex-task-model.ts';

export interface Dependencies { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }
export type JsonObject = Record<string, unknown>;
export class ApiFailure extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const projectPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export function invalid(): never { throw new ApiFailure('INVALID_INPUT', 400, '请求字段或长度不正确。'); }
export function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ApiFailure('SERVER_NOT_CONFIGURED', 503, '任务服务尚未配置完成。');
  return value;
}
export function allowedOwners(env: NodeJS.ProcessEnv): string[] {
  const ids = requiredEnv(env, 'CODEX_ALLOWED_USER_IDS').split(/[\s,]+/).filter(Boolean);
  if (!ids.length || ids.some((id) => !uuidPattern.test(id))) throw new ApiFailure('SERVER_NOT_CONFIGURED', 503, '任务服务授权配置不正确。');
  return ids.map((id) => id.toLowerCase());
}
export function bearer(request: Request): string {
  const match = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/i);
  if (!match || match[1].length < 20 || match[1].length > 10000) throw new ApiFailure('UNAUTHENTICATED', 401, '登录或设备凭据已失效。');
  return match[1];
}
export function secret(): string { return randomBytes(32).toString('base64url'); }
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || Array.from(value).length > max || (required && !value.trim())) invalid();
  return value;
}
export function uuid(value: unknown): string { if (typeof value !== 'string' || !uuidPattern.test(value)) invalid(); return value; }
export function projectId(value: unknown): string { if (typeof value !== 'string' || !projectPattern.test(value)) invalid(); return value; }
export function projects(value: unknown): CodexProject[] {
  if (!Array.isArray(value) || value.length > 30) invalid();
  const result = value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid();
    const entry = item as JsonObject;
    if (Object.keys(entry).some((key) => key !== 'id' && key !== 'label')) invalid();
    return { id: projectId(entry.id), label: text(entry.label, 100, true) };
  });
  if (new Set(result.map((p) => p.id)).size !== result.length) invalid();
  return result;
}
export function createInput(body: JsonObject): CreateCodexTaskInput {
  if (body.targetKind !== 'cloud' && body.targetKind !== 'device') invalid();
  if (body.targetKind === 'cloud' && body.deviceId != null) invalid();
  return { requestId: uuid(body.requestId), title: text(body.title, 240, true), prompt: text(body.prompt, 20000, true),
    acceptance: text(body.acceptance ?? '', 4000), targetKind: body.targetKind,
    deviceId: body.targetKind === 'device' ? uuid(body.deviceId) : null, projectId: projectId(body.projectId) };
}

/** Bound actual stream bytes, including requests that omit Content-Length. */
export async function readBody(request: Request): Promise<JsonObject> {
  const limit = 150000;
  if (Number(request.headers.get('content-length')) > limit) throw new ApiFailure('PAYLOAD_TOO_LARGE', 413, '请求内容过大。');
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiFailure('INVALID_INPUT', 400, '请求必须使用 JSON。');
  const reader = request.body?.getReader();
  if (!reader) invalid();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ApiFailure('PAYLOAD_TOO_LARGE', 413, '请求内容过大。'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
    return parsed as JsonObject;
  } catch (error) { if (error instanceof ApiFailure) throw error; invalid(); }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}
export function failureResponse(error: unknown): Response {
  const failure = error instanceof ApiFailure ? error : new ApiFailure('INTERNAL_ERROR', 500, '任务服务暂时无法完成请求。');
  if (failure.status >= 500) console.error('codex request failed', { code: failure.code, status: failure.status });
  return json({ error: { code: failure.code, message: failure.message } }, failure.status);
}
function dbFailure(code: unknown): ApiFailure {
  const failures: Record<string, [number, string]> = {
    DEVICE_UNAUTHORIZED: [401, '设备凭据已失效或设备已撤销。'], PAIR_INVALID: [401, '配对码无效、已使用或已过期。'],
    DEVICE_FORBIDDEN: [403, '无法使用此设备。'], PROJECT_FORBIDDEN: [403, '此项目不在指定设备允许列表中。'],
    TASK_NOT_FOUND: [404, '找不到此任务。'], RUN_CONFLICT: [409, '执行凭据或租约已失效，请停止本次执行。'],
    REQUEST_CONFLICT: [409, '此发布请求已绑定其他执行位置或项目，请使用新的请求 ID。'],
    TASK_CANCELLED: [409, '任务已取消后续派发。'], INVALID_INPUT: [400, '请求字段或长度不正确。'], INVALID_ACTION: [400, '不支持此操作。'],
  };
  const key = typeof code === 'string' ? code : '';
  const safe = failures[key];
  return safe ? new ApiFailure(key, safe[0], safe[1]) : new ApiFailure('DATABASE_UNAVAILABLE', 503, '任务存储服务暂时不可用。');
}

export function services({ env = process.env, fetchImpl = fetch }: Dependencies = {}) {
  const base = () => {
    const value = requiredEnv(env, 'SUPABASE_URL').replace(/\/$/, '');
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new ApiFailure('SERVER_NOT_CONFIGURED', 503, '任务服务配置不正确。'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new ApiFailure('SERVER_NOT_CONFIGURED', 503, '任务服务配置不正确。');
    return value;
  };
  async function rpc<T>(name: 'codex_user_action' | 'codex_runner_action' | 'codex_cloud_action', args: JsonObject): Promise<T> {
    const key = requiredEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
    let response: Response;
    try {
      response = await fetchImpl(`${base()}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(8000), cache: 'no-store' });
    } catch (error) { if (error instanceof ApiFailure) throw error; throw new ApiFailure('DATABASE_UNAVAILABLE', 503, '任务存储服务暂时不可用。'); }
    const data = await response.json().catch(() => null) as JsonObject | null;
    if (!response.ok) throw dbFailure(data?.message);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw dbFailure(null);
    if (typeof data.error === 'string') throw dbFailure(data.error);
    return data as T;
  }
  async function user(request: Request): Promise<string> {
    const token = bearer(request);
    const owners = allowedOwners(env);
    const key = requiredEnv(env, 'SUPABASE_SERVICE_ROLE_KEY');
    let response: Response;
    try {
      response = await fetchImpl(`${base()}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000), cache: 'no-store' });
    } catch (error) { if (error instanceof ApiFailure) throw error; throw new ApiFailure('AUTH_UNAVAILABLE', 503, '暂时无法验证登录状态。'); }
    if (!response.ok) throw new ApiFailure(response.status >= 500 ? 'AUTH_UNAVAILABLE' : 'UNAUTHENTICATED', response.status >= 500 ? 503 : 401, '无法验证登录状态。');
    const data = await response.json().catch(() => null) as JsonObject | null;
    if (typeof data?.id !== 'string' || !uuidPattern.test(data.id)) throw new ApiFailure('UNAUTHENTICATED', 401, '登录已失效。');
    if (!owners.includes(data.id.toLowerCase())) throw new ApiFailure('OWNER_FORBIDDEN', 403, '此账号未获授权派发任务。');
    return data.id.toLowerCase();
  }
  return { env, fetchImpl, rpc, user };
}
export type Services = ReturnType<typeof services>;
