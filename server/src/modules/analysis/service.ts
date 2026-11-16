import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { sceneContainsFiles } from '../../models/Scene';
import { requireOperator } from '../operators/registry';
import { PythonWorker } from '../operators/pythonWorker';
import type { ArtifactDraft, PreparedOperator, PythonSnapshot } from '../operators/types';
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
interface ReplayInput { expectedVersions?: InputVersions; replayRunId?: string }
type RunSubmission = ({ spec: unknown } & ReplayInput) | PlanReference;
type PreparedSubmission = ({ operator: PreparedOperator } & ReplayInput) | PlanReference;
type StoredSnapshot = { digest: string; payload: Buffer | null };
const snapshotExpired = () => new AnalysisError(410, 'INPUT_SNAPSHOT_EXPIRED', '输入快照已过保留期，请重新创建分析');
const cancelled = new Error('任务已取消');

interface RunRow {
  id: string;
  definition_id: string;
  plan_id: string | null;
  status: RunStatus;
  snapshot_id: string | null;
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
  private drainTask?: Promise<void>;
  private stopped = false;
  private activePython?: { id: string; controller: AbortController };
  private readonly worker = new PythonWorker();
  private lastPrune = 0;

  constructor(private readonly db: Pool, private readonly timeoutMs = 120000) {}

  initialize(): Promise<void> {
    if (!this.ready) {
      this.ready = migrateAnalysis(this.db).catch(error => { this.ready = undefined; throw error; });
    }
    return this.ready;
  }

  async start() {
    await this.initialize();
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.kick(), 1000);
    this.timer.unref();
    this.kick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.activePython?.controller.abort(new Error('分析调度器正在关闭'));
    await this.drainTask;
  }

  private kick() {
    if (!this.timer || this.stopped || this.drainTask) return;
    this.drainTask = this.drain().finally(() => { this.drainTask = undefined; });
  }

  private async readInputs(client: PoolClient, operator: PreparedOperator): Promise<{
    versions: InputVersions; snapshot?: PythonSnapshot;
  }> {
    if (operator.executor === 'python') {
      const snapshot = await operator.capture(client);
      return { versions: snapshot.versions, snapshot };
    }
    await operator.validate(client);
    return { versions: await operator.fingerprint(client) };
  }

  async createPlan(input: unknown, sceneId?: string) {
    await this.initialize();
    const operator = prepare(input);
    return transaction(this.db, 'BEGIN ISOLATION LEVEL REPEATABLE READ', async client => {
      const { versions } = await this.readInputs(client, operator);
      if (sceneId !== undefined) {
        const fileIds = Object.values(versions).map(version => version.fileId);
        if (!await sceneContainsFiles(client, sceneId, fileIds)) {
          throw new AnalysisInputError('计划引用了当前场景以外的图层', 'DATASET_NOT_FOUND');
        }
        if (operator.executor === 'python') await operator.validatePlanningFields?.(client);
      }
      return writePlan(client, operator.spec, digest(operator.spec), versions, false);
    });
  }

  getPlan(id: string) { return readPlan(this.db, id); }

  getArtifact(id: string) { return readArtifact(this.db, id); }

  async create(request: RunSubmission, submission?: SubmissionKey): Promise<AnalysisRun> {
    await this.initialize();
    if ('planId' in request && !submission) throw new AnalysisInputError('确认计划需要提供 Idempotency-Key');
    const prepared: PreparedSubmission = 'spec' in request
      ? { operator: prepare(request.spec), expectedVersions: request.expectedVersions, replayRunId: request.replayRunId }
      : request;
    // The legacy form and replay keep the request digest introduced with submission keys.
    const requestHash = submission ? digest('operator' in prepared
      ? { spec: prepared.operator.spec, expectedVersions: prepared.expectedVersions ?? null }
      : { planId: prepared.planId, planVersion: prepared.planVersion }) : null;

    for (let retry = 0; ; retry++) {
      try {
        const run = await transaction(this.db, 'BEGIN ISOLATION LEVEL REPEATABLE READ', client =>
          this.createRun(client, prepared, submission, requestHash));
        setImmediate(() => this.kick());
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

    const { plan, snapshotId } = 'planId' in request
      ? await this.checkPlan(client, request.planId, request.planVersion)
      : await this.implicitPlan(client, request);
    const runId = randomUUID();
    const existingDefinition = await client.query('SELECT id FROM geocsv_analysis_definitions WHERE spec_hash=$1', [plan.specHash]);
    const definitionId = existingDefinition.rows[0]?.id ?? (await client.query(`
      INSERT INTO geocsv_analysis_definitions(id, spec_hash, spec) VALUES($1,$2,$3)
      ON CONFLICT(spec_hash) DO UPDATE SET spec_hash = EXCLUDED.spec_hash RETURNING id`,
      [randomUUID(), plan.specHash, plan.spec])).rows[0].id;
    const result = await client.query<RunRow>(`
      INSERT INTO geocsv_analysis_runs(id, definition_id, spec, input_versions, plan_id,
        request_actor, request_scope, request_key, request_hash, snapshot_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [runId, definitionId, plan.spec, plan.inputVersions, plan.id,
        submission?.actor, submission?.scope, submission?.key, requestHash, snapshotId]);
    await confirmPlan(client, plan);
    return runFromRow(result.rows[0]);
  }

  private async checkPlan(client: PoolClient, id: string, version: number) {
    const plan = await readPlan(client, id);
    if (!plan) throw new AnalysisError(404, 'PLAN_NOT_FOUND', '分析计划不存在');
    if (plan.version !== version) throw new AnalysisError(409, 'PLAN_VERSION_CONFLICT', '计划版本已变化，请重新加载并确认');
    const operator = prepare(plan.spec);
    const stale = () => new InputVersionChanged('输入数据已改变，请重新校验并确认计划');
    let inputs;
    try {
      if (operator.executor === 'postgis') {
        const versions = await operator.fingerprint(client);
        if (!isDeepStrictEqual(plan.inputVersions, versions)) throw stale();
        await operator.validate(client);
        inputs = { versions };
      } else {
        inputs = await this.readInputs(client, operator);
      }
    } catch (error) {
      if (error instanceof AnalysisInputError) throw stale();
      throw error;
    }
    if (!isDeepStrictEqual(plan.inputVersions, inputs.versions)) throw stale();
    return { plan, snapshotId: await this.saveSnapshot(client, inputs.snapshot) };
  }

  private async implicitPlan(client: PoolClient, { operator, expectedVersions, replayRunId }: {
    operator: PreparedOperator;
  } & ReplayInput) {
    let versions: InputVersions;
    let snapshotId: string | null = null;
    if (operator.executor === 'python' && replayRunId && expectedVersions) {
      // Share the original immutable bytes. Hold the row until the new Run pins them.
      const source = await client.query<{ id: string }>(`
        SELECT s.id FROM geocsv_analysis_runs r JOIN geocsv_analysis_snapshots s ON s.id=r.snapshot_id
        WHERE r.id=$1 AND s.payload IS NOT NULL AND s.expires_at>now() FOR SHARE OF s`, [replayRunId]);
      if (!source.rowCount) throw snapshotExpired();
      snapshotId = source.rows[0].id;
      versions = expectedVersions;
    } else if (operator.executor === 'postgis' && expectedVersions) {
      await operator.validate(client);
      versions = expectedVersions;
    } else {
      const inputs = await this.readInputs(client, operator);
      versions = inputs.versions;
      snapshotId = await this.saveSnapshot(client, inputs.snapshot);
    }
    const plan = await writePlan(client, operator.spec, digest(operator.spec), versions, true);
    return { plan, snapshotId };
  }

  private async saveSnapshot(client: PoolClient, snapshot?: PythonSnapshot) {
    if (!snapshot) return null;
    const id = randomUUID();
    await client.query('INSERT INTO geocsv_analysis_snapshots(id,digest,payload) VALUES($1,$2,$3)',
      [id, snapshot.digest, snapshot.payload]);
    return id;
  }

  async get(id: string): Promise<AnalysisRun | null> {
    const result = await this.db.query<RunRow>('SELECT * FROM geocsv_analysis_runs WHERE id = $1', [id]);
    return result.rows[0] ? runFromRow(result.rows[0]) : null;
  }

  async history(limit: number, operatorId?: string): Promise<AnalysisRun[]> {
    const result = await this.db.query<RunRow>(`
      SELECT * FROM geocsv_analysis_runs
      WHERE ($2::text IS NULL OR spec->>'kind'=$2) ORDER BY created_at DESC, id LIMIT $1`, [limit, operatorId]);
    return result.rows.map(runFromRow);
  }

  async cancel(id: string): Promise<AnalysisRun | null> {
    const found = await transaction(this.db, 'BEGIN', async client => {
      const result = await client.query('SELECT * FROM geocsv_analysis_runs WHERE id=$1 FOR UPDATE', [id]);
      const row = result.rows[0];
      if (!row) return false;
      if (row.status === 'queued' || row.status === 'running') {
        await client.query(`UPDATE geocsv_analysis_runs SET cancel_requested=true,
          status=CASE WHEN status='queued' OR snapshot_id IS NOT NULL THEN 'cancelled' ELSE status END,
          completed_at=CASE WHEN status='queued' OR snapshot_id IS NOT NULL THEN now() ELSE completed_at END WHERE id=$1`, [id]);
        if (row.status === 'running' && row.backend_pid) {
          await client.query(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
            WHERE pid=$1 AND datname=current_database() AND application_name=$2`,
            [row.backend_pid, `geocsv-spatial:${id}`]);
        }
      }
      return true;
    });
    if (found && this.activePython?.id === id) this.activePython.controller.abort(cancelled);
    return found ? this.get(id) : null;
  }

  private async drain() {
    let connection: Awaited<ReturnType<typeof connectSafely>> | undefined;
    let locked = false;
    let discardClient = false;
    try {
      connection = await connectSafely(this.db);
      const { client } = connection;
      const lock = await client.query('SELECT pg_try_advisory_lock(193607241) AS locked');
      locked = lock.rows[0].locked;
      if (!locked) return;
      // Only PostGIS runs depend on a specific connection. Interrupted Python runs
      // can resume from the immutable input and reuse an already published result.
      await client.query(`UPDATE geocsv_analysis_runs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
        error='计算进程或连接中断，请重新运行', error_code='WORKER_INTERRUPTED',
        backend_pid=NULL, completed_at=now() WHERE status='running' AND snapshot_id IS NULL`);
      await this.pruneSnapshots(client);
      while (!this.stopped) {
        const next = await client.query<RunRow>(`
          UPDATE geocsv_analysis_runs SET status='running',
            backend_pid=CASE WHEN snapshot_id IS NULL THEN pg_backend_pid() ELSE NULL END
          WHERE id=(SELECT id FROM geocsv_analysis_runs
            WHERE status='queued' OR (status='running' AND snapshot_id IS NOT NULL AND NOT cancel_requested)
            ORDER BY (status='running') DESC, created_at,id LIMIT 1)
          AND status IN ('queued','running') AND NOT cancel_requested RETURNING *`);
        if (!next.rowCount) break;
        const row = next.rows[0];
        const run = runFromRow(row);
        if (row.snapshot_id) await this.executePython(client, run, row.snapshot_id);
        else await this.executePostgis(client, run);
      }
    } catch (error) {
      // A failed archive transaction leaves the Python run and published result resumable.
      discardClient = true;
      console.error('[Analysis worker]', error instanceof Error ? error.message : error);
    } finally {
      if (connection) {
        if (locked) await connection.client.query('SELECT pg_advisory_unlock(193607241)').catch(() => undefined);
        connection.release(discardClient);
      }
    }
  }

  private async pruneSnapshots(client: PoolClient) {
    if (Date.now() - this.lastPrune < 60 * 60_000) return;
    await client.query('BEGIN');
    try {
      // A replay holds a share lock until its new Run pins the snapshot. Check
      // for active Runs in a fresh statement after locking expired candidates.
      const { rows } = await client.query<{ id: string }>(`
        SELECT id FROM geocsv_analysis_snapshots s WHERE s.payload IS NOT NULL AND s.expires_at<=now()
          AND NOT EXISTS(SELECT 1 FROM geocsv_analysis_runs r WHERE r.snapshot_id=s.id AND r.status IN ('queued','running'))
        ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED`);
      if (rows.length) {
        await client.query(`
          UPDATE geocsv_analysis_snapshots s SET payload=NULL WHERE s.id=ANY($1::uuid[])
            AND NOT EXISTS(SELECT 1 FROM geocsv_analysis_runs r WHERE r.snapshot_id=s.id AND r.status IN ('queued','running'))`,
          [rows.map(row => row.id)]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    this.lastPrune = Date.now();
    await this.worker.prune(Date.now() - 7 * 24 * 60 * 60_000).catch(error => {
      console.error('[Analysis Worker cleanup]', error.message);
    });
  }

  private async executePython(client: PoolClient, run: AnalysisRun, snapshotId: string) {
    const operator = requireOperator(run.spec);
    const prepared = operator.prepare(run.spec);
    if (prepared.executor !== 'python') throw new Error('快照与算子执行方式不一致');
    const stored = await client.query<StoredSnapshot>(`
      SELECT s.digest,s.payload FROM geocsv_analysis_snapshots s
      JOIN geocsv_analysis_runs r ON r.snapshot_id=s.id WHERE s.id=$1 AND r.id=$2 AND r.status='running'`,
      [snapshotId, run.id]);
    if (this.stopped) return;
    if (!stored.rowCount) {
      await this.failRun(client, run.id, snapshotExpired());
      return;
    }
    const { digest, payload } = stored.rows[0];
    const controller = new AbortController();
    this.activePython = { id: run.id, controller };
    // A second API instance may commit a cancellation while this process owns the child.
    let checking = false;
    const cancelWatch = setInterval(async () => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const current = await client.query("SELECT 1 FROM geocsv_analysis_runs WHERE id=$1 AND status='running' AND NOT cancel_requested", [run.id]);
        if (!current.rowCount) controller.abort(cancelled);
      } catch (error) {
        controller.abort(error);
      } finally { checking = false; }
    }, 500);
    let draft: ArtifactDraft;
    try {
      if (!payload) throw snapshotExpired();
      if (!Object.values(run.inputVersions ?? {}).some(version => version.fingerprint === digest)) {
        throw new Error('输入快照与 Run 的数据版本不匹配');
      }
      draft = await prepared.execute(this.worker, {
        id: run.id, digest, payload, signal: controller.signal, timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (!this.stopped && error !== cancelled) await this.failRun(client, run.id, error);
      if (!this.stopped) await this.worker.forget(run.id);
      return;
    } finally {
      clearInterval(cancelWatch);
      this.activePython = undefined;
    }

    if (this.stopped) return;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(this.timeoutMs)]);
      const artifactId = randomUUID();
      await writeArtifact(client, artifactId, run, operator.descriptor.output, draft);
      const succeeded = await client.query(`UPDATE geocsv_analysis_runs SET status='succeeded',artifact_id=$2,completed_at=now()
        WHERE id=$1 AND status='running' AND snapshot_id=$3 AND NOT cancel_requested`, [run.id, artifactId, snapshotId]);
      if (!succeeded.rowCount) throw cancelled;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error !== cancelled) throw error;
    }
    await this.worker.forget(run.id);
  }

  private async executePostgis(client: PoolClient, run: AnalysisRun) {
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query(`SELECT set_config('statement_timeout', $1, true),
        set_config('application_name', $2, true)`, [String(this.timeoutMs), `geocsv-spatial:${run.id}`]);
      const operator = requireOperator(run.spec);
      const prepared = operator.prepare(run.spec);
      if (prepared.executor !== 'postgis') throw new Error('Python Run 缺少输入快照');
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
      await this.failRun(client, run.id, error);
    }
  }

  private async failRun(client: PoolClient, id: string, error: unknown) {
    const details = error instanceof Error ? error.message : '空间分析执行失败';
    const code = error instanceof AnalysisError ? error.errorCode : 'EXECUTION_FAILED';
    await client.query(`UPDATE geocsv_analysis_runs
      SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
          error=$2, error_code=CASE WHEN cancel_requested THEN NULL ELSE $3 END,
          backend_pid=NULL, completed_at=now() WHERE id=$1 AND status='running'`, [id, details, code]);
  }
}
