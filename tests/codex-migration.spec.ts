import { readFileSync, existsSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, test } from 'vitest';

const migrationUrl = new URL('../supabase/migrations/20261025_codex_tasks.sql', import.meta.url);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
let db: PGlite;
async function rpc(name: string, params: unknown[]) {
  const { rows } = await db.query<{ value: Record<string, unknown> }>(
    `select ${name}(${params.map((_, i) => `$${i + 1}`).join(',')}) as value`, params,
  );
  return rows[0].value;
}
const user = (action: string, body = {}, who = owner) => rpc('codex_user_action', [who, action, JSON.stringify(body)]);
const runner = (hash: string, action: string, body = {}) => rpc('codex_runner_action', [hash, action, JSON.stringify(body)]);
async function pair(suffix: string, who = owner, platform = 'windows') {
  await user('pair-code', { codeHash: `code-${suffix}` }, who);
  return runner('', 'pair', { codeHash: `code-${suffix}`, tokenHash: `token-${suffix}`, name: suffix, platform, projects: [{ id: 'project', label: '项目' }] });
}
async function create(deviceId: unknown, requestId = crypto.randomUUID(), who = owner) {
  return user('create', { requestId, title: '修复测试', prompt: '保留用户工作', acceptance: '测试通过', targetKind: 'device', deviceId, projectId: 'project' }, who);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  if (existsSync(migrationUrl)) await db.exec(readFileSync(migrationUrl, 'utf8'));
});
afterAll(async () => { await db.close(); });

test('pairing is single use and expired codes cannot create a device', async () => {
  await expect(pair('one')).resolves.toHaveProperty('deviceId');
  await expect(runner('', 'pair', { codeHash: 'code-one', tokenHash: 'another', name: 'again', platform: 'windows', projects: [{ id: 'project', label: 'p' }] })).rejects.toThrow('PAIR_INVALID');
  await user('pair-code', { codeHash: 'expired' });
  await db.exec("update codex_pair_codes set expires_at = now() - interval '1 second' where code_hash = 'expired'");
  await expect(runner('', 'pair', { codeHash: 'expired', tokenHash: 'expired-token', name: 'expired', platform: 'macos', projects: [] })).rejects.toThrow('PAIR_INVALID');
});

test('owner request id is idempotent and another owner cannot target a device', async () => {
  const device = await pair('two');
  const requestId = crypto.randomUUID();
  const [a, b] = await Promise.all([create(device.deviceId, requestId), create(device.deviceId, requestId)]);
  expect(a.task).toEqual(b.task);
  await expect(create(device.deviceId, crypto.randomUUID(), other)).rejects.toThrow('DEVICE_FORBIDDEN');
  await expect(user('create', { requestId: crypto.randomUUID(), title: 'x', prompt: 'x', targetKind: 'device', deviceId: device.deviceId, projectId: 'missing', acceptance: '' })).rejects.toThrow('PROJECT_FORBIDDEN');
});

test('a request id cannot be retargeted to a different device or project', async () => {
  const a = await pair('target-a');
  const b = await pair('target-b');
  const requestId = crypto.randomUUID();
  const first = await create(a.deviceId, requestId);
  await expect(create(b.deviceId, requestId)).rejects.toThrow('REQUEST_CONFLICT');
  await expect(user('create', { requestId, title: 'x', prompt: 'x', acceptance: '', targetKind: 'cloud', deviceId: null, projectId: 'project' })).rejects.toThrow('REQUEST_CONFLICT');
  await expect(user('create', { requestId, title: 'x', prompt: 'x', acceptance: '', targetKind: 'device', deviceId: a.deviceId, projectId: 'different' })).rejects.toThrow('REQUEST_CONFLICT');
  expect((await user('get', { taskId: (first.task as { id: string }).id })).task).toEqual(first.task);
});

test('concurrent consumes of a single pairing code create exactly one device', async () => {
  await user('pair-code', { codeHash: 'race-code' });
  const body = { codeHash: 'race-code', name: 'pair race', platform: 'windows', projects: [{ id: 'project', label: 'p' }] };
  const attempts = await Promise.allSettled([
    runner('', 'pair', { ...body, tokenHash: 'race-one' }),
    runner('', 'pair', { ...body, tokenHash: 'race-two' }),
  ]);
  expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
  expect((await db.query('select id from codex_devices where token_hash in ($1,$2)', ['race-one', 'race-two'])).rows).toHaveLength(1);
});

test('concurrent claims claim once and cannot cross devices or owners', async () => {
  const device = await pair('three');
  await pair('foreign', other, 'macos');
  const created = await create(device.deviceId);
  expect((await runner('token-foreign', 'claim')).task).toBeNull();
  const claims = await Promise.all([runner('token-three', 'claim'), runner('token-three', 'claim')]);
  const received = claims.filter((r) => r.task !== null);
  expect(received).toHaveLength(1);
  expect(received[0].task).toMatchObject({ id: (created.task as { id: string }).id, projectId: 'project' });
  expect(received[0]).toHaveProperty('leaseSeconds', 90);
});

test('old run tokens are rejected; a lost lease is attention and is never reexecuted', async () => {
  const device = await pair('four');
  await create(device.deviceId);
  const { task } = await runner('token-four', 'claim') as { task: { id: string; runToken: string } };
  await expect(runner('token-four', 'progress', { taskId: task.id, runToken: crypto.randomUUID(), summary: 'wrong' })).rejects.toThrow('RUN_CONFLICT');
  await db.query("update codex_tasks set lease_until = now() - interval '1 second' where id = $1", [task.id]);
  expect((await runner('token-four', 'claim')).task).toBeNull();
  const state = await db.query<{ status: string }>('select status from codex_tasks where id=$1', [task.id]);
  expect(state.rows[0].status).toBe('needs_attention');
  await expect(runner('token-four', 'complete', { taskId: task.id, runToken: task.runToken, status: 'succeeded', result: 'late', error: '', sessionId: null })).rejects.toThrow('RUN_CONFLICT');
});

test('late progress commits lease expiry and cannot revive the run', async () => {
  const device = await pair('late-progress');
  await create(device.deviceId);
  const { task } = await runner('token-late-progress', 'claim') as { task: { id: string; runToken: string } };
  await db.query("update codex_tasks set lease_until = now() - interval '1 second' where id=$1", [task.id]);
  expect(await runner('token-late-progress', 'progress', { taskId: task.id, runToken: task.runToken, summary: 'late' })).toEqual({ error: 'RUN_CONFLICT' });
  expect((await db.query<{ status: string }>('select status from codex_tasks where id=$1', [task.id])).rows[0].status).toBe('needs_attention');
  expect((await runner('token-late-progress', 'claim')).task).toBeNull();
});

test('revocation immediately rejects heartbeat, claim, progress, and result', async () => {
  const device = await pair('five');
  await create(device.deviceId);
  const { task } = await runner('token-five', 'claim') as { task: { id: string; runToken: string } };
  await user('revoke-device', { deviceId: device.deviceId });
  for (const action of ['heartbeat', 'claim', 'progress', 'complete']) {
    await expect(runner('token-five', action, { projects: [], taskId: task.id, runToken: task.runToken, status: 'succeeded', result: '', error: '', sessionId: null })).rejects.toThrow('DEVICE_UNAUTHORIZED');
  }
  const { devices } = await user('list');
  expect(JSON.stringify(devices)).not.toContain('token-five');
  expect(JSON.stringify(devices)).not.toContain('tokenHash');
});

test('cancellation is returned on progress and another owner cannot cancel the run', async () => {
  const device = await pair('six');
  await create(device.deviceId);
  const { task } = await runner('token-six', 'claim') as { task: { id: string; runToken: string } };
  await expect(user('cancel', { taskId: task.id }, other)).rejects.toThrow('TASK_NOT_FOUND');
  await user('cancel', { taskId: task.id });
  expect(await runner('token-six', 'progress', { taskId: task.id, runToken: task.runToken, summary: '正在停止' })).toMatchObject({ cancelRequested: true, leaseSeconds: 90 });
  await runner('token-six', 'complete', { taskId: task.id, runToken: task.runToken, status: 'cancelled', result: '', error: '', sessionId: null });
  expect((await db.query<{ status: string }>('select status from codex_tasks where id=$1', [task.id])).rows[0].status).toBe('cancelled');
});

test('migration can repeat without losing tasks and browser roles have no database execution rights', async () => {
  const before = await db.query('select id from codex_tasks');
  await db.exec(readFileSync(migrationUrl, 'utf8'));
  expect((await db.query('select id from codex_tasks')).rows).toEqual(before.rows);
  for (const role of ['anon', 'authenticated']) {
    const permissions = await db.query<{ allowed: boolean }>('select has_function_privilege($1, $2, $3) as allowed', [role, 'codex_user_action(uuid,text,jsonb)', 'EXECUTE']);
    expect(permissions.rows[0].allowed).toBe(false);
    const tables = await db.query<{ allowed: boolean }>('select has_table_privilege($1,$2,$3) as allowed', [role, 'codex_tasks', 'UPDATE']);
    expect(tables.rows[0].allowed).toBe(false);
  }
});

test('a deployment error rolls back a migration even when a runner sends separate SQL chunks', async () => {
  const isolated = new PGlite();
  try {
    await isolated.exec('create role anon; create role authenticated;');
    const sql = readFileSync(migrationUrl, 'utf8');
    const grantBoundary = sql.indexOf('grant all on public.codex_devices');
    await isolated.exec(sql.slice(0, grantBoundary));
    // The absent service_role intentionally fails a later statement after tables were created.
    await expect(isolated.exec(sql.slice(grantBoundary))).rejects.toThrow('service_role');
    await isolated.exec('rollback;');
    const state = await isolated.query<{ table_name: string | null }>("select to_regclass('public.codex_tasks')::text as table_name");
    expect(state.rows[0].table_name).toBeNull();
  } finally { await isolated.close(); }
});
