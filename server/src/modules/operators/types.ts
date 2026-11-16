import type { PoolClient } from 'pg';
import type { AnalysisArtifact, AnalysisSpec, InputVersions, OperatorDescriptor } from '../analysis/protocol';

export interface ArtifactDraft {
  columns: AnalysisArtifact['columns'];
  totalRows: number;
  summary: AnalysisArtifact['summary'];
  writeRows: (client: PoolClient, artifactId: string) => Promise<void>;
}

export interface PreparedOperator {
  spec: AnalysisSpec;
  validate(client: PoolClient): Promise<void>;
  fingerprint(client: PoolClient): Promise<InputVersions>;
  execute(client: PoolClient): Promise<ArtifactDraft>;
}

export interface Operator {
  descriptor: OperatorDescriptor;
  prepare(input: unknown): PreparedOperator;
}
