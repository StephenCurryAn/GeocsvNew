// Additive schema only: existing files, features and registered models stay untouched.
export const LEGACY_ANALYSIS_SCHEMA = `
CREATE TABLE geocsv_analysis_definitions (
  id UUID PRIMARY KEY,
  spec_hash TEXT UNIQUE NOT NULL,
  spec JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE geocsv_analysis_runs (
  id UUID PRIMARY KEY,
  definition_id UUID NOT NULL REFERENCES geocsv_analysis_definitions(id),
  spec JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  input_versions JSONB,
  artifact_id UUID,
  error TEXT,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  backend_pid INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX geocsv_runs_queue ON geocsv_analysis_runs(status, created_at);
CREATE TABLE geocsv_analysis_artifacts (
  id UUID PRIMARY KEY,
  run_id UUID UNIQUE NOT NULL REFERENCES geocsv_analysis_runs(id),
  spec JSONB NOT NULL,
  columns JSONB NOT NULL,
  total_rows INTEGER NOT NULL,
  summary JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE geocsv_analysis_artifact_rows (
  artifact_id UUID NOT NULL REFERENCES geocsv_analysis_artifacts(id) ON DELETE CASCADE,
  feature_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  counts JSONB NOT NULL,
  total INTEGER NOT NULL,
  geom GEOMETRY(Geometry,4326),
  PRIMARY KEY (artifact_id, feature_id)
);
`;
