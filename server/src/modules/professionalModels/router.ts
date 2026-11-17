import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import { sceneContainsFiles } from '../../models/Scene';
import { AnalysisError, AnalysisInputError } from '../analysis/errors';
import { analysisRoute, integer, submissionKey, uuid } from '../analysis/router';
import type { AnalysisService } from '../analysis/service';
import { record } from '../operators/planning';
import { readDataset } from '../spatialPivot/datasets';
import {
  createModel, createNextDraft, getModel, listModels, modelNotFound, modelSpec, professionalOperators, publishModel, updateDraft,
} from './catalog';

const hash = (value: string) => createHash('sha256').update(value).digest();
const requireModelAdmin = (req: Request) => {
  const token = process.env.GEOCSV_MODEL_ADMIN_TOKEN;
  if (!token) throw new AnalysisError(403, 'MODEL_ADMIN_REQUIRED', '此实例尚未启用专业模型管理');
  if (!timingSafeEqual(hash(req.get('Authorization') ?? ''), hash('Bearer ' + token))) {
    throw new AnalysisError(401, 'MODEL_ADMIN_REQUIRED', '请输入正确的专业模型管理密钥');
  }
};

const modelVersion = (req: Request) => [
  uuid(req.params.id), integer(req.params.version, 0, 2147483647),
] as const;

export const createProfessionalModelRouter = (db: Pool, service: AnalysisService) => {
  const router = Router();
  const route = analysisRoute(service);
  const root = '/professional-models';
  const manage = root + '/manage';
  const version = manage + '/:id/:version';
  const scene = '/scenes/:sceneId' + root;

  router.get(root, route(async (_req, res) => res.json({ code: 200, data: await listModels(db, false) })));
  router.get(manage, route(async (req, res) => {
    requireModelAdmin(req);
    res.set('Cache-Control', 'no-store').json({
      code: 200, data: { models: await listModels(db, true), operators: professionalOperators() },
    });
  }));
  router.post(manage, route(async (req, res) => {
    requireModelAdmin(req);
    res.status(201).json({ code: 201, data: await createModel(db, req.body) });
  }));
  router.put(version, route(async (req, res) => {
    requireModelAdmin(req);
    res.json({ code: 200, data: await updateDraft(db, ...modelVersion(req), uuid(req.body?.revision), req.body) });
  }));
  router.post(version + '/next', route(async (req, res) => {
    requireModelAdmin(req);
    res.status(201).json({ code: 201, data: await createNextDraft(db, ...modelVersion(req)) });
  }));
  router.post(version + '/publish', route(async (req, res) => {
    requireModelAdmin(req);
    res.json({ code: 200, data: await publishModel(db, ...modelVersion(req), uuid(req.body?.revision)) });
  }));

  router.get(scene + '/datasets', route(async (req, res) => {
    const { rows } = await db.query(`
      SELECT id AS "fileId", name FROM file_nodes WHERE scene_id=$1 AND type='file' ORDER BY name,id`,
    [uuid(req.params.sceneId)]);
    res.json({ code: 200, data: rows });
  }));
  router.get(scene + '/datasets/:fileId', route(async (req, res) => {
    const { fileId } = req.params;
    if (typeof fileId !== 'string' || !await sceneContainsFiles(db, uuid(req.params.sceneId), [fileId])) {
      throw new AnalysisInputError('所选图层不属于当前场景', 'DATASET_NOT_FOUND');
    }
    res.json({ code: 200, data: await readDataset(db, fileId, true) });
  }));
  router.get(scene + '/runs', route(async (req, res) => {
    const data = await service.history(integer(req.query.limit, 20, 100), undefined, uuid(req.params.sceneId), true);
    res.json({ code: 200, data });
  }));
  router.post(scene + '/:id/:version/runs', route(async (req, res) => {
    const sceneId = uuid(req.params.sceneId);
    if (!record(req.body) || Object.keys(req.body).some(key => !['revision', 'purpose', 'inputs'].includes(key))
      || (req.body.purpose !== 'trial' && req.body.purpose !== 'run')) {
      throw new AnalysisInputError('请提供模型修订、任务用途及所选图层');
    }
    const { purpose, inputs } = req.body;
    if (purpose === 'trial') requireModelAdmin(req);
    const model = await getModel(db, ...modelVersion(req));
    if (purpose === 'run' && !model.published_at) throw modelNotFound();
    if (model.revision !== uuid(req.body.revision) || (purpose === 'trial' && model.published_at)) {
      throw new AnalysisError(409, 'MODEL_REVISION_CONFLICT', '模型配置已变化，请刷新后重试');
    }
    const key = submissionKey(req, `professional-models:${sceneId}:${model.id}:${purpose}`);
    if (!key) throw new AnalysisInputError('创建模型任务需要提供 Idempotency-Key');
    const run = await service.create({
      spec: modelSpec(model, inputs),
      professionalModel: { id: model.id, version: model.version, revision: model.revision, name: model.name, sceneId, purpose },
    }, key);
    res.status(202).json({ code: 202, data: run });
  }));
  return router;
};
