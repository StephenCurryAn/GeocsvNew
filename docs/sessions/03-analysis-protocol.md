# 阶段 1 · 分析协议与可靠提交

验收日期 2026-11-16。分支 `codex/01-analysis-protocol`，基线 `4c56763f98b6e140ecb09dfd9707bb8d9dc1c98a`。

| 提交 | 内容 |
| --- | --- |
| `d8ec81557ac93ca57579d8824800274a026b0990` | Run 请求键、数据库唯一索引、冲突响应、前端复用键和断线重试验证 |
| `c1929479f12e58bb04818c175c16d740292e4f49` | 通用分析服务、算子目录、计划持久化、版本迁移、跨语言契约和兼容性验证 |

## 从确认到结果

1. 表单通过 `POST /api/analysis/plans` 固定两份输入指纹。自然语言规划的 `ready` 分支复用同一计划服务。前端确认时发送计划 ID、版本和请求键。
2. [AnalysisService](../../server/src/modules/analysis/service.ts) 在同一事务查请求键、检查计划版本和输入指纹并写入 Run。并发事务由唯一约束裁决。提交已成功但响应丢失时，相同请求键取回已有 Run。
3. [空间透视算子](../../server/src/modules/operators/spatialPivot.ts) 绑定 `plan.ts` 中的空间 SQL。计算事务重新核对输入，再把结果明细、复制的目标几何、Artifact 和 Run 成功状态一起提交。
4. [版本化迁移](../../server/src/modules/analysis/migrations.ts) 对照基线核验已有结构。Run 的新字段可为空，Artifact 格式列有默认值，因此旧路由仍能读写空间透视 v1 结果。

阶段 2 使用 [公共接口和错误约定](../analysis-protocol.md)、[JSON Schema](../contracts/analysis.schema.json) 和 [样例](../contracts/analysis.examples.json)。同一业务版本内使用新键可以主动重算。表单保留的请求键与当前待确认计划一起驻留在页面内存。数据库事务保留的请求键供 API 调用方跨连接重试。

## 验收结果

使用 WSL PostgreSQL 16.15 + PostGIS 3.5，独立数据库 `geocsv_phase1_test`。集成测试使用随机命名的独立 schema，旧库用基线 DDL 和合成的历史记录重建。浏览器使用隔离前后端进程和合成三面四点数据。

| 检查 | 实际结果 |
| --- | --- |
| 服务端构建与单元测试 | 构建通过，20 项通过 |
| 真实 PostGIS 集成测试 | 4 项通过、0 跳过。覆盖同键并发、响应丢失重试、同键不同内容、新键重算、确认和排队时源数据变化、取消与数据库连接中断 |
| 数据库迁移 | 新库及旧结构副本应用版本 1–3，首批请求键记录保留，重复初始化台账不变，结构不符时回滚。旧 Run 和 Artifact 可读取、分页、查看 GeoJSON 和导出 CSV |
| 旧版回退读取 | 从 `4c56763` 提取并启动旧分析路由，对浏览器生成的两条新 Run 读取历史和元数据，并取得 3 个 GeoJSON 要素与 3 条 CSV 数据行 |
| 前端 | 生产构建与本次修改文件的 ESLint 通过。运行历史测试 3 项，流协议测试 6 项通过 |
| 跨语言契约 | TypeScript HTTP 集成用同组样例核对请求和响应。Python 校验通过 10 个契约样例及 2 个无效输入 |
| 浏览器 | 自然语言规则入口得到 2、1、0，手工表单纳入边界得到 3、2、0 |

浏览器写入的两组记录保留在独立测试库。

| 入口 | Plan ID | Run ID | Artifact ID |
| --- | --- | --- | --- |
| 自然语言，排除边界 | `57ce72ba-2a02-4a8c-a21d-0ad7c62d6249` | `bcb8a2bc-838d-4ef7-bacb-ed858b22d2d9` | `c90f3026-4687-4f68-bf25-195b06e81cb2` |
| 表单，纳入边界 | `6ce4dc46-530c-420e-b9fd-932bf61a0804` | `8b5c7057-8558-4066-8610-32e620afddd5` | `07bd7f70-ee3b-48ec-847a-676e3616c6fc` |

最后一次 PostGIS 测试中，同键并发返回 Run `cac67a6f-5ad4-47e8-82a2-90bbd8738f8e`。使用新键主动重算，服务端提交后断开 HTTP 响应，客户端以原键取回 Run `f90efabb-05bc-40d6-adc6-0f0ee208d7b8`。两次执行均得到 2、1、0。测试使用的随机 schema 已清理。日志中的数据库连接中断来自故障注入。

### 复现命令

| 目录 | 命令 |
| --- | --- |
| `server` | `npm run build`、`npm test`、设置专用库的 `TEST_DATABASE_URL` 后执行 `npm run test:integration` |
| `client` | `npm run build`、`npm run test:analysis`、`npm run test:pipeline` |
| 根目录 | `uv run --no-project --with jsonschema python server/tests/validate_analysis_contract.py`、`git diff --check` |

正式库迁移和在线模型调用留待独立验收。阶段 2 仍需实现 Python Worker 的执行生命周期、不可变输入快照和新结果格式。前端构建保留既有大包提示。
