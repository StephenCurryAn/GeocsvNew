# GeoCSV 分析协议 v1

[JSON Schema](contracts/analysis.schema.json) 定义公共载荷，[跨语言样例](contracts/analysis.examples.json) 包含算子、空间透视参数、确认请求、Run、Artifact、分页和错误。成功 JSON 响应使用 `{ code, data }`，其中 `code` 与 HTTP 状态一致。下表路径以 `/api` 为前缀。

| 方法与路径 | 请求与成功状态 |
| --- | --- |
| `GET /operators` | 200，`Operator[]` |
| `POST /analysis/plans` | `{ spec }`，201，返回待确认 `Plan` |
| `GET /analysis/plans/:id` | 200，返回已保存的 `Plan` |
| `POST /scenes/:sceneId/analysis/plans/natural-language` | 200，当前场景自然语言规划、澄清、不支持或复用空间透视结果 |
| `POST /runs` | `{ planId, planVersion }`，需带 `Idempotency-Key`，202 |
| `POST /runs` | 兼容 `{ spec }`，202，为本次提交登记隐式确认计划。可带请求键 |
| `GET /runs/:id`、`GET /runs?limit=20&operator=spatial_pivot` | 200，单条 `Run` 或按创建时间倒序的历史列表。省略 `operator` 返回全部算子的记录 |
| `POST /runs/:id/cancel` | 200，返回最新的 `Run` |
| `POST /runs/:id/replay` | 可带请求键，202。Moran/LISA 重用保留期内的原输入快照 |
| `GET /artifacts/:id` | 200，返回 `Artifact` 元数据 |

Moran/LISA (`spatial_autocorrelation@2`) 使用同一 Plan、Run 和 Artifact 路径。`moran_lisa` v1 的 `summary` 为 `MoranLisaSummary`，`/artifacts/:id/rows` 为 `MoranLisaPage`，地图预览和 CSV 沿用相同地址。逐要素结果可空的 `pValue` 或 `quadrant` 分别表示未检验或无象限。空间透视沿用 [分页、GeoJSON 与 CSV](spatial-pivot.md) 地址和内容。旧 `GET /operators/spatial-pivot` 仍返回原能力对象。旧 `POST /analysis-plans` 仍以裸 `SpatialPivotSpec` 校验并返回规范化参数，采用这条路径的旧客户端在提交时固定输入。旧自然语言路由在 `ready` 响应额外返回 `plan`，其他分支沿用原结构。

场景规划请求接受 `{ userPrompt, fileIds, contextRunId?, contextPlanId? }`。有勾选时只使用所选场景内图层。未勾选时可点名使用当前场景中的图层。`contextRunId` 用于同场景空间透视结果复用。`contextPlanId` 可为“同一图层”提供上一份 Moran/LISA 计划的目标图层，服务端重新校验图层归属。`ready` 响应新增 `confirmationStatus: "pending_confirmation"`，返回已验证并保存的 `plan`（协议状态为 `validated`，`confirmedAt` 为 `null`）。规划与读取计划均不创建 Run。

`GET /operators` 可读取每个版本的能力说明、别名、输入角色和字段类型。`parameterSchema` 引用完整 Plan Spec，`planningParameters` 描述模型可以识别的显式参数和服务端默认值。Express 按场景和角色构建候选，再将私有草案 `{ operator, inputs, parameters }` 交给选中的注册项转换为现有 Spec。`inputs` 使用单次请求内的图层引用，`parameters` 按用户需求填写。

## 阶段 2 接线字段

| 对象 | 字段与使用约定 |
| --- | --- |
| Operator | `id` + `version` 共同选择算子，`executor` 标识实现，`inputs` 按角色列出几何约束，`parameterSchema` 指向本协议文件内的参数定义，`output` 提供 `format` 与 `schemaVersion` |
| Spec | `schemaVersion`、`kind`、`operatorVersion` 为固定头部。各算子负责解析自己的参数并输出稳定的键顺序，供规范参数 SHA-256 与提交摘要使用 |
| Plan | `id`、`version`、`operator`、`spec`、`specHash`、`inputVersions`、`status`、`createdAt`、`confirmedAt`。当前版本号为 1，重新校验生成新的 Plan ID。首次接受确认与创建 Run 在同一事务生效 |
| Run | `id`、`definitionId`、`planId`、`operator`、`spec`、`inputVersions`、`status`、`artifactId`、`error`、`errorCode`、`createdAt`、`completedAt`。历史 Run 的 `planId` 和 `errorCode` 可以为 null，部分旧记录的 `inputVersions` 也可以为 null |
| Artifact | `id`、`runId`、`operator`、`schemaVersion`、`format`、`spec`、`columns`、`totalRows`、`summary`。按 `format` 与 `schemaVersion` 选择结果读取方式。空间透视为 `spatial_counts` v1，`counts`、`total` 是整数，几何来自入库时复制的目标要素 |
| DatasetVersion | `inputVersions` 用角色名映射到 `{ fileId, count, fingerprint }`。空间透视使用 `target`、`join`，指纹覆盖有序要素 ID、几何与属性，作为不透明字符串比较 |

Operator 的调度入口在 `server/src/modules/operators/registry.ts`。`prepare` 解析参数并绑定 PostGIS 的 `validate`、`fingerprint` 和 `execute`，或 Python 的 `capture` 和 `execute`。公共服务负责排队、取消和终态，Artifact 与 Run 成功状态在同一事务提交。Python 使用 Run ID 作为执行 ID，读取提交时固定的快照，发布结果后由 Node 核对执行身份和版本并归档。

### 重试和版本变化

- 键允许 1–128 个 ASCII 字母、数字或 `. _ ~ -`。数据库按服务端访问主体、操作范围、键唯一。当前单用户主体为 `local`，提交范围为 `runs:create`，历史重放使用 `runs:replay:<原 Run ID>`。
- 同键同内容返回 202 和已有 Run，状态可能随执行推进。同键不同内容返回 409。键随 Run 提交成功后才占用。已提交请求的重试优先按键返回历史 Run，期间发生的数据变化不影响取回该 Run。
- 前端两种入口对同一份待确认计划复用内存中的键。界面退出或刷新后，可从运行历史找回已经接受的任务。主动重算使用新键。API 允许对同一计划用新键重算，每次都会重新核对输入。
- 确认前发现源数据版本变化时，重新调用计划接口并审阅新计划。空间透视在执行前再次核对数据版本。Moran/LISA 确认 Run 时固定快照，源图层随后更新也可执行和重放。输入指纹是快照实际字节的 SHA-256，包含有序要素 ID、WKB、目标字段的原始值与 CRS。

| HTTP 或 Run 终态 | `errorCode` | 含义 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 缺少确认键、请求键格式错误、无效 ID 或版本请求 |
| 400 | `INVALID_SPEC` | 参数结构、字段类型、协议版本或算子语义无效 |
| 400 | `UNSUPPORTED_OPERATOR` | 算子 ID 或版本未注册 |
| 400 | `DATASET_NOT_FOUND`、`UNKNOWN_FIELD`、`INVALID_GEOMETRY` | 图层不存在、属性字段不存在或几何校验失败 |
| 404 | `PLAN_NOT_FOUND` | 计划不存在 |
| 409 | `PLAN_VERSION_CONFLICT` | 请求的计划版本与持久化版本不同 |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | 请求键已关联不同请求 |
| 409 或 `failed` | `INPUT_VERSION_CHANGED` | 确认前或排队期间的输入版本发生变化 |
| 410 或 `failed` | `INPUT_SNAPSHOT_EXPIRED` | Moran/LISA 的历史输入快照已过七天保留期或内容不可用 |
| 429、502、503、504 | `PLANNER_RATE_LIMITED`、`PLANNER_INVALID_RESPONSE`、`PLANNER_UNAVAILABLE`、`PLANNER_TIMEOUT` | 模型限流、结构化响应无效、服务不可用或调用超时 |
| `failed` | `EXECUTION_TIMEOUT` | Python 子进程超过执行时限 |
| `failed` | `WORKER_INTERRUPTED`、`EXECUTION_FAILED` | 执行连接中断或其他计算错误 |

### 工具输入练习

把“按类型统计街道内设施数量，排除边界”表达为 `CreatePlan.spec`，令其参数引用 `#/$defs/SpatialPivotSpec`。例子中的 `target.fileId` 和 `join.fileId` 标识图层，`target.labelField` 决定展示名称，`join.categoryField` 决定计数分列，`boundaryPolicy` 决定空间谓词。工具只产生计划，由调用方在确认后提交 Run。

1. 解析器检查字段类型、未知键、边界枚举。多传 `unknown` 字段会在 `parseSpatialPivotSpec` 被拒绝。
2. `readDataset` 从数据库查图层与字段。不存在的图层返回 `DATASET_NOT_FOUND`，拼错类别属性返回 `UNKNOWN_FIELD`。
3. `validateDatasets` 检查面与点的角色、几何质量和坐标系。将两个图层的几何角色交换会返回 `INVALID_GEOMETRY`。
4. 算子 ID 与版本由 `requireOperator` 选择，未知算子在读取数据前返回 `UNSUPPORTED_OPERATOR`。

## 数据库迁移

`server/src/modules/analysis/migrations.ts` 由分析模块初始化调用。迁移使用 PostgreSQL 事务级锁串行化，`geocsv_analysis_migrations` 记录已应用版本。每条迁移与其版本登记共同提交，出错时回滚。

1. 版本 1 创建四张空间透视表。发现现有分析表时，先用同一份旧 DDL 的参考结构比对列、默认值及主键、外键和检查约束，再登记基线。部分存在或不匹配时报告错误。
2. 版本 2 增加请求键与摘要、唯一索引和字段完整性约束。第一批已存在的四个字段与索引会被校验并保留。
3. 版本 3 新增计划表、Run 的可空计划引用和错误码，并为 Artifact 增加带默认值的格式和版本。原结果行无需改写。
4. 版本 4 新增 Python 输入快照与 `moran_lisa` 逐要素表，Run 通过可空引用关联快照。

发布时先更新服务端，再更新两种计划入口的前端。回退到空间透视旧版时，可保留新增表和列，旧 INSERT 列表与结果读取仍兼容当前格式。若后续阶段写入其他 Artifact 格式，应在回退前核对旧读取器的支持范围。
