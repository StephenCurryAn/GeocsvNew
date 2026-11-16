import type { Map as LibreMap, StyleSpecification, SourceSpecification, LayerSpecification } from 'maplibre-gl';

export const BASEMAP_ANCHOR = 'geocsv-basemap-anchor';
export const DEFAULT_BASEMAP = 'protomaps-light';
const THEMES = ['light', 'white', 'grayscale', 'dark', 'black'] as const;
export const BASEMAP_OPTIONS = [
  ...THEMES.map(theme => ({ key: `protomaps-${theme}`, name: `Protomaps ${theme}` })),
  { key: 'tianditu-vector', name: '天地图矢量' },
  { key: 'tianditu-imagery', name: '天地图影像' },
];

export type BasemapConfig = { protomapsKey: string; apiBase: string };

export function rasterStyle(key: string, apiBase: string): StyleSpecification {
  if (!['tianditu-vector', 'tianditu-imagery'].includes(key)) {
    throw new Error('不支持的底图');
  }
  const layers = key === 'tianditu-vector' ? ['vec', 'cva'] : ['img', 'cia'];
  const sources: Record<string, SourceSpecification> = {};
  for (const layer of layers) {
    sources[layer] = {
      type: 'raster', tileSize: 256,
      maxzoom: 18,
      tiles: [`${apiBase.replace(/\/+$/, '')}/basemap-tiles/tianditu/${layer}/{z}/{x}/{y}`],
      attribution: '© 天地图',
    };
  }
  return { version: 8, sources, layers: layers.map(id => ({ id, source: id, type: 'raster' })) };
}

export function prepareBasemap(style: StyleSpecification, prefix: string): StyleSpecification {
  if (style.version !== 8 || !style.sources || !Array.isArray(style.layers) || !style.layers.length
    || (style.sprite !== undefined && typeof style.sprite !== 'string')) {
    throw new Error('底图样式格式不受支持');
  }
  const ids = new Set<string>();
  const layers = style.layers.map(layer => {
    if (!layer.id || ids.has(layer.id) || 'ref' in layer) throw new Error('底图图层定义无效');
    ids.add(layer.id);
    if ('source' in layer && typeof layer.source === 'string' && !style.sources[layer.source]) {
      throw new Error('底图引用了缺失的数据源');
    }
    return {
      ...layer, id: prefix + layer.id,
      ...('source' in layer && typeof layer.source === 'string' ? { source: prefix + layer.source } : {}),
    } as LayerSpecification;
  });
  return { ...style, sources: Object.fromEntries(Object.entries(style.sources).map(([id, source]) => [prefix + id, source])), layers };
}

export function initialMapStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: BASEMAP_ANCHOR, type: 'background', paint: { 'background-opacity': 0 } }],
  };
}

export async function loadBasemap(key: string, config: BasemapConfig, signal: AbortSignal): Promise<StyleSpecification> {
  if (!key.startsWith('protomaps-')) return rasterStyle(key, config.apiBase);
  const theme = key.slice('protomaps-'.length);
  if (!(THEMES as readonly string[]).includes(theme)) throw new Error('不支持的 Protomaps 主题');
  if (!config.protomapsKey.trim()) throw new Error('尚未配置 Protomaps Key');
  const url = `https://api.protomaps.com/styles/v5/${theme}/en.json?key=${encodeURIComponent(config.protomapsKey.trim())}`;
  try {
    const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error('provider unavailable');
    return await response.json() as StyleSpecification;
  } catch {
    // Provider URLs may include a browser key; do not surface raw errors or URLs.
    throw new Error('Protomaps 样式加载失败，请检查 Key、允许来源和网络');
  }
}

type BasemapMap = Pick<LibreMap, 'addLayer' | 'addSource' | 'getLayer' | 'getSource' | 'removeLayer' | 'removeSource'
  | 'getGlyphs' | 'setGlyphs' | 'getSprite' | 'setSprite' | 'isSourceLoaded' | 'on' | 'off'>;
type Installed = { layers: string[]; sources: string[] };
type Loader = (key: string, signal: AbortSignal) => Promise<StyleSpecification>;

const TIANDITU_TILE_ERRORS: Partial<Record<number, string>> = {
  403: '天地图拒绝访问，请检查服务端 Key 权限和服务器出口 IP 白名单',
  429: '天地图瓦片请求过多，请稍后重试',
  502: '天地图瓦片服务暂不可用，请检查 GeoCSV 后端能否访问天地图',
  503: '天地图服务端 Key 尚未配置',
  504: '天地图瓦片请求超时，请检查 GeoCSV 后端网络',
};

class TiandituTileError extends Error {}

/** Owns only basemap layers below the anchor. Never replaces business sources or the camera. */
export class BasemapController {
  private map: BasemapMap;
  private load: Loader;
  private timeoutMs: number;
  private installed: Installed = { layers: [], sources: [] };
  private request = 0;
  private disposed = false;
  private abort?: AbortController;
  private tail: Promise<boolean> = Promise.resolve(true);

  constructor(map: BasemapMap, load: Loader, timeoutMs = 20000) {
    this.map = map;
    this.load = load;
    this.timeoutMs = timeoutMs;
  }

  switchTo(key: string): Promise<boolean> {
    const request = ++this.request;
    this.abort?.abort();
    const previous = this.tail.catch(() => false);
    this.tail = previous.then(async () => {
      if (this.disposed || request !== this.request) return false;
      const abort = new AbortController();
      this.abort = abort;
      const timer = setTimeout(() => abort.abort(), this.timeoutMs);
      let candidate: Installed | undefined;
      const glyphs = this.map.getGlyphs();
      const sprite = this.map.getSprite().find(item => item.id === 'default')?.url ?? null;
      let assetsChanged = false;
      try {
        const style = prepareBasemap(await this.load(key, abort.signal), `basemap-${request}-`);
        if (abort.signal.aborted || this.disposed || request !== this.request) return false;
        candidate = { layers: style.layers.map(layer => layer.id), sources: Object.keys(style.sources) };
        // Attach readiness/error listeners before adding resources, including synchronous validation errors.
        const ready = this.waitForSources(candidate.sources, abort.signal, key.startsWith('tianditu-'));
        try {
          if (style.glyphs && style.glyphs !== glyphs) { assetsChanged = true; this.map.setGlyphs(style.glyphs); }
          if (typeof style.sprite === 'string' && style.sprite !== sprite) { assetsChanged = true; this.map.setSprite(style.sprite); }
          for (const [id, source] of Object.entries(style.sources)) this.map.addSource(id, source);
          for (const layer of style.layers) this.map.addLayer(layer, BASEMAP_ANCHOR);
        } catch {
          abort.abort();
        }
        await ready;
        if (abort.signal.aborted || this.disposed || request !== this.request) throw new Error('cancelled');
        this.remove(this.installed);
        this.installed = candidate;
        candidate = undefined;
        return true;
      } catch (error) {
        if (candidate && !this.disposed) this.remove(candidate);
        if (assetsChanged && !this.disposed) {
          this.map.setGlyphs(glyphs);
          this.map.setSprite(sprite);
        }
        if (this.disposed || request !== this.request) return false;
        if (error instanceof TiandituTileError) throw error;
        throw new Error('底图加载失败，已保留原底图。请检查配置、网络或服务额度。');
      } finally {
        clearTimeout(timer);
        if (this.abort === abort) this.abort = undefined;
      }
    });
    return this.tail;
  }

  dispose() {
    this.disposed = true;
    ++this.request;
    this.abort?.abort();
  }

  private remove(group: Installed) {
    for (const id of [...group.layers].reverse()) if (this.map.getLayer(id)) this.map.removeLayer(id);
    for (const id of group.sources) if (this.map.getSource(id)) this.map.removeSource(id);
  }

  private waitForSources(ids: string[], signal: AbortSignal, isTianditu: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearInterval(interval);
        this.map.off('error', onError);
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      };
      const onAbort = () => finish(new Error('cancelled'));
      const onError = (event: { sourceId?: string; error?: { status?: number } }) => {
        if (event.sourceId && !ids.includes(event.sourceId)) return;
        const status = event.error?.status;
        const reason = isTianditu && event.sourceId && status !== undefined ? TIANDITU_TILE_ERRORS[status] : undefined;
        finish(reason ? new TiandituTileError(`${reason}。已保留原底图。`) : new Error('provider failed'));
      };
      const interval = setInterval(() => {
        if (ids.every(id => this.map.getSource(id) && this.map.isSourceLoaded(id))) finish();
      }, 50);
      this.map.on('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}
