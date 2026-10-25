import { afterAll, beforeAll, expect, test } from 'vitest';
import { createCodexTasksHandler } from '../netlify/functions/codex-tasks.mts';
import { createCodexRunnerHandler } from '../netlify/functions/codex-runner.mts';
import { backendFixture, request, testEnv, ownerId } from './codex-backend-fixtures.ts';

let fixture: Awaited<ReturnType<typeof backendFixture>>;
let tasks: ReturnType<typeof createCodexTasksHandler>;
let runner: ReturnType<typeof createCodexRunnerHandler>;
beforeAll(async () => {
  fixture = await backendFixture();
  tasks = createCodexTasksHandler({ env: testEnv, fetchImpl: fixture.fetchImpl });
  runner = createCodexRunnerHandler({ env: testEnv, fetchImpl: fixture.fetchImpl });
});
afterAll(async () => { await fixture?.db.close(); });

test('user authentication and explicit owner allowlist guard all browser actions', async () => {
  expect((await tasks(request({ action: 'list' }, ''))).status).toBe(401);
  expect((await tasks(request({ action: 'list' }, 'outsider-token-123456789000'))).status).toBe(403);
  const missingConfig = createCodexTasksHandler({ env: { ...testEnv, CODEX_ALLOWED_USER_IDS: '' }, fetchImpl: fixture.fetchImpl });
  expect((await missingConfig(request({ action: 'list' }))).status).toBe(503);
});

test('pair, create, claim, and complete preserve the fixed route and expose no credentials', async () => {
  const codeResponse = await tasks(request({ action: 'pair-code' }));
  expect(codeResponse.status).toBe(200);
  const { code } = await codeResponse.json();
  const paired = await runner(request({ action: 'pair', code, name: 'Windows', platform: 'windows', projects: [{ id: 'xs', label: 'XS' }] }, ''));
  expect(paired.status).toBe(200);
  const { deviceId, token } = await paired.json();
  expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  const body = { action: 'create', requestId: crypto.randomUUID(), title: '修复', prompt: '执行测试', acceptance: '通过', targetKind: 'device', deviceId, projectId: 'xs', ownerId: 'attacker' };
  const created = await (await tasks(request(body))).json();
  expect(created.task).toMatchObject({ deviceId, targetKind: 'device', projectId: 'xs', status: 'queued' });
  const duplicate = await (await tasks(request({ ...body, title: 'different ignored' }))).json();
  expect(duplicate.task.id).toBe(created.task.id);
  const claim = await (await runner(request({ action: 'claim' }, token))).json();
  expect(claim.task).toMatchObject({ id: created.task.id, projectId: 'xs' });
  const completion = { action: 'complete', taskId: claim.task.id, runToken: claim.task.runToken, status: 'succeeded', result: 'tests passed', error: '', sessionId: 'session-1' };
  expect((await runner(request(completion, token))).status).toBe(200);
  expect((await runner(request(completion, token))).status).toBe(200);
  expect((await runner(request({ ...completion, result: 'changed after completion' }, token))).status).toBe(409);
  const list = await (await tasks(request({ action: 'list' }))).json();
  expect(list.tasks[0]).toMatchObject({ status: 'succeeded', actualDeviceId: deviceId, result: 'tests passed', sessionId: 'session-1' });
  expect(JSON.stringify(list)).not.toContain(token);
  expect(JSON.stringify(list)).not.toMatch(/token_hash|tokenHash|server-key/);
  const stored = await fixture.db.query<{ token_hash: string; owner_id: string }>('select token_hash,owner_id from codex_devices where id=$1', [deviceId]);
  expect(stored.rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(stored.rows[0].owner_id).toBe(ownerId);
  await tasks(request({ action: 'revoke-device', deviceId }));
  expect((await runner(request({ action: 'claim' }, token))).status).toBe(401);
});

test('removing an owner from server allowlist revokes existing device calls', async () => {
  const { code } = await (await tasks(request({ action: 'pair-code' }))).json();
  const paired = await (await runner(request({ action: 'pair', code, name: 'revoked owner', platform: 'macos', projects: [{ id: 'xs', label: 'XS' }] }, ''))).json();
  const disallowed = createCodexRunnerHandler({ env: { ...testEnv, CODEX_ALLOWED_USER_IDS: '22222222-2222-4222-8222-222222222222' }, fetchImpl: fixture.fetchImpl });
  expect((await disallowed(request({ action: 'claim' }, paired.token))).status).toBe(401);
});

test('a retargeted request id returns 409 and concurrent claims return one execution', async () => {
  const { code } = await (await tasks(request({ action: 'pair-code' }))).json();
  const firstDevice = await (await runner(request({ action: 'pair', code, name: 'A', platform: 'windows', projects: [{ id: 'xs', label: 'XS' }] }, ''))).json();
  const secondCode = await (await tasks(request({ action: 'pair-code' }))).json();
  const secondDevice = await (await runner(request({ action: 'pair', code: secondCode.code, name: 'B', platform: 'macos', projects: [{ id: 'xs', label: 'XS' }] }, ''))).json();
  const body = { action: 'create', requestId: crypto.randomUUID(), title: 'x', prompt: 'x', acceptance: '', targetKind: 'device', deviceId: firstDevice.deviceId, projectId: 'xs' };
  expect((await tasks(request(body))).status).toBe(200);
  expect((await tasks(request({ ...body, deviceId: secondDevice.deviceId }))).status).toBe(409);
  expect((await (await runner(request({ action: 'claim' }, secondDevice.token))).json()).task).toBeNull();
  const claims = await Promise.all(Array.from({ length: 8 }, () => runner(request({ action: 'claim' }, firstDevice.token)).then((response) => response.json())));
  expect(claims.filter((claim) => claim.task !== null)).toHaveLength(1);
  const claim = claims.find((claim) => claim.task !== null).task;
  await fixture.db.query("update codex_tasks set lease_until=now()-interval '1 second' where id=$1", [claim.id]);
  expect((await runner(request({ action: 'progress', taskId: claim.id, runToken: claim.runToken, summary: 'too late' }, firstDevice.token))).status).toBe(409);
  const state = await fixture.db.query<{ status: string }>('select status from codex_tasks where id=$1', [claim.id]);
  expect(state.rows[0].status).toBe('needs_attention');
});

test('invalid input and oversized results fail before database execution with safe errors', async () => {
  const input = { action: 'create', requestId: crypto.randomUUID(), title: 'x'.repeat(241), prompt: 'x', acceptance: '', targetKind: 'device', deviceId: crypto.randomUUID(), projectId: 'xs' };
  expect((await tasks(request(input))).status).toBe(400);
  expect((await tasks(request({ ...input, title: 'x', projectId: '../secret' }))).status).toBe(400);
  expect((await runner(request({ action: 'complete', taskId: crypto.randomUUID(), runToken: crypto.randomUUID(), status: 'succeeded', result: 'x'.repeat(20001), error: '', sessionId: null }, 'a'.repeat(43)))).status).toBe(400);
  const huge = await tasks(request({ action: 'list', padding: 'x'.repeat(160000) }));
  expect(huge.status).toBe(413);
  expect(huge.headers.get('cache-control')).toBe('no-store');
  expect(JSON.stringify(await huge.json())).not.toContain('server-key');
});

test('malformed upstream auth and network errors cannot leak secrets', async () => {
  const broken = createCodexTasksHandler({ env: testEnv, fetchImpl: async () => { throw new Error('server-key-never-return'); } });
  const response = await broken(request({ action: 'list' }));
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain('server-key');
  const malformed = createCodexTasksHandler({ env: testEnv, fetchImpl: async () => Response.json({ id: 'not-a-uuid' }) });
  expect((await malformed(request({ action: 'list' }))).status).toBe(401);
});
