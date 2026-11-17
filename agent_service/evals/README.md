# Chicago 311 评估

使用 [阶段 02 的 2024 年 1 月数据](../../docs/sessions/02-chicago-311.md)和[阶段 04 的数据库副本](../../docs/sessions/04-scene-analysis-workflow.md)。固定用例在 [chicago311.json](chicago311.json)。其中 `expected` 是公开 API 的判据，`fixture` 是确定性测试中模拟的模型响应。开发集保留原问题和明确 Queen，独立验收集覆盖 Rook、澄清续答、显式零值、邻接冲突和缺失月份。安全集覆盖异场景图层选择、草案中的虚构引用和字段，以及提供商限流。

## 准备副本

以下命令在仓库根目录运行。需要阶段 04 留下的 **`chicago-baseline.pgdump`**（PostgreSQL 自定义格式），或从相同快照和场景标识制成的副本。用例启动时核对 Docker 项目、端口、库名、图层归属、月份、两个指标和 77 面。请在副本上串行运行评估，回归会比较运行前后的计划和任务总数。

```powershell
$env:GEOCSV_WEB_PORT = '8087'
$env:AGENT_SERVICE_TOKEN = [guid]::NewGuid().ToString('N')
$evalCompose = @('-p', 'geocsv-phase06', '-f', 'compose.yaml', '-f', 'agent_service/evals/compose.eval.yaml', '--profile', 'planner')

docker compose @evalCompose up -d --build --wait db
docker exec geocsv-phase06-db-1 createdb -U geocsv phase06_test
$evalDump = 'D:\GeoCSV\.worktrees\04-langgraph-workflow\.tmp\chicago-baseline.pgdump'
docker cp $evalDump geocsv-phase06-db-1:/tmp/chicago.pgdump
docker exec geocsv-phase06-db-1 pg_restore --exit-on-error -U geocsv -d phase06_test /tmp/chicago.pgdump
```

第一次启动应用后登记月份。已有副本可以重跑登记命令。

```powershell
docker exec geocsv-phase06-db-1 psql -U geocsv -d phase06_test -v ON_ERROR_STOP=1 -c "INSERT INTO geocsv_analysis_dataset_periods(file_id, month) VALUES ('b64dacd7-fdf4-4ee0-a71f-8c80eda1b37e', '2024-01') ON CONFLICT DO NOTHING"
```

## 确定性回归

启动时附加固定模型响应覆盖文件，再执行上述月份登记。覆盖文件将模型凭据清空。LangChain 通过进程内 HTTP 测试传输取得固定响应，LangGraph、Express、PostGIS 与 Python Worker 走正常执行路径。

```powershell
docker compose @evalCompose -f agent_service/evals/compose.fixture.yaml up -d --build --wait
node agent_service/evals/run.cjs
node server/tests/sceneWorkflowDocker.cjs --phase06 --restart-agent
```

第二条测试复用阶段 04 的故障注入。它重启 Agent 验证澄清、待确认与已提交步骤，并在任务提交后、Agent 收到回执前中断一次，检查恢复和重复确认取回同一个 Run。运行期间只操作本评估项目。

## 手动评估 DeepSeek

从已有凭据存储将 DeepSeek 密钥传给当前终端的 `ALIYUN_API_KEY`，设置 `LLM_BASE_URL=https://api.deepseek.com` 和模型名 `LLM_PLANNER_MODEL=deepseek-flash`。只传基础 Compose 和评估数据库覆盖文件来启动在线 Agent。第一次启动应用后登记月份。

```powershell
docker compose @evalCompose up -d --build --wait
node agent_service/evals/run.cjs --live --rounds=3 --max-calls=24
```

在线模式每轮 7 例、至多 8 次调用，三轮上限 24 次。默认单轮，`--max-calls` 在发送请求前核对调用额度。模型同步调用禁用自动重试，每次最多输出 1,600 token。报告列出每条用例的追踪 ID、有效参数、用量、耗时和失败类别。退出码 1 代表存在失败或环境未满足。最终通过率按公开 API 判定，`modelStatusMatches` 另统计每例的模型草案状态是否直接符合对应步骤预期。首轮原始问题确认并执行，后续轮次复查待确认计划。

## 查找一次运行

先从启动或确认请求的 `x-geocsv-trace-id` 响应头取值，或用报告中的 `traceId`。同一场景会话使用相同追踪 ID。每次请求的 `requestId` 用于区分澄清、确认和重试。

```powershell
docker compose @evalCompose logs --no-color server agent 2>&1 | Select-String -SimpleMatch '<traceId>'
```

按 `langchain.model` 查看草案状态、延迟与 token，按 `draft.validation.error` 和 `plan.persisted` 查看校验及入库。随后用 `workflow.run.accepted`、`python.worker.result` 和 `artifact.postgis.committed` 对齐提交、计算和归档。日志记录编号、状态与诊断类别，报告只摘录用例核对所需的参数和统计值。
