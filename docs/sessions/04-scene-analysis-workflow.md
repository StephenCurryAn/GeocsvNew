# 场景内自然语言分析

## 芝加哥 311 验收

在独立本地 Docker 工作台 `http://127.0.0.1:8085/` 切到 `Chicago 311` 场景，向右侧助手提交以下需求：

> 2024 年 1 月，芝加哥坑洞投诉多的社区，是否也挨着投诉多的社区？如果有这种聚集，具体在哪里

本例读取场景中已有的社区汇总层。从[数据制作记录](02-chicago-311.md#从上传到归档)核对汇总数据来源后，在验收库登记月份 `2024-01`。候选数据同时包含社区边界、311 原始点和社区统计汇总层，只有社区汇总层具备本题所需的面几何、坑洞投诉次数及月份元数据。

确认卡片显示图层、指标、月份与规则。用户未指定邻接规则时沿用算子注册项的 Queen 默认值，即共边或共顶点的社区视为相邻。确认后提交到已有分析队列，由 Python 算子计算 77 个社区并把结果保存到 PostGIS。Moran’s I 约为 0.267211，置换 p 值 0.005。地图上的高—高候选包括 Lincoln Park、Near North Side、West Town 和 Loop。局部候选采用原始 p 值 0.05 阈值，供探索性分析。

使用 `node server/tests/sceneWorkflowDocker.cjs --restart-agent` 检查待确认时尚未创建任务、Agent 重启能够恢复、重复确认复用同一任务、其他场景无法读取该会话，及产物包含 77 个社区。

## 代码分工

- [场景数据语义](../../server/src/modules/analysisPlanner/sceneDataMeaning.ts)提供字段含义与来源月份。算子注册项负责约束输入及提供默认值。
- [LangChain 规划](../../agent_service/planner.py)使用 DeepSeek 严格工具参数。模型在候选中选择，Python 校验返回结构，TypeScript 再按场景与算子合同验证数据、字段和参数。
- [LangGraph 工作流](../../agent_service/workflow.py)在澄清或确认处持久化暂停状态，确认之后调用应用服务提交。Docker 卷 `agent-checkpoints` 存储单实例 SQLite 检查点。
- [结果工作台](../../client/src/features/analysis/components/MoranResult.tsx)呈现局部候选、全局统计量、表格和地图定位。

当前覆盖单场景及已注册算子。月份依赖登记的数据来源，跨场景与通用时间筛选属于后续能力。此工作台使用本地验证实例。
