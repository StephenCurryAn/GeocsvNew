import type { FilterSpecification, Map, GeoJSONSource, VectorTileSource } from 'maplibre-gl';

export const LAYER_PALETTE = ['#8DB8E9', '#EDA6B2', '#E8C46E', '#89C7B2', '#B4A4E0', '#F2B38D', '#80C5DA', '#B9CB89'];
export const EMPTY_SELECTION: FilterSpecification = ['==', 1, 0];

export function defaultLayerColor(fileId: string) {
  let hash = 0;
  for (const char of fileId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return LAYER_PALETTE[hash % LAYER_PALETTE.length];
}

export const layerIds = (key: string) => ({
  source: `${key}-source`,
  fill: `${key}-fill`, border: `${key}-border`, line: `${key}-line`, point: `${key}-point`,
  selectedFill: `${key}-selected-fill`, selectedLine: `${key}-selected-line`, selectedPoint: `${key}-selected-point`,
});
type LayerIds = ReturnType<typeof layerIds>;
export const geometryLayers = (ids: LayerIds) => [
  { id: ids.fill, geometry: 'Polygon' as const },
  { id: ids.border, geometry: 'Polygon' as const },
  { id: ids.line, geometry: 'LineString' as const },
  { id: ids.point, geometry: 'Point' as const },
];
export const highlightLayers = (ids: LayerIds) => [ids.selectedFill, ids.selectedLine, ids.selectedPoint];
export const drawingLayers = (ids: LayerIds) => [...geometryLayers(ids).map(layer => layer.id), ...highlightLayers(ids)];

const polygon: FilterSpecification = ['==', '$type', 'Polygon'];
const line: FilterSpecification = ['==', '$type', 'LineString'];
const point: FilterSpecification = ['==', '$type', 'Point'];

export function addFileLayers(map: Map, ids: LayerIds, tiles?: string[]) {
  map.addSource(ids.source, tiles
    ? { type: 'vector', tiles, maxzoom: 14 }
    : { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const source = { source: ids.source, ...(tiles ? { 'source-layer': 'default_layer' } : {}) };
  map.addLayer({ id: ids.fill, type: 'fill', ...source, filter: polygon });
  map.addLayer({ id: ids.border, type: 'line', ...source, filter: polygon });
  map.addLayer({ id: ids.line, type: 'line', ...source, filter: line });
  map.addLayer({ id: ids.point, type: 'circle', ...source, filter: point });
  map.addLayer({ id: ids.selectedFill, type: 'fill', ...source, filter: EMPTY_SELECTION,
    paint: { 'fill-color': '#fff', 'fill-opacity': 0.12 } });
  map.addLayer({ id: ids.selectedLine, type: 'line', ...source, filter: EMPTY_SELECTION,
    paint: { 'line-color': '#27364E', 'line-width': 2.5 } });
  map.addLayer({ id: ids.selectedPoint, type: 'circle', ...source, filter: EMPTY_SELECTION,
    paint: { 'circle-radius': 7, 'circle-color': '#FFF', 'circle-stroke-width': 2.5, 'circle-stroke-color': '#27364E' } });
}

export function paintFileLayers(map: Map, ids: LayerIds, color: string, { grid = false, dense = false } = {}) {
  if (!map.getSource(ids.source)) return;
  map.setPaintProperty(ids.fill, 'fill-color', color);
  map.setPaintProperty(ids.fill, 'fill-opacity', 0.58);
  map.setPaintProperty(ids.fill, 'fill-outline-color', 'transparent');
  map.setPaintProperty(ids.border, 'line-color', color);
  map.setPaintProperty(ids.border, 'line-width', grid ? 0 : 1.4);
  map.setPaintProperty(ids.border, 'line-opacity', 0.95);
  map.setPaintProperty(ids.line, 'line-color', color);
  map.setPaintProperty(ids.line, 'line-width', 2.5);
  map.setPaintProperty(ids.line, 'line-opacity', 0.9);
  map.setPaintProperty(ids.point, 'circle-color', color);
  map.setPaintProperty(ids.point, 'circle-radius', dense
    ? ['interpolate', ['linear'], ['zoom'], 7, 1, 12, 1.8, 16, 4.5]
    : 4.5);
  map.setPaintProperty(ids.point, 'circle-opacity', dense
    ? ['interpolate', ['linear'], ['zoom'], 7, 0.3, 12, 0.52, 16, 0.94]
    : 1);
  map.setPaintProperty(ids.point, 'circle-stroke-width', dense
    ? ['interpolate', ['linear'], ['zoom'], 12, 0, 16, 0.8]
    : 0.8);
  map.setPaintProperty(ids.point, 'circle-stroke-color', '#27364E');
  map.setPaintProperty(ids.point, 'circle-stroke-opacity', 0.55);
}

export function removeFileLayers(map: Map, ids: LayerIds) {
  for (const id of drawingLayers(ids)) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(ids.source)) map.removeSource(ids.source);
}

export function setFileVisibility(map: Map, ids: LayerIds, visible: boolean) {
  const value = visible ? 'visible' : 'none';
  for (const id of drawingLayers(ids)) {
    if (map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== value) map.setLayoutProperty(id, 'visibility', value);
  }
}

export const updateVectorTiles = (map: Map, ids: LayerIds, tiles: string[]) =>
  (map.getSource(ids.source) as VectorTileSource).setTiles(tiles);

export const updateGridGeometry = (map: Map, ids: LayerIds, data: GeoJSON.FeatureCollection) =>
  (map.getSource(ids.source) as GeoJSONSource).setData(data);
