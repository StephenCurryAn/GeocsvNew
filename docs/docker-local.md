# 用 Docker 运行 GeoCSV

这套 Compose 配置用于本机开发和验收。它启动 Web 前端、Express、Python/FastAPI 和 PostgreSQL 16 + PostGIS，并使用独立的数据库和上传存储。Docker 数据库首次启动时应用现有的初始化 SQL。另有可选的自然语言规划服务。正式部署和备份恢复按阶段 7 的计划验收。

在 Docker Desktop 启动后，从包含 `compose.yaml` 的 GeoCSV 工作目录运行：

```powershell
docker compose up --build --detach --wait
docker compose ps
```

打开 [Docker 版 GeoCSV](http://127.0.0.1:8080/)，从「资源管理」上传资料。除了本机 Web 入口，数据库、Python 和 Node 端口均由容器内部访问。Nginx 同源转发 `/api` 和瓦片请求，并保留流式响应。数据库、上传文件和旧模型文件分别存入 Docker 卷。停止和重新启动 Compose 后会保留这些数据。

前端和后端镜像从仓库中的锁文件安装和构建。修改源码后重新执行带 `--build` 的启动命令。需要热更新时可继续使用现有 Vite 开发方式。

现有 Windows/WSL 开发版仍使用 5173、3000、8000 和现有 PostgreSQL。它与 Docker 版各有自己的数据库，旧版数据不会自动出现在 Docker 版。如 8080 已占用，可先设 `$env:GEOCSV_WEB_PORT = '8088'`，再执行启动命令。

Compose 使用 BuildKit 构建依赖镜像，需 Docker Compose 2.22 或更新版本。`server` 复用 `python` 服务的镜像层，使用同一位置的 CPython、`uv.lock`、虚拟环境和 Worker 代码。FastAPI 仍由独立的 `python` 服务提供。 [Docker Compose 依赖镜像说明](https://docs.docker.com/compose/how-tos/dependent-images/)

`server` 以 UID 1000 运行。Node 启动本地 Python 子进程，专用命名卷 `analysis-worker` 仅挂载给 `server`，目录权限为 `0700`。卷保存 Worker 已发布而尚待归档的结果。替换容器时保留此卷和数据库卷，调度器重启后可按 Run ID 继续归档。`init: true` 明确由 Docker 回收子进程。

## 可选配置

业务图层和现有确定性分析功能无需配置 Key。如需加载默认的 Protomaps light 底图或使用外部模型，可以在工作目录创建被 Git 忽略的 `.env`，参照 [地图接入](map-services.md) 和 [模型配置](environment-baseline.md) 设置变量。

- `VITE_PROTOMAPS_API_KEY` 是浏览器使用的 Key，修改后执行 `docker compose up --build --detach --wait` 重新构建前端，并在供应商控制台允许实际使用的本机 Web 地址。
- `TIANDITU_SERVER_KEY`、`ALIYUN_API_KEY`、`LLM_BASE_URL` 和 `LLM_PLANNER_MODEL` 由 Compose 在运行时传给服务端。启动时重新应用配置。Docker 版与本机 Node 版分别读取其配置。

### 启用自然语言规划

在工作目录被忽略的 `.env` 或传给 Compose 的本地环境文件中，设置 `AGENT_SERVICE_TOKEN` 为随机生成的共享凭据，并设置模型的 `ALIYUN_API_KEY`、`LLM_BASE_URL` 和 `LLM_PLANNER_MODEL`。DeepSeek 官方接口使用 `https://api.deepseek.com` 和 `deepseek-flash`。模型若需要代理，可设置规划容器可达的 `LLM_PROXY_URL`。然后启用 `planner` profile。

```powershell
$env:GEOCSV_WEB_PORT = '8083'
docker compose -p geocsv-phase3 --profile planner up --build --detach --wait
```

规划容器使用专用 Compose 网络，只有 Express 连接该网络并携带共享凭据。浏览器继续通过 Web 的同源 API 请求。普通启动可省略 `planner` profile，空间透视表单和规则规划仍可用。旧自然语言路由的模型回退也使用该 profile。规划验收见 [阶段 03](sessions/03-langchain-planner.md)。

## 排查与停机

```powershell
docker compose logs --tail 100
docker compose stop
```

如果 Docker Desktop 报 `dockerInference` 或 `docker-secrets-engine/engine.sock` 无法删除，先查看 Docker Desktop 的启动日志。这次修复将两个只含运行时套接字的目录改名留为备份后重启 Docker Desktop。[Docker Windows 启动问题记录](https://github.com/docker/desktop-feedback/issues/460)

恢复或重新构建时使用同一个 Compose 项目。上传的数据保存在 Docker 卷内，删除卷会清除对应的数据。

## Moran/LISA 的独立 Compose 验收

在仓库根目录执行。`geocsv-moran-check` 使用独立的数据库、上传和 Worker 卷，Nginx 入口为 `127.0.0.1:8082`。首次运行时 Compose 创建这些卷。

```powershell
$env:GEOCSV_WEB_PORT = '8082'
docker compose -p geocsv-moran-check up --build --detach --wait
$receipt = Join-Path $PWD 'python_engine/.tmp/docker-moran-check/receipt.json'
New-Item -ItemType Directory -Force (Split-Path $receipt) | Out-Null
$report = node server/tests/moranDocker.cjs
if ($LASTEXITCODE -ne 0) { throw 'Moran/LISA 验收失败' }
$report | Set-Content -Encoding utf8 $receipt
docker compose -p geocsv-moran-check up --detach --no-build --force-recreate --wait
node server/tests/moranDocker.cjs $receipt
```

脚本通过 Nginx 创建场景并上传四面样例和点数据，从 Plan 提交 Queen、Rook 和空间计数。提供已有报告时，脚本经相同入口复读原 Run、Artifact、分页行、GeoJSON 和 CSV。四面样例及本轮容器验收记录见 [阶段 02](sessions/02-python-execution.md)。

## 本机验证记录

2026-11-16，在 Docker Engine 29.6.1 上构建并启动四个容器，健康检查全部通过。数据库实测为 PostgreSQL 16.16、PostGIS 3.7。通过 Web 入口上传三块街道面和四个设施点，排除边界的空间透视结果为 `2、1、0`，分页、GeoJSON 与 CSV 都可读取。另从 Node 容器访问 Python 的旧空间自相关端点，确认 Python 可读取同一数据库中的三条面记录并完成计算。完整停止并再次启动 GeoCSV 容器后，仍可读取上传数据和原任务结果，两份上传文件也保存在卷中。
