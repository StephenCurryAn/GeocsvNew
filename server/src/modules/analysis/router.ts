import { Router, type Request, type Response } from 'express';
import { listOperators } from '../operators/registry';
import { AnalysisError, AnalysisInputError } from './errors';
import type { AnalysisService } from './service';

export const submissionKey = (req: Request, scope: string) => {
  const key = req.headers['idempotency-key'];
  if (key === undefined) return undefined;
  if (typeof key !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(key)) {
    throw new AnalysisInputError('请求键必须为 1–128 个字母、数字或 . _ ~ -');
  }
  // Map the authenticated access context here when multi-user support is introduced.
  return { actor: 'local', scope, key };
};

export const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)) {
    throw new AnalysisInputError('无效的记录 ID');
  }
  return value.toLowerCase();
};

export const integer = (value: unknown, fallback: number, max: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new AnalysisInputError('无效的分页参数');
  }
  return Number(value);
};

export const analysisRoute = (service: AnalysisService) =>
  (handler: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { await service.initialize(); await handler(req, res); }
    catch (error) {
      if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
      const status = error instanceof AnalysisError ? error.status : 500;
      res.status(status).json({
        code: status,
        message: error instanceof Error ? error.message : '分析服务失败',
        ...(error instanceof AnalysisError ? { errorCode: error.errorCode } : {}),
      });
    }
  };

export const createAnalysisRouter = (service: AnalysisService) => {
  const router = Router();
  const route = analysisRoute(service);
  router.get('/operators', route(async (_req, res) => res.json({ code: 200, data: listOperators() })));
  router.post('/analysis/plans', route(async (req, res) => {
    if (!req.body || Object.keys(req.body).length !== 1 || !Object.prototype.hasOwnProperty.call(req.body, 'spec')) {
      throw new AnalysisInputError('请提供计划参数 spec');
    }
    res.status(201).json({ code: 201, data: await service.createPlan(req.body.spec) });
  }));
  router.get('/analysis/plans/:id', route(async (req, res) => {
    const plan = await service.getPlan(uuid(req.params.id));
    if (!plan) throw new AnalysisError(404, 'PLAN_NOT_FOUND', '分析计划不存在');
    res.json({ code: 200, data: plan });
  }));
  router.post('/runs', route(async (req, res) => {
    const key = submissionKey(req, 'runs:create');
    const body = req.body;
    if (body?.planId !== undefined || body?.planVersion !== undefined) {
      if (Object.keys(body).some(field => field !== 'planId' && field !== 'planVersion')
        || !Number.isSafeInteger(body.planVersion) || body.planVersion < 1) {
        throw new AnalysisInputError('请提供计划 ID 及正整数计划版本');
      }
      const run = await service.create({ planId: uuid(body.planId), planVersion: body.planVersion }, key);
      res.status(202).json({ code: 202, data: run });
      return;
    }
    const run = await service.create({ spec: body?.spec }, key);
    res.status(202).json({ code: 202, data: run });
  }));
  router.get('/runs', route(async (req, res) => res.json({ code: 200, data: await service.history(integer(req.query.limit, 20, 100)) })));
  router.get('/runs/:id', route(async (req, res) => {
    const run = await service.get(uuid(req.params.id));
    res.status(run ? 200 : 404).json({ code: run ? 200 : 404, ...(run ? { data: run } : { message: '执行记录不存在' }) });
  }));
  router.post('/runs/:id/cancel', route(async (req, res) => {
    const run = await service.cancel(uuid(req.params.id));
    res.status(run ? 200 : 404).json({ code: run ? 200 : 404, ...(run ? { data: run } : { message: '执行记录不存在' }) });
  }));
  router.post('/runs/:id/replay', route(async (req, res) => {
    const run = await service.get(uuid(req.params.id));
    if (!run) { res.status(404).json({ code: 404, message: '执行记录不存在' }); return; }
    if (!run.inputVersions) throw new AnalysisInputError('此执行没有可重放的输入版本');
    const replay = await service.create({ spec: run.spec, expectedVersions: run.inputVersions },
      submissionKey(req, `runs:replay:${run.id}`));
    res.status(202).json({ code: 202, data: replay });
  }));
  router.get('/artifacts/:id', route(async (req, res) => {
    const artifact = await service.getArtifact(uuid(req.params.id));
    if (!artifact) { res.status(404).json({ code: 404, message: '结果不存在' }); return; }
    res.json({ code: 200, data: artifact });
  }));
  return router;
};
