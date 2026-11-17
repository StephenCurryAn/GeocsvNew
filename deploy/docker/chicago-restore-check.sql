-- Compare the logical contents before migration, after migration and after restore.
-- Scope this to the v5 Chicago 311 database used in the phase 07 rehearsal.
SET TIME ZONE 'UTC';

SELECT 'scenes', count(*), md5(string_agg(md5(to_jsonb(s)::text), '' ORDER BY id)) FROM scenes s;
SELECT 'files', count(*), md5(string_agg(md5(to_jsonb(n)::text), '' ORDER BY id)) FROM file_nodes n;
SELECT 'layer:' || file_id, count(*), md5(string_agg(md5(to_jsonb(f)::text), '' ORDER BY id))
FROM spatial_features f GROUP BY file_id ORDER BY file_id;
SELECT 'periods', count(*), md5(string_agg(md5(to_jsonb(p)::text), '' ORDER BY file_id))
FROM geocsv_analysis_dataset_periods p;
SELECT 'plans', count(*), md5(string_agg(md5(to_jsonb(p)::text), '' ORDER BY id)) FROM geocsv_analysis_plans p;
SELECT 'runs', count(*), md5(string_agg(md5((to_jsonb(r) - 'professional_model' - 'trace_id')::text), '' ORDER BY id))
FROM geocsv_analysis_runs r;
SELECT 'artifacts', count(*), md5(string_agg(md5(to_jsonb(a)::text), '' ORDER BY id)) FROM geocsv_analysis_artifacts a;
SELECT 'moran:' || artifact_id, count(*), md5(string_agg(md5(to_jsonb(m)::text), '' ORDER BY feature_id))
FROM geocsv_analysis_moran_rows m GROUP BY artifact_id ORDER BY artifact_id;
