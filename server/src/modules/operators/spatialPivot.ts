import { SPATIAL_PIVOT_OPERATOR, SPATIAL_PIVOT_PARAMETERS, buildSpatialPivotQuery, formatSpatialCounts,
  parseSpatialPivotSpec, type SpatialCount, type SpatialPivotSpec } from '../spatialPivot/plan';
import { fingerprintDataset, validateDatasets } from '../spatialPivot/datasets';
import { boundaryChoice, unsupportedRequirement } from '../analysisPlanner/rules';
import { NaturalAnalysisPlanner } from '../analysisPlanner/service';
import { clarification } from '../analysisPlanner/types';
import { readOperatorParameters } from './parameters';
import { fitsInput, namedDatasets, sameOperator, type PlanningHistory } from './planning';
import type { Operator } from './types';

export const pivotPlanningHistory = (spec: SpatialPivotSpec): PlanningHistory => ({
  operator: { id: spec.kind, version: spec.operatorVersion },
  fileIds: { target: spec.target.fileId, join: spec.join.fileId },
  parameters: { boundaryPolicy: spec.boundaryPolicy },
});

export const spatialPivot: Operator = {
  descriptor: {
    id: SPATIAL_PIVOT_OPERATOR.id,
    version: SPATIAL_PIVOT_OPERATOR.version,
    name: SPATIAL_PIVOT_OPERATOR.name,
    aliases: ['空间透视', '面内点计数', '面内点统计'],
    description: '统计每个目标面内的点数，可按点字段分类和指定面标识字段。重叠面分别计数，保留零计数目标。仅支持面内点计数，支持沿用同一算子的历史边界规则。',
    executor: 'postgis',
    inputs: {
      target: { geometryTypes: SPATIAL_PIVOT_OPERATOR.targetGeometry,
        fields: { labelField: { type: 'any', required: false, description: '目标面的标识字段' } } },
      join: { geometryTypes: SPATIAL_PIVOT_OPERATOR.joinGeometry,
        fields: { categoryField: { type: 'any', required: false, description: '点分类字段' } } },
    },
    parameterSchema: '#/$defs/SpatialPivotSpec',
    planningParameters: SPATIAL_PIVOT_PARAMETERS,
    output: { format: 'spatial_counts', schemaVersion: 1 },
  },
  async planDraft({ inputs, parameters, datasets, userPrompt, history }) {
    const unsupported = unsupportedRequirement(userPrompt);
    if (unsupported) return { status: 'unsupported', message: unsupported };
    for (const [role, definition] of Object.entries(spatialPivot.descriptor.inputs)) {
      const eligible = datasets.filter(dataset => fitsInput(dataset, definition));
      const explicit = namedDatasets(userPrompt, eligible);
      const choices = explicit.length ? explicit : eligible;
      if (choices.length !== 1 || choices[0].fileId !== inputs[role].dataset.fileId) {
        return clarification('请明确空间透视使用的目标面图层和关联点图层。');
      }
    }
    const boundary = boundaryChoice(userPrompt);
    if (boundary === 'conflict') return clarification('边界点同时被要求纳入和排除，请选择一种规则。');
    const prior = history && sameOperator(history.operator, spatialPivot.descriptor)
      ? history.parameters?.boundaryPolicy : undefined;
    const previous: Pick<SpatialPivotSpec, 'boundaryPolicy'> | undefined = prior === 'include' || prior === 'exclude'
      ? { boundaryPolicy: prior } : undefined;
    const effective = readOperatorParameters(SPATIAL_PIVOT_PARAMETERS, {
      ...parameters, boundaryPolicy: parameters.boundaryPolicy === undefined ? previous?.boundaryPolicy : parameters.boundaryPolicy,
    });
    const { target, join } = inputs;
    const result = await NaturalAnalysisPlanner.reviewProposal({
      status: 'ready', unsupportedRequirements: [], view: { chartType: effective.chartType },
      spec: { schemaVersion: 1, kind: SPATIAL_PIVOT_OPERATOR.id, operatorVersion: SPATIAL_PIVOT_OPERATOR.version,
        target: { fileId: target.dataset.fileId, labelField: target.fields.labelField ?? null },
        join: { fileId: join.dataset.fileId, categoryField: join.fields.categoryField ?? null },
        boundaryPolicy: effective.boundaryPolicy },
    }, datasets, userPrompt, previous);
    if (result.status === 'view_only') return clarification('请明确要计算的空间透视参数。');
    return result.status === 'ready' ? { ...result, source: 'llm' } : result;
  },
  prepare(input) {
    const spec = parseSpatialPivotSpec(input);
    return {
      spec,
      executor: 'postgis',
      async validate(client) { await validateDatasets(client, spec); },
      async fingerprint(client) {
        return {
          target: await fingerprintDataset(client, spec.target.fileId),
          join: await fingerprintDataset(client, spec.join.fileId),
        };
      },
      async execute(client) {
        const datasets = await validateDatasets(client, spec);
        const query = buildSpatialPivotQuery(spec);
        const counts = await client.query<SpatialCount>(query.text, query.values);
        const { columns, rows } = formatSpatialCounts(counts.rows, spec.join.categoryField !== null);
        return {
          columns,
          totalRows: rows.length,
          summary: {
            targetCount: datasets.target.featureCount, joinCount: datasets.join.featureCount,
            matchedPairs: rows.reduce((sum, row) => sum + row.total, 0),
            boundaryPolicy: spec.boundaryPolicy, matchPolicy: 'all_matches',
            operator: 'spatial_pivot@1', analysisCrs: 'EPSG:4326 (topological predicates)',
          },
          // Copy geometry inside the artifact transaction, using the computation snapshot.
          async writeRows(db, artifactId) {
            await db.query(`
              INSERT INTO geocsv_analysis_artifact_rows(artifact_id,feature_id,label,counts,total,geom)
              SELECT $1, r."featureId", r.label, r.counts, r.total, f.geom
              FROM jsonb_to_recordset($2::jsonb) AS r("featureId" integer,label text,counts jsonb,total integer)
              JOIN spatial_features f ON f.id=r."featureId" AND f.file_id=$3`,
              [artifactId, JSON.stringify(rows), spec.target.fileId]);
          },
        };
      },
    };
  },
};
