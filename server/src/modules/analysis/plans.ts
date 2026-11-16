import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { operatorOf, type AnalysisPlan, type AnalysisSpec, type InputVersions } from './protocol';

interface PlanRow {
  id: string;
  version: number;
  spec: AnalysisSpec;
  spec_hash: string;
  input_versions: InputVersions;
  created_at: Date;
  confirmed_at: Date | null;
}

const fromRow = (row: PlanRow): AnalysisPlan => ({
  schemaVersion: 1, id: row.id, version: row.version, operator: operatorOf(row.spec), spec: row.spec,
  specHash: row.spec_hash, inputVersions: row.input_versions,
  status: row.confirmed_at ? 'confirmed' : 'validated',
  createdAt: row.created_at.toISOString(), confirmedAt: row.confirmed_at?.toISOString() ?? null,
});

export const readPlan = async (db: Pool | PoolClient, id: string): Promise<AnalysisPlan | null> => {
  const row = (await db.query<PlanRow>('SELECT * FROM geocsv_analysis_plans WHERE id=$1', [id])).rows[0];
  return row ? fromRow(row) : null;
};

export const writePlan = async (
  db: PoolClient, spec: AnalysisSpec, specHash: string, versions: InputVersions, confirmed: boolean,
): Promise<AnalysisPlan> => {
  const result = await db.query<PlanRow>(`
    INSERT INTO geocsv_analysis_plans(id,spec,spec_hash,input_versions,confirmed_at)
    VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now() END) RETURNING *`,
    [randomUUID(), spec, specHash, versions, confirmed]);
  return fromRow(result.rows[0]);
};

export const confirmPlan = async (db: PoolClient, plan: AnalysisPlan) => {
  if (plan.status === 'validated') {
    await db.query('UPDATE geocsv_analysis_plans SET confirmed_at=now() WHERE id=$1 AND confirmed_at IS NULL', [plan.id]);
  }
};
