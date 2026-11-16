import type { Pool, PoolClient } from 'pg';
import type { ArtifactDraft } from '../operators/types';
import { operatorOf, type AnalysisArtifact, type AnalysisRun, type AnalysisSpec, type OperatorDescriptor } from './protocol';

interface ArtifactRow {
  id: string;
  run_id: string;
  schema_version: number;
  format: string;
  spec: AnalysisSpec;
  columns: AnalysisArtifact['columns'];
  total_rows: number;
  summary: AnalysisArtifact['summary'];
}

export const readArtifact = async (db: Pool, id: string): Promise<AnalysisArtifact | null> => {
  const row = (await db.query<ArtifactRow>('SELECT * FROM geocsv_analysis_artifacts WHERE id=$1', [id])).rows[0];
  if (!row) return null;
  return {
    id: row.id, runId: row.run_id, schemaVersion: row.schema_version, format: row.format,
    operator: operatorOf(row.spec), spec: row.spec, columns: row.columns, totalRows: row.total_rows, summary: row.summary,
  };
};

export const writeArtifact = async (
  client: PoolClient, id: string, run: AnalysisRun, output: OperatorDescriptor['output'], draft: ArtifactDraft,
) => {
  await client.query(`
    INSERT INTO geocsv_analysis_artifacts(id,run_id,spec,columns,total_rows,summary,format,schema_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, run.id, run.spec, JSON.stringify(draft.columns), draft.totalRows, draft.summary, output.format, output.schemaVersion]);
  await draft.writeRows(client, id);
};
