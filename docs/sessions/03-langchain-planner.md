# 阶段 03 · LangChain 规划验收

## 基线整合复验

工作台与规划服务合并后，在 [同一个 Docker 工作台](http://127.0.0.1:5173/) 使用原有的「Chicago 311 · 2024-01」场景复验。选中社区统计图层，在属性表确认 `pothole_requests` 和 `total_requests`，再用下文两句生成计划。两条请求均由 DeepSeek `deepseek-flash` 返回，使用同一个 77 面图层，分别保存为 Queen 和 Rook 待确认计划，Run 数保持为 0。五个容器均通过健康检查。

## 阶段 03 独立验收

2026-11-16 在 `geocsv-phase3` 独立 Compose 项目验收，Web 入口为 [127.0.0.1:8083](http://127.0.0.1:8083/)。五个服务均通过健康检查。数据、上传目录和 Worker 缓存均使用该项目自己的卷。

## 浏览器操作

在左侧切换到「Chicago 311」，保留三个图层未勾选。在右侧「空间分析助手 → 自然语言」依次提交以下两句，每次点击「规划分析」。第二句引用当前助手刚通过校验的第一份计划。

1. 用 Chicago-311-community-counts 图层的 pothole_requests 做 Moran/LISA，采用 Queen 邻接，199 次置换
2. 对同一图层的 total_requests 用 Rook 共边邻接计算空间自相关，199 次置换

场景 ID 为 `31521d56-f118-41d7-b08c-029cd4a26801`。导入 `Chicago-community-areas.geojson`（77 面）、`Chicago-311-community-counts.geojson`（77 面）和 `Chicago-311-2024-01.geojson`（89,807 点）。这些资料来自 [芝加哥 311 已验收案例](02-chicago-311.md)。

| 字段 | 邻接 | 计划 ID | 卡片 |
| --- | --- | --- | --- |
| `pothole_requests` | Queen | `36c32f61-d353-4e6b-ae03-7a240a9b0689` | [浏览器截图](../screenshots/phase3-chicago-queen.jpg) |
| `total_requests` | Rook | `91ef7b0b-f59b-4829-88d4-160853e295a2` | [浏览器截图](../screenshots/phase3-chicago-rook.jpg) |

两条记录的算子和版本均为 `spatial_autocorrelation@2`，目标图层 ID 均为 `b64dacd7-fdf4-4ee0-a71f-8c80eda1b37e`，置换次数 199、种子 42。浏览器显示「待确认」，PostgreSQL 中 `confirmed_at` 均为空。两轮浏览器验收让计划数从 0 增至 4，Run 数始终为 0。模型日志记录最终两次成功响应分别使用了 1,896/61 和 1,895/58 个输入/输出 token。

```sql
SELECT id, spec, confirmed_at IS NULL AS pending_confirmation
FROM geocsv_analysis_plans
WHERE spec->>'kind' = 'spatial_autocorrelation'
ORDER BY created_at;

SELECT count(*) FROM geocsv_analysis_runs;
```

## Messages 到持久化 Plan

1. [场景规划路由](../../server/src/modules/analysisPlanner/sceneRouter.ts)读取活动场景和可信图层目录，检查所选 ID 的归属。确定性计数继续从规则返回。表达式超出规则路径时，可以交给模型解析。
2. [规划客户端](../../server/src/integrations/agent/client.ts)为图层分配单次请求使用的引用，如 `layer_1`。发送图层名称、几何类型、字段名、数值字段标记、注册算子和用户需求。同图层续问使用请求内的同一个引用。Express 通过专用网络、共享凭据调用 FastAPI，凭据不进入 Messages。
3. [LangChain 适配](../../agent_service/planner.py)把可用分析和返回约束放入 `SystemMessage`，把上述 JSON 放入 `HumanMessage`。`ChatOpenAI` 使用 JSON 模式，Pydantic 对完成后的 `AIMessage.content` 严格解析为草案、澄清或不支持。用户可见的规划调用最多请求模型一次，截断、空响应或无效 JSON 会得到可重试的提示。
4. Express 将临时引用映射回真实文件 ID，重新核对候选、字段、算子注册版本以及明确给出的邻接和数值参数。[AnalysisService.createPlan](../../server/src/modules/analysis/service.ts)在同一事务中固定输入指纹、复查场景归属及数值字段，再保存原有协议的 `validated` 计划。场景路由返回 `pending_confirmation` 供界面显示。任务提交仍使用独立的 Run 接口。

真实提供商为 DeepSeek 官方 API，响应模型为 `deepseek-flash`。探测确认 JSON 对象和自动函数调用均可用。这条产品路径选择 JSON 模式，模型所需的只读元数据由 Express 一次提供，服务没有工具调用循环或执行能力。固定依赖为 Python 3.12.13、FastAPI 0.163.1、LangChain Core 1.8.1、LangChain OpenAI 1.8.0、OpenAI SDK 2.54.0、Pydantic 2.14.3 和 Uvicorn 0.54.0，传递依赖见 [锁文件](../../agent_service/uv.lock)。[DeepSeek JSON 输出](https://api-docs.deepseek.com/guides/json_mode/) · [DeepSeek 函数调用](https://api-docs.deepseek.com/guides/tool_calls/)。

## 回归与范围

- Python 契约测试覆盖 Messages、JSON 模式、服务凭据、字段元数据边界、截断、无效输出、超时和限流。Express 固定响应测试覆盖候选范围外或虚构图层、虚构字段、非法算子版本、超限参数、代码字段、模型故障和计数规则回退。
- 芝加哥 311 API 在数值字段歧义时返回澄清，在请求异场景图层时返回 `DATASET_NOT_FOUND`，在请求 SQL 或 DBSCAN 时返回不支持。新旧入口对同一面内分类计数需求都返回规则计划，分类字段为 `category`，排除边界。新增两份计数计划，Run 数仍为 0。空间透视的确认按钮、任务与历史仍沿用原流程。
- Moran/LISA 助手卡片本阶段交付到待确认。工作流持久化、澄清会话恢复和工作台中的 Moran/LISA 执行交互留待后续阶段。
- Compose 五个镜像首次构建成功。Docker Hub 后续查询基础镜像时返回 EOF，验收实例用首次构建的本地镜像更新最终源码和编译产物。8083 保留供浏览。CARTO 底图在验收环境提示需要 Key，规划卡片和数据目录正常工作。
