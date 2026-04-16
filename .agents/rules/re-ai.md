---
trigger: always_on
---

“
我们当前正在开发一个面向 GeoAI 领域的空间分析与透视系统。为了支撑即将进行的“滑坡易发性分析与地理探测器”顶刊级复现案例，我们需要对当前单体架构进行一次“最小可行性的多智能体（Multi-Agent）重构”。

本次重构的核心思想是：**状态机主循环 (State Machine) + 强类型 JSON 契约 (Structured Outputs) + Python 沙盒算子化 (Operator SDK)**。请不要引入微服务、Redis 或复杂的向量数据库，保持架构轻量级但逻辑绝对严密。

请按照以下 4 个阶段，帮我阅读并修改相关代码：

#### 阶段一：定义全局状态与强类型契约 (TypeScript 层)
请在项目中（如新建 `types/agent.ts` 或在 `llmService.ts` 中）定义以下核心接口：
1. `WorkflowState`: 包含原始文件路径、当前文件路径、用户问题、表结构元数据 (Schema)、执行日志 (Execution Log)，以及 `currentAgent` 状态（"planner" | "feature" | "pivot" | "expert" | "visualization" | "end"）。
2. `PlannerContract`: 包含 `thought_process` (思维链) 和 `next_agent` (下一个路由目标)。
3. `FeatureContract`: 用于规定空间特征计算的参数（如调用的算子名称、目标列、距离等）。
4. `PivotContract`: 严格遵循我们的 "5+1" 空间透视范式（[S]约束, [T]对象, [R]行, [C]列, [M]方法, [V]字段）。

#### 阶段二：重构 LLM 服务 (Agentic 接口层)
请重构 `llmService.ts`：
- 废弃以前那种“让 LLM 一口气写完所有 Python 代码”的 Prompt。
- 利用大模型的 Function Calling 或 JSON 结构化输出能力，将 LLM 服务拆分为几个独立的函数：`runPlannerAgent`, `runFeatureAgent`, `runPivotAgent`。它们各自拥有独立的 System Prompt，并严格返回阶段一中定义的强类型 JSON。

#### 阶段三：搭建状态机主循环 (Node.js 控制层)
请重构 `analysisController.ts`（或新建工作流文件）：
- 构建一个基于 `while` 循环的异步状态机（带最大循环次数限制防止死循环）。
- 循环根据 `state.currentAgent` 的值使用 `switch-case` 派发任务：
  - Planner 负责决策下一步。
  - Feature/Pivot/Expert Agent 生成 JSON 契约，并将其转化为特定的 Python 调用语句，发送给底层的 Python 沙盒执行。执行完毕后更新 `state.currentDataPath` 和 `state.schemaInfo`，然后把控制权交还给 Planner。

#### 阶段四：扩容并整合 Python SDK (物理沙盒层)
请在后端的 Python 目录中，将原有的代码片段整合并新建一个 `geo_core_sdk.py`，其中必须包含三大类静态方法：
1. **GeoFeature 类**: 包含如 `calculate_area`, `buffer_count`, `extract_raster_value` 等为原始数据新增特征列的算子。
2. **GeoPivot 类**: 包含基于 DE-9IM 的安全拓扑聚合（`safe_sjoin_aggregate`），实现 5+1 范式的物理执行。
3. **DomainExpert 类**: 写一个 `run_geodetector(df, target_col, factor_cols)` 的包裹函数，接收宽表，返回 Q 值 JSON。

**【行动要求】**
请先阅读我现在的 `llmService.ts` 和 `analysisController.ts`，然后告诉我你是否理解了上述架构思想。
”
上面是我的现在阶段的重构，并且我刚才已经完成了这些重构，现在阶段是想要对我的系统进行测试，并且对测试时候所暴露的一些问题进行修复，主要目的是为了能够完整跑通两个权威并且专业的案例来支撑我的论文写作。