import { Router } from 'express';
import { uploadFile, createFolder, getFileTree, getFileData,
        renameNode, deleteNode, updateFileData,
        addRow, deleteRow, addColumn, deleteColumn, exportFile, renameColumn } from '../controllers/fileController';
import upload from '../utils/uploadConfig';

/**
 * 文件路由模块
 * 定义与文件上传相关的 API 接口
 */
const router = Router();


// GET: 拿数据（安全）。
// POST: 塞数据（新建）、复杂操作、万能替补。
// PUT: 改属性。
// DELETE: 删东西。

/**
 * POST /upload
 * 文件上传 接口
 * 使用 upload.array('files') 中间件处理多个文件上传
 * 然后调用 uploadFile 控制器处理业务逻辑
 */
// 这里面的'file'，是前端 form-data 里那个字段的名字
// single 方法表示只处理单个文件上传
// http://localhost:3000/api/files/upload
router.post('/upload', upload.array('files'), uploadFile);

/**
 * POST /folder
 * 创建文件夹 接口
 * 接收 { name, parentId } 参数，在数据库中创建文件夹记录
 */
// http://localhost:3000/api/files/folder
router.post('/folder', createFolder);

/**
 * GET /tree
 * 获取文件树 接口
 * 查询数据库中的所有文件节点并返回树形结构
 */
// http://localhost:3000/api/files/tree
router.get('/tree', getFileTree);

/**
 * GET /content/:id
 * 获取文件内容 接口
 * 用于前端点击文件时，通过 ID 获取文件内容 (按需加载)
 */
// http://localhost:3000/api/files/content/65a1b2c3d4e5...
// router.get('/content/:id', getFileContent); // （建议在需要保存csv的时候再使用）
router.get('/:id/data', getFileData); // 分页读取路由
// /content/:id 代表**“这个文件里面的具体内容”**（比如 GeoJSON 的那一大串坐标数据）。
// /:id 代表**“这个文件本身”**（通常指文件的基本信息，如名字、大小、创建时间）。

/**
 * PUT /:id
 * 重命名文件或文件夹
 */
// PUT 请求：整体更新/ 资源
// 在 RESTful 规范里，更新现有资源通常用 PUT（或 PATCH）
router.put('/:id', renameNode);

/**
 * DELETE /:id
 * 删除文件或文件夹
 */
router.delete('/:id', deleteNode);

/**
 * POST /:id/update
 * 更新文件 数据接口
 * 对应前端: geoService.updateFileData
 * 逻辑: 根据 rowIndex   GeoJSON 中的 properties 并写回硬盘
 * 发生在前端用户操作后，需要将 后的内容保存到服务器
 */
// http://localhost:3000/api/files/65a1.../update
router.post('/:id/update', updateFileData);


// 1. 新增行
router.post('/:id/row', addRow);
// 2. 删除行 (通常用 DELETE 方法，传 body 需要注意客户端支持，或者用 POST 模拟)
// 为了方便，这里用 POST 携带 body
router.post('/:id/row/delete', deleteRow);

// 3. 新增列
router.post('/:id/column', addColumn);
// 4. 删除列
router.post('/:id/column/delete', deleteColumn);
// 重命名列名
router.put('/:id/columns/rename', renameColumn);

/**
 * GET /:id/export
 * 导出/下载文件
 * 从数据库读取最新数据并生成 CSV
 */
router.get('/:id/export', exportFile);

// export default 的特权：在别的文件中引用的时候，可以随意起名（路径对就行）
// (在index.ts里引用的时候起名为fileRoutes)
export default router;