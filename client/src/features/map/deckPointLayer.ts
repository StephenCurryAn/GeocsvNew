import { MapLibreOverlay } from '@deck.gl/maplibre';
import { MVTLayer } from '@deck.gl/geo-layers';
import workerUrl from '@loaders.gl/mvt/mvt-worker.js?url';
import type { Map } from 'maplibre-gl';

export interface DeckPointOptions {
  fileId: string;
  tileUrl: string;
  beforeId: string;
  color: string;
  dense: boolean;
}

interface PickedPoint {
  id: number;
  properties: Record<string, unknown>;
}

export interface DeckPointLayer {
  pick(x: number, y: number): PickedPoint | undefined;
  align(): void;
  dispose(): void;
}

function interpolate(zoom: number, low: number, high: number, from: number, to: number) {
  const fraction = Math.max(0, Math.min(1, (zoom - low) / (high - low)));
  return from + (to - from) * fraction;
}

export function addDeckPointLayer(
  map: Map, options: DeckPointOptions, onReady: () => void, onError: (error: unknown) => void,
): DeckPointLayer {
  const canvas = map.getCanvas();
  const context = canvas.getContext('webgl2');
  if (!context || context.isContextLost()) throw new Error('WebGL2 unavailable');

  const rgb = Number.parseInt(options.color.slice(1), 16);
  const loadOptions = { mvt: { workerUrl } };
  const groupId = 'deck-maplibre-layer-group-before:' + options.beforeId;
  let viewportLoaded = false;
  const reportReady = () => {
    if (viewportLoaded && map.getLayer(groupId)) onReady();
  };
  const createLayer = () => {
    const zoom = map.getZoom();
    const radius = zoom < 12 ? interpolate(zoom, 7, 12, 1, 1.8) : interpolate(zoom, 12, 16, 1.8, 4.5);
    const opacity = zoom < 12 ? interpolate(zoom, 7, 12, 0.3, 0.52) : interpolate(zoom, 12, 16, 0.52, 0.94);
    return new MVTLayer({
      id: 'deck-points-' + options.fileId,
      beforeId: options.beforeId,
      data: options.tileUrl,
      minZoom: 0,
      maxZoom: 14,
      binary: true,
      loadOptions,
      pickable: true,
      pointRadiusUnits: 'pixels',
      getPointRadius: options.dense ? radius : 4.5,
      getFillColor: [rgb >> 16, (rgb >> 8) & 255, rgb & 255, options.dense ? Math.round(opacity * 255) : 255],
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: options.dense ? interpolate(zoom, 12, 16, 0, 0.8) : 0.8,
      getLineColor: [39, 54, 78, 140],
      onViewportLoad: () => {
        viewportLoaded = true;
        reportReady();
      },
      onTileError: onError,
    });
  };

  const overlay = new MapLibreOverlay({ interleaved: true, layers: [createLayer()], onError });
  const onZoom = () => overlay.setProps({ layers: [createLayer()] });
  const waitForStyle = () => {
    // The interleaved control only inserts its group once MapLibre's style is loaded.
    if (!map.getLayer(groupId)) onZoom();
    if (map.getLayer(groupId)) {
      map.off('idle', waitForStyle);
      reportReady();
    }
  };
  const onContextLost = () => onError(new Error('WebGL2 context lost'));
  map.addControl(overlay);
  if (!map.getLayer(groupId)) map.on('idle', waitForStyle);
  map.on('zoom', onZoom);
  canvas.addEventListener('webglcontextlost', onContextLost);

  return {
    pick(x, y) {
      try {
        const feature = overlay.pickObject({ x, y })?.object as GeoJSON.Feature | undefined;
        return typeof feature?.id === 'number' && Number.isSafeInteger(feature.id)
          ? { id: feature.id, properties: feature.properties ?? {} } : undefined;
      } catch (error) {
        onError(error);
      }
    },
    align() {
      // The overlay skips its style-data alignment while another source is loading.
      const order = map.getLayersOrder();
      const anchor = order.indexOf(options.beforeId);
      const group = order.indexOf(groupId);
      if (anchor >= 0 && group >= 0 && group !== anchor - 1) map.moveLayer(groupId, options.beforeId);
    },
    dispose() {
      map.off('idle', waitForStyle);
      map.off('zoom', onZoom);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      if (map.hasControl(overlay)) {
        map.removeControl(overlay);
        // v9.4.1 skips group removal while the style is loading.
        if (map.getLayer(groupId)) map.removeLayer(groupId);
      }
    },
  };
}
