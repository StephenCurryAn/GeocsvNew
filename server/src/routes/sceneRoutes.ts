import { Router } from 'express';
import { createScene, listScenes } from '../models/Scene';
import fileRoutes from './fileRoutes';

const router = Router();

router.get('/', async (_req, res) => {
  res.json({ code: 200, data: await listScenes() });
});

router.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 255) {
    res.status(400).json({ code: 400, message: '请输入 1 到 255 个字符的场景名称' });
    return;
  }
  res.status(201).json({ code: 201, data: await createScene(name) });
});

router.use('/:sceneId/files', fileRoutes);

export default router;
