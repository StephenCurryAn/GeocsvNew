import { useEffect, useMemo, useRef, useState } from 'react';
import { AimOutlined } from '@ant-design/icons';
import { Button, Empty, Spin } from 'antd';
import maplibregl from 'maplibre-gl';
import { bbox } from '@turf/turf';
import { rasterStyle } from '../../map/basemaps';
import { useWorkbenchAppearance } from '../../../layouts/WorkbenchTheme';
import type { SpatialPivotGeoJSON } from '../../../services/spatialPivotService';

const RESULT_SOURCE = 'spatial-pivot-result';
const FILL_LAYER = 'spatial-pivot-fill';
const OUTLINE_LAYER = 'spatial-pivot-outline';
const CONTEXT_SOURCE = 'spatial-pivot-context';

interface SpatialResultMapProps {
  geoJSON: SpatialPivotGeoJSON | null;
  message: string | null;
  selectedFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}

const getBounds = (data: SpatialPivotGeoJSON | SpatialPivotGeoJSON['features'][number]) => {
  try {
    const bounds = bbox(data);
    return bounds.length === 4 && bounds.every(Number.isFinite)
      ? bounds as [number, number, number, number]
      : null;
  } catch {
    return null;
  }
};

const readFeatureId = (value: unknown) => (
  (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN
);

export default function SpatialResultMap({ geoJSON, message, selectedFeatureId, onSelectFeature }: SpatialResultMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onSelectFeature);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [mapError, setMapError] = useState(false);
  const { palette, dark } = useWorkbenchAppearance();
  const bounds = useMemo(() => geoJSON ? getBounds(geoJSON) : null, [geoJSON]);
  const hasExtent = bounds !== null;
  const maxTotal = useMemo(() => Math.max(0, ...(geoJSON?.features ?? []).map(feature => Number(feature.properties?.total) || 0)), [geoJSON]);
  const selected = useMemo(() => selectedFeatureId == null ? undefined : geoJSON?.features.find(
    feature => readFeatureId(feature.properties?.featureId) === selectedFeatureId,
  ), [geoJSON, selectedFeatureId]);

  useEffect(() => { callback.current = onSelectFeature; }, [onSelectFeature]);

  useEffect(() => {
    if (!container.current || !hasExtent) return;
    let preview: maplibregl.Map;
    try {
      preview = new maplibregl.Map({
        container: container.current,
        style: { version: 8, sources: {}, layers: [] },
        center: [0, 0],
        zoom: 1,
        attributionControl: { compact: true },
        dragRotate: false,
      });
    } catch {
      setMapError(true);
      return;
    }

    preview.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    preview.addControl(new maplibregl.ScaleControl(), 'bottom-left');
    preview.once('load', () => {
      preview.addSource(RESULT_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      preview.addLayer({ id: FILL_LAYER, type: 'fill', source: RESULT_SOURCE, paint: { 'fill-opacity': 0.78 } });
      preview.addLayer({ id: OUTLINE_LAYER, type: 'line', source: RESULT_SOURCE });
      preview.on('click', FILL_LAYER, event => {
        const id = readFeatureId(event.features?.[0]?.properties?.featureId);
        if (Number.isFinite(id)) callback.current(id);
      });
      preview.on('mouseenter', FILL_LAYER, () => { preview.getCanvas().style.cursor = 'pointer'; });
      preview.on('mouseleave', FILL_LAYER, () => { preview.getCanvas().style.cursor = ''; });
      setMap(preview);
    });
    return () => { preview.remove(); };
  }, [hasExtent]);

  useEffect(() => {
    if (!map || !geoJSON || !bounds) return;
    const source = map.getSource<maplibregl.GeoJSONSource>(RESULT_SOURCE);
    if (!source) return;
    source.setData(geoJSON);
    map.resize();
    map.fitBounds(bounds, { padding: 52, maxZoom: 15, duration: 0 });
  }, [map, geoJSON, bounds]);

  useEffect(() => {
    if (!map || !hasExtent) return;
    // The thematic geometry can load immediately. Context tiles arrive independently.
    const key = dark ? 'dark' : 'light';
    const raster = rasterStyle(key, '').sources[key] as maplibregl.RasterSourceSpecification;
    const context = map.getSource<maplibregl.RasterTileSource>(CONTEXT_SOURCE);
    if (context) {
      context.setTiles(raster.tiles ?? []);
    } else {
      map.addSource(CONTEXT_SOURCE, raster);
      map.addLayer({
        id: CONTEXT_SOURCE, type: 'raster', source: CONTEXT_SOURCE,
        paint: { 'raster-opacity': 0.64, 'raster-saturation': -0.8 },
      }, FILL_LAYER);
    }
  }, [map, dark, hasExtent]);

  useEffect(() => {
    if (!map || !hasExtent) return;
    const isSelected: maplibregl.ExpressionSpecification = selectedFeatureId == null
      ? ['literal', false]
      : ['==', ['to-number', ['get', 'featureId'], -1], selectedFeatureId];
    const fill: maplibregl.ExpressionSpecification = maxTotal > 0
      ? ['interpolate', ['linear'], ['to-number', ['get', 'total'], 0], 0, palette.mapLow, maxTotal, palette.mapHigh]
      : ['literal', palette.mapLow];

    map.setPaintProperty(FILL_LAYER, 'fill-color', ['case', isSelected, palette.focusSurface, fill]);
    map.setPaintProperty(OUTLINE_LAYER, 'line-color', ['case', isSelected, palette.focus, palette.mapOutline]);
    map.setPaintProperty(OUTLINE_LAYER, 'line-width', ['case', isSelected, 2.6, 1.1]);
    if (!selected) return;
    const extent = getBounds(selected);
    if (extent && !map.getBounds().contains([(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2])) {
      map.fitBounds(extent, { padding: 54, maxZoom: 15, duration: 220 });
    }
  }, [map, maxTotal, palette, selectedFeatureId, selected, hasExtent]);

  const fixExtent = () => {
    if (bounds) map?.fitBounds(bounds, { padding: 52, maxZoom: 15, duration: 220 });
  };

  return (
    <section className="spatial-result-panel spatial-result-map" aria-label="结果地图">
      <header className="spatial-result-panel-heading">
        <h3>结果地图</h3>
        {bounds && !mapError && (
          <Button type="text" size="small" icon={<AimOutlined />} onClick={fixExtent} disabled={!map}>全图</Button>
        )}
      </header>
      <div className="spatial-result-map-stage" style={{ background: palette.mapSurface }}>
        <div ref={container} className="spatial-result-map-canvas" aria-label="空间透视结果地图" />
        {(message || !bounds || mapError || !map) && (
          <div className="spatial-result-placeholder">
            {!bounds || mapError
              ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={mapError ? '地图预览暂不可用' : (message || '暂无可预览的结果范围')} />
              : <Spin aria-label="加载结果地图" />}
          </div>
        )}
      </div>
      {bounds && !mapError && (
        <div className="spatial-result-map-footer">
          <div className="spatial-result-legend" aria-label="地图颜色图例">
            <span>合计</span>
            <span>0</span>
            <span className="spatial-result-ramp" style={{ background: 'linear-gradient(90deg, ' + palette.mapLow + ', ' + palette.mapHigh + ')' }} />
            <span>{maxTotal.toLocaleString('zh-CN')}</span>
          </div>
          {selected && (
            <span className="spatial-result-map-selection" role="status">
              <span style={{ background: palette.focus }} />
              {String(selected.properties?.label ?? '要素 ' + selectedFeatureId)}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
