import type { ExpressionSpecification, FilterSpecification, Map, GeoJSONSource, VectorTileSource } from 'maplibre-gl';

export const LAYER_PALETTE = ['#8DB8E9', '#EDA6B2', '#E8C46E', '#89C7B2', '#B4A4E0', '#F2B38D', '#80C5DA', '#B9CB89'];
export const EMPTY_SELECTION = false;

export type SelectionStyle = {
  point: { color: string; radius: number };
  line: { color: string; width: number };
  polygon: { color: string; opacity: number; outlineWidth: number };
};

export const DEFAULT_SELECTION_STYLE: SelectionStyle = {
  point: { color: '#FFB454', radius: 7 },
  line: { color: '#78350F', width: 3.5 },
  polygon: { color: '#FFB454', opacity: 0.38, outlineWidth: 3.5 },
};

export function defaultLayerColor(fileId: string) {
  let hash = 0;
  for (const char of fileId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return LAYER_PALETTE[hash % LAYER_PALETTE.length];
}

export const layerIds = (key: string) => ({
  source: `${key}-source`,
  fill: `${key}-fill`, border: `${key}-border`, line: `${key}-line`, point: `${key}-point`,
  selectedFill: `${key}-selected-fill`, selectedLine: `${key}-selected-line`, selectedPoint: `${key}-selected-point`,
  selectedBorder: `${key}-selected-border`,
});
type LayerIds = ReturnType<typeof layerIds>;
export const geometryLayers = (ids: LayerIds) => [
  { id: ids.fill, geometry: 'Polygon' as const },
  { id: ids.border, geometry: 'Polygon' as const },
  { id: ids.line, geometry: 'LineString' as const },
  { id: ids.point, geometry: 'Point' as const },
];
export const highlightLayers = (ids: LayerIds) => [ids.selectedFill, ids.selectedBorder, ids.selectedLine, ids.selectedPoint];
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
  addHighlightLayers(map, ids, tiles ? 'default_layer' : undefined, EMPTY_SELECTION);
}

function addHighlightLayers(map: Map, ids: LayerIds, sourceLayer?: string, filter?: FilterSpecification) {
  const source = { source: ids.source, ...(sourceLayer ? { 'source-layer': sourceLayer } : {}) };
  map.addLayer({ id: ids.selectedFill, type: 'fill', ...source, filter: filter ?? polygon });
  map.addLayer({ id: ids.selectedBorder, type: 'line', ...source, filter: filter ?? polygon });
  map.addLayer({ id: ids.selectedLine, type: 'line', ...source, filter: filter ?? line });
  map.addLayer({ id: ids.selectedPoint, type: 'circle', ...source, filter: filter ?? point });
  paintSelectionStyle(map, ids, DEFAULT_SELECTION_STYLE);
}

export function paintSelectionStyle(map: Map, ids: LayerIds, style: SelectionStyle) {
  map.setPaintProperty(ids.selectedFill, 'fill-color', style.polygon.color);
  map.setPaintProperty(ids.selectedFill, 'fill-opacity', style.polygon.opacity);
  map.setPaintProperty(ids.selectedBorder, 'line-color', style.polygon.color === DEFAULT_SELECTION_STYLE.polygon.color
    ? '#78350F' : style.polygon.color);
  map.setPaintProperty(ids.selectedBorder, 'line-width', style.polygon.outlineWidth);
  map.setPaintProperty(ids.selectedLine, 'line-color', style.line.color);
  map.setPaintProperty(ids.selectedLine, 'line-width', style.line.width);
  map.setPaintProperty(ids.selectedPoint, 'circle-color', style.point.color);
  map.setPaintProperty(ids.selectedPoint, 'circle-radius', style.point.radius);
  map.setPaintProperty(ids.selectedPoint, 'circle-stroke-color', '#78350F');
  map.setPaintProperty(ids.selectedPoint, 'circle-stroke-width', 2);
}

export function highlightGeometryFilter(ids: LayerIds, layer: string, filter: boolean | ExpressionSpecification): FilterSpecification {
  const type = layer === ids.selectedPoint ? 'Point' : layer === ids.selectedLine ? 'LineString' : 'Polygon';
  return ['all', filter, ['==', ['geometry-type'], type]];
}

export function addSelectionLayers(map: Map, ids: LayerIds) {
  map.addSource(ids.source, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  addHighlightLayers(map, ids);
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
