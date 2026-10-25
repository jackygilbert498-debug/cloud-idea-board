import type { Config } from '@netlify/functions';
import { ApiFailure, allowedOwners, bearer, failureResponse, hash, invalid, json, projects, readBody, secret, services, text, uuid, type Dependencies, type JsonObject } from './_codex/core.mts';

export function createCodexRunnerHandler(deps: Dependencies = {}) {
  const api = services(deps);
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST') throw new ApiFailure('METHOD_NOT_ALLOWED', 405, '只支持 POST 请求。');
      const owners = allowedOwners(api.env);
      const body = await readBody(request);
      let tokenHash = '';
      let data: JsonObject;
      if (body.action === 'pair') {
        const code = text(body.code, 64, true);
        if (!/^[A-Za-z0-9_-]{32,64}$/.test(code)) invalid();
        if (body.platform !== 'windows' && body.platform !== 'macos') invalid();
        const token = secret();
        data = { codeHash: hash(code), tokenHash: hash(token), name: text(body.name, 100, true), platform: body.platform, projects: projects(body.projects), _allowedOwnerIds: owners };
        const paired = await api.rpc<{ deviceId: string }>('codex_runner_action', { p_token_hash: '', p_action: 'pair', p_body: data });
        return json({ deviceId: paired.deviceId, token });
      }
      tokenHash = hash(bearer(request));
      switch (body.action) {
        case 'heartbeat': data = { projects: projects(body.projects) }; break;
        case 'claim': data = {}; break;
        case 'progress': data = { taskId: uuid(body.taskId), runToken: uuid(body.runToken), summary: text(body.summary ?? '', 2000) }; break;
        case 'complete':
          if (!['succeeded', 'failed', 'cancelled', 'needs_attention'].includes(String(body.status))) invalid();
          data = { taskId: uuid(body.taskId), runToken: uuid(body.runToken), status: body.status, result: text(body.result ?? '', 20000), error: text(body.error ?? '', 2000), sessionId: body.sessionId == null ? null : text(body.sessionId, 200, true) };
          break;
        default: invalid();
      }
      return json(await api.rpc('codex_runner_action', { p_token_hash: tokenHash, p_action: body.action, p_body: { ...data, _allowedOwnerIds: owners } }));
    } catch (error) { return failureResponse(error); }
  };
}

export default createCodexRunnerHandler();
export const config: Config = { path: '/api/codex-runner', method: 'POST', rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
