// Seed only a dedicated test database for browser acceptance; never the application database.
const { Pool } = require('pg');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

async function main() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString || !/test|tmp/i.test(new URL(connectionString).pathname)) {
    throw new Error('Set TEST_DATABASE_URL to a dedicated test database');
  }
  const db = new Pool({ connectionString, max: 1 });
  try {
    await db.query(readFileSync(join(__dirname, '../src/config/init.sql'), 'utf8'));
    if (Number((await db.query('SELECT count(*) FROM file_nodes')).rows[0].count) !== 0) {
      console.log('Existing demo data preserved; no data changed.');
      return;
    }
    await db.query('BEGIN');
    await db.query(`INSERT INTO file_nodes(id,name,type,extension) VALUES
      ('demo-districts','示例街道.geojson','file','.geojson'), ('demo-pois','示例设施.geojson','file','.geojson')`);
    const features = [
      ['demo-districts', 'POLYGON((118.70 32.00,118.72 32.00,118.72 32.02,118.70 32.02,118.70 32.00))', { id: 'street-a', 名称: '甲街道' }],
      ['demo-districts', 'POLYGON((118.72 32.00,118.74 32.00,118.74 32.02,118.72 32.02,118.72 32.00))', { id: 'street-b', 名称: '乙街道' }],
      ['demo-districts', 'POLYGON((118.75 32.00,118.76 32.00,118.76 32.01,118.75 32.01,118.75 32.00))', { id: 'street-c', 名称: '丙街道' }],
      ['demo-pois', 'POINT(118.71 32.01)', { id: 'poi-a', 类型: '公园' }],
      ['demo-pois', 'POINT(118.715 32.01)', { id: 'poi-b', 类型: '学校' }],
      ['demo-pois', 'POINT(118.72 32.01)', { id: 'poi-boundary', 类型: '公园' }],
      ['demo-pois', 'POINT(118.73 32.01)', { id: 'poi-c', 类型: '公园' }],
    ];
    for (const [fileId, wkt, props] of features) {
      await db.query('INSERT INTO spatial_features(file_id,geom,properties) VALUES($1,ST_GeomFromText($2,4326),$3)', [fileId, wkt, props]);
    }
    await db.query('COMMIT');
    console.log('Demo ready: excluding boundary totals 2,1,0; including boundary totals 3,2,0.');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { await db.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
