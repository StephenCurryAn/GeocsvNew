import type { DatasetSummary } from '../spatialPivot/datasets';
import type { RunStatus } from '../analysis/protocol';
import type { SpatialPivotSpec } from '../spatialPivot/plan';

export interface AnalysisView { chartType: 'bar' | 'line' | 'pie' }
export type NaturalPlan =
  | { status: 'ready'; source: 'rules' | 'llm'; message: string; spec: SpatialPivotSpec;
      view: AnalysisView; assumptions: string[]; inputs: { targetName: string; joinName: string } }
  | { status: 'clarification'; message: string; questions: string[] }
  | { status: 'unsupported'; message: string }
  | { status: 'view_only'; message: string; runId: string; artifactId: string; view: AnalysisView };

export interface PlanningContext {
  userPrompt: string;
  datasets: DatasetSummary[];
  previousSpec: SpatialPivotSpec | null;
}

export interface PlannerDependencies {
  readDataset: (fileId: string) => Promise<DatasetSummary>;
  validatePlan: (spec: unknown) => Promise<SpatialPivotSpec>;
  getRun: (id: string) => Promise<{ id: string; status: RunStatus; artifactId: string | null; spec: SpatialPivotSpec } | null>;
  complete?: (context: PlanningContext) => Promise<unknown>;
}

export const clarification = (...questions: string[]): NaturalPlan => ({
  status: 'clarification', message: '需要补充或确认分析条件。', questions,
});
