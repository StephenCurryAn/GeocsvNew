# 用 Docker 运行 GeoCSV

这套 Compose 配置用于本机开发和验收。它启动 Web 前端、Express、Python/FastAPI 和 PostgreSQL 16 + PostGIS，并使用独立的数据库和上传存储。Docker 数据库首次启动时应用现有的初始化 SQL。正式部署、备份恢复和 Agent 服务仍按阶段 7 的计划验收。

在 Docker Desktop 启动后，从包含 `compose.yaml` 的 GeoCSV 工作目录运行：

```powershell
docker compose up --build --detach --wait
docker compose ps
```

打开 [Docker 版 GeoCSV](http://127.0.0.1:8080/)，从「资源管理」上传资料。除了本机 Web 入口，数据库、Python 和 Node 端口均由容器内部访问。Nginx 同源转发 `/api` 和瓦片请求，并保留流式响应。数据库、上传文件和旧模型文件分别存入 Docker 卷。停止和重新启动 Compose 后会保留这些数据。

前端和后端镜像从仓库中的锁文件安装和构建。修改源码后重新执行带 `--build` 的启动命令。需要热更新时可继续使用现有 Vite 开发方式。

现有 Windows/WSL 开发版仍使用 5173、3000、8000 和现有 PostgreSQL。它与 Docker 版各有自己的数据库，旧版数据不会自动出现在 Docker 版。如 8080 已占用，可先设 `$env:GEOCSV_WEB_PORT = '8088'`，再执行启动命令。

## 可选配置

程序可以在没有地图或模型凭据时运行。CARTO 和现有确定性分析功能无需配置 Key。如需配置外部服务，可以在工作目录创建被 Git 忽略的 `.env`，参照 [地图接入](map-services.md) 和 [模型配置](environment-baseline.md) 设置变量。

- `VITE_PROTOMAPS_API_KEY` 是浏览器使用的 Key，修改后执行 `docker compose up --build --detach --wait` 重新构建前端，并在供应商控制台允许实际使用的本机 Web 地址。
- `TIANDITU_SERVER_KEY`、`ALIYUN_API_KEY`、`LLM_BASE_URL` 和 `LLM_PLANNER_MODEL` 由 Compose 在运行时传给服务端。启动时重新应用配置。Docker 版与本机 Node 版分别读取其配置。

## 排查与停机

```powershell
docker compose logs --tail 100
docker compose stop
```

如果 Docker Desktop 报 `dockerInference` 或 `docker-secrets-engine/engine.sock` 无法删除，先查看 Docker Desktop 的启动日志。这次修复将两个只含运行时套接字的目录改名留为备份后重启 Docker Desktop。[Docker Windows 启动问题记录](https://github.com/docker/desktop-feedback/issues/460)

恢复或重新构建时使用同一个 Compose 项目。上传的数据保存在 Docker 卷内，删除卷会清除对应的数据。

## 本机验证记录

2026-11-16，在 Docker Engine 29.6.1 上构建并启动四个容器，健康检查全部通过。数据库实测为 PostgreSQL 16.16、PostGIS 3.7。通过 Web 入口上传三块街道面和四个设施点，排除边界的空间透视结果为 `2、1、0`，分页、GeoJSON 与 CSV 都可读取。另从 Node 容器访问 Python 的旧空间自相关端点，确认 Python 可读取同一数据库中的三条面记录并完成计算。完整停止并再次启动 GeoCSV 容器后，仍可读取上传数据和原任务结果，两份上传文件也保存在卷中。
