import { timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { AnalysisError, AnalysisInputError } from '../analysis/errors';
import { analysisRoute, integer, uuid } from '../analysis/router';
import type { AnalysisService } from '../analysis/service';
import { record } from '../operators/planning';

export function requireAgentCallback(req: Request) {
  const token = process.env.AGENT_SERVICE_TOKEN;
  if (!token) throw new AnalysisError(503, 'PLANNER_UNAVAILABLE', '分析助手服务尚未配置');
  const header = Buffer.from(req.get('authorization') ?? '');
  const expected = Buffer.from('Bearer ' + token);
  if (header.length !== expected.length || !timingSafeEqual(header, expected)) {
    throw new AnalysisError(401, 'INVALID_REQUEST', '无权调用分析助手内部接口');
  }
}

async function agentWorkflow(sceneId: string, threadId: string, event?: Record<string, unknown>) {
  const host = process.env.AGENT_SERVICE_URL;
  const token = process.env.AGENT_SERVICE_TOKEN;
  if (!host || !token) throw new AnalysisError(503, 'PLANNER_UNAVAILABLE', '分析助手服务尚未配置');
  const path = `/workflow/${sceneId}/${threadId}${event ? '/events' : ''}`;
  const signal = AbortSignal.timeout(50000);
  let response: Response;
  try {
    response = await fetch(new URL(path, host), {
      method: event ? 'POST' : 'GET',
      redirect: 'error',
      signal,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(event ? { body: JSON.stringify(event) } : {}),
    });
  } catch {
    if (signal.aborted) throw new AnalysisError(504, 'PLANNER_TIMEOUT', '分析助手请求超时，请恢复当前会话后重试');
    throw new AnalysisError(503, 'PLANNER_UNAVAILABLE', '暂时无法连接分析助手');
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = record(data) ? data.detail : undefined;
    const message = typeof detail === 'string' && /[\u4e00-\u9fa5]/.test(detail) && detail.length < 420 ? detail : undefined;
    const code = response.status === 404 || response.status === 409 || response.status === 422 ? 'INVALID_REQUEST'
      : response.status === 429 ? 'PLANNER_RATE_LIMITED'
      : response.status === 504 ? 'PLANNER_TIMEOUT' : 'PLANNER_UNAVAILABLE';
    throw new AnalysisError(response.status, code, message ?? (response.status === 404 ? '当前场景没有这条分析会话'
      : response.status === 409 ? '这个步骤已变化，请恢复会话再操作' : '分析助手暂时无法继续，请稍后重试'));
  }
  if (!record(data) || data.threadId !== threadId || data.sceneId !== sceneId) {
    throw new AnalysisError(502, 'PLANNER_INVALID_RESPONSE', '分析助手返回了无效的会话状态');
  }
  return data;
}

export function createWorkflowRouter(service: AnalysisService) {
  const router = Router();
  const route = analysisRoute(service);
  const path = '/scenes/:sceneId/analysis/sessions/:threadId';
  router.get('/scenes/:sceneId/analysis/runs', route(async (req, res) => {
    const data = await service.history(integer(req.query.limit, 20, 100), undefined, uuid(req.params.sceneId));
    res.json({ code: 200, data });
  }));
  router.get(path, route(async (req, res) => {
    const data = await agentWorkflow(uuid(req.params.sceneId), uuid(req.params.threadId));
    res.json({ code: 200, data });
  }));
  router.post(path + '/events', route(async (req, res) => {
    const { body } = req;
    if (!record(body) || Object.keys(body).some(key => !['action', 'requestId', 'prompt', 'interactionId', 'contextRunId'].includes(key))
      || typeof body.action !== 'string' || !['start', 'answer', 'confirm', 'cancel', 'resume'].includes(body.action)) {
      throw new AnalysisInputError('无效的分析会话操作');
    }
    const sceneId = uuid(req.params.sceneId);
    const threadId = uuid(req.params.threadId);
    const data = await agentWorkflow(sceneId, threadId, { ...body, requestId: uuid(body.requestId) });
    res.json({ code: 200, data });
  }));
  router.post('/internal/analysis/workflow/submit', route(async (req, res) => {
    requireAgentCallback(req);
    const { sceneId, threadId, planId, planVersion, interactionId } = record(req.body) ? req.body : {};
    if (typeof planVersion !== 'number' || !Number.isSafeInteger(planVersion) || planVersion < 1
      || typeof interactionId !== 'string' || !/^[a-z\d._~-]{1,128}$/i.test(interactionId)) {
      throw new AnalysisInputError('确认需要关联待确认步骤和计划版本');
    }
    const scene = uuid(sceneId);
    const thread = uuid(threadId);
    const run = await service.create({ planId: uuid(planId), planVersion, sceneId: scene },
      { actor: 'agent', scope: `workflow:${scene}:${thread}`, key: interactionId });
    res.status(202).json({ code: 202, data: run });
  }));
  return router;
}
