import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { readDataset } from './datasets';
import { AnalysisInputError, SPATIAL_PIVOT_OPERATOR } from './plan';
import { SpatialPivotService } from './service';
import { NaturalAnalysisPlanner } from '../analysisPlanner/service';
import { completeNaturalPlan } from '../analysisPlanner/provider';
import { isLLMConfigured } from '../../integrations/llm/client';

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value)) {
    throw new AnalysisInputError('无效的记录 ID');
  }
  return value;
};
const integer = (value: unknown, fallback: number, max: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new AnalysisInputError('无效的分页参数');
  }
  return Number(value);
};
const csv = (value: string | number): string => {
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

export const createSpatialPivotRouter = (db: Pool, service = new SpatialPivotService(db), planner?: NaturalAnalysisPlanner) => {
  const router = Router();
  const naturalPlanner = planner || new NaturalAnalysisPlanner({
    readDataset: fileId => readDataset(db, fileId),
    validatePlan: spec => service.plan(spec),
    getRun: id => service.get(id),
    complete: context => isLLMConfigured() ? completeNaturalPlan(context) : Promise.reject(new Error('未配置模型解析')),
  });
  const route = (handler: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { await service.initialize(); await handler(req, res); }
    catch (error) {
      if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
      const status = error instanceof AnalysisInputError ? 400 : 500;
      res.status(status).json({ code: status, message: error instanceof Error ? error.message : '分析服务失败' });
    }
  };
  const artifact = async (id: string) => {
    const result = await db.query('SELECT * FROM geocsv_analysis_artifacts WHERE id=$1', [id]);
    return result.rows[0];
  };
  router.get('/datasets', route(async (req, res) => {
    const ids = typeof req.query.ids === 'string' ? [...new Set(req.query.ids.split(',').filter(Boolean))] : [];
    if (ids.length > 30 || ids.some(id => id.length > 255)) throw new AnalysisInputError('一次最多查询 30 个图层');
    res.json({ code: 200, data: await Promise.all(ids.map(id => readDataset(db, id))) });
  }));
  router.get('/operators/spatial-pivot', route(async (_req, res) => res.json({ code: 200, data: SPATIAL_PIVOT_OPERATOR })));
  router.post('/analysis-plans', route(async (req, res) => res.json({ code: 200, data: await service.plan(req.body) })));
  router.post('/analysis-plans/natural-language', route(async (req, res) => {
    res.json({ code: 200, data: await naturalPlanner.plan(req.body) });
  }));
  router.post('/runs', route(async (req, res) => res.status(202).json({ code: 202, data: await service.create(req.body?.spec) })));
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
    res.status(202).json({ code: 202, data: await service.create(run.spec, run.inputVersions) });
  }));
  router.get('/artifacts/:id', route(async (req, res) => {
    const row = await artifact(uuid(req.params.id));
    if (!row) { res.status(404).json({ code: 404, message: '结果不存在' }); return; }
    res.json({ code: 200, data: { id: row.id, runId: row.run_id, spec: row.spec, columns: row.columns, totalRows: row.total_rows, summary: row.summary } });
  }));
  router.get('/artifacts/:id/rows', route(async (req, res) => {
    const id = uuid(req.params.id);
    const row = await artifact(id);
    if (!row) { res.status(404).json({ code: 404, message: '结果不存在' }); return; }
    const page = integer(req.query.page, 1, 1000000);
    const pageSize = integer(req.query.pageSize, 20, 500);
    const rows = await db.query(`SELECT feature_id AS "featureId",label,counts,total FROM geocsv_analysis_artifact_rows
      WHERE artifact_id=$1 ORDER BY feature_id OFFSET $2 LIMIT $3`, [id, (page - 1) * pageSize, pageSize]);
    res.json({ code: 200, data: { rows: rows.rows, total: row.total_rows, page, pageSize } });
  }));
  router.get('/artifacts/:id/geojson', route(async (req, res) => {
    const id = uuid(req.params.id);
    const row = await artifact(id);
    if (!row) { res.status(404).json({ code: 404, message: '结果不存在' }); return; }
    if (row.total_rows > 5000) { res.status(413).json({ code: 413, message: '地图预览最多 5000 个目标，请使用分页结果或 CSV 导出' }); return; }
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
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="spatial-pivot-${id}.csv"`);
    res.write('\uFEFF' + ['feature_id', '目标', '合计', ...row.columns.map((column: { label: string }) => column.label)].map(csv).join(',') + '\r\n');
    let after = 0;
    while (!res.destroyed) {
      const batch = await db.query(`SELECT feature_id,label,total,counts FROM geocsv_analysis_artifact_rows
        WHERE artifact_id=$1 AND feature_id>$2 ORDER BY feature_id LIMIT 500`, [id, after]);
      if (!batch.rowCount) break;
      for (const item of batch.rows) {
        res.write([item.feature_id, item.label, item.total, ...row.columns.map((column: { key: string }) => item.counts[column.key] ?? 0)].map(csv).join(',') + '\r\n');
      }
      after = batch.rows[batch.rows.length - 1].feature_id;
    }
    res.end();
  }));
  return router;
};
