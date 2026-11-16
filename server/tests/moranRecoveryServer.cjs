const express = require('express');
const { Pool } = require('pg');
const { AnalysisService } = require('../src/modules/analysis/service');
const { createSpatialPivotRouter } = require('../src/modules/spatialPivot/router');

const db = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  options: '-c search_path=' + process.env.TEST_SCHEMA + ',public',
  max: 6,
});
const service = new AnalysisService(db, 30000);
const app = express();
app.use(express.json());
app.use('/api', createSpatialPivotRouter(db, service));
const server = app.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
  service.start().then(() => console.log('ready:' + server.address().port)).catch(error => {
    console.error(error);
    process.exitCode = 1;
    server.close(() => void db.end());
  });
});
process.once('SIGTERM', () => {
  Promise.resolve(service.stop()).finally(() => {
    server.close(() => void db.end().finally(() => process.exit(0)));
  });
});
process.once('SIGINT', () => process.kill(process.pid, 'SIGTERM'));
