import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AnalysisError } from '../analysis/errors';
import { traceEvent } from '../analysis/trace';

const engineDir = resolve(__dirname, '../../../../python_engine');
const resultVersion = 'moran-lisa/2.0.0';
const workerFailure = (message: string) => new AnalysisError(500, 'EXECUTION_FAILED', message);

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export interface MoranParameters {
  contiguity: 'queen' | 'rook';
  permutations: number;
  seed: number;
}

export interface PythonExecution {
  id: string;
  payload: Buffer;
  digest: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export class PythonWorker {
  private readonly directory = resolve(process.env.ANALYSIS_WORKER_DIR ?? join(engineDir, '.tmp', 'analysis-worker'));
  private readonly python = process.env.ANALYSIS_PYTHON
    ?? join(engineDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

  async moran(execution: PythonExecution, parameters: MoranParameters) {
    execution.signal.throwIfAborted();
    if (sha256(execution.payload) !== execution.digest) throw workerFailure('输入快照校验失败');
    const lockText = await readFile(join(engineDir, 'uv.lock'), 'utf8');
    const lockDigest = sha256(Buffer.from(lockText.replace(/\r\n/g, '\n')));
    const resultFile = this.resultFile(execution.id);
    let text = await this.readResult(resultFile);
    const reusedResult = text !== null;
    if (text === null) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.runProcess(execution, resultFile, parameters);
      text = await this.readResult(resultFile);
      if (text === null) throw workerFailure('Python Worker 缺少执行结果');
    }
    const envelope = JSON.parse(text);
    if (!envelope || envelope.executionId !== execution.id || envelope.inputDigest !== execution.digest
      || envelope.algorithmVersion !== resultVersion || envelope.dependencyLockDigest !== lockDigest) {
      throw workerFailure('Python Worker 返回的执行身份或版本不匹配');
    }
    if (typeof envelope.error === 'string') throw new AnalysisError(400, 'INVALID_SPEC', envelope.error);
    traceEvent('python.worker.result', { runId: execution.id, algorithmVersion: resultVersion,
      dependencyLockDigest: lockDigest, reusedResult });
    return { result: envelope.result as unknown, algorithmVersion: resultVersion, dependencyLockDigest: lockDigest };
  }

  async forget(id: string) {
    await unlink(this.resultFile(id)).catch(error => {
      if (error.code !== 'ENOENT') console.error('[Analysis Worker cleanup]', error.message);
    });
  }

  async prune(expiredBefore: number) {
    const names = await readdir(this.directory).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    await Promise.all(names.filter(name => /^[a-f0-9-]{36}(?:-[a-z0-9_]+)?\.json(?:\.tmp)?$/i.test(name))
      .map(async name => {
        const path = join(this.directory, name);
        try {
          if ((await stat(path)).mtimeMs < expiredBefore) await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }));
  }

  private resultFile(id: string) {
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) throw workerFailure('无效的 Python 执行 ID');
    return join(this.directory, id + '.json');
  }

  private readResult(path: string) {
    return readFile(path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  }

  private runProcess(execution: PythonExecution, result: string, parameters: MoranParameters) {
    execution.signal.throwIfAborted();
    return new Promise<void>((done, fail) => {
      const osKeys = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
        'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LD_LIBRARY_PATH'];
      const env = Object.fromEntries(osKeys.map(key => [key, process.env[key]]));
      const child = spawn(this.python, [
        'analysis_worker.py', '--execution-id', execution.id, '--input-digest', execution.digest,
        '--input-bytes', String(execution.payload.length), '--result', result, '--contiguity', parameters.contiguity,
        '--permutations', String(parameters.permutations), '--seed', String(parameters.seed),
      ], {
        cwd: engineDir, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
        env: { ...env, PYTHONUTF8: '1', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' },
      });
      let stopReason: unknown;
      const stop = (reason: unknown) => {
        stopReason ??= reason;
        child.stdin.destroy();
        child.kill('SIGKILL');
      };
      const abort = () => stop(execution.signal.reason);
      const timeout = setTimeout(() => stop(new AnalysisError(500, 'EXECUTION_TIMEOUT', 'Python Worker 执行超时')), execution.timeoutMs);
      execution.signal.addEventListener('abort', abort, { once: true });
      child.stderr.resume();
      child.stdin.on('error', () => undefined); // An early process exit is reported on close.
      child.on('error', error => { stopReason ??= workerFailure('无法启动 Python Worker：' + error.message); });
      child.on('exit', () => {
        if (stopReason) child.stderr.destroy();
      });
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        execution.signal.removeEventListener('abort', abort);
        if (stopReason) fail(stopReason);
        else if (code !== 0) {
          fail(new AnalysisError(500, 'WORKER_INTERRUPTED', 'Python Worker 提前退出（' + (signal ?? code) + '）'));
        } else done();
      });
      // Keep the pipe open after the fixed-size input. The worker watches it for parent death.
      child.stdin.write(execution.payload);
    });
  }
}
