export type SelectedFeature = {
  fileId: string;
  id: string;
  geometry: GeoJSON.Geometry | null;
  properties: GeoJSON.GeoJsonProperties;
  anchor?: [number, number];
};

export const featureId = (feature: GeoJSON.Feature): string => String(feature.id ?? feature.properties?.id ?? '');

export const selectionKey = ({ fileId, id }: Pick<SelectedFeature, 'fileId' | 'id'>): string => `${fileId}/${id}`;

export const selectedFromTable = (fileId: string, feature: GeoJSON.Feature): SelectedFeature => ({
  fileId,
  id: featureId(feature),
  geometry: feature.geometry,
  properties: feature.properties,
});

export function toggleFeature(selection: SelectedFeature[], feature: SelectedFeature, additive: boolean): SelectedFeature[] {
  if (!additive) return [feature];
  const key = selectionKey(feature);
  return selection.some(item => selectionKey(item) === key)
    ? selection.filter(item => selectionKey(item) !== key)
    : [...selection, feature];
}

export function replacePageSelection(
  selection: SelectedFeature[], fileId: string, page: GeoJSON.Feature[], ids: Set<string>,
): SelectedFeature[] {
  const pageIds = new Set(page.map(featureId));
  const retained = selection.filter(item => item.fileId !== fileId || !pageIds.has(item.id));
  return [...retained, ...page.filter(feature => ids.has(featureId(feature))).map(feature => selectedFromTable(fileId, feature))];
}
