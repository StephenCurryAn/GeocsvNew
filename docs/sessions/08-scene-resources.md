# 08 场景与资源管理

2026-11-16，分支 `codex/08-scene-resources`，基线 `1eb04f8909c2e1725f15a361f80044b9ca3e3b6d`。

## 实现

- [Scene.ts](../../server/src/models/Scene.ts) 维护持久化场景和 `geocsv_scene_migrations` 版本记录。服务启动时以同一事务执行迁移，通过 PostgreSQL 咨询锁串行化并发启动。旧节点通过新列默认值自动归入「默认场景」，保留文件与目录 ID、父子关系、磁盘路径和要素。已有分析记录保持原样。新库仍先执行 `server/src/config/init.sql`，启动迁移需要可建表及修改 `file_nodes` 的数据库账号。
- [fileRoutes.ts](../../server/src/routes/fileRoutes.ts) 同时挂载于旧文件路由与场景路由。场景路由查库确认场景存在，再按场景和节点 ID 校验读取、导出、瓦片、表格编辑及节点操作。创建和上传要求父节点属于当前场景且类型为文件夹。数据库组合外键约束父子节点的场景归属。约束保留历史孤立节点，并校验迁移后新增或修改的父子关系。
- [fileController.ts](../../server/src/controllers/fileController.ts) 复用现有解析器。每个独立文件生成一个节点，同名 Shapefile 主文件和配套文件组成一个节点。磁盘暂存与最终路径使用随机 ID，同目录重名加数字后缀，两场景的同名文件可以同时保留原名。批次中节点和要素在同一个事务提交，失败清理本批磁盘文件。删除以场景为范围处理整棵子树，数据库先提交，再清理磁盘文件。
- [LeftPanel](../../client/src/features/workspace/components/LeftPanel.tsx) 提供场景选择与创建。[FileTree](../../client/src/features/workspace/components/FileTree.tsx) 使用当前场景接口，支持选中文件夹作为创建和上传目标，按文件 ID 多选。活动场景和每个场景的文件选择保存在浏览器本地。清空、改名和删除会同步已有选择回调。场景切换会取消树读取，旧组件迟到的响应只可能通知原场景刷新。

## 接口与整合契约

| 接口或事件 | 行为 |
| --- | --- |
| `GET /api/scenes`、`POST /api/scenes` | 列出和创建场景，返回 `{ id, name, isDefault }`。创建接收 `{ name }`。 |
| `/api/scenes/:sceneId/files/*` | 路径指定场景，服务端用数据库关系校验资源归属。父目录和节点冒用返回 404。上传成功的 `data` 为数据集数组，每项含 `_id`、`fileName`、`fileSize`、`fileType` 和 `totalFeatures`。 |
| `/api/files` 旧入口 | 树、上传、建目录、节点重命名和删除都以默认场景为范围。上传的 `data` 保持单对象响应，为批次最后一个数据集。按稳定文件 ID 的数据、编辑、导出与瓦片入口保留旧的全局语义，供现有表格和地图使用。旧分析写入资源时也采用默认场景。 |
| `LeftPanel.onSceneChange?(scene)` | 首次恢复或切换时发布活动场景对象。随后 `onSelectFiles([], [])` 同步清空选择。新场景的树读取后，用 `onSelectFiles(names, ids)` 发送经树验证的保存选择，两个数组逐项对应。 |
| `REFRESH_FILE_TREE` | 原有无参数事件刷新活动树。指定 `detail.sceneId` 时仅刷新对应的活动树，供后续结果归属和迟到写入通知复用。 |

主会话可用 `onSceneChange` 将场景 ID 接入地图、表格和助手的上下文，并以场景 ID 和文件 ID 校验读写。前端可用 `sceneFilesPath(sceneId)` 生成资源地址，`geoService.getFileData` 已接受可选场景 ID。将助手请求、Run 与 Artifact 归属接入场景，以及显式授权的跨场景分析由后续整合完成。

现有地图在空场景有一项已复现的联动缺口。选中场景 A 的图层，再创建并进入空场景 B，左侧选择、属性表和图例会清空，MapLibre 的 `uploaded-geo-data` 仍指向 A 的主图层瓦片。当前 `MapView` 只在有 `displayData` 时重绘主图层。主会话可在切换时使用 `onSceneChange` 取消旧读取，并在空选择时移除主图层和来源。

地图验收应包括从含两个图层的场景切到空场景，确认主图层和附加图层一起清除。再选中另一场景的资源，核对地图来源和属性表按文件 ID 更新。切回原场景以及刷新时，应从已验证的资源选择恢复地图。地图和表格读取使用当前活动场景或取消旧请求的接线由主会话负责。

## 验证记录

验证仅使用 `geocsv_08_scene_test` 独立数据库、合成文件及本工作树下的测试上传目录。真实全应用验证使用前端 `127.0.0.1:5178` 和后端 `127.0.0.1:3008`，前端 `VITE_API_BASE_URL` 指向该后端。现有主库未执行迁移或数据操作。

- `npm run typecheck --prefix server` 和 `npm run build --prefix client` 通过。前端构建仍报告大包体积提示。资源组件和场景管理相关文件 ESLint 通过。
- `npm test --prefix server` 通过 20 项。`npm run test:integration --prefix server` 在真实 PostGIS 通过 5 项，设置 `SCENE_TEST_DATABASE_URL` 与 `TEST_DATABASE_URL` 指向独立测试库。新增用例并发运行迁移并比较迁移前后文件、路径、要素与分析历史，测试跨场景范围、普通 CSV、GeoJSON、同名资源和失败批次回滚。入库回滚用例注入 PostGIS 约束错误并比较上传目录。默认旧树和旧上传响应也通过检查。
- 同一 multipart 请求上传合成点 Shapefile 的 `.shp/.dbf/.shx` 与另一个 CSV，返回两个节点；通过场景数据接口读取到 Shapefile 的坐标和属性。
- Chromium 从默认树开始，通过页面创建两个场景和一个文件夹。场景 A（`668a8e44-dcd6-4642-82bf-ae4e536da7a2`）在一次上传后手动选择两个图层，校验主图层瓦片、附加 GeoJSON 图源和属性行。场景 B（`6b451736-7804-4632-8006-e2b0e6090344`）上传同名 `same.geojson`，实际瓦片和表格标记与 A 不同。切回 A 并刷新后，两项选择、两个图源和活动场景都恢复。底图使用合成图像，业务瓦片和数据来自独立 PostGIS。
- 浏览器分别延迟场景 A 的真实上传响应和树读取响应，在响应返回前切到 B。放行响应后，B 的树、选择和图源仍对应 B。再进入 A 可以看到迟到完成的上传，原两个图层的选择得到保留。
