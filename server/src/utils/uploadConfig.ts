import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';

const uploadDir = path.join(process.cwd(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

export const shapefileSidecars = ['.shx', '.dbf', '.prj', '.cpg'];
const allowedExtensions = new Set([
  '.json', '.geojson', '.csv', '.shp', '.tif', '.tiff', ...shapefileSidecars,
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    // Multipart parts are written before the controller runs. Never stage by user filename.
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  }),
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.has(extension)) {
      callback(new Error(`不支持的文件类型：${extension}`));
      return;
    }
    callback(null, true);
  },
  limits: { fileSize: 1000 * 1024 * 1024 },
});

export default upload;
