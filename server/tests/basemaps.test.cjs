const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createBasemapRouter } = require('../src/modules/basemaps/router');

const key = 'server-key-test-never-return-this';
const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const serve = async (options = {}) => {
  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  if (options.beforeRouter) app.use(options.beforeRouter);
  app.use(createBasemapRouter({ getKey: () => key, ...options }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const address = server.address();
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
};

const imageResponse = (bytes = validPng, mime = 'image/png') => new Response(bytes, {
  status: 200, headers: { 'content-type': `${mime}; charset=binary` },
});

test('catalog only reveals whether server credential exists', async t => {
  const service = await serve();
  t.after(() => service.close());
  const response = await fetch(`${service.base}/basemaps`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(JSON.parse(body), { code: 200, data: { tianditu: { configured: true } } });
  assert.ok(!body.includes(key));
});

test('remote socket is blocked only on basemap routes and forwarding headers cannot bypass it', async t => {
  const service = await serve({ beforeRouter: (req, _res, next) => {
    // Test-only transport simulation. Production guard reads the socket, never this header.
    Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: '10.0.0.8' });
    next();
  } });
  t.after(() => service.close());
  assert.equal((await fetch(`${service.base}/health`)).status, 200);
  const response = await fetch(`${service.base}/basemap-tiles/tianditu/img/0/0/0`, {
    headers: { 'x-forwarded-for': '127.0.0.1' },
  });
  assert.equal(response.status, 403);
  assert.match((await response.json()).message, /only available from this machine/);
});

test('tile proxy builds a fixed upstream WMTS URL and returns verified image bytes', async t => {
  let inspected;
  const service = await serve({ fetchImpl: async (url, init) => {
    inspected = { url: new URL(url), init };
    return imageResponse();
  } });
  t.after(() => service.close());
  const response = await fetch(`${service.base}/basemap-tiles/tianditu/vec/3/2/5`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), validPng);
  assert.equal(inspected.url.origin, 'https://t0.tianditu.gov.cn');
  assert.equal(inspected.url.pathname, '/vec_w/wmts');
  assert.equal(inspected.url.searchParams.get('TILEMATRIX'), '3');
  assert.equal(inspected.url.searchParams.get('TILECOL'), '2');
  assert.equal(inspected.url.searchParams.get('TILEROW'), '5');
  assert.equal(inspected.url.searchParams.get('tk'), key);
  assert.equal(inspected.init.redirect, 'manual');
  assert.ok(inspected.init.signal instanceof AbortSignal);
});

test('missing key, query injection, and invalid tile coordinates are rejected before fetch', async t => {
  let calls = 0;
  const service = await serve({ getKey: () => '', fetchImpl: async () => { calls += 1; return imageResponse(); } });
  t.after(() => service.close());
  const catalog = await fetch(`${service.base}/basemaps`).then(response => response.json());
  assert.equal(catalog.data.tianditu.configured, false);
  const missing = await fetch(`${service.base}/basemap-tiles/tianditu/img/0/0/0`);
  assert.equal(missing.status, 503);
  assert.match((await missing.json()).message, /not configured/);
  assert.equal(calls, 0);
});

test('invalid layer, z/x/y, and caller query values never reach provider', async t => {
  let calls = 0;
  const service = await serve({ fetchImpl: async () => { calls += 1; return imageResponse(); } });
  t.after(() => service.close());
  for (const path of [
    '/basemap-tiles/tianditu/evil/0/0/0',
    '/basemap-tiles/tianditu/cva/19/0/0',
    '/basemap-tiles/tianditu/img/1/2/0',
    '/basemap-tiles/tianditu/img/1/0/2',
    '/basemap-tiles/tianditu/img/1/nope/0',
    '/basemap-tiles/tianditu/img/1/0/0?tk=caller-secret',
  ]) {
    const response = await fetch(`${service.base}${path}`);
    assert.equal(response.status, 400, path);
    const body = await response.text();
    assert.ok(!body.includes('caller-secret'));
  }
  assert.equal(calls, 0);
});

test('provider redirects, error bodies, and unsupported MIME responses stay private', async t => {
  let responseFromProvider = new Response('provider secret body', { status: 302, headers: { location: 'https://evil.test' } });
  const service = await serve({ fetchImpl: async () => responseFromProvider });
  t.after(() => service.close());
  let response = await fetch(`${service.base}/basemap-tiles/tianditu/img/0/0/0`);
  let body = await response.text();
  assert.equal(response.status, 502);
  assert.ok(!body.includes('provider secret body') && !body.includes('evil.test') && !body.includes(key));

  responseFromProvider = new Response('provider key in text', { status: 200, headers: { 'content-type': 'text/html' } });
  response = await fetch(`${service.base}/basemap-tiles/tianditu/img/0/0/0`);
  body = await response.text();
  assert.equal(response.status, 502);
  assert.ok(!body.includes('provider key in text'));
});

test('MIME and image signatures must agree; declared and streamed bodies are size limited', async t => {
  let upstream = new Response(Buffer.from('not-png!'), { headers: { 'content-type': 'image/png' } });
  const service = await serve({ maxBytes: 16, fetchImpl: async () => upstream });
  t.after(() => service.close());
  let response = await fetch(`${service.base}/basemap-tiles/tianditu/img/0/0/0`);
  assert.equal(response.status, 502);

  upstream = new Response(Buffer.alloc(17, 1), { headers: { 'content-type': 'image/png' } });
  response = await fetch(`${service.base}/basemap-tiles/tianditu/img/0/0/0`);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /size limit/);

  upstream = new Response(validPng, { headers: { 'content-type': 'image/png', 'content-length': '17' } });
  response = await fetch(`${service.base}/basemap-tiles/tianditu/img/0/0/0`);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /size limit/);

  upstream = new Response(validPng, { headers: { 'content-type': 'image/jpeg' } });
  response = await fetch(`${service.base}/basemap-tiles/tianditu/img/0/0/0`);
  assert.equal(response.status, 502);
});

test('timeout and concurrency guard fail safely and release request capacity', async t => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  let calls = 0;
  const service = await serve({
    timeoutMs: 180,
    maxInFlight: 1,
    fetchImpl: (_url, { signal }) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(imageResponse());
      return new Promise((_resolve, reject) => {
        began();
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  t.after(() => service.close());
  const firstPromise = fetch(`${service.base}/basemap-tiles/tianditu/img/0/0/0`);
  await started;
  const overloaded = await fetch(`${service.base}/basemap-tiles/tianditu/img/0/0/0`);
  assert.equal(overloaded.status, 429);
  assert.equal(overloaded.headers.get('retry-after'), '1');
  const first = await firstPromise;
  assert.equal(first.status, 504);
  assert.ok(!(await first.text()).includes(key));
  const recovered = await fetch(`${service.base}/basemap-tiles/tianditu/img/0/0/0`);
  assert.equal(recovered.status, 200);
});

test('downstream disconnect cancels upstream and frees request capacity', async t => {
  let started;
  let aborted;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const upstreamAborted = new Promise(resolve => { aborted = resolve; });
  let calls = 0;
  const service = await serve({ maxInFlight: 1, fetchImpl: (_url, { signal }) => {
    calls += 1;
    if (calls > 1) return Promise.resolve(imageResponse());
    return new Promise((_resolve, reject) => {
      started();
      signal.addEventListener('abort', () => {
        aborted();
        reject(new Error('upstream cancelled'));
      }, { once: true });
    });
  } });
  t.after(() => service.close());
  const http = require('node:http');
  const client = http.get(`${service.base}/basemap-tiles/tianditu/img/0/0/0`);
  client.on('error', () => undefined);
  await requestStarted;
  client.destroy();
  await upstreamAborted;
  assert.equal((await fetch(`${service.base}/basemap-tiles/tianditu/img/0/0/0`)).status, 200);
});
