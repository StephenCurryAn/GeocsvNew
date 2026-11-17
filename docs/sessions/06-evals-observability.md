# 阶段 06 · Agent 评估与可观测性

2026-11-17 从公共基线 `3fc0dca` 在 `codex/06-evals-observability` 验收。使用独立 Docker 项目 `geocsv-phase06`、本地端口 8087、PostGIS 库 `phase06_test` 和独立 SQLite 卷。使用现有基础镜像，挂载本分支编译的 Express 和 Agent 源码验收。Chicago 311 副本来自阶段 04 的 `chicago-baseline.pgdump`，SHA-256 为 `ce456d766ace75d89c14c58b1601ae5cfc5c0918a2c3261a471895912c263ccf`。复跑方法见 [Chicago 311 评估说明](../../agent_service/evals/README.md)。

## 判据与追踪

- [用例](../../agent_service/evals/chicago311.json)写明预期状态和有效参数。[评估程序](../../agent_service/evals/run.cjs)根据公开 API 核对计划版本、图层、字段、月份、邻接、置换、种子和 77 面，并在 PostGIS 查确认状态、任务数与归档。原问题默认使用 Queen、199 次置换和种子 42，显式 Rook 和显式零值分别由独立用例覆盖。
- [Express](../../server/src/modules/analysis/trace.ts)使用经过校验的场景与会话 UUID 生成稳定的追踪 ID，通过私有头传到 [FastAPI 与 LangGraph](../../agent_service/main.py)，再通过规划和提交回调传回 Express。[LangChain 模型调用](../../agent_service/planner.py)从当前请求读取追踪上下文，在调用配置中携带 ID，从 `AIMessage.usage_metadata` 取 token 数，并记录按实际提示和工具契约生成的版本摘要。锁定版本为 LangChain Core 1.8.1、LangChain OpenAI 1.8.0、LangGraph 1.2.22。[LangChain ChatOpenAI](https://docs.langchain.com/oss/python/integrations/chat/openai) · [LangGraph 中断与恢复](https://docs.langchain.com/oss/python/langgraph/interrupts)
- [AnalysisService](../../server/src/modules/analysis/service.ts)将追踪 ID 与 Run 一起提交。调度器从数据库恢复 ID，通过 Run ID 核对 Python 结果，归档事务提交后才写 Artifact 事件。历史任务的追踪字段可以为空。日志记录诊断类别、编号、版本、耗时和用量。用于复跑的提示词保存在固定用例文件中。

## 无密钥回归与恢复

固定响应回归 **11/11**，用时 24.7 秒。所有初始请求及澄清续答在确认前保持原有 Run 数量。越界选择返回 `DATASET_NOT_FOUND`，虚构字段得到澄清，429 归类为 `MODEL_RATE_LIMITED`。

例如虚构字段调用的 trace ID 为 `1c8d8340d827c62d8b1f61c3f9ff9dae`。同一 ID 下，`langchain.model` 得到 `ready`，`draft.validation.error` 记录 `UNKNOWN_FIELD`，公开 API 返回澄清，计划和任务数保持原值。这样可以在校验阶段找到拒绝原因。

阶段 04 故障注入复跑通过。澄清和待确认状态可在 Agent 重启后读取。PostGIS 提交 Run 后中断 Agent，恢复及重复确认取回同一个 Run `30e08aa3-0b04-41b8-8ca9-7ad5b89f3b9d`，追踪 ID `72cf2d256046bd3edfd6a7c63066571a`，Artifact `97be8a9f-131f-4e25-8d24-b31c98a33ae2`。另查验跨场景确认和已过期确认步骤的拒绝。输入更新使旧计划的确认返回 409，任务数为 0，原始数据随后恢复。

## 真实 DeepSeek

官方 API 响应模型为 `deepseek-flash`，模型调用使用严格工具参数，提示版本为 `d047c8953e30bd33`。每轮 7 例，其中指标澄清包含两次调用。阶段 06 的通过率按包含校验和确认的公开接口判定，模型草案状态另行统计。

| 批次 | API 通过 | 失败类别 | 调用数 | 输入 token（缓存命中） | 输出 token | 评估总耗时 |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| 首跑 | 20/21 | 局部聚集名称的断言大小写，1 例 | 24 | 37,845（29,568） | 4,559 | 112.6 s |
| 修正后复跑 | **21/21**，每轮 7/7 | 0 | 24 | 37,845（33,792） | 4,518 | 104.2 s |

复跑的 24 次模型调用均返回用量，单次耗时 1.06–6.63 秒。按本次缓存用量与 DeepSeek 公布的高峰价估算约 0.00684 美元。[DeepSeek 计费](https://api-docs.deepseek.com/quick_start/pricing/)

模型草案状态 **15/21** 符合预期。指标歧义和缺失二月数据各有 3 次得到 `ready` 草案，Express 的 Moran/LISA 校验把这 6 次请求转为澄清。通过率由服务端约束补足，下一次比较模型或提示时应单独复核这两类。首跑的真实请求已经生成正确 Artifact。断言把界面记录中的标题大小写与归档中的全大写社区名直接比较，引发了一次误报。修正后以统一大小写核对标签。

### 一次真实请求的追踪

原问题复跑的 trace ID 为 `b8b13a57e66041b4514c5732b4a21a5c`。

| 事件 | 实测 |
| --- | --- |
| `workflow.http.event` | Express 返回 200，规划请求 7,330 ms |
| `langchain.model` | `ready`，6,251 ms，输入 1,804 / 输出 168 token |
| `plan.persisted` | 计划 `c4193495-1c98-40c5-a3ee-a4c5449c72f4`，Plan v1，`spatial_autocorrelation@2`，校验入库 66 ms |
| `langgraph.event.completed` | `pending_confirmation`，无 Run |
| `workflow.run.accepted` | 确认后 Run `43493e8b-f0a6-47e6-adce-5c767976b194` 入队，两次重复确认取回同一个 Run |
| `python.worker.result` / `execution.python.completed` | `moran-lisa/2.0.0`，4,082 ms |
| `artifact.postgis.committed` | Artifact `51c9203c-9816-492b-b6f7-cb31c9c99f87`，32 ms |

77 个社区全部归档，Moran’s I 为 0.2672111559，置换 p 值为 0.005。Lincoln Park、Near North Side、West Town 和 Loop 均符合局部高—高及原始 p 值 ≤ 0.05 的判据。

定位时，先查模型事件的状态和错误类别，再核对计划是否持久化。Run 已入队时，可沿同一追踪 ID 看计算完成及归档提交。首跑的误报中，这些事件全部完成，因此从 Artifact 的局部结果核对测试判据，找到了标签大小写差异。

## 持续集成

[GitHub Actions 配置](../../.github/workflows/analysis-regression.yml)接入前后端 JavaScript、Agent 和算法 Python 测试，以及真实 PostGIS 集成套件。PostGIS 测试文件串行执行，以免在一个数据库内争用调度器的 advisory lock。本地验证通过 Express 构建、前后端 JavaScript 各 23 项、Agent Python 16 项、算法 Python 18 项和 PostGIS 9 项。GitHub 托管环境还没有运行记录。带 Chicago 副本的完整验收和在线评估使用上面的本地命令。样例库当前为 Chicago 单案例，需要其他数据场景时可继续补充独立验收集。
