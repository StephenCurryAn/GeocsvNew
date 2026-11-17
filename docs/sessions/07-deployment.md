# 阶段 07 · 本机 Docker 升级与恢复

2026-11-17 在 `D:/GeoCSV/.worktrees/07-deployment` 的 `codex/07-deployment` 分支验收。五个目标镜像从公共基线 `1b0c4ed58dcd64584967d41f5187949630e25868` 构建。`geocsv-07-upgrade` 使用 18090，`geocsv-07-restore` 使用 18091。恢复目标复用同一批镜像，每个项目各有自己的卷和网络。原有 8089 实例保持运行，演练后健康接口仍返回 200。

## Compose 与数据边界

[compose.yaml](../../compose.yaml) 把 Nginx 与 Express 放在同一个网络命名空间。主机只监听 `127.0.0.1:<GEOCSV_WEB_PORT>`，由 Nginx 提供前端、转发 API 并保留流式响应。Express 从默认网络访问 `db:5432`、`python:8000`，从 `planner` 网络访问 `agent:8100`。`planner` profile 开启后才会启动 Agent。现代 Moran/LISA 由 Express 在 `server` 容器内启动 Python Worker，独立的 `python` 容器仍提供 FastAPI 计算接口。

| 卷 | 数据 | 本轮备份办法 |
| --- | --- | --- |
| `database` | 场景、图层及 PostGIS 要素、Plan、Run、Artifact、专业模型配置、迁移记录、仍保留的输入快照 | `pg_dump` 逻辑备份，恢复时由 `pg_restore` 重建。原始快照载荷按分析服务的七天期限清理。 |
| `uploads` | `file_nodes.path` 指向的原文件及配套文件 | 用 tar 保留卷目录和权限，恢复到 `/app/server/uploads`。 |
| `models` | Express 与旧 Python 接口共用的模型文件目录 | 完整归档，保留它与数据库中旧模型注册记录的对应关系。 |
| `agent-checkpoints` | `/data/checkpoints.sqlite` 及 SQLite 辅助文件。LangGraph 按 `sceneId:threadId` 保存检查点和成功事件回执 | 关闭 Agent 后归档整个卷。待确认会话还需要 PostGIS 中同一份 Plan 和输入数据。 |
| `analysis-worker` | Python Worker 已产出、等待入库的中间文件 | 这次先完成排队和运行任务再停服务。脚本检查无 `queued` 或 `running` 任务，恢复目标使用新 Worker 卷。 |

模型凭据、服务间令牌和浏览器本地状态由各自环境提供。端口变更后，浏览器原先记住的会话 ID 不会自动出现在新地址。可用已记录的场景和会话 ID 读取并继续恢复的步骤。[启动与规划配置](../docker-local.md) · [LangGraph 持久化说明](04-scene-analysis-workflow.md#代码分工)

## 旧库实际升级

数据库来源是 `geocsv-workflow`（8085），旧 Express 镜像 ID 为 `sha256:cd58182d0be5ec9b4d8b2b33fe9533777b4734375f1074c56854ecad69a70495`。以实际库记录确定起点为场景迁移 **1**、分析迁移 **1–5**，PostgreSQL 16.16、PostGIS 3.7.0。旧镜像的 Git 提交无可核对的镜像标签。`pg_dump` 生成的旧库副本 SHA-256 为 `6E9D6113CC845CD263E76BF541745D0B7C3FE603E1F6403ED69148B886463DC8`。8085 的上传卷为空。上游 `geocsv-phase3` 的数据库中三条文件 ID、路径和大小与旧库一致，从其上传卷按只读方式归档原始文件。数据制作过程见 [Chicago 311 数据记录](02-chicago-311.md)。

以下命令记录实际构建、导入和启动流程。在 PowerShell 7.4+ 从仓库根目录运行。本次两个 `.env` 文件位于 `.tmp` 中，分别指定 18090 和 18091，并指向本地配置的 DeepSeek API。命令示例中的 `dropdb` 仅作用于刚为本次演练创建的 `geocsv-07-upgrade-db-1`，其中最初只有镜像初始化的数据库。

```powershell
$upgrade = @('compose', '--env-file', '.tmp/.env.07-upgrade', '-p', 'geocsv-07-upgrade', '--profile', 'planner')
$db = 'geocsv-07-upgrade-db-1'
New-Item -ItemType Directory -Force .tmp/legacy | Out-Null
$source = 'geocsv-workflow-db-1'
$dump = '/tmp/geocsv-07-source-' + [guid]::NewGuid().ToString('n') + '.pgdump'
docker exec $source pg_dump -U geocsv -d geocsv -Fc -f $dump
docker cp "${source}:$dump" .tmp/legacy/database.pgdump
docker exec $source rm -- $dump
$stage = (Resolve-Path .tmp/legacy).Path
docker run --rm --network none --entrypoint tar `
  --mount 'type=volume,source=geocsv-phase3_uploads,target=/source,readonly' `
  --mount "type=bind,source=$stage,target=/backup" `
  postgres:16 -cpf /backup/uploads.tar -C /source .

docker @upgrade build
docker @upgrade up --no-build -d --wait db
docker cp .tmp/legacy/database.pgdump "${db}:/tmp/phase07-legacy.pgdump"
docker exec $db dropdb -U geocsv geocsv
docker exec $db createdb -U geocsv -T template0 geocsv
docker exec $db pg_restore -U geocsv -d geocsv --exit-on-error --single-transaction /tmp/phase07-legacy.pgdump
docker exec $db rm -- /tmp/phase07-legacy.pgdump
docker run --rm --network none --entrypoint tar `
  --mount 'type=volume,source=geocsv-07-upgrade_uploads,target=/target' `
  --mount "type=bind,source=$stage,target=/backup,readonly" `
  postgres:16 -xpf /backup/uploads.tar -C /target

$query = @('psql', '-qXAt', '-U', 'geocsv', '-d', 'geocsv', '-v', 'ON_ERROR_STOP=1')
$ledger = 'SELECT * FROM geocsv_analysis_migrations ORDER BY version; SELECT * FROM geocsv_scene_migrations ORDER BY version;'
Get-Content -Raw deploy/docker/chicago-restore-check.sql | docker exec -i $db @query
docker exec $db @query -c $ledger
docker @upgrade up --no-build -d --wait
Get-Content -Raw deploy/docker/chicago-restore-check.sql | docker exec -i $db @query
docker exec $db @query -c $ledger
docker @upgrade restart server web
docker @upgrade up --no-build -d --wait
docker exec $db @query -c $ledger
```

[Express 启动入口](../../server/src/index.ts) 先连库并执行 `migrateScenes`，再调用 `AnalysisService.start()` 执行分析迁移，完成后才监听 HTTP。[migrations.ts](../../server/src/modules/analysis/migrations.ts) 在事务内获取 PostgreSQL advisory lock，读取连续版本号并从下一项开始执行。6 建立专业模型版本表并给 Run 增加 `professional_model`。7 给 Run 增加可空的 `trace_id`，旧运行仍可读取。迁移与版本记录一起提交，启动错误会退出。实测两条新记录均在 14:41:28 落库，原分析 1–5 和场景 1 的时间戳保持一致。重启后两张迁移记录与第一次启动完成时完全一致。导入前后的逻辑行数及内容摘要一致，逐表校验覆盖两个场景、三条文件记录、月份元数据、全部三层要素、13 个 Plan、3 个成功 Run 和 3 个 Artifact 各自的 77 行局部统计与几何。[校验 SQL](../../deploy/docker/chicago-restore-check.sql)

## 备份并恢复到新卷

先等待当前任务结束并暂停该副本的应用写入。备份前在 18090 发起一条问题，停在 `pending_confirmation`。记录场景 ID `31521d56-f118-41d7-b08c-029cd4a26801`、会话 ID `99420c67-5db6-4733-b2dd-4debf7f7cfcd`、确认步骤 `a7b1e375-11e0-44bf-9886-8781328883db` 和 Plan `94f7c478-9e4e-405d-af4d-d4b901416069`。此时 PostGIS 共有 14 份计划，旧有的 3 个 Run 均为 `succeeded`。

```powershell
docker @upgrade stop web agent server python
./deploy/docker/scene-backup.ps1 -Operation Backup -Project geocsv-07-upgrade `
  -EnvFile .tmp/.env.07-upgrade -Directory .tmp/phase07-backup

foreach ($service in 'db', 'python', 'agent', 'server', 'web') {
  docker image tag "geocsv-07-upgrade-${service}:latest" "geocsv-07-restore-${service}:latest"
}
./deploy/docker/scene-backup.ps1 -Operation Restore -Project geocsv-07-restore `
  -EnvFile .tmp/.env.07-restore -Directory .tmp/phase07-backup
$restore = @('compose', '--env-file', '.tmp/.env.07-restore', '-p', 'geocsv-07-restore', '--profile', 'planner')
docker @restore up --no-build -d --wait
Get-Content -Raw deploy/docker/chicago-restore-check.sql | docker exec -i geocsv-07-restore-db-1 @query
docker exec geocsv-07-restore-db-1 @query -c $ledger
```

[备份恢复脚本](../../deploy/docker/scene-backup.ps1) 写出逻辑数据库备份及三个卷的 tar，最后生成含数据库版本和各文件 SHA-256 的 `manifest.json`。恢复先验摘要，确认目标名称尚无容器和卷，再只启动目标数据库，用 `template0` 空库和单事务导入数据库。应用卷提取完毕后再启动其余服务。本轮备份在本地 `.tmp/phase07-backup`，数据库备份摘要为 `A82F54B92209E6A071654346BDE51D48E2B7D2485736AB1BF4F1CB983E4BC314`。

防误操作实测覆盖备份目录已存在、恢复项目已有容器或卷、数据库备份 SHA-256 校验失败三种情况。脚本均在写入目标之前退出。

| 验收对象 | 恢复证据 |
| --- | --- |
| 场景和图层 | 浏览器显示「默认场景」和 `Chicago 311`。社区边界 77 面、1 月原始请求 89,807 点、社区汇总 77 面，逻辑行内容摘要与备份前一致。 |
| 原文件 | 按数据库路径在 `server` 容器内用应用用户读取并解析三个原始 GeoJSON，分别得到 77、89,807、77 个要素。文件 SHA-256 与旧上传归档逐个相同。 |
| 历史结果 | 复读旧 Plan、Run 和 Artifact。三个旧归档 `59ca4503-09e2-40fa-8e95-3c0861192497`、`1cedb5bd-8652-461a-9f42-4c23c81710ad`、`d356e5f9-88c5-4858-aefc-a2ff20a2f409` 的元数据、行接口、GeoJSON、CSV 响应字节与备份前一致。每份含 77 行、77 个地图要素和 77 条 CSV 数据。恢复后的工作台从运行历史打开其中一份并显示结果表与地图。 |
| 待确认会话 | `GET /api/scenes/:sceneId/analysis/sessions/:threadId` 读回原 Plan、确认步骤和追踪 ID。确认前该会话有 0 个 Run。同一确认事件发送两次，均返回 Run `31209459-a99a-443b-920e-536570598e6e`，库中只有一条。归档 `a1933f75-6a4f-455c-b61a-dc97c5730ab7` 有 77 行。跨备份前后可按 trace `d000e3cb7a9d21491079710c3507c251` 核对。 |

可从 `/api/runs/<runId>` 取回 `artifactId`，再对照 `/api/artifacts/<artifactId>/rows?page=1&pageSize=100`、`/geojson`、`/export.csv`。原文件与关系库的几何表分别核对，避免用运行时导出的 GeoJSON 代替原文件验证。

## 恢复后从浏览器重新运行原题

2026-11-17 14:52，在 [恢复的工作台](http://127.0.0.1:18091/) 的 `Chicago 311` 场景输入原题「2024 年 1 月，芝加哥坑洞投诉多的社区，是否也挨着投诉多的社区？如果有这种聚集，具体在哪里」。Agent 访问 `api.deepseek.com`，响应模型为 `deepseek-flash`。待确认界面显示汇总层、坑洞投诉次数、2024-01、Queen 邻接、199 次置换、种子 42。核对该追踪 ID 下没有 Run，随后在浏览器点击「确认并运行」。

追踪 ID `ff130e085c0b2792a33aac6385174411`，会话 ID `e0f73310-6603-4c48-8052-250045d54d73`。

| 事件 | 实测记录 |
| --- | --- |
| `workflow.http.event` | 规划请求返回 200，9,261 ms。 |
| `langchain.model` | `deepseek-flash` 返回 `ready`，8,052 ms。输入 1,804 token，其中缓存命中 1,664，输出 168。提示版本 `d047c8953e30bd33`。 |
| `plan.persisted` | Plan `f0325e27-413a-4ebf-a22b-7bda8aa4ccd4` v1，`spatial_autocorrelation@2`，校验入库 59 ms。 |
| `langgraph.event.completed` | `pending_confirmation`，`runId` 为空。用户确认后为 `submitted`。 |
| `workflow.run.accepted` | Run `ceec66ce-858d-4a08-a48c-b3d28f5e67ff` 入队，提交事务 100 ms。 |
| `python.worker.result` / `execution.python.completed` | Worker 执行 `moran-lisa/2.0.0`，2,487 ms。 |
| `artifact.postgis.committed` | Artifact `88624f19-7b69-4d2d-b812-f13f0b9945fb` 完成提交，41 ms。 |

数据库按 `trace_id` 联结 Plan、Run 和 Artifact，查到已确认的 Plan、成功 Run 及 77 条 EPSG:4326 几何结果。工作台显示全局 Moran’s I **0.26721115589489386**（界面取四位）和置换 p 值 **0.005**。四个局部高—高候选是 **Lincoln Park、Near North Side、West Town、Loop**。点击 Lincoln Park 后地图定位并选中同一表格行。用页面的「导出 CSV」下载，核对含 77 条数据。局部候选以未经多重比较校正的 `p ≤ 0.05` 标记，供探索。[阶段 06 追踪代码路径](06-evals-observability.md#判据与追踪)

```powershell
$trace = 'ff130e085c0b2792a33aac6385174411'
docker @restore logs --no-log-prefix server agent | Select-String -SimpleMatch $trace
```

```sql
SELECT p.id AS plan, p.confirmed_at IS NOT NULL AS confirmed,
       r.id AS run, r.status, a.id AS artifact, count(m.feature_id) AS rows
FROM geocsv_analysis_runs r
JOIN geocsv_analysis_plans p ON p.id = r.plan_id
JOIN geocsv_analysis_artifacts a ON a.id = r.artifact_id
JOIN geocsv_analysis_moran_rows m ON m.artifact_id = a.id
WHERE r.trace_id = 'ff130e085c0b2792a33aac6385174411'
GROUP BY p.id, r.id, a.id;
```

## 范围与回退

本轮验证同一 PostgreSQL 主版本、同一 PostGIS 扩展版本的本机升级与离线备份。升级前的 `database.pgdump` 和 `uploads.tar` 留在 `.tmp/legacy`，回退可用起点镜像配合旧备份另建副本，分析 v7 的卷继续保留供核查。备份或恢复失败时，保留来源项目和备份文件，使用另一个新项目重试。完整阶段计划里的第二个业务案例、数据库短时不可用、Python 超时、浏览器断线、跨版本 PostgreSQL/PostGIS 升级、并发写入备份和多人部署仍待验证。[阶段 7 验收清单](../agent-refactor-plan.md#阶段-7--部署与迁移收尾)
