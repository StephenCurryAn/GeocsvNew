# GeoCSV 并行会话与分支约定

日期：2026-11-16。各会话归属 Codex 的 GeoCSV 项目。

按 [GeoCSV 重构实施与 Agent 学习计划](agent-refactor-plan.md) 的阶段组织会话。编号与阶段对应，每个阶段使用一条分支。日常修复、前端小优化与维护集中在主会话，阶段内的子任务也在同一会话持续推进。

| 会话 | 分支 | 开始条件与交付 |
| --- | --- | --- |
| 01 分析协议与可靠提交 | `codex/01-analysis-protocol` | 现在开始。统一分析协议、幂等提交、计划持久化与迁移，以真实 PostGIS 核对已知结果和重试行为。 |
| 02 Python算子与统一执行 | `codex/02-python-execution` | 与 01 并行做独立的空间自相关算法对照、输入与权重规则测试。01 契约验收合入后，在同一会话完成 Worker、Run 与 Artifact 联调。 |
| 03 LangChain规划服务 | `codex/03-langchain-planner` | 02 的两类算子共用任务接口后开始，完成结构化规划、受控工具与真实模型验收。 |
| 04 LangGraph工作流 | `codex/04-langgraph-workflow` | 03 验收后开始，完成澄清、确认、幂等执行和重启恢复。 |
| 05 工作台会话与地图 | `codex/05-workbench` | 04 的会话与事件接口验收后开始，与 06 并行。覆盖工作台接入、会话恢复、地图与结果联动，deck.gl 试点放在同一阶段。 |
| 06 评估与可观测性 | `codex/06-evals-observability` | 04 验收后与 05 并行，覆盖模型与工具评估、调用追踪和持续集成。05 使用已验收的接口，接口变更由主会话协调。 |
| 07 部署与迁移验收 | `codex/07-deployment` | 05、06 合入后开始，完成部署、备份恢复、两项端到端案例与迁移回归。 |

阶段 0 已完成。远端公共基础分支是 `codex/00-foundation`，当前本地整合分支为 `codex/00-integration`。先前的 Python 离线基线和 AG Grid 按需加载已合入整合分支，验收记录见 [Python 基线](sessions/01-python-baseline.md) 和 [前端加载](sessions/02-client-loading.md)。

新阶段从包含已验收前置成果的整合提交创建分支，在 GeoCSV 项目下使用独立工作目录 `D:/GeoCSV/.worktrees/NN-english-module`。日常改动使用主会话现有工作区，按需验证。阶段会话提交成果并报告代码、学习要点和验收情况，主会话审阅后合入并更新依赖阶段。后置会话到达开始条件再创建。
