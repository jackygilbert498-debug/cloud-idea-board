import { expect, test } from 'vitest';
import { createCodexTasksHandler } from '../netlify/functions/codex-tasks.mts';
import { backendFixture, request, testEnv } from './codex-backend-fixtures.ts';

function githubFixture(mode: 'success' | 'unknown-created' | 'unknown-missing' = 'success') {
  let branch = false;
  let file = false;
  let pr = false;
  let triggers = 0;
  let posts = 0;
  const comments: Array<{ id: number; body: string; user: { login: string }; created_at: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (new Headers(init?.headers).get('authorization') !== 'Bearer github-server-secret') throw new Error('missing server credential');
    const endpoint = url.pathname.replace('/repos/person/project', '');
    if (endpoint === '' && method === 'GET') return Response.json({ default_branch: 'main', private: false });
    if (endpoint === '/git/ref/heads/main') return Response.json({ object: { sha: 'base-sha' } });
    if (endpoint.startsWith('/git/ref/heads/codex/')) return branch ? Response.json({ object: { sha: 'task-sha' } }) : Response.json({}, { status: 404 });
    if (endpoint === '/git/refs' && method === 'POST') { branch = true; return Response.json({ object: { sha: 'base-sha' } }, { status: 201 }); }
    if (endpoint.startsWith('/contents/.codex/tasks/')) {
      if (method === 'GET') return file ? Response.json({ sha: 'blob-sha' }) : Response.json({}, { status: 404 });
      file = true; return Response.json({ commit: { sha: 'task-sha' } }, { status: 201 });
    }
    if (endpoint === '/pulls' && method === 'GET') return Response.json(pr ? [{ number: 12, html_url: 'https://github.com/person/project/pull/12', head: { ref: url.searchParams.get('head')?.slice('person:'.length), sha: 'task-sha' }, state: 'open', merged: false }] : []);
    if (endpoint === '/pulls' && method === 'POST') { pr = true; return Response.json({ number: 12, html_url: 'https://github.com/person/project/pull/12', head: { ref: body.head, sha: 'task-sha' }, state: 'open', merged: false }, { status: 201 }); }
    if (endpoint === '/pulls/12') return Response.json({ number: 12, html_url: 'https://github.com/person/project/pull/12', state: 'open', merged: false, head: { sha: 'task-sha' } });
    if (endpoint === '/issues/12/comments') {
      if (method === 'GET') return Response.json(comments);
      posts += 1;
      if (mode !== 'unknown-missing') {
        triggers += 1;
        comments.push({ id: 20, body: body.body, user: { login: 'person' }, created_at: '2026-10-25T00:00:00Z' });
      }
      if (mode !== 'success') throw new Error('connection reset after response');
      return Response.json(comments[comments.length - 1], { status: 201 });
    }
    throw new Error(`Unexpected GitHub request ${method} ${url.pathname}`);
  };
  return { fetchImpl, comments, triggerCount: () => triggers, postCount: () => posts };
}
const cloudEnv = { ...testEnv, CODEX_CLOUD_ENABLED: 'true', CODEX_GITHUB_TOKEN: 'github-server-secret', CODEX_CLOUD_PROJECTS: JSON.stringify([{ id: 'main', label: '公开项目', repository: 'person/project', isPublic: true }]) };
const input = () => ({ action: 'create', requestId: crypto.randomUUID(), title: '需求', prompt: '修复指定问题', acceptance: '测试通过', targetKind: 'cloud', deviceId: null, projectId: 'main' });

test('cloud dispatch uses one deterministic branch, PR and marker comment for duplicate requests', async () => {
  const github = githubFixture();
  const fixture = await backendFixture(github.fetchImpl);
  try {
    const handler = createCodexTasksHandler({ env: cloudEnv, fetchImpl: fixture.fetchImpl });
    const body = input();
    const first = await handler(request(body));
    expect(first.status).toBe(200);
    const data = await first.json();
    expect(data.task).toMatchObject({ status: 'submitted', cloudUrl: 'https://github.com/person/project/pull/12' });
    expect((await (await handler(request(body))).json()).task.id).toBe(data.task.id);
    expect(github.triggerCount()).toBe(1);
    expect(github.comments[0].body).toContain(`<!-- codex-task:${data.task.id} -->`);
    expect(github.comments[0].body).toContain('@codex');
    const list = await (await handler(request({ action: 'list' }))).json();
    expect(list.cloudEnabled).toBe(true);
    expect(list.cloudProjects).toEqual([{ id: 'main', label: '公开项目', repository: 'person/project', isPublic: true }]);
    expect(JSON.stringify(list)).not.toContain('github-server-secret');
  } finally { await fixture.db.close(); }
});

test.each(['unknown-created', 'unknown-missing'] as const)('ambiguous comment response (%s) never blindly posts again', async (mode) => {
  const github = githubFixture(mode);
  const fixture = await backendFixture(github.fetchImpl);
  try {
    const handler = createCodexTasksHandler({ env: cloudEnv, fetchImpl: fixture.fetchImpl });
    const body = input();
    const first = await (await handler(request(body))).json();
    expect(first.task.status).toBe('needs_attention');
    await handler(request(body));
    const synced = await (await handler(request({ action: 'sync', taskId: first.task.id }))).json();
    expect(github.postCount()).toBe(1);
    expect(synced.task.status).toBe(mode === 'unknown-created' ? 'submitted' : 'needs_attention');
  } finally { await fixture.db.close(); }
});

test('official bot reply is acknowledgement, not a false completion', async () => {
  const github = githubFixture();
  const fixture = await backendFixture(github.fetchImpl);
  try {
    const handler = createCodexTasksHandler({ env: cloudEnv, fetchImpl: fixture.fetchImpl });
    const created = await (await handler(request(input()))).json();
    github.comments.push({ id: 21, body: 'I am looking into the task.', user: { login: 'chatgpt-codex-connector[bot]' }, created_at: '2026-10-25T00:01:00Z' });
    const synced = await (await handler(request({ action: 'sync', taskId: created.task.id }))).json();
    expect(synced.task.status).toBe('acknowledged');
    expect(synced.task.result).toContain('I am looking into the task.');
  } finally { await fixture.db.close(); }
});

test('cloud is gated by server configuration and a project allowlist', async () => {
  const fixture = await backendFixture();
  try {
    const disabled = createCodexTasksHandler({ env: { ...cloudEnv, CODEX_CLOUD_ENABLED: 'false' }, fetchImpl: fixture.fetchImpl });
    expect((await disabled(request(input()))).status).toBe(503);
    const handler = createCodexTasksHandler({ env: cloudEnv, fetchImpl: fixture.fetchImpl });
    expect((await handler(request({ ...input(), projectId: 'other' }))).status).toBe(403);
    expect((await fixture.db.query('select * from codex_tasks')).rows).toHaveLength(0);
  } finally { await fixture.db.close(); }
});

test('cancelling a recoverable GitHub failure permanently closes later dispatch', async () => {
  const github = githubFixture();
  let offline = true;
  let writes = 0;
  const fixture = await backendFixture(async (url, init) => {
    if (offline) throw new Error('offline');
    if (init?.method && init.method !== 'GET') writes += 1;
    return github.fetchImpl(url, init);
  });
  try {
    const handler = createCodexTasksHandler({ env: cloudEnv, fetchImpl: fixture.fetchImpl });
    const created = await (await handler(request(input()))).json();
    expect(created.task.status).toBe('needs_attention');
    const cancelled = await (await handler(request({ action: 'cancel', taskId: created.task.id }))).json();
    expect(cancelled.task.status).toBe('cancelled');
    offline = false;
    const synced = await (await handler(request({ action: 'sync', taskId: created.task.id }))).json();
    expect(synced.task.status).toBe('cancelled');
    expect(writes).toBe(0);
    expect(github.postCount()).toBe(0);
  } finally { await fixture.db.close(); }
});

test.each(['repository', 'base-ref', 'requirement', 'comment-authorized'] as const)('cancel at %s boundary prevents all subsequent GitHub writes', async (boundary) => {
  const github = githubFixture();
  let reached!: () => void;
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let writes = 0;
  const fixture = await backendFixture(async (url, init) => {
    const endpoint = new URL(String(url)).pathname.replace('/repos/person/project', '');
    const method = init?.method ?? 'GET';
    const block = method === 'GET' && (
      (boundary === 'repository' && endpoint === '') ||
      (boundary === 'base-ref' && endpoint === '/git/ref/heads/main') ||
      (boundary === 'requirement' && endpoint.startsWith('/contents/.codex/tasks/'))
    );
    if (block) { reached(); await gate; }
    if (method !== 'GET') writes += 1;
    return github.fetchImpl(url, init);
  });
  const fetchImpl: typeof fetch = async (url, init) => {
    const response = await fixture.fetchImpl(url, init);
    if (boundary === 'comment-authorized' && String(url).endsWith('/rpc/codex_cloud_action')
      && JSON.parse(String(init?.body)).p_action === 'mark-comment') { reached(); await gate; }
    return response;
  };
  try {
    const handler = createCodexTasksHandler({ env: cloudEnv, fetchImpl });
    const creation = handler(request(input()));
    await paused;
    const { rows } = await fixture.db.query<{ id: string }>('select id from codex_tasks limit 1');
    const cancel = await (await handler(request({ action: 'cancel', taskId: rows[0].id }))).json();
    expect(cancel.task.status).toBe('cancel_requested');
    const writesAtCancel = writes;
    resume();
    const finished = await (await creation).json();
    expect(finished.task.status).toBe('cancel_requested');
    expect(writes).toBe(writesAtCancel);
    expect((await (await handler(request({ action: 'sync', taskId: rows[0].id }))).json()).task.status).toBe('cancel_requested');
    expect(writes).toBe(writesAtCancel);
  } finally { resume(); await fixture.db.close(); }
});
