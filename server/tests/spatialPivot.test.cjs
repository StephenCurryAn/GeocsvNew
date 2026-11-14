const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSpatialPivotSpec, buildSpatialPivotQuery, formatSpatialCounts } = require('../src/modules/spatialPivot/plan');

const plan = () => ({
  schemaVersion: 1, kind: 'spatial_pivot', operatorVersion: 1,
  target: { fileId: 'districts', labelField: "O'Brien" },
  join: { fileId: 'pois', categoryField: 'category' }, boundaryPolicy: 'exclude',
});

test('validates the complete plan and rejects unsupported spatial semantics', () => {
  assert.deepEqual(parseSpatialPivotSpec(plan()), plan());
  for (const change of [{ kind: 'buffer' }, { operatorVersion: 2 }, { boundaryPolicy: null }, { target: { fileId: 'pois' } }]) {
    assert.throws(() => parseSpatialPivotSpec({ ...plan(), ...change }));
  }
  assert.throws(() => parseSpatialPivotSpec(null));
  assert.throws(() => parseSpatialPivotSpec({ ...plan(), target: { fileId: ['wrong'] } }));
  assert.throws(() => parseSpatialPivotSpec({ ...plan(), distance: 500 }), /不支持的参数/);
});

test('keeps quotes and injection strings in bound parameters', () => {
  const spec = plan();
  spec.join.categoryField = "category'); DROP TABLE file_nodes; --";
  const query = buildSpatialPivotQuery(parseSpatialPivotSpec(spec));
  assert.ok(!query.text.includes(spec.target.labelField));
  assert.ok(!query.text.includes('DROP TABLE'));
  assert.equal(query.values[3], spec.join.categoryField);
  assert.ok(query.text.includes('ST_Contains'));
  assert.ok(buildSpatialPivotQuery({ ...spec, boundaryPolicy: 'include' }).text.includes('ST_Covers'));
});

test('preserves duplicate labels, zero-match targets, null and reserved category values', () => {
  const result = formatSpatialCounts([
    { feature_id: 1, label: 'same', category: '__proto__', count: 2 },
    { feature_id: 1, label: 'same', category: null, count: 1 },
    { feature_id: 2, label: 'same', category: null, count: 0 },
    { feature_id: 3, label: 'third', category: '未分类（空值）', count: 1 },
  ], true);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows.map(row => row.total), [3, 0, 1]);
  assert.equal(new Set(result.columns.map(column => column.key)).size, 3);
  assert.equal(new Set(result.columns.map(column => column.label)).size, 3);
  assert.deepEqual(Object.values(result.rows[1].counts), [0, 0, 0]);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(formatSpatialCounts([], true), { columns: [], rows: [] });
});
