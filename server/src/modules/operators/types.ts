import type { PoolClient } from 'pg';
import type { AnalysisArtifact, AnalysisSpec, InputVersions, OperatorDescriptor } from '../analysis/protocol';
import type { PythonExecution, PythonWorker } from './pythonWorker';

export interface ArtifactDraft {
  columns: AnalysisArtifact['columns'];
  totalRows: number;
  summary: AnalysisArtifact['summary'];
  writeRows: (client: PoolClient, artifactId: string) => Promise<void>;
}

export interface PythonSnapshot {
  payload: Buffer;
  digest: string;
  versions: InputVersions;
}

interface PreparedPostgis {
  executor: 'postgis';
  spec: AnalysisSpec;
  validate(client: PoolClient): Promise<void>;
  fingerprint(client: PoolClient): Promise<InputVersions>;
  execute(client: PoolClient): Promise<ArtifactDraft>;
}

interface PreparedPython {
  executor: 'python';
  spec: AnalysisSpec;
  capture(client: PoolClient): Promise<PythonSnapshot>;
  execute(worker: PythonWorker, execution: PythonExecution): Promise<ArtifactDraft>;
}

export type PreparedOperator = PreparedPostgis | PreparedPython;

export interface Operator {
  descriptor: OperatorDescriptor;
  prepare(input: unknown): PreparedOperator;
}
