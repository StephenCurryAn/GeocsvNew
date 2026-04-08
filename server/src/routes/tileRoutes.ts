import { Router } from 'express';
import { getVectorTile } from '../controllers/tileController';

const router = Router();

// Mapbox Vector Tile (MVT) 请求端点
// 路由格式 /api/tiles/{file_id}/{z}/{x}/{y}
router.get('/:fileId/:z/:x/:y', getVectorTile);

export default router;
