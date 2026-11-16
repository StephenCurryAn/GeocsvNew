import test from 'node:test';
import assert from 'node:assert/strict';
import { replacePageSelection, selectedFromTable, selectionKey, toggleFeature } from '../src/features/map/featureSelection.ts';

const row = id => ({ id, type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { id } });

test('map multi-selection distinguishes identical row IDs from different layers', () => {
  const first = selectedFromTable('points', row(71));
  const second = selectedFromTable('areas', row(71));
  const batch = toggleFeature([first], second, true);
  assert.deepEqual(batch.map(selectionKey), ['points/71', 'areas/71']);
  assert.deepEqual(toggleFeature(batch, first, true), [second]);
  assert.deepEqual(toggleFeature(batch, second, false), [second]);
});

test('updating page checkboxes preserves selections from other pages and layers', () => {
  const offPage = selectedFromTable('areas', row(71));
  const otherLayer = selectedFromTable('points', row(9));
  const currentPage = [row(9), row(10)];
  const selected = replacePageSelection([offPage, otherLayer], 'areas', currentPage, new Set(['9', '10']));
  assert.deepEqual(selected.map(selectionKey), ['areas/71', 'points/9', 'areas/9', 'areas/10']);
  assert.deepEqual(replacePageSelection(selected, 'areas', currentPage, new Set()).map(selectionKey), ['areas/71', 'points/9']);
});
