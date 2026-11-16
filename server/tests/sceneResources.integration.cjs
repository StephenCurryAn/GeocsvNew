const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, readdirSync, readFileSync, rmSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { Pool } = require('pg');
const express = require('express');

const databaseUrl = process.env.SCENE_TEST_DATABASE_URL;

test('PostGIS: scene migration, multi-file import, scoped resource access and rollback',
  { skip: !databaseUrl, timeout: 45000 }, async t => {
    const url = new URL(databaseUrl);
    assert.match(url.pathname, /^\/geocsv_.*_test$/, 'Use an isolated scene test database');
    const admin = new Pool({ connectionString: url.href });
    const schema = 'scene_test_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    const originalDirectory = process.cwd();
    const dependenciesDirectory = join(__dirname, '../node_modules');
    const scratch = mkdtempSync(join(dependenciesDirectory, '.scene-uploads-'));
    process.chdir(scratch);
    process.env.DATABASE_URL = url.href;
    const db = require('../src/config/db').default;
    const { migrateScenes, DEFAULT_SCENE_ID } = require('../src/models/Scene');
    const { LEGACY_ANALYSIS_SCHEMA } = require('../src/modules/analysis/legacySchema');
    const app = express();
    app.use(express.json());
    app.use('/api/files', require('../src/routes/fileRoutes').default);
    app.use('/api/scenes', require('../src/routes/sceneRoutes').default);
    const server = app.listen(0, '127.0.0.1');
    t.after(async () => {
      await new Promise(resolve => server.close(resolve));
      await db.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      process.chdir(originalDirectory);
      assert.equal(dirname(scratch), dependenciesDirectory);
      rmSync(scratch, { recursive: true });
    });
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port + '/api';

    const request = async (path, status = 200, method = 'GET', body) => {
      const form = body instanceof FormData;
      const response = await fetch(base + path, {
        method,
        headers: body && !form ? { 'Content-Type': 'application/json' } : undefined,
        body: form ? body : body && JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result.data;
    };
    const point = (marker, coordinates = [110, 30]) => JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: { id: marker } }],
    });
    const upload = (path, files, parentId, status = 200) => {
      const data = new FormData();
      for (const [filename, content] of files) data.append('files', new Blob([content]), filename);
      if (parentId) data.append('parentId', parentId);
      return request(path + '/upload', status, 'POST', data);
    };
    const paths = () => readdirSync(join(scratch, 'uploads')).sort();

    await db.query(readFileSync(join(__dirname, '../src/config/init.sql'), 'utf8'));
    await db.query(`
      INSERT INTO file_nodes(id,name,type,parent_id,path) VALUES
        ('old-folder','旧文件夹','folder',NULL,NULL),
        ('old-file','旧文件.csv','file','old-folder','uploads/keep.csv'),
        ('orphan','旧孤立节点','file','historically-missing',NULL);
      INSERT INTO spatial_features(id,file_id,properties) VALUES (5001,'old-file','{"id":"old-row"}');
    `);
    await db.query(LEGACY_ANALYSIS_SCHEMA);
    const definition = randomUUID();
    const spec = { fileId: 'old-file' };
    await db.query('INSERT INTO geocsv_analysis_definitions(id,spec_hash,spec) VALUES($1,$2,$3)',
      [definition, 'legacy-hash', spec]);
    await db.query('INSERT INTO geocsv_analysis_runs(id,definition_id,spec,status) VALUES($1,$2,$3,$4)',
      [randomUUID(), definition, spec, 'succeeded']);
    const oldRuns = (await db.query('SELECT * FROM geocsv_analysis_runs')).rows;
    const oldNodes = (await db.query('SELECT * FROM file_nodes ORDER BY id')).rows;
    const oldFeatures = (await db.query('SELECT * FROM spatial_features ORDER BY id')).rows;
    await Promise.all([migrateScenes(db), migrateScenes(db)]);
    const newNodes = (await db.query('SELECT * FROM file_nodes ORDER BY id')).rows;
    assert.deepEqual(newNodes, oldNodes.map(row => ({ ...row, scene_id: DEFAULT_SCENE_ID })));
    assert.deepEqual((await db.query('SELECT * FROM spatial_features ORDER BY id')).rows, oldFeatures);
    assert.deepEqual((await db.query('SELECT * FROM geocsv_analysis_runs')).rows, oldRuns);
    assert.equal((await db.query('SELECT * FROM geocsv_scene_migrations')).rowCount, 1);
    const [defaultScene] = await request('/scenes');
    assert.deepEqual(defaultScene, { id: DEFAULT_SCENE_ID, name: '默认场景', isDefault: true });
    const defaultTree = '/scenes/' + DEFAULT_SCENE_ID + '/files/tree';
    assert.deepEqual(await request(defaultTree), await request('/files/tree'));
    assert.equal((await request(defaultTree))[0].children[0].id, 'old-file');
    await db.query("INSERT INTO file_nodes(id,name,type) VALUES ('late-legacy','legacy.csv','file')");
    assert.equal((await request(defaultTree)).find(node => node.id === 'late-legacy').scene_id, DEFAULT_SCENE_ID);

    const a = await request('/scenes', 201, 'POST', { name: '场景甲' });
    const b = await request('/scenes', 201, 'POST', { name: '场景乙' });
    const aPath = '/scenes/' + a.id + '/files';
    const bPath = '/scenes/' + b.id + '/files';
    const aFolder = await request(aPath + '/folder', 200, 'POST', { name: '图层' });
    const bFolder = await request(bPath + '/folder', 200, 'POST', { name: '图层' });
    const [aFiles, bFiles] = await Promise.all([
      upload(aPath, [['same.geojson', point('a')], ['second.csv', 'id,lon,lat\nsecond,111,30']], aFolder._id),
      upload(bPath, [['same.geojson', point('b')], ['table.csv', 'id,name\nplain,Example']], bFolder._id),
    ]);
    assert.deepEqual(aFiles.map(file => file.fileName), ['same.geojson', 'second.csv']);
    assert.deepEqual(bFiles.map(file => file.fileName), ['same.geojson', 'table.csv']);
    assert.notEqual(aFiles[0]._id, bFiles[0]._id);
    const importedNodes = (await db.query('SELECT path FROM file_nodes WHERE id = ANY($1)', [
      [...aFiles, ...bFiles].map(file => file._id),
    ])).rows;
    assert.equal(new Set(importedNodes.map(node => node.path)).size, 4);

    const aFile = aPath + '/' + aFiles[0]._id;
    const bFile = bPath + '/' + bFiles[0]._id;
    assert.equal((await request(aFile + '/data')).features[0].properties.id, 'a');
    assert.equal((await request(bFile + '/data')).features[0].properties.id, 'b');
    assert.equal((await request(bPath + '/' + bFiles[1]._id + '/data')).features[0].properties.id, 'plain');

    const beforeRejection = paths();
    await upload(aPath, [['intruder.geojson', point('bad')]], bFolder._id, 404);
    await upload(aPath, [['intruder.geojson', point('bad')]], aFiles[0]._id, 404);
    await upload(aPath, [['first.geojson', point('valid')], ['invalid.geojson', '{']], aFolder._id, 400);
    await db.query(`ALTER TABLE spatial_features ADD CHECK ((properties->>'id') IS DISTINCT FROM 'reject-in-db')`);
    await upload(aPath, [['first.geojson', point('valid')], ['invalid.geojson', point('reject-in-db')]], aFolder._id, 500);
    assert.deepEqual(paths(), beforeRejection);
    await request(aPath + '/folder', 404, 'POST', { name: 'bad', parentId: bFolder._id });
    await assert.rejects(db.query('UPDATE file_nodes SET parent_id=$1 WHERE id=$2', [bFolder._id, aFiles[0]._id]),
      { code: '23503' });
    const spoofed = aPath + '/' + bFiles[0]._id;
    await request(spoofed + '/data', 404);
    await request(spoofed + '/export', 404);
    await request(spoofed + '/tiles/0/0/0', 404);
    await request(spoofed + '/column', 404, 'POST', { fieldName: 'intruder' });
    await request(spoofed, 404, 'PUT', { name: 'intruder' });
    await request(spoofed, 404, 'DELETE');
    await request('/scenes/bad/files/tree', 400);
    await request('/scenes/' + randomUUID() + '/files/tree', 404);

    const legacyUpload = await upload('/files', [['legacy.csv', 'id,lon,lat\nlegacy,109,30']]);
    assert.equal(legacyUpload.fileName, 'legacy(1).csv');
    assert.equal((await request('/files/' + bFiles[0]._id + '/data')).features[0].properties.id, 'b');
    await request('/files/' + bFiles[0]._id, 404, 'DELETE');
    assert.deepEqual((await request(aPath + '/tree'))[0].children.map(node => node.id).sort(),
      aFiles.map(file => file._id).sort());
    await request(aFile, 200, 'PUT', { name: 'edited.geojson' });
    assert.equal((await request(aPath + '/tree'))[0].children.find(node => node.id === aFiles[0]._id).name,
      'edited.geojson');
    await request(aPath + '/' + aFolder._id, 200, 'DELETE');
    assert.deepEqual(await request(aPath + '/tree'), []);
    assert.equal((await db.query('SELECT * FROM spatial_features WHERE file_id = ANY($1)', [
      aFiles.map(file => file._id),
    ])).rowCount, 0);
    assert.equal((await request(bFile + '/data')).features[0].properties.id, 'b');
    await migrateScenes(db);
    assert.equal((await request('/scenes')).length, 3);
  });
