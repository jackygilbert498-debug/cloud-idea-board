import type { CodexProject, CodexTask } from '../../../lib/codex-task-model.ts';
import { ApiFailure, projectId, requiredEnv, text, type JsonObject, type Services } from './core.mts';

interface CloudProject extends CodexProject { repository: string; baseBranch?: string }
interface CloudState { project?: CloudProject; prNumber?: number; commentAttempted?: boolean; commentId?: number }
interface CloudRecord { task: CodexTask; state: CloudState; acquired?: boolean; lockToken?: string; shouldPost?: boolean }
interface GitHubPull { number: number; html_url: string; state: string; merged?: boolean; head?: { ref?: string; sha?: string } }
interface GitHubComment { id: number; body: string; user?: { login?: string }; created_at: string }
const bots = new Set(['chatgpt-codex-connector[bot]']);

export function cloudSettings(env: NodeJS.ProcessEnv): { projects: CloudProject[]; enabled: boolean } {
  let projects: CloudProject[] = [];
  if (env.CODEX_CLOUD_PROJECTS?.trim()) {
    try {
      const value: unknown = JSON.parse(env.CODEX_CLOUD_PROJECTS);
      if (!Array.isArray(value) || value.length > 30) throw new Error();
      projects = value.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error();
        const item = entry as JsonObject;
        if (typeof item.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repository)) throw new Error();
        const baseBranch = item.baseBranch == null ? undefined : text(item.baseBranch, 200, true);
        if (baseBranch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseBranch) || baseBranch.includes('..'))) throw new Error();
        return { id: projectId(item.id), label: text(item.label, 100, true), repository: item.repository,
          isPublic: item.isPublic !== false, ...(baseBranch ? { baseBranch } : {}) };
      });
      if (new Set(projects.map((project) => project.id)).size !== projects.length) throw new Error();
    } catch { throw new ApiFailure('SERVER_NOT_CONFIGURED', 503, '云端项目允许列表配置不正确。'); }
  }
  return { projects, enabled: env.CODEX_CLOUD_ENABLED === 'true' && Boolean(env.CODEX_GITHUB_TOKEN?.trim()) && projects.length > 0 };
}
export function publicProjects(projects: CloudProject[]): CodexProject[] {
  return projects.map(({ id, label, repository, isPublic }) => ({ id, label, repository, isPublic }));
}
export function requireCloudProject(api: Services, id: string): CloudProject {
  const settings = cloudSettings(api.env);
  if (!settings.enabled) throw new ApiFailure('CLOUD_NOT_CONFIGURED', 503, '云端委派尚未启用或完成真实验收。');
  const project = settings.projects.find((item) => item.id === id);
  if (!project) throw new ApiFailure('PROJECT_FORBIDDEN', 403, '此项目不在云端允许列表中。');
  return project;
}

/** All GitHub writes use deterministic task IDs and fixed server repository bindings. */
export async function dispatchCloud(api: Services, owner: string, task: CodexTask): Promise<{ task: CodexTask }> {
  const currentProject = requireCloudProject(api, task.projectId);
  const rpc = (action: string, body: JsonObject = {}) => api.rpc<CloudRecord>('codex_cloud_action', { p_owner: owner, p_task_id: task.id, p_action: action, p_body: body });
  const locked = await rpc('lock');
  if (!locked.acquired) return { task: locked.task };
  let record = locked;
  const lockToken = locked.lockToken;
  const checkpoint = async (body: JsonObject) => {
    record = await rpc('checkpoint', { ...body, _lockToken: lockToken });
    return record;
  };
  const project = locked.state.project;
  const deadline = AbortSignal.timeout(35000);
  try {
    if (!project || project.id !== currentProject.id || project.repository !== currentProject.repository || project.baseBranch !== currentProject.baseBranch) {
      await checkpoint({ status: 'needs_attention', error: '项目配置已更改，请检查原任务。为避免跨项目执行，平台已停止派发。' });
      return { task: record.task };
    }
    const prefix = `https://api.github.com/repos/${project.repository}`;
    const token = requiredEnv(api.env, 'CODEX_GITHUB_TOKEN');
    async function github<T>(endpoint: string, method = 'GET', body?: unknown, missingOk = false): Promise<T | null> {
      // Reads can outlive a cancel request. Revalidate the durable cancellation/lease fence
      // immediately before each external write, including after mark-comment returns.
      if (method !== 'GET') await checkpoint({});
      let response: Response;
      try {
        response = await api.fetchImpl(`${prefix}${endpoint}`, { method,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([deadline, AbortSignal.timeout(7000)]), cache: 'no-store', redirect: 'error' });
      } catch { throw new ApiFailure('GITHUB_UNAVAILABLE', 502, '暂时无法核实 GitHub 派发结果。'); }
      if (response.status === 404 && missingOk) return null;
      if (!response.ok) throw new ApiFailure('GITHUB_UNAVAILABLE', 502, 'GitHub 暂时无法完成此操作。');
      const result: unknown = await response.json().catch(() => null);
      if (result === null) throw new ApiFailure('GITHUB_UNAVAILABLE', 502, 'GitHub 返回内容无法核实。');
      return result as T;
    }
    async function comments(number: number): Promise<GitHubComment[]> {
      const result: GitHubComment[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const batch = await github<GitHubComment[]>(`/issues/${number}/comments?per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw new ApiFailure('GITHUB_UNAVAILABLE', 502, 'GitHub 评论无法核实。');
        result.push(...batch);
        if (batch.length < 100) return result;
      }
      throw new ApiFailure('GITHUB_UNAVAILABLE', 502, '评论数量较多，请打开任务链接核实派发状态。');
    }
    const branch = `codex/task-${task.id}`;
    const marker = `<!-- codex-task:${task.id} -->`;
    const repository = await github<{ default_branch: string; private: boolean }>('');
    if (!repository || typeof repository.default_branch !== 'string' || typeof repository.private !== 'boolean') throw new ApiFailure('GITHUB_UNAVAILABLE', 502, 'GitHub 仓库信息无法核实。');
    if (!repository.private && project.isPublic === false) {
      await checkpoint({ status: 'needs_attention', error: '仓库现为公开仓库，与发布时配置不一致；请检查后重新发布。' });
      return { task: record.task };
    }
    const baseBranch = project.baseBranch ?? repository.default_branch;
    let pull: GitHubPull | null = null;
    if (record.state.prNumber) {
      pull = await github<GitHubPull>(`/pulls/${record.state.prNumber}`);
    } else {
      const ownerName = project.repository.split('/')[0];
      const pulls = await github<GitHubPull[]>(`/pulls?head=${encodeURIComponent(`${ownerName}:${branch}`)}&state=all&per_page=100`);
      if (!Array.isArray(pulls)) throw new ApiFailure('GITHUB_UNAVAILABLE', 502, 'GitHub PR 无法核实。');
      pull = pulls.find((item) => item.head?.ref === branch) ?? null;
    }
    if (!pull && !record.state.commentAttempted) {
      const ref = await github<{ object: { sha: string } }>(`/git/ref/heads/${branch}`, 'GET', undefined, true);
      if (!ref) {
        const base = await github<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(baseBranch)}`);
        if (!base?.object?.sha) throw new ApiFailure('GITHUB_UNAVAILABLE', 502, 'GitHub 基础分支无法核实。');
        await github('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: base.object.sha });
      }
      const filePath = `/.codex/tasks/${task.id}.md`;
      const file = await github<{ sha: string }>(`/contents${filePath}?ref=${encodeURIComponent(branch)}`, 'GET', undefined, true);
      if (!file) {
        const requirement = `# ${task.title}\n\n任务 ID: ${task.id}\n\n## 需求\n\n${task.prompt}\n\n## 验收要求\n\n${task.acceptance}\n\n请保留无关工作，不自动合并或部署。\n`;
        await github(`/contents${filePath}`, 'PUT', { message: `docs: record Codex task ${task.id}`, content: Buffer.from(requirement).toString('base64'), branch });
      }
      pull = await github<GitHubPull>('/pulls', 'POST', { title: task.title, head: branch, base: baseBranch, body: `${marker}\n\n任务需求见 \`.codex/tasks/${task.id}.md\`。由本人任务看板创建，等待 Codex 回执。` });
    }
    if (!pull || !Number.isSafeInteger(pull.number) || pull.number < 1 || typeof pull.html_url !== 'string'
      || pull.html_url.toLowerCase() !== `https://github.com/${project.repository}/pull/${pull.number}`.toLowerCase()) throw new ApiFailure('GITHUB_UNAVAILABLE', 502, '派发评论结果尚无法核实，请打开原任务检查。');
    await checkpoint({ state: { prNumber: pull.number }, cloudUrl: pull.html_url });
    if (pull.merged || pull.state === 'closed') {
      await checkpoint({ status: pull.merged ? 'merged' : 'closed', summary: pull.merged ? 'GitHub PR 已合并。' : 'GitHub PR 已关闭。', error: '' });
      return { task: record.task };
    }
    let allComments = await comments(pull.number);
    let trigger = allComments.find((comment) => typeof comment.body === 'string' && comment.body.includes(marker) && comment.body.includes('@codex'));
    if (!trigger && !record.state.commentAttempted) {
      // Persist the attempt BEFORE the write: an unknown network outcome must never trigger again.
      const permission = await rpc('mark-comment', { _lockToken: lockToken });
      if (permission.shouldPost) {
        trigger = await github<GitHubComment>(`/issues/${pull.number}/comments`, 'POST', { body: `${marker}\n\n@codex 请执行本 PR 中 \`.codex/tasks/${task.id}.md\` 的需求，并遵守项目 AGENTS.md。请给出改动、测试结果和限制；不要合并或部署。` }) ?? undefined;
        allComments = trigger ? [...allComments, trigger] : allComments;
      }
    }
    if (!trigger || !Number.isSafeInteger(trigger.id)) {
      await checkpoint({ status: 'needs_attention', error: '委派评论结果不确定；平台不会重复触发。请打开任务链接核实。' });
      return { task: record.task };
    }
    const reply = allComments.filter((comment) => bots.has(comment.user?.login ?? '') && comment.id > trigger.id).at(-1);
    await checkpoint({ state: { commentId: trigger.id }, status: reply ? 'acknowledged' : 'submitted',
      summary: reply ? '已收到 Codex 官方账号回复；请打开 PR 核实改动和测试。' : '已发布委派评论，等待 Codex 真实回执。',
      result: reply && typeof reply.body === 'string' ? Array.from(reply.body).slice(0, 20000).join('') : record.task.result, error: '' });
    return { task: record.task };
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'TASK_CANCELLED') {
      return api.rpc('codex_user_action', { p_owner: owner, p_action: 'get', p_body: { taskId: task.id } });
    }
    console.error('codex cloud dispatch failed', { taskId: task.id, code: error instanceof ApiFailure ? error.code : 'GITHUB_UNAVAILABLE' });
    try { await checkpoint({ status: 'needs_attention', error: '云端资源或委派回执暂无法核实，请同步或打开任务链接检查；平台不会重复触发未知结果的评论。' }); }
    catch (checkpointError) {
      if (checkpointError instanceof ApiFailure && checkpointError.code === 'TASK_CANCELLED') {
        return api.rpc('codex_user_action', { p_owner: owner, p_action: 'get', p_body: { taskId: task.id } });
      }
      // Preserve the original durable state if storage is unavailable.
    }
    return { task: record.task };
  } finally {
    // A lost lease cannot release another handler's lock.
    await rpc('release', { _lockToken: lockToken }).catch(() => undefined);
  }
}
