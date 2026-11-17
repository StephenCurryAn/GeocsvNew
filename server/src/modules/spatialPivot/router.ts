import { Router } from 'express';
import type { Pool } from 'pg';
import { analysisRoute } from '../analysis/router';
import { AnalysisService } from '../analysis/service';
import { readDataset, validateDatasets } from './datasets';
import { AnalysisInputError, parseSpatialPivotSpec, SPATIAL_PIVOT_OPERATOR } from './plan';
import { NaturalAnalysisPlanner } from '../analysisPlanner/service';
import { isAgentConfigured, requestDraft } from '../../integrations/agent/client';
import { pivotPlanningHistory, spatialPivot } from '../operators/spatialPivot';

export const createSpatialPivotRouter = (db: Pool, service = new AnalysisService(db), planner?: NaturalAnalysisPlanner) => {
  const router = Router();
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
      async complete({ userPrompt, datasets, previousSpec }) {
        const result = await requestDraft({
          userPrompt, datasets, history: previousSpec ? pivotPlanningHistory(previousSpec) : undefined,
        }, [spatialPivot]);
        return result.status === 'ready'
          ? { status: 'ready', spec: result.spec, view: result.view, unsupportedRequirements: [] }
          : result;
      },
    } : {}),
  });
  const route = analysisRoute(service);
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
  return router;
};
