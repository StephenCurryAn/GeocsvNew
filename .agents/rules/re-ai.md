---
trigger: always_on
---

# GeoCSV 当前开发方向

当前业务是地理数据管理、空间透视与专业模型分析。实现采用 React/TypeScript、Express、PostgreSQL/PostGIS 和 Python/FastAPI。

默认自然语言入口位于 server/src/modules/analysisPlanner，生成可校验计划。server/src/modules/spatialPivot 负责已验证计数算子、Run 和 Artifact。Python 专业模型和旧 AI 实验入口正在等待逐项迁移。

具体语义、已知限制与验收方式读取以下文件。

- AI_MIGRATION_RULES.md 给出当前职责和开发约定。
- docs/spatial-pivot.md 定义现有算子和任务协议。
- docs/ai-refactor-progress.md 记录已落地的自然语言能力。
- docs/agent-refactor-plan.md 给出独立 Python Agent、算子审计和前端演进的实施阶段。
- docs/environment-baseline.md 记录环境复现与当前验证证据。

每次扩展能力先检查现有实现和调用者，复用业务校验与任务结果协议。模型、数据库或库版本变化时，用已知答案和故障场景检查行为。分组、连接、CRS 与统计算法按算子定义选择并测试。
