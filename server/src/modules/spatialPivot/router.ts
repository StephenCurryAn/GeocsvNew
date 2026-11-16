import { Router } from 'express';
import type { Pool } from 'pg';
import { analysisRoute, createAnalysisRouter, integer, uuid } from '../analysis/router';
import { AnalysisService } from '../analysis/service';
import { readDataset, validateDatasets } from './datasets';
import { AnalysisInputError, parseSpatialPivotSpec, SPATIAL_PIVOT_OPERATOR } from './plan';
import { NaturalAnalysisPlanner } from '../analysisPlanner/service';
import { isAgentConfigured, requestDraft } from '../../integrations/agent/client';

const moranColumns = `feature_id AS "featureId",local_i AS "localI",expected_i AS "expectedI",z,
  lag_z AS "lagZ",neighbor_count AS "neighborCount",p_value AS "pValue",quadrant`;

const csv = (value: string | number): string => {
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};

export const createSpatialPivotRouter = (db: Pool, service = new AnalysisService(db), planner?: NaturalAnalysisPlanner) => {
  const router = Router();
  router.use(createAnalysisRouter(service));
  const validatePlan = async (input: unknown) => {
    const spec = parseSpatialPivotSpec(input);
    await validateDatasets(db, spec);
    return spec;
  };
  const naturalPlanner = planner || new NaturalAnalysisPlanner({
    readDataset: fileId => readDataset(db, fileId),
    validatePlan,
    async getRun(id) {
      const run = await service.get(id);
      return run?.operator.id === SPATIAL_PIVOT_OPERATOR.id && run.operator.version === SPATIAL_PIVOT_OPERATOR.version
        ? { ...run, spec: parseSpatialPivotSpec(run.spec) } : null;
    },
    ...(isAgentConfigured() ? {
      complete: ({ userPrompt, datasets, previousSpec }) => requestDraft({
        userPrompt, datasets, previousPivot: previousSpec, pivotOnly: true,
      }),
    } : {}),
  });
  const route = analysisRoute(service);
  const artifact = async (id: string) => {
    const result = await service.getArtifact(id);
    return result?.schemaVersion === 1 && ['spatial_counts', 'moran_lisa'].includes(result.format) ? result : null;
  };
  router.get('/datasets', route(async (req, res) => {
    const ids = typeof req.query.ids === 'string' ? [...new Set(req.query.ids.split(',').filter(Boolean))] : [];
    if (ids.length > 30 || ids.some(id => id.length > 255)) throw new AnalysisInputError('一次最多查询 30 个图层');
    res.json({ code: 200, data: await Promise.all(ids.map(id => readDataset(db, id))) });
  }));
  router.get('/operators/spatial-pivot', route(async (_req, res) => res.json({ code: 200, data: SPATIAL_PIVOT_OPERATOR })));
  router.post('/analysis-plans', route(async (req, res) => res.json({ code: 200, data: await validatePlan(req.body) })));
  router.post('/analysis-plans/natural-language', route(async (req, res) => {
    const result = await naturalPlanner.plan(req.body);
    const data = result.status === 'ready' ? { ...result, plan: await service.createPlan(result.spec) } : result;
    res.json({ code: 200, data });
  }));
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
    const headers = moran ? ['feature_id'] : ['feature_id', '目标', '合计'];
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
          ? [item.feature_id, ...row.columns.map(column => item[column.key] ?? '')]
          : [item.feature_id, item.label, item.total, ...row.columns.map(column => item.counts[column.key] ?? 0)];
        res.write(fields.map(csv).join(',') + '\r\n');
      }
      after = batch.rows[batch.rows.length - 1].feature_id;
    }
    res.end();
  }));
  return router;
};
