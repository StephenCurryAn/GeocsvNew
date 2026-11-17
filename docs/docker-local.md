# 用 Docker 运行 GeoCSV

这套 Compose 配置用于本机开发和验收。它启动 Web 前端、Express、Python/FastAPI 和 PostgreSQL 16 + PostGIS，并使用独立的数据库和上传存储。Docker 数据库首次启动时应用现有的初始化 SQL。另有可选的自然语言规划服务。旧库升级、备份及恢复的实测步骤见[阶段 07 验收记录](sessions/07-deployment.md)。

本机开发、联调和验收共用 Docker Compose 项目 `geocsv-local`。同一套服务一次运行一个分支或集成版本。当前工作台继续使用端口 8089，恢复后的卷名和环境变量分别由仓库根目录下的 `.tmp/geocsv-local.compose.yaml` 和 `.tmp/geocsv-local.env` 管理。两个本地文件由 Git 忽略。

在 Docker Desktop 启动后，从要运行的分支工作目录执行以下命令。切换版本时沿用同一项目和两个本地配置文件。

```powershell
$geoLocal = @('-p', 'geocsv-local', '--profile', 'planner', '-f', 'compose.yaml',
    '-f', 'D:/GeoCSV/.tmp/geocsv-local.compose.yaml', '--env-file', 'D:/GeoCSV/.tmp/geocsv-local.env')
docker compose @geoLocal up --build --detach --wait
docker compose @geoLocal ps
```

打开 [Docker 版 GeoCSV](http://localhost:8089/)，从「资源管理」上传资料。只有 Web 端口对本机开放，数据库、Python、Agent 和 Node 通过容器网络通信。Nginx 同源转发 `/api` 和瓦片请求并保留流式响应。数据库、上传文件、模型文件和 Agent 检查点各自保存在 Docker 卷中，容器可以按同一配置重建。

前端和后端镜像从仓库中的锁文件安装和构建。修改源码后重新执行带 `--build` 的启动命令。

在另一台电脑首次启动空工作台时，执行 `docker compose -p geocsv-local --profile planner up --build --detach --wait` 可使用默认卷和端口 8080。需恢复现有工作台时，先按下文校验备份并选择新卷。

Compose 使用 BuildKit 构建依赖镜像，需 Docker Compose 2.22 或更新版本。`server` 复用 `python` 服务的镜像层，使用同一位置的 CPython、`uv.lock`、虚拟环境和 Worker 代码。FastAPI 仍由独立的 `python` 服务提供。 [Docker Compose 依赖镜像说明](https://docs.docker.com/compose/how-tos/dependent-images/)

`server` 以 UID 1000 运行。Node 启动本地 Python 子进程，专用命名卷 `analysis-worker` 仅挂载给 `server`，目录权限为 `0700`。卷保存 Worker 已发布而尚待归档的结果。替换容器时保留此卷和数据库卷，调度器重启后可按 Run ID 继续归档。`init: true` 明确由 Docker 回收子进程。

## 可选配置

业务图层和现有确定性分析功能无需配置 Key。如需加载默认的 Protomaps light 底图或使用外部模型，可以在工作目录创建被 Git 忽略的 `.env`，参照 [地图接入](map-services.md) 和 [模型配置](environment-baseline.md) 设置变量。

- `VITE_PROTOMAPS_API_KEY` 是浏览器使用的 Key，修改后用上面的共享配置重新构建前端，并在供应商控制台允许实际使用的本机 Web 地址。
- `TIANDITU_SERVER_KEY`、`ALIYUN_API_KEY`、`LLM_BASE_URL` 和 `LLM_PLANNER_MODEL` 由 Compose 在运行时传给服务端。启动时重新应用配置。Docker 版与本机 Node 版分别读取其配置。

### 启用自然语言规划

在工作目录被忽略的 `.env` 或传给 Compose 的本地环境文件中，设置 `AGENT_SERVICE_TOKEN` 为随机生成的共享凭据，并设置模型的 `ALIYUN_API_KEY`、`LLM_BASE_URL` 和 `LLM_PLANNER_MODEL`。DeepSeek 官方接口使用 `https://api.deepseek.com` 和 `deepseek-flash`。模型若需要代理，可设置规划容器可达的 `LLM_PROXY_URL`。然后启用 `planner` profile。

规划容器使用专用 Compose 网络，只有 Express 连接该网络并携带共享凭据。浏览器继续通过 Web 的同源 API 请求。普通启动可省略 `planner` profile，空间透视表单和规则规划仍可用。旧自然语言路由的模型回退也使用该 profile。规划验收见 [阶段 03](sessions/03-langchain-planner.md)。

## 排查与停机

```powershell
docker compose @geoLocal logs --tail 100
docker compose @geoLocal stop
```

如果 Docker Desktop 报 `dockerInference` 或 `docker-secrets-engine/engine.sock` 无法删除，先查看 Docker Desktop 的启动日志。这次修复将两个只含运行时套接字的目录改名留为备份后重启 Docker Desktop。[Docker Windows 启动问题记录](https://github.com/docker/desktop-feedback/issues/460)

恢复或重新构建时使用同一个 Compose 项目。上传的数据保存在 Docker 卷内，删除卷会清除对应的数据。

## 备份和恢复共享工作台

确认运行中的分析完成后，保留数据库容器并停掉写入服务。使用 [备份恢复脚本](../deploy/docker/scene-backup.ps1) 的 `-ComposeOverride` 指向当前卷配置，使脚本按 Compose 实际挂载的卷备份。恢复时准备一份指向全新卷名的覆盖文件，移除目标项目的旧容器，再用同一个 `geocsv-local` 项目恢复。脚本拒绝已有的目标卷，并校验归档的 SHA-256 和数据库版本。旧卷继续保留供回退。

Moran/LISA 四面样例和此前独立实例的实验记录见 [阶段 02](sessions/02-python-execution.md)。数据库升级、同版恢复和 Chicago 311 全流程记录见 [阶段 07](sessions/07-deployment.md)。

## 本机验证记录

2026-11-16，在 Docker Engine 29.6.1 上构建并启动四个容器，健康检查全部通过。数据库实测为 PostgreSQL 16.16、PostGIS 3.7。通过 Web 入口上传三块街道面和四个设施点，排除边界的空间透视结果为 `2、1、0`，分页、GeoJSON 与 CSV 都可读取。另从 Node 容器访问 Python 的旧空间自相关端点，确认 Python 可读取同一数据库中的三条面记录并完成计算。完整停止并再次启动 GeoCSV 容器后，仍可读取上传数据和原任务结果，两份上传文件也保存在卷中。
