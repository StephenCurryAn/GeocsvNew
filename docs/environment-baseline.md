# 阶段 0：环境与现有功能基线

验证日期：2026-11-16。工作目录 `D:\GeoCSV`，分支 `agent-refactor`，起点提交 `a08cf2f45ea75c232c0589d4765c038f059a3128`。本文记录本次实际验证范围；其他专业算法和旧实验入口仍需逐项验收。

## 1. 本轮固定了什么

| 层 | 本次环境 | 作用与配置位置 |
| --- | --- | --- |
| 前端 | Node 24.11.0、npm 11.6.1、Vite 7.3.1 | React 工作台；`client/package-lock.json` 固定依赖 |
| 业务服务 | 同一 Node 环境、Express、TypeScript | 3000 端口；`server/.env` 配置数据库与模型 |
| Python 计算 | Python 3.12.13、uv 0.11.26 | 8000 端口；`pyproject.toml` + `uv.lock` 固定依赖 |
| Python GIS | GeoPandas 1.2.0、pandas 2.3.3、NumPy 2.5.5 | 读取空间数据、既有专业计算；算法正确性另行验证 |
| 数据库 | WSL Ubuntu，PostgreSQL 16.15、PostGIS 3.5.3 | 5432 端口；本轮使用专用 `geocsv_baseline_test` |
| 浏览器 | 本机浏览器访问 Vite | `http://127.0.0.1:5173`；`/api` 代理到 Node |

Node 锁文件沿用仓库版本，以 `npm ci` 安装。Python 原来缺少依赖声明，本轮按实际 import 建立可复现环境；这并不代表恢复了作者当年的环境。后续升级应单独更新锁文件并运行回归。

Python 的批量写入使用 `psycopg2.extras.execute_batch`，要求连接产生 psycopg2 cursor。SQLAlchemy 的版本范围约束为 2.0 系列，锁定版本为 2.0.57，避免新默认驱动与旧批量写入代码不兼容。未来升级驱动时需要一起迁移写入路径。

## 2. 准备独立 PostGIS 数据库

本机已有 WSL Ubuntu 和 PostgreSQL 16。本轮启动了已有集群，安装 PostGIS 扩展包，并创建新的测试账号及数据库。没有迁移原项目业务数据。安装时 Ubuntu 仓库同时更新了依赖的 GDAL 等系统包。

在 PowerShell 执行（新 Ubuntu 需要先安装 PostgreSQL 16）：

```powershell
wsl -d Ubuntu -u root -- bash -lc 'apt-get update && apt-get install -y postgresql-16 postgresql-16-postgis-3 postgresql-16-postgis-3-scripts'
wsl -d Ubuntu -u root -- pg_ctlcluster 16 main start

@'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'geocsv_baseline', 'geocsv_baseline_local')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='geocsv_baseline') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', 'geocsv_baseline_test', 'geocsv_baseline')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='geocsv_baseline_test') \gexec
'@ | wsl -d Ubuntu -u postgres -- psql -v ON_ERROR_STOP=1

@'
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SELECT PostGIS_Full_Version();
'@ | wsl -d Ubuntu -u postgres -- psql -d geocsv_baseline_test -v ON_ERROR_STOP=1
```

上述账号密码仅用于本机合成样例。若已有同名角色，这段脚本保留其密码；请使用该角色已有凭据。普通测试账号拥有该数据库，扩展由管理员预先启用。集成测试需要创建 schema 及中断自己的测试连接。

如果 Windows 不能连接 `127.0.0.1:5432`，先检查 `wsl -d Ubuntu -- pg_lsclusters` 和 WSL localhost 转发。本机已验证 Windows 到 WSL 的该地址可用。已有服务占用端口时应选择其他端口并同步配置。

## 3. 安装与配置

```powershell
Set-Location D:\GeoCSV\server
npm ci --no-audit --no-fund
if (!(Test-Path .env)) { Copy-Item .env.example .env }

Set-Location D:\GeoCSV\client
npm ci --no-audit --no-fund

Set-Location D:\GeoCSV\python_engine
uv sync --frozen
uv lock --check
```

本机 uv 位于 `C:\Users\22309\.local\bin\uv.exe`，未加入 PATH 时用该绝对路径调用。uv 按 `.python-version` 选择 Python；首次可能需要下载解释器。

在 `server/.env` 设置以下字段，保留已有密钥和其他配置：

```dotenv
DATABASE_URL=postgresql://geocsv_baseline:geocsv_baseline_local@127.0.0.1:5432/geocsv_baseline_test
PORT=3000
PYTHON_API_URL=http://127.0.0.1:8000/api
```

`client/.env.example` 的 `/api` 默认值已适合本地开发，无需另建前端密钥配置。`.env`、`.venv` 与上传目录均不进入 Git。

初始化已知答案样例：

```powershell
Set-Location D:\GeoCSV\server
$env:TEST_DATABASE_URL='postgresql://geocsv_baseline:geocsv_baseline_local@127.0.0.1:5432/geocsv_baseline_test'
node tests/seed-spatial-demo.cjs
```

脚本先建立基础表；仅在 `file_nodes` 为空时插入样例，已有数据会保留。数据库名必须含 `test` 或 `tmp`。本轮样例为两个文件、七个空间要素：三个街道面和四个设施点。

## 4. 启动与停止

分别打开三个终端，以下进程均以前台方式运行；对应终端 Ctrl+C 可停止。本轮保留了三个本地服务供继续检查。

```powershell
# 终端 1
Set-Location D:\GeoCSV\server
npm run dev

# 终端 2
Set-Location D:\GeoCSV\client
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort

# 终端 3
Set-Location D:\GeoCSV\python_engine
$env:PG_URI='postgresql://geocsv_baseline:geocsv_baseline_local@127.0.0.1:5432/geocsv_baseline_test'
uv run --frozen uvicorn main:app --host 127.0.0.1 --port 8000
```

本轮 Node 验收运行的是构建后的 `node dist/index.js`；修改源码后需要重新构建并重启，日常开发可用上面的 `npm run dev`。前端 5173、Node 3000、Python 8000。Python API 文档位于 `http://127.0.0.1:8000/docs`。

Python `main.py` 直接读取进程环境变量，不自动加载 `.env`。若复制了 `python_engine/.env.example`，需修改 `PG_URI` 并使用 `uv run --frozen uvicorn main:app --env-file .env --host 127.0.0.1 --port 8000`。

`/api/health` 仅是 Node 存活检查；数据库可用性还需检查启动日志和实际查询。`/openapi.json` 证明 Python 服务及接口 Schema 可加载，不能独自证明算法和数据库写入可用。

## 5. 回归命令与真实结果

```powershell
# server 目录
npm run build
npm test
$env:TEST_DATABASE_URL='postgresql://geocsv_baseline:geocsv_baseline_local@127.0.0.1:5432/geocsv_baseline_test'
npm run test:integration

# client 目录
npm run build
npm run test:analysis
npm run test:pipeline
```

| 验收项 | 本轮证据 |
| --- | --- |
| Node 安装与构建 | 两端 `npm ci` 和构建成功；沿用原锁文件 |
| 服务端单元测试 | 11 项通过，含新增的 GIS 全局变量与模型 SDK 兼容性回归 |
| 客户端状态及流测试 | 3 + 6 项通过 |
| 真实 PostGIS 集成测试 | 1 项通过、0 跳过，含边界、重放、数据隔离、取消与连接故障 |
| Python 安装 | `uv sync --frozen`、`uv lock --check` 通过 |
| Python 服务 | `/openapi.json` 返回 200，7 个业务路径（含文档共 11 条应用路由） |
| Python 数据读取 | `_load_vector_layer('demo-districts')` 得到 3 行、EPSG:4326；邻接表为 `[[1],[0],[]]` |
| Python 批量写入兼容性 | 默认驱动为 psycopg2；`execute_batch` 向事务内临时表写入两条 JSONB，读回 score 合计 5，随后回滚；样例库仍为两个文件、七个要素 |
| 排除边界 | 页面表单运行成功，甲乙丙分别 2、1、0 |
| 纳入边界 | 页面表单运行成功，甲乙丙分别 3、2、0 |
| 结果持久化 | 两次运行均可读取 3 个 GeoJSON 要素及完整 CSV；刷新后从历史恢复结果 |
| 地图联动 | 点击甲街道后地图面与图表同步高亮，浏览器未记录 error 级日志 |
| 自然语言规则路径 | “统计每个街道内不同类型的设施数量，排除边界”返回 `ready`、`source: rules`，选择名称和类型字段 |
| 真实模型调用 | DeepSeek 官方 deepseek-flash：鉴权、真实结构化输出与应用接口均通过；返回 `ready`、`source: llm`，字段与边界校验通过 |

集成测试中的 `Connection terminated unexpectedly` 是主动断开测试连接的故障注入日志。测试最终通过且零跳过才是验收依据。

本轮浏览器生成的记录（仅存在于该本地测试库）：

| 边界 | Run ID | Artifact ID |
| --- | --- | --- |
| exclude | `ae877ee2-b735-43c7-ac95-e430aabe18b7` | `a127c302-68bf-4099-80eb-c0bf3444d5fe` |
| include | `1e14ce20-6133-40cf-8302-2eeaaa9befa8` | `16570057-e09b-4b61-ad05-77f59f661b38` |

![刷新恢复后的纳入边界结果及地图高亮](screenshots/environment-baseline-2026-11-16.png)

## 6. 跟着这次运行读代码

```mermaid
sequenceDiagram
    participant UI as SpatialPivotPanel
    participant API as spatialPivot/router.ts
    participant S as spatialPivot/service.ts
    participant DB as PostGIS
    UI->>API: POST /analysis-plans（spec）
    API->>S: plan(spec)
    S->>DB: 读取图层、字段与几何信息
    S-->>UI: 返回校验后的计划
    Note over UI: 用户确认
    UI->>API: POST /runs（spec）
    API->>S: create(spec)
    S->>DB: 固定输入指纹并登记 Run
    API-->>UI: 202 + runId
    S->>DB: 执行空间 SQL，保存 Artifact
    UI->>API: 查询 Run 状态与 Artifact
    API-->>UI: 表格、GeoJSON、CSV
```

1. `client/src/features/analysis/components/SpatialPivotPanel.tsx` 收集目标、关联图层、字段和边界规则，形成 `spec`。这里的参数决定“算什么”。
2. `server/src/modules/spatialPivot/router.ts` 将 HTTP 请求交给业务模块。`plan.ts` 负责约束与 SQL；`datasets.ts` 提供真实图层信息，前端填写或模型猜测的字段都需要再校验。
3. `server/src/modules/spatialPivot/service.ts` 创建并调度 Run，保存输入指纹、状态和结果引用。Run 决定“这一次执行走到了哪里”。
4. `plan.ts` 中的 `ST_ContainsProperly` 排除边界，`ST_Covers` 纳入边界。公共边界点可以匹配两个目标，因此纳入时总匹配数为 5，超过 4 个源点符合当前多重归属定义。
5. Artifact 保存独立结果；`SpatialPivotResult.tsx` 读取它并展示。刷新恢复是重新读取结果，既不要求模型重答，也不重新计算。
6. `server/src/modules/analysisPlanner/service.ts` 在规则/模型草案与上述计划校验之间衔接；`provider.ts` 才是本轮可配置模型的调用点。Python 目前是另一条计算服务路径，空间透视不经过它。

后续 LangChain 将承接模型消息、结构化输出与工具调用；LangGraph 将组织澄清、确认、提交、等待和恢复。两者应复用已经验收的计划、Run、Artifact 接口。阶段 0 尚未安装这两个框架。

学习练习：对照两条 Run，找出 `spec.boundaryPolicy`、`status`、`artifactId` 分别表示什么；解释为什么切换图表可以复用 Artifact，而切换边界规则必须产生新计算。

## 7. DeepSeek 配置与尚未覆盖的能力

新自然语言入口可以使用 DeepSeek 官方密钥，在 `server/.env` 同时设置并重启 Node：

```dotenv
ALIYUN_API_KEY=填写自己的DeepSeek密钥
LLM_BASE_URL=https://api.deepseek.com
LLM_PLANNER_MODEL=deepseek-flash
```

`ALIYUN_API_KEY` 是现有变量名，并不限制这个入口必须使用阿里云。地址和模型名依据 2026-11-16 查阅的 [DeepSeek 官方文档](https://api-docs.deepseek.com/)，今后以账户可用模型为准。密钥留在本地，不写入前端、截图或 Git。旧 `server/src/utils/llmService.ts` 多处硬编码 `deepseek-v3`，本轮没有把所有旧实验入口迁移为可切换供应商。

| 现有能力 | 实现与后续边界 |
| --- | --- |
| 空间透视计数 | PostGIS，已验证本轮已知答案及故障用例 |
| Moran's I / LISA | `python_engine/main.py` 的 NumPy 手写实现；本轮仅验证读取和邻接，统计推断待阶段 2 审计 |
| 地理探测器与滑坡评价 | `main.py` 中 q 值及评分组合；公式、离散化与结果解释待审计 |
| 公园可达性 | `main.py` 中距离和归一化评分；CRS、单位和适用范围待审计 |
| 评分分级 | `mapclassify` 为可选 import，本次未安装；当前代码走备用分位数路径。自然断点与分位数的语义差异需阶段 2 显式处理 |
| 动态注册模型与 exec | 本轮没有注册模型或执行模型生成的代码；进程内 exec 的隔离问题仍在计划中 |

现有前端生产构建仍有约 4.55 MB 主 JS 包（gzip 约 1.38 MB）的体积警告；本轮保留为性能基线。样例库的模型注册表为空，旧面板仍显示“正在同步云端模型库”，其空状态表达待改善。Python 的可选 TestClient 依赖未安装；本轮 HTTP 检查直接访问真实 uvicorn 服务。文件导入、编辑回写、全部旧 AI 入口和专业模型全链路未在本轮全面覆盖，不能据此宣称整个系统均已验收。


## 8. 2026-11-16 补充：在线模型与地图配置

用户在本地配置 DeepSeek 官方凭据后，真实模型验收发现 `fileController.ts` 给 Node 注入了 `window/document`，结合 Node 自带 navigator 触发模型 SDK 的浏览器检测。`server/src/integrations/llm/client.ts` 现在通过 `node:process` 的运行时身份允许该服务端客户端初始化，凭据仍仅由后端读取。新增回归测试先复现失败，修复后服务端 11 项测试及构建通过。

实际请求“请清点示例街道各自内部的设施点，按照类型分别列出数量，排除边界。”返回 `ready`、`source: llm`，目标为 demo-districts/名称，关联为 demo-pois/类型，边界 exclude。此次只生成并校验计划，未自动提交计算。原有算子计算和表单执行沿用前述基线。

地图接入现状已更新：移除影像地址中硬编码的旧 Key 后，进一步按 NeoGIS 方案接入 Protomaps 与天地图后端代理。过渡变量 `VITE_TIANDITU_KEY` 已移除；当前使用前端 `VITE_PROTOMAPS_API_KEY` 和后端 `TIANDITU_SERVER_KEY`。两把 Key 已配置；Protomaps 在线通过，天地图网络连接被重置，尚待在线验收。最新架构、限制与证据见 [地图服务接入记录](map-services.md)。

### NeoGIS 对照与申请清单

本次读取 NeoGIS 前端 origin/main 提交 `525ddbcee201731bb23fe3962506d4136a1899db`，后端提交 `4635f5182d7c254b3b3283e7d789de1e44c7493e`。依据源码而非仅依据阶段计划：

- 前端 `.env.example` 和 `src/domain/map/basemap-style.ts` 使用 `NEXT_PUBLIC_PROTOMAPS_API_KEY`，构造 Protomaps v5 Style JSON。
- `src/domain/map/basemaps/builtin-catalog.ts` 包含 light/white/grayscale/dark/black 五种主题，以及天地图 vec+cva、img+cia 两种组合；中文注记独立成层。
- 后端 `ngis-tile/ngis_tile/basemap_proxy.py` 从 `TIANDITU_SERVER_KEY` 取得凭据，向固定天地图端点请求，向浏览器提供同源瓦片地址。前端只有显式开发模式才支持浏览器直连 Key。
- `ngis-tile/ngis_tile/tiles.py` 用 PostGIS ST_AsMVT 提供业务矢量瓦片，用 rio-tiler 读取 COG；MinIO、Redis 是自部署存储和缓存，不是需要申请地图 Key 的官网服务。

若采用 NeoGIS 的正式架构，当前先准备以下两项：

1. **Protomaps API Key**：打开 https://protomaps.com/ → Hosted API → Account Dashboard（https://protomaps.com/account），按页面完成注册/登录并创建 Key；在该 Key 的允许来源设置中填写开发来源 `http://127.0.0.1:5173` 和 `http://localhost:5173`，部署后加入正式域名。服务使用范围和额度以官网账户为准。官方说明：https://protomaps.com/api 。
2. **天地图服务端 Key**：打开 https://www.tianditu.gov.cn/ → 开发资源 → 控制台（https://console.tianditu.gov.cn/api/key），按提示注册并完成开发者认证；进入应用管理/我的应用，创建 GeoCSV 应用，类型选择“服务端”，按实际用途填写行业与说明，提交后保存 Key。若控制台要求 IP 限制，按实际发起请求的服务器出口 IP 配置，后续更换服务器时更新。控制台字段与认证要求以登录后的页面为准。

官网入口若调整，可从天地图首页的“开发资源”进入。官方节点手册说明注册、认证、创建应用及获取 tk 的流程：https://tianjin.tianditu.gov.cn/static/help/note.html 。

两项配置现已保存并接入：前端 `.env.local` 的 `VITE_PROTOMAPS_API_KEY` 用于 Protomaps 样式，后端 `.env` 的 `TIANDITU_SERVER_KEY` 用于固定天地图 WMTS 代理。不能将 NeoGIS 的 Next.js `NEXT_PUBLIC_*` 名称直接照搬到 Vite 项目。

采用后端代理方案无需另申请浏览器端天地图 Key。底图控制器仅管理自己的图层与数据源，不调用整图 setStyle；切换 Protomaps 时业务图层持续保留。
