import { SPATIAL_PIVOT_OPERATOR, buildSpatialPivotQuery, formatSpatialCounts, parseSpatialPivotSpec, type SpatialCount } from '../spatialPivot/plan';
import { fingerprintDataset, validateDatasets } from '../spatialPivot/datasets';
import type { Operator } from './types';

export const spatialPivot: Operator = {
  descriptor: {
    id: SPATIAL_PIVOT_OPERATOR.id,
    version: SPATIAL_PIVOT_OPERATOR.version,
    name: SPATIAL_PIVOT_OPERATOR.name,
    executor: 'postgis',
    inputs: {
      target: { geometryTypes: SPATIAL_PIVOT_OPERATOR.targetGeometry },
      join: { geometryTypes: SPATIAL_PIVOT_OPERATOR.joinGeometry },
    },
    parameterSchema: '#/$defs/SpatialPivotSpec',
    output: { format: 'spatial_counts', schemaVersion: 1 },
  },
  prepare(input) {
    const spec = parseSpatialPivotSpec(input);
    return {
      spec,
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
