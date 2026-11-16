# 融合地理模型服务的在线数据透视分析平台

GeoCSV 提供地理数据导入、属性表编辑、地图、统计透视、模型公式和 AI 辅助分析。首轮重构增加了不依赖 AI 或 Python 的“行政区内分类 POI 统计”：检查分析计划，提交任务，查看独立保存的表格、图表与地图结果。原有网格、模型和 AI 入口保留，逐步迁移。

## 技术与目录

前端使用 React 18、TypeScript、Vite、Ant Design、Zustand、AG Grid、MapLibre 和 ECharts；应用服务使用 Node、Express 与 PostGIS；原有计算引擎为 Python、FastAPI 和 GeoPandas。

```text
client/src/features/analysis/        原有分析工具与新增空间透视界面
client/src/services/                 API、流解析和数据服务
server/src/modules/spatialPivot/    分析协议、数据校验、任务、结果与接口
server/src/modules/attributePivot.ts 从旧控制器迁出的属性透视
server/src/controllers/             待逐步迁移的原有接口
server/src/config/init.sql          原有数据表与空间索引
server/tests/                       单元测试与真实 PostGIS 集成测试
python_engine/                      原有模型计算服务
```

## 本地运行

本轮验证使用 Node 24.11.0、Python 3.12.13 和独立 PostGIS 测试库。完整安装、样例数据、启动步骤与验收证据见 [环境与功能基线](docs/environment-baseline.md)。

先准备 PostgreSQL/PostGIS。新数据库执行 `server/src/config/init.sql`；已有数据库不要重建或清空。数据库账号需有增量建表权限，首次使用新接口时会创建 `geocsv_analysis_*` 表。

在 `server` 和 `client` 目录分别运行：

```powershell
npm ci
npm run dev
```

后端默认连接 `127.0.0.1:5432` 的 `geocsv` 数据库，默认用户名密码均为 `geocsv`。通过 `DATABASE_URL` 或 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` 覆盖。变量示例见 [server/.env.example](server/.env.example)，有现成 `.env` 时保留它，不要覆盖。

打开 Vite 显示的地址。开发环境 `/api` 代理到本地 3000 端口；生产环境需要同源反向代理，或在构建时设置 `VITE_API_BASE_URL`。

普通透视与新增空间透视只需 Node 和 PostGIS。原有 AI 功能需要 `ALIYUN_API_KEY`；原有 Python 模型需启动 `python_engine/main.py`，通过 `PG_URI` 配置数据库，Node 通过 `PYTHON_API_URL` 调用。

Python 依赖使用 `python_engine/pyproject.toml` 和 `uv.lock`。在 `python_engine` 目录运行 `uv sync --frozen`，设置 `PG_URI`，再运行 `uv run --frozen uvicorn main:app --host 127.0.0.1 --port 8000`。示例见 `python_engine/.env.example`；`main.py` 不自动读取 `.env`，使用文件时需在 uvicorn 命令中显式增加 `--env-file .env`。

## 空间透视操作

1. 在资源管理选择面图层与点图层。
2. 打开“分析工具 → 空间透视分析”。
3. 选择目标、关联图层、可选标签与分类字段，明确是否纳入边界点。
4. 检查分析计划，确认后开始运行。
5. 查看结果表、当前页图表、地图联动及完整 CSV。
6. 刷新页面后从最近运行恢复结果，无需重新计算或选择源文件。

同名目标不合并，无匹配目标保留为 0，分析不回写源图层。结果地图预览上限为 5,000 个目标，表格和 CSV 不受该预览限制。

## 验证

当前验证环境为 Node 24。前端流测试使用 Node 的 TypeScript 类型擦除能力。

```powershell
# server 目录
npm test
npm run typecheck
npm run build

# client 目录
npm run test:analysis
npm run test:pipeline
npm run build
```

真实空间集成测试需要独立的、名称含 test 或 tmp 的 PostGIS 数据库：

```powershell
# server 目录；换成自己的测试数据库地址
$env:TEST_DATABASE_URL = 'postgresql://postgres@127.0.0.1:55439/geocsv_refactor_test'
npm run test:integration
```

测试创建随机 schema，完成后只清理自己的 schema，不使用应用的 `DATABASE_URL`。测试账号需要建 schema、启用 PostGIS 和中断自身测试连接的权限。

## 自然语言分析

右侧 GeoPivot 默认进入“自然语言（算子优先）”。勾选面与点图层后，可以输入“统计每个街道内不同类型的设施数量，排除边界”，检查计划后执行已验证算子。常见计数表述走规则路径；其他表述使用配置的模型生成结构化草案，并校验真实图层、字段和算子能力。

完成分析后可追问“把上次结果换成饼图”，只读取既有结果。原有三种模式保留在“原有实验流程”中。模型连接不可用时会明确提示，不会自动执行生成代码。模型名称可通过 `LLM_PLANNER_MODEL` 配置，代理通过 `LLM_PROXY_URL` 显式配置，修改服务环境变量后需重启后端。

## 文档

- [首轮重构实施记录](docs/refactor-progress.md)
- [环境与功能基线、代码学习路线](docs/environment-baseline.md)
- [使用 Docker Compose 启动本地 GeoCSV](docs/docker-local.md)
- [Protomaps 与天地图接入、配置和学习记录](docs/map-services.md)
- [Agent 重构实施与学习计划](docs/agent-refactor-plan.md)
- [并行会话、分支命名与合入约定](docs/parallel-development.md)
- [空间透视协议与运行边界](docs/spatial-pivot.md)
- [架构诊断与后续设计](docs/architecture-review.md)
- [自然语言接入与验证边界](docs/ai-refactor-progress.md)
