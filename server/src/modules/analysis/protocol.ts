import type { AnalysisErrorCode } from './errors';

export interface OperatorRef { id: string; version: number }

export interface OperatorInput {
  geometryTypes: readonly string[];
  fields?: Record<string, { type: 'any' | 'numeric'; required: boolean; description: string }>;
}

export type OperatorParameter = { description: string } & (
  | { type: 'string'; enum: readonly string[]; default: string }
  | { type: 'integer'; minimum: number; maximum: number; default: number }
);

export interface OperatorParameterSchema {
  type: 'object';
  properties: Record<string, OperatorParameter>;
  additionalProperties: false;
}

export interface OperatorDescriptor extends OperatorRef {
  name: string;
  description: string;
  aliases: readonly string[];
  executor: string;
  inputs: Record<string, OperatorInput>;
  parameterSchema: string;
  planningParameters: OperatorParameterSchema;
  output: { format: string; schemaVersion: number };
}

export interface AnalysisSpec {
  schemaVersion: number;
  kind: string;
  operatorVersion: number;
}

export interface DatasetVersion { fileId: string; count: number; fingerprint: string }
export type InputVersions = Record<string, DatasetVersion>;

export interface AnalysisPlan {
  schemaVersion: 1;
  id: string;
  version: number;
  operator: OperatorRef;
  spec: AnalysisSpec;
  specHash: string;
  inputVersions: InputVersions;
  status: 'validated' | 'confirmed';
  createdAt: string;
  confirmedAt: string | null;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface AnalysisRun {
  schemaVersion: 1;
  id: string;
  definitionId: string;
  planId: string | null;
  operator: OperatorRef;
  status: RunStatus;
  spec: AnalysisSpec;
  inputVersions: InputVersions | null;
  artifactId: string | null;
  error: string | null;
  errorCode: AnalysisErrorCode | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ArtifactColumn { key: string; label: string }

export interface AnalysisArtifact {
  id: string;
  runId: string;
  schemaVersion: number;
  format: string;
  operator: OperatorRef;
  spec: AnalysisSpec;
  columns: ArtifactColumn[];
  totalRows: number;
  summary: Record<string, unknown>;
}

export const operatorOf = (spec: AnalysisSpec): OperatorRef => ({ id: spec.kind, version: spec.operatorVersion });
