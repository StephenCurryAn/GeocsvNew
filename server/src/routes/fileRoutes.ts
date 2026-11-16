import { Router } from 'express';
import {
  uploadFile, createFolder, getFileTree, getFileData, getFileExtent, renameNode, deleteNode, updateFileData,
  addRow, deleteRow, addColumn, deleteColumn, exportFile, renameColumn, getTile,
} from '../controllers/fileController';
import { findFileNodeById } from '../models/FileNode';
import { sceneExists } from '../models/Scene';
import upload from '../utils/uploadConfig';

const router = Router({ mergeParams: true });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(async (req, res, next) => {
  const { sceneId } = req.params;
  if (sceneId !== undefined) {
    if (typeof sceneId !== 'string' || !uuidPattern.test(sceneId)) {
      res.status(400).json({ code: 400, message: '场景 ID 无效' });
      return;
    }
    if (!(await sceneExists(sceneId))) {
      res.status(404).json({ code: 404, message: '场景不存在' });
      return;
    }
  }
  next();
});

// The same ID-based endpoints are mounted under /api/scenes/:sceneId/files and /api/files.
router.param('id', async (req, res, next, id: string) => {
  const { sceneId } = req.params;
  if (typeof sceneId === 'string' && !(await findFileNodeById(id, sceneId))) {
    res.status(404).json({ code: 404, message: '当前场景中没有该资源' });
    return;
  }
  next();
});

router.post('/upload', (req, res, next) => {
  upload.array('files')(req, res, error => {
    if (error) {
      res.status(400).json({ code: 400, message: error.message });
      return;
    }
    next();
  });
}, uploadFile);
router.post('/folder', createFolder);
router.get('/tree', getFileTree);
router.get('/:id/data', getFileData);
router.get('/:id/extent', getFileExtent);
router.put('/:id', renameNode);
router.delete('/:id', deleteNode);
router.post('/:id/update', updateFileData);
router.post('/:id/row', addRow);
router.post('/:id/row/delete', deleteRow);
router.post('/:id/column', addColumn);
router.post('/:id/column/delete', deleteColumn);
router.put('/:id/columns/rename', renameColumn);
router.get('/:id/tiles/:z/:x/:y', getTile);
router.get('/:id/export', exportFile);

export default router;
