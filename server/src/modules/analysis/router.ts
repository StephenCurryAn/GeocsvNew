import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { listOperators } from '../operators/registry';
import { AnalysisError, AnalysisInputError } from './errors';
import type { AnalysisService } from './service';
import { traceError, traceEvent, traceRequest } from './trace';

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
  (handler: (req: Request, res: Response) => Promise<unknown>, operation?: string) => async (req: Request, res: Response) => {
    const work = async () => {
      try { await service.initialize(); await handler(req, res); }
      catch (error) {
        traceEvent('http.error', { operation, errorCategory: traceError(error) });
        if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
        const status = error instanceof AnalysisError ? error.status : 500;
        res.status(status).json({
          code: status,
          message: error instanceof Error ? error.message : '分析服务失败',
          ...(error instanceof AnalysisError ? { errorCode: error.errorCode } : {}),
        });
      }
    };
    if (operation) await traceRequest(req, res, operation, work);
    else await work();
  };

const moranColumns = `feature_id AS "featureId",label,local_i AS "localI",expected_i AS "expectedI",z,
  lag_z AS "lagZ",neighbor_count AS "neighborCount",p_value AS "pValue",quadrant`;

const csv = (value: string | number): string => {
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

export const createAnalysisRouter = (db: Pool, service: AnalysisService) => {
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
  router.get('/runs', route(async (req, res) => {
    const operator = req.query.operator;
    if (operator !== undefined && (typeof operator !== 'string' || !listOperators().some(item => item.id === operator))) {
      throw new AnalysisInputError('无效的历史算子筛选条件', 'UNSUPPORTED_OPERATOR');
    }
    res.json({ code: 200, data: await service.history(integer(req.query.limit, 20, 100), operator) });
  }));
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
    const replay = await service.create({ spec: run.spec, expectedVersions: run.inputVersions, replayRunId: run.id,
      professionalModel: run.professionalModel },
      submissionKey(req, `runs:replay:${run.id}`));
    res.status(202).json({ code: 202, data: replay });
  }));
  router.get('/artifacts/:id', route(async (req, res) => {
    const artifact = await service.getArtifact(uuid(req.params.id));
    if (!artifact) { res.status(404).json({ code: 404, message: '结果不存在' }); return; }
    res.json({ code: 200, data: artifact });
  }));
  const artifact = async (id: string) => {
    const result = await service.getArtifact(id);
    return result?.schemaVersion === 1 && ['spatial_counts', 'moran_lisa'].includes(result.format) ? result : null;
  };
  router.get('/artifacts/:id/rows', route(async (req, res) => {
    const id = uuid(req.params.id);
    const row = await artifact(id);
    if (!row) { res.status(404).json({ code: 404, message: '结果不存在' }); return; }
    const page = integer(req.query.page, 1, 1000000);
    const pageSize = integer(req.query.pageSize, 20, 500);
    const select = row.format === 'moran_lisa'
      ? `SELECT ${moranColumns} FROM geocsv_analysis_moran_rows`
      : 'SELECT feature_id AS "featureId",label,counts,total FROM geocsv_analysis_artifact_rows';
    const rows = await db.query(`${select} WHERE artifact_id=$1 ORDER BY feature_id OFFSET $2 LIMIT $3`,
      [id, (page - 1) * pageSize, pageSize]);
    res.json({ code: 200, data: { rows: rows.rows, total: row.totalRows, page, pageSize } });
  }));
  router.get('/artifacts/:id/geojson', route(async (req, res) => {
    const id = uuid(req.params.id);
    const row = await artifact(id);
    if (!row) { res.status(404).json({ code: 404, message: '结果不存在' }); return; }
    if (row.totalRows > 5000) { res.status(413).json({ code: 413, message: '地图预览最多 5000 个目标，请使用分页结果或 CSV 导出' }); return; }
    if (row.format === 'moran_lisa') {
      const result = await db.query(`SELECT ${moranColumns},ST_AsGeoJSON(geom)::jsonb AS geometry
        FROM geocsv_analysis_moran_rows WHERE artifact_id=$1 ORDER BY feature_id`, [id]);
      res.json({ type: 'FeatureCollection', features: result.rows.map(({ geometry, ...properties }) => ({
        type: 'Feature', id: properties.featureId, geometry, properties,
      })) });
      return;
    }
    const result = await db.query(`SELECT feature_id,label,counts,total,ST_AsGeoJSON(geom)::jsonb AS geometry
      FROM geocsv_analysis_artifact_rows WHERE artifact_id=$1 ORDER BY feature_id`, [id]);
    res.json({ type: 'FeatureCollection', features: result.rows.map(item => ({
      type: 'Feature', id: item.feature_id, geometry: item.geometry,
      properties: { featureId: item.feature_id, label: item.label, total: item.total, ...item.counts },
    })) });
  }));
  router.get('/artifacts/:id/export.csv', route(async (req, res) => {
    const id = uuid(req.params.id);
    const row = await artifact(id);
    if (!row) { res.status(404).json({ code: 404, message: '结果不存在' }); return; }
    const moran = row.format === 'moran_lisa';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${moran ? 'moran-lisa' : 'spatial-pivot'}-${id}.csv"`);
    const headers = moran ? ['feature_id', '区域'] : ['feature_id', '目标', '合计'];
    res.write('\uFEFF' + [...headers, ...row.columns.map(column => column.label)].map(csv).join(',') + '\r\n');
    let after = 0;
    while (!res.destroyed) {
      const select = moran
        ? `SELECT feature_id,${moranColumns} FROM geocsv_analysis_moran_rows`
        : 'SELECT feature_id,label,total,counts FROM geocsv_analysis_artifact_rows';
      const batch = await db.query(`${select} WHERE artifact_id=$1 AND feature_id>$2 ORDER BY feature_id LIMIT 500`, [id, after]);
      if (!batch.rowCount) break;
      for (const item of batch.rows) {
        const fields = moran
          ? [item.feature_id, item.label ?? '', ...row.columns.map(column => item[column.key] ?? '')]
          : [item.feature_id, item.label, item.total, ...row.columns.map(column => item.counts[column.key] ?? 0)];
        res.write(fields.map(csv).join(',') + '\r\n');
      }
      after = batch.rows[batch.rows.length - 1].feature_id;
    }
    res.end();
  }));
  return router;
};
