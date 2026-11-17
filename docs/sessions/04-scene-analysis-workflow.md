# 场景内自然语言分析

## 芝加哥 311 验收

在独立本地 Docker 工作台 `http://127.0.0.1:8085/` 切到 `Chicago 311` 场景，向右侧助手提交以下需求：

> 2024 年 1 月，芝加哥坑洞投诉多的社区，是否也挨着投诉多的社区？如果有这种聚集，具体在哪里

本例读取场景中已有的社区汇总层。从[数据制作记录](02-chicago-311.md#从上传到归档)核对汇总数据来源后，在验收库登记月份 `2024-01`。候选数据同时包含社区边界、311 原始点和社区统计汇总层，只有社区汇总层具备本题所需的面几何、坑洞投诉次数及月份元数据。

确认卡片显示图层、指标、月份与规则。用户未指定邻接规则时沿用算子注册项的 Queen 默认值，即共边或共顶点的社区视为相邻。确认后提交到已有分析队列，由 Python 算子计算 77 个社区并把结果保存到 PostGIS。Moran’s I 约为 0.267211，置换 p 值 0.005。地图上的高—高候选包括 Lincoln Park、Near North Side、West Town 和 Loop。局部候选采用原始 p 值 0.05 阈值，供探索性分析。

## LangGraph 执行层验收

2026-11-17 使用独立 Compose 项目 `geocsv-04-acceptance`、`127.0.0.1:8086`、Chicago 311 的 PostGIS 副本、独立 SQLite 卷和真实 DeepSeek `deepseek-flash`。8085 实例继续使用原有服务和数据卷。

| 场景 | 实测行为 |
| --- | --- |
| 澄清后继续 | 从「芝加哥 2024 年 1 月的社区投诉有没有空间聚集？请先问我选哪个投诉指标，等我答复后再生成计划。」开始。模型询问投诉指标，Agent 重启后仍保留澄清问题。补充「就分析坑洞投诉次数，比较相邻社区的坑洞投诉是否聚集。」后生成新步骤，计划使用 `pothole_requests`、2024-01、Queen 邻接和 199 次置换。确认前 Run 数保持原值。 |
| 待确认恢复 | Agent 重启后，`GET` 返回同一个计划和步骤 ID。使用上一步澄清的 ID 确认返回 409。 |
| 提交断点与幂等 | 先让提交回调在 Postgres 等锁，再暂停 Agent、释放锁，让 Run 事务先提交。确认 Postgres 已有 Run 后终止 Agent，客户端收到 503。重启时会话显示「处理中」且尚无 `runId`。发送 `resume` 取回原 Run，数据库仍只有一条。并发重发相同请求、用新请求 ID 重复确认，以及「已提交」后再次重启，均返回该 Run。 |
| 场景隔离与取消 | 默认场景读取或确认 Chicago 的会话返回 404。用同一个 thread ID 在默认场景创建会话后，两个场景保有各自的步骤。取消默认场景的澄清后，原答复返回 409，Chicago 的待确认步骤和运行历史保持各自归属。已提交的会话拒绝会话取消。 |
| 输入更新 | 保存待确认计划后，在副本中将一个社区的 `pothole_requests` 加 1。旧计划确认返回 409 和「输入数据已改变」，Run 数为 0，计划仍为 `validated`，会话仍可取消。新计划使用不同的输入版本。重复确认更新前已提交的步骤仍返回原 Run。脚本结束时恢复该社区的值。 |

本次断点恢复使用会话 `efd486a0-581b-4805-aab5-23448474d857`，复用 Run `36128cc7-584e-439a-ba00-593b3cf5ca41`。Artifact `ec5167c2-e287-4cd1-8038-c017bbfdf85e` 包含 77 个社区，全局 Moran’s I 为 0.26721115589489386，置换 p 值为 0.005。另用常规提交路径验证首次确认与并发重复确认。

复验时用副本装载 [芝加哥 311 验收数据](02-chicago-311.md) 并登记汇总层的月份。脚本使用本文案例的场景和图层标识，默认访问 8086。启用 `--restart-agent` 时，脚本会先核对 Compose 项目、端口和库名，再操作该项目的 Agent 与数据库。Agent 应运行本分支代码，PostGIS 连接指向副本库 `workflow_acceptance`。

```powershell
node server/tests/sceneWorkflowDocker.cjs
node server/tests/sceneWorkflowDocker.cjs --restart-agent
```

Agent 回归测试另外覆盖两种失败后继续的情况。首次规划失败并重启后，客户端以新的 `requestId` 恢复同一会话。补充内容拼接后超长会在送进 `interrupt` 之前返回 422，用户可以缩短补充并继续当前步骤。

## 代码分工

- [场景数据语义](../../server/src/modules/analysisPlanner/sceneDataMeaning.ts)提供字段含义与来源月份。算子注册项负责约束输入及提供默认值。
- [LangChain 规划](../../agent_service/planner.py)使用 DeepSeek 严格工具参数。模型在候选中选择，Python 校验返回结构，[场景规划路由](../../server/src/modules/analysisPlanner/sceneRouter.ts)与算子再校验数据、字段和参数，保存计划及输入版本。
- [LangGraph 工作流](../../agent_service/workflow.py)用 `interrupt()` 等待补充或确认，并以 `Command(resume=...)` 接收当前步骤的事件。补充后回到规划。复合键 `sceneId:threadId` 隔离检查点，Docker 卷 `agent-checkpoints` 存储单实例 SQLite 检查点和成功事件回执。同步检查点先保存批准状态，再执行提交回调。`GET` 只读检查点，`resume` 可继续中断的规划或提交。
- [提交路由](../../server/src/modules/analysisPlanner/workflowRouter.ts)以场景和会话作为幂等范围，以确认步骤 ID 作为幂等键。[AnalysisService](../../server/src/modules/analysis/service.ts)先查已有 Run，再在新任务的事务中校验输入版本，保存 Python 输入快照和排队 Run。Agent 记录返回的 `runId` 后便可结束会话工作流。应用调度器独立取队列并归档结果。明确的旧计划拒绝会重新打开确认步骤，临时提交失败则保留批准检查点以便重试。
- [结果工作台](../../client/src/features/analysis/components/MoranResult.tsx)呈现局部候选、全局统计量、表格和地图定位。

当前覆盖单场景及已注册算子。月份依赖登记的数据来源，跨场景与通用时间筛选属于后续能力。此工作台使用本地验证实例。
