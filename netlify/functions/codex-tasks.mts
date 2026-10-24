import type { Config } from '@netlify/functions';
import type { CodexTask, CodexDevice } from '../../lib/codex-task-model.ts';
import { ApiFailure, createInput, failureResponse, hash, invalid, json, readBody, secret, services, uuid, type Dependencies } from './_codex/core.mts';
import { cloudSettings, dispatchCloud, publicProjects, requireCloudProject } from './_codex/cloud.mts';

export function createCodexTasksHandler(deps: Dependencies = {}) {
  const api = services(deps);
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST') throw new ApiFailure('METHOD_NOT_ALLOWED', 405, '只支持 POST 请求。');
      const owner = await api.user(request);
      const body = await readBody(request);
      const invoke = <T,>(action: string, data = {}) => api.rpc<T>('codex_user_action', { p_owner: owner, p_action: action, p_body: data });
      switch (body.action) {
        case 'list': {
          const data = await invoke<{ tasks: CodexTask[]; devices: CodexDevice[] }>('list');
          const cloud = cloudSettings(api.env);
          return json({ ...data, cloudProjects: publicProjects(cloud.projects), cloudEnabled: cloud.enabled });
        }
        case 'pair-code': {
          const code = secret();
          const data = await invoke<{ expiresAt: string }>('pair-code', { codeHash: hash(code) });
          return json({ code, expiresAt: data.expiresAt });
        }
        case 'create': {
          const input = createInput(body);
          const cloudProject = input.targetKind === 'cloud' ? requireCloudProject(api, input.projectId) : null;
          const created = await invoke<{ task: CodexTask }>('create', { ...input, ...(cloudProject ? { _cloudProject: cloudProject } : {}) });
          return json(created.task.targetKind === 'cloud' ? await dispatchCloud(api, owner, created.task) : created);
        }
        case 'revoke-device': return json(await invoke('revoke-device', { deviceId: uuid(body.deviceId) }));
        case 'cancel': return json(await invoke('cancel', { taskId: uuid(body.taskId) }));
        case 'sync': {
          const existing = await invoke<{ task: CodexTask }>('get', { taskId: uuid(body.taskId) });
          return json(existing.task.targetKind === 'cloud' ? await dispatchCloud(api, owner, existing.task) : existing);
        }
        default: invalid();
      }
    } catch (error) { return failureResponse(error); }
  };
}

export default createCodexTasksHandler();
export const config: Config = { path: '/api/codex-tasks', method: 'POST', rateLimit: { windowLimit: 90, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
