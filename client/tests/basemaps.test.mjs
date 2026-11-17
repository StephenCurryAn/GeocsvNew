import test from 'node:test';
import assert from 'node:assert/strict';
import { BasemapController, BASEMAP_ANCHOR, BASEMAP_OPTIONS, DEFAULT_BASEMAP, initialMapStyle, rasterStyle, prepareBasemap, loadBasemap } from '../src/features/map/basemaps.ts';

class MapDouble {
  constructor() {
    const initial = initialMapStyle();
    this.layers = initial.layers;
    this.sources = initial.sources;
    this.sources.business = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
    this.layers.push({ id: 'selected-business', type: 'fill', source: 'business', filter: ['==', 'id', 7] });
    this.handlers = new Set();
    this.glyphs = null;
    this.sprite = null;
    this.ready = true;
  }
  getLayer(id) { return this.layers.find(layer => layer.id === id); }
  getSource(id) { return this.sources[id]; }
  addSource(id, source) { assert.ok(!this.sources[id]); this.sources[id] = source; }
  addLayer(layer, before) {
    if (this.failLayer) throw new Error('invalid style');
    const index = this.layers.findIndex(item => item.id === before);
    assert.notEqual(index, -1);
    this.layers.splice(index, 0, layer);
  }
  removeLayer(id) { this.layers = this.layers.filter(layer => layer.id !== id); }
  removeSource(id) {
    assert.ok(!this.layers.some(layer => layer.source === id));
    delete this.sources[id];
  }
  getGlyphs() { return this.glyphs; }
  setGlyphs(value) { this.glyphs = value; }
  getSprite() { return this.sprite ? [{ id: 'default', url: this.sprite }] : []; }
  setSprite(value) { this.sprite = value; }
  isSourceLoaded() { return this.ready; }
  isStyleLoaded() { return this.ready; }
  on(_type, fn) { this.handlers.add(fn); }
  off(_type, fn) { this.handlers.delete(fn); }
  fail(sourceId, error) { for (const handler of this.handlers) handler({ sourceId, error }); }
}

const vectorStyle = () => ({
  version: 8, glyphs: 'https://assets.example/font/{fontstack}/{range}.pbf', sprite: 'https://assets.example/sprite',
  sources: { world: { type: 'vector', url: 'https://api.example/tiles.json' } },
  layers: [{ id: 'water', type: 'fill', source: 'world', 'source-layer': 'water' }],
});

test('Protomaps light is the default and the initial map only provides a transparent anchor', () => {
  assert.deepEqual(BASEMAP_OPTIONS.map(option => option.key), [
    'protomaps-light', 'protomaps-white', 'protomaps-grayscale', 'protomaps-dark', 'protomaps-black',
    'tianditu-vector', 'tianditu-imagery',
  ]);
  assert.equal(DEFAULT_BASEMAP, BASEMAP_OPTIONS[0].key);
  assert.deepEqual(initialMapStyle().sources, {});
  assert.deepEqual(initialMapStyle().layers.map(layer => layer.id), [BASEMAP_ANCHOR]);
  assert.equal(initialMapStyle().layers[0].paint['background-opacity'], 0);
  assert.throws(() => rasterStyle('dark', '/api'));
  assert.throws(() => rasterStyle('light', '/api'));
});

test('TianDiTu composite contains base and Chinese labels using only our API', () => {
  for (const [key, expected] of [['tianditu-vector', ['vec', 'cva']], ['tianditu-imagery', ['img', 'cia']]]) {
    const style = rasterStyle(key, '/api/');
    assert.deepEqual(style.layers.map(layer => layer.source), expected);
    for (const source of Object.values(style.sources)) {
      assert.match(source.tiles[0], /^\/api\/basemap-tiles\/tianditu\//);
      assert.ok(!source.tiles[0].includes('tk=') && !source.tiles[0].includes('tianditu.gov.cn'));
    }
  }
  assert.throws(() => rasterStyle('arbitrary', '/api'));
});

test('provider IDs are namespaced without changing source-layer names', () => {
  const style = prepareBasemap(vectorStyle(), 'owned-');
  assert.equal(style.layers[0].id, 'owned-water');
  assert.equal(style.layers[0].source, 'owned-world');
  assert.equal(style.layers[0]['source-layer'], 'water');
  assert.throws(() => prepareBasemap({ ...vectorStyle(), sources: {} }, 'owned-'));
});

test('switching basemaps preserves business source identity, highlight filter and layer ordering', async () => {
  const map = new MapDouble();
  const business = map.sources.business;
  const highlight = map.getLayer('selected-business');
  const controller = new BasemapController(map, async key => key === 'protomaps-dark' ? vectorStyle() : rasterStyle(key, '/api'));
  assert.equal(await controller.switchTo('protomaps-dark'), true);
  assert.equal(await controller.switchTo('tianditu-imagery'), true);
  assert.equal(map.sources.business, business);
  assert.equal(map.getLayer('selected-business'), highlight);
  assert.equal(map.layers.at(-2).id, BASEMAP_ANCHOR);
  assert.equal(map.layers.at(-1).id, 'selected-business');
  assert.ok(!Object.keys(map.sources).some(id => id.startsWith('basemap-1-')));
  assert.equal(map.handlers.size, 0);
});

test('a rejected style leaves the previous basemap intact and redacts provider errors', async () => {
  const map = new MapDouble();
  const before = [...map.layers];
  const controller = new BasemapController(map, async () => { throw new Error('https://provider?key=secret'); });
  await assert.rejects(controller.switchTo('protomaps-dark'), error => !error.message.includes('secret'));
  assert.deepEqual(map.layers, before);
});

test('tile timeout removes staged resources and restores glyphs and sprites', async () => {
  const map = new MapDouble();
  map.ready = false;
  const before = [...map.layers];
  const controller = new BasemapController(map, async () => vectorStyle(), 70);
  await assert.rejects(controller.switchTo('protomaps-dark'), /已保留/);
  assert.deepEqual(map.layers, before);
  assert.equal(map.glyphs, null);
  assert.equal(map.sprite, null);
  assert.equal(map.handlers.size, 0);
  assert.deepEqual(Object.keys(map.sources), ['business']);
});

test('basemap readiness ignores business tiles and independent sprite errors', async () => {
  const map = new MapDouble();
  map.isStyleLoaded = () => false;
  const controller = new BasemapController(map, async () => vectorStyle());
  const switching = controller.switchTo('protomaps-light');
  await new Promise(resolve => setImmediate(resolve));
  map.fail('business', { status: 502 });
  map.fail(undefined, new Error('sprite unavailable'));
  assert.equal(await switching, true);
});

test('TianDiTu proxy statuses are translated without exposing provider URLs', async () => {
  const map = new MapDouble();
  const controller = new BasemapController(map, async key => key.startsWith('tianditu')
    ? rasterStyle(key, '/api') : vectorStyle());
  assert.equal(await controller.switchTo('protomaps-light'), true);
  const switching = controller.switchTo('tianditu-imagery');
  await new Promise(resolve => setImmediate(resolve));
  map.fail('basemap-2-img', { status: 403, message: 'https://provider?key=secret' });
  await assert.rejects(switching, error => /服务端 Key/.test(error.message) && !error.message.includes('secret'));
  assert.ok(map.getSource('basemap-1-world'));
  assert.equal(map.getSource('basemap-2-img'), undefined);
});

test('synchronous layer validation failure rolls back partially installed sources', async () => {
  const map = new MapDouble();
  map.failLayer = true;
  const controller = new BasemapController(map, async () => vectorStyle());
  await assert.rejects(controller.switchTo('protomaps-dark'), /已保留/);
  assert.equal(map.handlers.size, 0);
  assert.deepEqual(Object.keys(map.sources), ['business']);
});

test('latest selection wins when an earlier request is still loading', async () => {
  const map = new MapDouble();
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const controller = new BasemapController(map, (key, signal) => {
    if (key === 'protomaps-dark') return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      started();
    });
    return Promise.resolve(rasterStyle(key, '/api'));
  });
  const first = controller.switchTo('protomaps-dark');
  await firstStarted;
  const second = controller.switchTo('tianditu-vector');
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.ok(map.getSource('basemap-2-vec'));
  assert.equal(map.handlers.size, 0);
});

test('dispose cancels a pending tile wait before the map is removed', async () => {
  const map = new MapDouble();
  map.ready = false;
  const controller = new BasemapController(map, async () => vectorStyle());
  const pending = controller.switchTo('protomaps-dark');
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.dispose();
  assert.equal(await pending, false);
  assert.equal(map.handlers.size, 0);
});

test('Protomaps styles are generated locally for each theme and use the configured tile key', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('style must not make a network request'));
  const signal = new AbortController().signal;
  const config = { protomapsKey: ' test key ', apiBase: '/api' };
  for (const option of BASEMAP_OPTIONS.filter(option => option.key.startsWith('protomaps-'))) {
    const style = await loadBasemap(option.key, config, signal);
    const source = style.sources.protomaps;
    const tile = new URL(source.tiles[0]);
    assert.equal(style.version, 8);
    assert.equal(source.maxzoom, 15);
    assert.equal(tile.origin, 'https://api.protomaps.com');
    assert.equal(tile.searchParams.get('key'), 'test key');
    assert.ok(source.tiles[0].includes('/tiles/v4/{z}/{x}/{y}.mvt'));
    assert.ok(style.sprite.endsWith(`/sprites/v4/${option.key.slice('protomaps-'.length)}`));
    assert.ok(style.layers.some(layer => layer.source === 'protomaps' && layer['source-layer']));
    assert.ok(prepareBasemap(style, 'candidate-').sources['candidate-protomaps']);
  }
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(loadBasemap('protomaps-dark', { ...config, protomapsKey: '' }, signal), /未配置/);
  await assert.rejects(loadBasemap('protomaps-invalid', config, signal), /不支持/);
  await assert.rejects(loadBasemap('blank', config, signal), /不支持/);
});
