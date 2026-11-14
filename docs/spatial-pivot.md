# 空间透视首条流程

## 业务范围

算子 `spatial_pivot@1` 对每个行政区面统计符合空间关系的点要素数量，可按点的类别拆列。目标与关联要素身份使用 `spatial_features.id`，标签字段只用于显示；重复业务 ID 或名称不会合并目标。

- 排除边界使用 `ST_ContainsProperly`，纳入边界使用 `ST_Covers`。
- 重叠目标允许多重归属，每个目标内按关联要素数据库主键去重。
- MultiPoint 按一个要素计数，整体几何必须满足空间关系，不拆为多个独立点。
- 无匹配目标保留为 0；完全空的关联数据集也可以产生全零结果。
- 类别空值、空字符串和真实名称独立表达。输出列使用生成的 `c0/c1/...` 键，避免类别名称覆盖系统字段。
- 拒绝非面目标、非点关联、无效几何、空几何、非 EPSG:4326 数据及不存在的字段。
- 仅做拓扑包含统计，不涉及距离或面积，也不使用 Web Mercator 作为测量坐标系。

## 模块职责

| 模块 | 内容 |
| --- | --- |
| `plan.ts` | 运行时协议校验、固定版本算子、参数化空间查询、矩阵格式化 |
| `datasets.ts` | 现有数据适配、全字段摘要、几何质量和内容指纹 |
| `service.ts` | 分析定义、任务提交、单并发调度、取消、恢复和事务提交 |
| `schema.ts` | 增量建表，不改动原有文件或要素表 |
| `router.ts` | HTTP 适配、分页、结果 GeoJSON 和 CSV |
| `SpatialPivotPanel.tsx` | 参数、计划检查、任务状态、取消及运行历史 |
| `SpatialPivotResult.tsx` | 当前页图表、统计明细、专题地图与选中联动 |

首条链路直接使用 PostGIS。Node 异步调度 SQL，不在应用进程内执行 GIS 几何算法；Python 引擎继续通过旧入口服务专业模型。后续迁移专业模型时再接入独立 Python Worker。

## 计划协议

```json
{
  "schemaVersion": 1,
  "kind": "spatial_pivot",
  "operatorVersion": 1,
  "target": { "fileId": "districts", "labelField": "名称" },
  "join": { "fileId": "pois", "categoryField": "类型" },
  "boundaryPolicy": "exclude"
}
```

两个字段参数可为 null。不支持的参数和协议版本会明确拒绝，避免把缓冲、筛选或求和请求悄悄当计数执行。本版本固定逐目标要素计数，尚未开放完整六要素协议中的任意行维度和数值聚合。

## API

路径均以 `/api` 开头，除 GeoJSON 和 CSV 外使用 `{code,data}` 成功响应。

| 方法与路径 | 作用 |
| --- | --- |
| `GET /datasets?ids=a,b` | 所选图层元数据与完整字段集合 |
| `GET /operators/spatial-pivot` | 固定算子能力 |
| `POST /analysis-plans` | 校验并返回规范化计划 |
| `POST /runs`，body 为 `{spec}` | 保存提交时指纹，返回 202 与排队记录 |
| `GET /runs?limit=20` | 最近运行 |
| `GET /runs/:id` | 状态、输入指纹、结果或错误 |
| `POST /runs/:id/cancel` | 请求取消 |
| `POST /runs/:id/replay` | 按历史参数和指纹重放，数据改变时失败 |
| `GET /artifacts/:id` | 结果元数据、统计列与摘要 |
| `GET /artifacts/:id/rows?page=1&pageSize=20` | 结果分页，单页上限 500 |
| `GET /artifacts/:id/geojson` | 裸 FeatureCollection，最多 5,000 个目标 |
| `GET /artifacts/:id/export.csv` | 分批导出完整结果，中文 BOM 与公式内容转义 |

## 数据一致性与任务状态

提交时在 repeatable-read 事务中检查数据并保存内容指纹，排队期间数据变化会拒绝执行。计算事务同样使用 repeatable-read，指纹、统计和结果几何来自一致的读取视图。

指纹检测变更，不是历史输入备份。旧结果可以独立查看，但只有源数据未改变时才能重放旧计算；完整 DatasetVersion 历史快照仍待实现。

任务用 PostgreSQL advisory lock 保证单并发，状态为 queued、running、succeeded、failed 或 cancelled。每条计算 SQL 默认超时 120 秒。取消排队任务直接进入终态；取消运行任务会请求中断对应 SQL，并阻止结果成功提交。连接恢复后会回收中断任务；浏览器断开不等于计算取消。

Artifact 元数据、结果明细、目标几何快照与成功状态在同一事务提交。取消、失败或连接中断会回滚半成品。计算不回写源数据，展示和下载只读取保存的结果。

新增四张表：`geocsv_analysis_definitions`、`geocsv_analysis_runs`、`geocsv_analysis_artifacts`、`geocsv_analysis_artifact_rows`。停用时可移除新路由，无需删除源表。

## 验证与样例

真实 PostGIS 集成测试覆盖相邻行政区、边界点、同名目标、重复业务 ID、零匹配、空数据集、空类别、特殊类别名、带单引号字段与注入字符串。同时验证输入不被改写、历史重放、排队期间改数据、取消计算、强制断开计算连接和后续恢复。

浏览器验收使用独立的 `geocsv_refactor_ui_test` 数据库。甲、乙、丙三个街道与四个设施，排除边界时计数为 2、1、0，纳入边界时为 3、2、0。`server/tests/seed-spatial-demo.cjs` 仅允许 test/tmp 命名数据库，有已有文件时不会继续写入。

## 当前边界

本条链路已接入算子优先的自然语言规划，接口为 `POST /analysis-plans/natural-language`；请求只包含 userPrompt、fileIds 和可选 contextRunId。待确认计划通过同一 `/runs` 执行，换图追问只读取已有 Artifact。详见 [接入记录](ai-refactor-progress.md)。原有 AI 实验模式、专业模型、网格和公式入口保留，尚未全部迁入新协议。旧 Python 动态执行也尚未成为不可信代码隔离环境。

结果地图是数量受限的 GeoJSON 预览，尚未统一为版本化 MVT。图表明确显示当前页，切换视图和恢复历史不创建新任务。任务调度仍与 Node API 同进程，重计算在 PostGIS 中执行，部署按本地单用户设计。
