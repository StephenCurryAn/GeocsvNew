import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AnalysisInputError, buildSpatialPivotQuery, formatSpatialCounts, parseSpatialPivotSpec, type SpatialCount, type SpatialPivotSpec } from './plan';
import { fingerprintDataset, validateDatasets } from './datasets';
import { SPATIAL_PIVOT_SCHEMA } from './schema';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface AnalysisRun {
  id: string; definitionId: string; status: RunStatus; spec: SpatialPivotSpec;
  inputVersions: unknown; artifactId: string | null; error: string | null;
  createdAt: string; completedAt: string | null;
}

interface RunRow {
  id: string; definition_id: string; status: RunStatus; spec: SpatialPivotSpec;
  input_versions: unknown; artifact_id: string | null; error: string | null;
  created_at: Date | string; completed_at: Date | string | null;
}

const runFromRow = (row: RunRow): AnalysisRun => ({
  id: row.id, definitionId: row.definition_id, status: row.status, spec: row.spec,
  inputVersions: row.input_versions, artifactId: row.artifact_id, error: row.error,
  createdAt: new Date(row.created_at).toISOString(),
  completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
});

const connectSafely = async (db: Pool) => {
  const client = await db.connect();
  let connectionError: Error | undefined;
  const onError = (error: Error) => { connectionError = error; };
  // pg-pool only handles errors while a client is idle, not while checked out.
  client.on('error', onError);
  return {
    client,
    release(discard = false) {
      client.removeListener('error', onError);
      client.release(connectionError || discard);
    },
  };
};

export class SpatialPivotService {
  private ready?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;
  private stopped = false;
  private recovered = false;

  constructor(private readonly db: Pool, private readonly timeoutMs = 120000) {}

  initialize(): Promise<void> {
    if (!this.ready) {
      this.ready = this.db.query(SPATIAL_PIVOT_SCHEMA).then(() => {
        this.timer = setInterval(() => void this.drain(), 1000);
        this.timer.unref();
        void this.drain();
      }).catch(error => { this.ready = undefined; throw error; });
    }
    return this.ready;
  }

  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); }

  async plan(input: unknown): Promise<SpatialPivotSpec> {
    const spec = parseSpatialPivotSpec(input);
    await validateDatasets(this.db, spec);
    return spec;
  }

  async create(input: unknown, expectedVersions: unknown = null): Promise<AnalysisRun> {
    await this.initialize();
    const spec = parseSpatialPivotSpec(input);
    const json = JSON.stringify(spec);
    const hash = createHash('sha256').update(json).digest('hex');
    const connection = await connectSafely(this.db);
    const { client } = connection;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await validateDatasets(client, spec);
      const inputVersions = expectedVersions || {
        target: await fingerprintDataset(client, spec.target.fileId),
        join: await fingerprintDataset(client, spec.join.fileId),
      };
      const definition = await client.query(`
        INSERT INTO geocsv_analysis_definitions(id, spec_hash, spec) VALUES($1,$2,$3)
        ON CONFLICT(spec_hash) DO UPDATE SET spec_hash = EXCLUDED.spec_hash RETURNING id`, [randomUUID(), hash, json]);
      const result = await client.query(`
        INSERT INTO geocsv_analysis_runs(id, definition_id, spec, input_versions)
        VALUES($1,$2,$3,$4) RETURNING *`, [randomUUID(), definition.rows[0].id, json, inputVersions]);
      await client.query('COMMIT');
      setImmediate(() => void this.drain());
      return runFromRow(result.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }

  async get(id: string): Promise<AnalysisRun | null> {
    const result = await this.db.query('SELECT * FROM geocsv_analysis_runs WHERE id = $1', [id]);
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  async history(limit: number): Promise<AnalysisRun[]> {
    const result = await this.db.query('SELECT * FROM geocsv_analysis_runs ORDER BY created_at DESC, id LIMIT $1', [limit]);
    return result.rows.map(runFromRow);
  }

  async cancel(id: string): Promise<AnalysisRun | null> {
    const connection = await connectSafely(this.db);
    const { client } = connection;
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM geocsv_analysis_runs WHERE id=$1 FOR UPDATE', [id]);
      const row = result.rows[0];
      if (!row) { await client.query('ROLLBACK'); return null; }
      if (row.status === 'queued' || row.status === 'running') {
        await client.query(`UPDATE geocsv_analysis_runs SET cancel_requested=true,
          status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
          completed_at=CASE WHEN status='queued' THEN now() ELSE completed_at END WHERE id=$1`, [id]);
        if (row.status === 'running' && row.backend_pid) {
          await client.query(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
            WHERE pid=$1 AND datname=current_database() AND application_name=$2`,
            [row.backend_pid, `geocsv-spatial:${id}`]);
        }
      }
      await client.query('COMMIT');
      return this.get(id);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  }

  private async drain() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    let client: PoolClient | undefined;
    let connection: Awaited<ReturnType<typeof connectSafely>> | undefined;
    let locked = false;
    let discardClient = false;
    try {
      connection = await connectSafely(this.db);
      client = connection.client;
      const lock = await client.query('SELECT pg_try_advisory_lock(193607241) AS locked');
      locked = lock.rows[0].locked;
      if (!locked) return;
      if (!this.recovered) {
        // With the worker lock held, no other worker can still be executing a run.
        await client.query(`UPDATE geocsv_analysis_runs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
          error='计算进程或连接中断，请重新运行', backend_pid=NULL, completed_at=now() WHERE status='running'`);
        this.recovered = true;
      }
      while (!this.stopped) {
        const next = await client.query(`
          UPDATE geocsv_analysis_runs SET status='running', backend_pid=pg_backend_pid()
          WHERE id=(SELECT id FROM geocsv_analysis_runs WHERE status='queued' ORDER BY created_at,id LIMIT 1)
          AND status='queued' RETURNING *`);
        if (!next.rowCount) break;
        await this.execute(client, runFromRow(next.rows[0]));
      }
    } catch (error) {
      // If rollback/failure registration also lost its connection, recover its persisted
      // running record on the next successful acquisition of the exclusive worker lock.
      this.recovered = false;
      discardClient = true;
      console.error('[SpatialPivot worker]', error instanceof Error ? error.message : error);
    }
    finally {
      if (client) {
        if (locked) await client.query('SELECT pg_advisory_unlock(193607241)').catch(() => undefined);
        connection!.release(discardClient);
      }
      this.draining = false;
    }
  }

  private async execute(client: PoolClient, run: AnalysisRun) {
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query(`SELECT set_config('statement_timeout', $1, true),
        set_config('application_name', $2, true)`, [String(this.timeoutMs), `geocsv-spatial:${run.id}`]);
      const spec = parseSpatialPivotSpec(run.spec);
      const datasets = await validateDatasets(client, spec);
      const versions = {
        target: await fingerprintDataset(client, spec.target.fileId),
        join: await fingerprintDataset(client, spec.join.fileId),
      };
      if (run.inputVersions && JSON.stringify(run.inputVersions) !== JSON.stringify(versions)) {
        // JSONB key order is not an application-level ordering contract.
        const expected = run.inputVersions as typeof versions;
        if (expected.target?.fingerprint !== versions.target.fingerprint || expected.join?.fingerprint !== versions.join.fingerprint) {
          throw new AnalysisInputError('输入数据已改变，无法按历史版本重放；请创建新分析');
        }
      }
      const query = buildSpatialPivotQuery(spec);
      const counts = await client.query<SpatialCount>(query.text, query.values);
      const result = formatSpatialCounts(counts.rows, spec.join.categoryField !== null);
      const artifactId = randomUUID();
      const summary = {
        targetCount: datasets.target.featureCount, joinCount: datasets.join.featureCount,
        matchedPairs: result.rows.reduce((sum, row) => sum + row.total, 0),
        boundaryPolicy: spec.boundaryPolicy, matchPolicy: 'all_matches',
        operator: 'spatial_pivot@1', analysisCrs: 'EPSG:4326 (topological predicates)',
      };
      await client.query(`INSERT INTO geocsv_analysis_artifacts(id,run_id,spec,columns,total_rows,summary)
        VALUES($1,$2,$3,$4,$5,$6)`, [artifactId, run.id, spec, JSON.stringify(result.columns), result.rows.length, summary]);
      // Copy result geometry at execution time; later source edits never change the artifact.
      await client.query(`
        INSERT INTO geocsv_analysis_artifact_rows(artifact_id,feature_id,label,counts,total,geom)
        SELECT $1, r."featureId", r.label, r.counts, r.total, f.geom
        FROM jsonb_to_recordset($2::jsonb) AS r("featureId" integer,label text,counts jsonb,total integer)
        JOIN spatial_features f ON f.id=r."featureId" AND f.file_id=$3`,
        [artifactId, JSON.stringify(result.rows), spec.target.fileId]);
      // This update locks the run row. A concurrent cancel either wins before commit
      // (serialization error -> rollback) or observes the already committed terminal state.
      const completed = await client.query(`UPDATE geocsv_analysis_runs
        SET status='succeeded', artifact_id=$2, input_versions=$3, backend_pid=NULL, completed_at=now()
        WHERE id=$1 AND status='running' AND NOT cancel_requested RETURNING id`, [run.id, artifactId, versions]);
      if (!completed.rowCount) throw new Error('任务已取消');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      const details = error instanceof Error ? error.message : '空间分析执行失败';
      await client.query(`UPDATE geocsv_analysis_runs
        SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
            error=$2, backend_pid=NULL, completed_at=now() WHERE id=$1 AND status='running'`, [run.id, details]);
    }
  }
}
