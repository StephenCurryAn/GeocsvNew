import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { requireOperator } from '../operators/registry';
import type { PreparedOperator } from '../operators/types';
import { readArtifact, writeArtifact } from './artifacts';
import { connectSafely, transaction } from './database';
import { AnalysisError, AnalysisInputError, InputVersionChanged, RequestKeyConflict, type AnalysisErrorCode } from './errors';
import { migrateAnalysis } from './migrations';
import { confirmPlan, readPlan, writePlan } from './plans';
import { operatorOf, type AnalysisRun, type AnalysisSpec, type InputVersions, type RunStatus } from './protocol';

export interface SubmissionKey {
  actor: string;
  scope: string;
  key: string;
}

type PlanReference = { planId: string; planVersion: number };
type RunSubmission = { spec: unknown; expectedVersions?: InputVersions } | PlanReference;
type PreparedSubmission = { operator: PreparedOperator; expectedVersions?: InputVersions } | PlanReference;

interface RunRow {
  id: string;
  definition_id: string;
  plan_id: string | null;
  status: RunStatus;
  spec: AnalysisSpec;
  request_hash: string | null;
  input_versions: InputVersions | null;
  artifact_id: string | null;
  error: string | null;
  error_code: AnalysisErrorCode | null;
  created_at: Date;
  completed_at: Date | null;
}

const runFromRow = (row: RunRow): AnalysisRun => ({
  schemaVersion: 1, id: row.id, definitionId: row.definition_id, planId: row.plan_id, operator: operatorOf(row.spec),
  status: row.status, spec: row.spec, inputVersions: row.input_versions, artifactId: row.artifact_id,
  error: row.error, errorCode: row.error_code,
  createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
});

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const prepare = (input: unknown) => requireOperator(input).prepare(input);

export class AnalysisService {
  private ready?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;
  private stopped = false;
  private recovered = false;

  constructor(private readonly db: Pool, private readonly timeoutMs = 120000) {}

  initialize(): Promise<void> {
    if (!this.ready) {
      this.ready = migrateAnalysis(this.db).then(() => {
        this.timer = setInterval(() => void this.drain(), 1000);
        this.timer.unref();
        void this.drain();
      }).catch(error => { this.ready = undefined; throw error; });
    }
    return this.ready;
  }

  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); }

  async createPlan(input: unknown) {
    await this.initialize();
    const operator = prepare(input);
    return transaction(this.db, 'BEGIN ISOLATION LEVEL REPEATABLE READ', async client => {
      await operator.validate(client);
      const versions = await operator.fingerprint(client);
      return writePlan(client, operator.spec, digest(operator.spec), versions, false);
    });
  }

  getPlan(id: string) { return readPlan(this.db, id); }

  getArtifact(id: string) { return readArtifact(this.db, id); }

  async create(request: RunSubmission, submission?: SubmissionKey): Promise<AnalysisRun> {
    await this.initialize();
    if ('planId' in request && !submission) throw new AnalysisInputError('确认计划需要提供 Idempotency-Key');
    const prepared: PreparedSubmission = 'spec' in request
      ? { operator: prepare(request.spec), expectedVersions: request.expectedVersions }
      : request;
    // The legacy form and replay keep the request digest introduced with submission keys.
    const requestHash = submission ? digest('operator' in prepared
      ? { spec: prepared.operator.spec, expectedVersions: prepared.expectedVersions ?? null }
      : { planId: prepared.planId, planVersion: prepared.planVersion }) : null;

    for (let retry = 0; ; retry++) {
      try {
        const run = await transaction(this.db, 'BEGIN ISOLATION LEVEL REPEATABLE READ', client =>
          this.createRun(client, prepared, submission, requestHash));
        setImmediate(() => void this.drain());
        return run;
      } catch (error) {
        // A concurrent insert or confirmation can become visible after our snapshot.
        const dbError = error as { code?: string; constraint?: string };
        const concurrentWrite = dbError.code === '40001'
          || (dbError.code === '23505' && dbError.constraint === 'geocsv_runs_request_key');
        if (!concurrentWrite || retry >= 3) throw error;
      }
    }
  }

  private async createRun(
    client: PoolClient, request: PreparedSubmission,
    submission: SubmissionKey | undefined, requestHash: string | null,
  ): Promise<AnalysisRun> {
    if (submission) {
      const existing = await client.query<RunRow>(`SELECT * FROM geocsv_analysis_runs
        WHERE request_actor=$1 AND request_scope=$2 AND request_key=$3`,
        [submission.actor, submission.scope, submission.key]);
      const row = existing.rows[0];
      if (row) {
        if (row.request_hash !== requestHash) throw new RequestKeyConflict();
        return runFromRow(row);
      }
    }

    const plan = 'planId' in request
      ? await this.checkPlan(client, request.planId, request.planVersion)
      : await this.implicitPlan(client, request.operator, request.expectedVersions);
    const existingDefinition = await client.query('SELECT id FROM geocsv_analysis_definitions WHERE spec_hash=$1', [plan.specHash]);
    const definitionId = existingDefinition.rows[0]?.id ?? (await client.query(`
      INSERT INTO geocsv_analysis_definitions(id, spec_hash, spec) VALUES($1,$2,$3)
      ON CONFLICT(spec_hash) DO UPDATE SET spec_hash = EXCLUDED.spec_hash RETURNING id`,
      [randomUUID(), plan.specHash, plan.spec])).rows[0].id;
    const result = await client.query<RunRow>(`
      INSERT INTO geocsv_analysis_runs(id, definition_id, spec, input_versions, plan_id,
        request_actor, request_scope, request_key, request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [randomUUID(), definitionId, plan.spec, plan.inputVersions, plan.id,
        submission?.actor, submission?.scope, submission?.key, requestHash]);
    await confirmPlan(client, plan);
    return runFromRow(result.rows[0]);
  }

  private async checkPlan(client: PoolClient, id: string, version: number) {
    const plan = await readPlan(client, id);
    if (!plan) throw new AnalysisError(404, 'PLAN_NOT_FOUND', '分析计划不存在');
    if (plan.version !== version) throw new AnalysisError(409, 'PLAN_VERSION_CONFLICT', '计划版本已变化，请重新加载并确认');
    const operator = prepare(plan.spec);
    const stale = () => new InputVersionChanged('输入数据已改变，请重新校验并确认计划');
    if (!isDeepStrictEqual(plan.inputVersions, await operator.fingerprint(client))) throw stale();
    try { await operator.validate(client); }
    catch (error) {
      if (error instanceof AnalysisInputError) throw stale();
      throw error;
    }
    return plan;
  }

  private async implicitPlan(client: PoolClient, operator: PreparedOperator, expectedVersions?: InputVersions) {
    await operator.validate(client);
    const versions = expectedVersions ?? await operator.fingerprint(client);
    return writePlan(client, operator.spec, digest(operator.spec), versions, true);
  }

  async get(id: string): Promise<AnalysisRun | null> {
    const result = await this.db.query<RunRow>('SELECT * FROM geocsv_analysis_runs WHERE id = $1', [id]);
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  async history(limit: number): Promise<AnalysisRun[]> {
    const result = await this.db.query<RunRow>('SELECT * FROM geocsv_analysis_runs ORDER BY created_at DESC, id LIMIT $1', [limit]);
    return result.rows.map(runFromRow);
  }

  async cancel(id: string): Promise<AnalysisRun | null> {
    const found = await transaction(this.db, 'BEGIN', async client => {
      const result = await client.query('SELECT * FROM geocsv_analysis_runs WHERE id=$1 FOR UPDATE', [id]);
      const row = result.rows[0];
      if (!row) return false;
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
      return true;
    });
    return found ? this.get(id) : null;
  }

  private async drain() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    let connection: Awaited<ReturnType<typeof connectSafely>> | undefined;
    let locked = false;
    let discardClient = false;
    try {
      connection = await connectSafely(this.db);
      const { client } = connection;
      const lock = await client.query('SELECT pg_try_advisory_lock(193607241) AS locked');
      locked = lock.rows[0].locked;
      if (!locked) return;
      if (!this.recovered) {
        // With the worker lock held, no other worker can still be executing a run.
        await client.query(`UPDATE geocsv_analysis_runs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
          error='计算进程或连接中断，请重新运行', error_code='WORKER_INTERRUPTED',
          backend_pid=NULL, completed_at=now() WHERE status='running'`);
        this.recovered = true;
      }
      while (!this.stopped) {
        const next = await client.query<RunRow>(`
          UPDATE geocsv_analysis_runs SET status='running', backend_pid=pg_backend_pid()
          WHERE id=(SELECT id FROM geocsv_analysis_runs WHERE status='queued' ORDER BY created_at,id LIMIT 1)
          AND status='queued' RETURNING *`);
        if (!next.rowCount) break;
        await this.execute(client, runFromRow(next.rows[0]));
      }
    } catch (error) {
      // If failure registration also lost its connection, recover the running record next time.
      this.recovered = false;
      discardClient = true;
      console.error('[Analysis worker]', error instanceof Error ? error.message : error);
    } finally {
      if (connection) {
        if (locked) await connection.client.query('SELECT pg_advisory_unlock(193607241)').catch(() => undefined);
        connection.release(discardClient);
      }
      this.draining = false;
    }
  }

  private async execute(client: PoolClient, run: AnalysisRun) {
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query(`SELECT set_config('statement_timeout', $1, true),
        set_config('application_name', $2, true)`, [String(this.timeoutMs), `geocsv-spatial:${run.id}`]);
      const operator = requireOperator(run.spec);
      const prepared = operator.prepare(run.spec);
      const versions = await prepared.fingerprint(client);
      if (run.inputVersions && !isDeepStrictEqual(run.inputVersions, versions)) {
        throw new InputVersionChanged('输入数据已改变，无法按历史版本重放；请创建新分析');
      }
      const artifactId = randomUUID();
      const draft = await prepared.execute(client);
      await writeArtifact(client, artifactId, run, operator.descriptor.output, draft);
      // This update serializes completion with cancellation; losing the race rolls back the artifact.
      const completed = await client.query(`UPDATE geocsv_analysis_runs
        SET status='succeeded', artifact_id=$2, input_versions=$3, backend_pid=NULL, completed_at=now()
        WHERE id=$1 AND status='running' AND NOT cancel_requested RETURNING id`, [run.id, artifactId, versions]);
      if (!completed.rowCount) throw new Error('任务已取消');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      const details = error instanceof Error ? error.message : '空间分析执行失败';
      const code = error instanceof AnalysisError ? error.errorCode : 'EXECUTION_FAILED';
      await client.query(`UPDATE geocsv_analysis_runs
        SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
            error=$2, error_code=CASE WHEN cancel_requested THEN NULL ELSE $3 END,
            backend_pid=NULL, completed_at=now() WHERE id=$1 AND status='running'`, [run.id, details, code]);
    }
  }
}
