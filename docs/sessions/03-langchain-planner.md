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

## 原评审记录 · 专业模型的规划信息

当前 Python 的 `SystemMessage` 同时包含通用规划指令、Moran/LISA 和空间透视的业务语义、默认参数及示例。随着专业模型增多，这段提示词可能要随每次模型接入改动，且其中的默认值可能与 Express 算子代码产生偏差。示例使用的 `layer_1` 也是临时引用，在不同请求里对应不同图层。

用户提出，每个专业模型应有自己可登记的信息，例如能力说明、输入图层与字段要求、参数约束和默认值。待主会话评审，这些信息是否由现有算子注册表统一提供，运行时怎样把适用算子的信息交给 LangChain，以及通用 `SystemMessage`、Pydantic 草案结构和 Express 业务校验各自承担哪些职责。此处记录疑问，架构方案待评审。

## 2026-11-17 · 算子目录复验

在公共基线 `7812a9e` 上完成。GeoCSV 采用 NeoGIS 的版本化算子目录思路。两个算子分别登记能力、别名、图层和字段角色、版本及参数定义。目录保留完整 Plan Spec 的 Schema 引用，并提供模型可填写的参数定义。Moran/LISA 用同一份参数定义生成候选、校验草案和解析现有 Plan Spec。[NeoGIS 模型注册表](https://github.com/GeoScenarioScripter/neogis-server-micro-service/blob/1edf89032e5a5e379563d15b4c22f8f586fe83b8/ngis-geoanalysis/ngis_geoanalysis/registry/tool_registry.py) · [NeoGIS 模型检索](https://github.com/GeoScenarioScripter/neogis-server-micro-service/blob/1edf89032e5a5e379563d15b4c22f8f586fe83b8/ngis-ai/ngis_ai/tools/retrieval_tools.py) · [Moran/LISA 注册](../../server/src/modules/operators/moranLisa.ts) · [空间透视注册](../../server/src/modules/operators/spatialPivot.ts)

[规划客户端](../../server/src/integrations/agent/client.ts)按算子名称、输入几何和字段要求准备候选，把每个角色的 `eligibleRefs` 放入 `HumanMessage`。点名 Moran/LISA 时，芝加哥 311 请求点图层被筛出，两个社区面图层保留。`SystemMessage` 提供通用选择与澄清规则。Python 校验 `operator`、`inputs`、`parameters` 的结构，Express 复查版本和输入引用，再由注册项校验用户明确给出的参数并补足缺项。[通用提示与调用](../../agent_service/planner.py) · [私有草案契约](../../agent_service/contracts.py) · [保存待确认计划](../../server/src/modules/analysisPlanner/sceneRouter.ts)

在 [独立实例](http://127.0.0.1:8083/) 选择 Chicago 311，保留图层未选中，展开「空间分析助手 → 自然语言」，依次输入以下两句并点击「规划分析」。

1. 用 Chicago-311-community-counts 图层的 pothole_requests 做 Moran/LISA，采用 Queen 邻接，199 次置换
2. 对同一图层的 pothole_requests 用 Rook 共边邻接计算空间自相关

| 验收项 | 实际参数 | 计划 ID | 证据 |
| --- | --- | --- | --- |
| 浏览器 Queen | `queen`，199 次，种子 42 | `3d7049ae-05a5-4273-a4d8-14f4d14ec58b` | [截图](../screenshots/phase3-catalog-chicago-queen.jpg) |
| 浏览器 Rook | `rook`，199 次，种子 42 | `9bd317d9-8019-4cec-9649-9c3d017e7211` | [截图](../screenshots/phase3-catalog-chicago-rook.jpg) |
| API 明确给 0 | `rook`，0 次，种子 0 | `25560745-3e1b-46f3-94c3-266696a084d8` | [计划](http://127.0.0.1:8083/api/analysis/plans/25560745-3e1b-46f3-94c3-266696a084d8) |

三条计划均由 DeepSeek `deepseek-flash` 规划。算子为 `spatial_autocorrelation@2`，图层 ID 为 `b64dacd7-fdf4-4ee0-a71f-8c80eda1b37e`，77 个面，字段为 `pothole_requests`，数据库记录的确认时间均为空。10000 次置换和同时指定 Queen/Rook 均返回澄清，跨场景引用返回 `DATASET_NOT_FOUND`。旧计数入口仍生成 `category` 分组、排除边界的规则计划。四份有效计划让 Plan 从 6 增至 10，Run 保持为 0。

固定响应测试还让模型在用户省略置换次数和种子时返回 `123`、`99`，保存值仍为目录默认的 `199`、`42`。中文及英文显式 `0` 均被保留。第三个测试算子「点抽样」经同一通用提示、Python 草案契约和 Express 路由生成计划，按其角色只看到点图层。服务端 23 项、Python 6 项、前端分析历史 3 项测试和 13 份协议样例通过，前后端构建通过。GHCR 在最终重建时鉴权超时，8083 使用本轮已构建镜像和最终服务端编译产物完成部署。

### Rook 请求怎样流过新契约

以下为脱敏的契约示例，字段和有效参数对照已保存的 Rook 计划。服务日志记录状态与用量。额外抓取完整模型草案的复送遇到提供商连接错误。

```json
{
  "userPrompt": "对同一图层的 pothole_requests 用 Rook 共边邻接计算空间自相关",
  "datasets": [
    { "ref": "layer_1", "name": "Chicago-311-community-counts.geojson", "numericFields": ["community_id", "pothole_requests", "total_requests"] },
    { "ref": "layer_2", "name": "Chicago-community-areas.geojson", "numericFields": ["community_id"] }
  ],
  "operators": [{
    "id": "spatial_autocorrelation", "version": 2, "eligibleRefs": { "target": ["layer_1", "layer_2"] },
    "planningParameters": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "contiguity": { "type": "string", "enum": ["queen", "rook"], "default": "queen" },
        "permutations": { "type": "integer", "minimum": 0, "maximum": 9999, "default": 199 },
        "seed": { "type": "integer", "minimum": 0, "maximum": 4294967295, "default": 42 }
      }
    }
  }],
  "history": { "operator": { "id": "spatial_autocorrelation", "version": 2 }, "inputs": { "target": "layer_1" } }
}
```

```json
{
  "status": "ready",
  "operator": { "id": "spatial_autocorrelation", "version": 2 },
  "inputs": { "target": { "ref": "layer_1", "fields": { "valueField": "pothole_requests" } } },
  "parameters": { "contiguity": "rook" }
}
```

Express 用本次引用表还原目标文件 ID，核对字段和明确请求的 Rook，使用注册项的 199 与 42 补足缺项，然后保存 [Rook 计划](http://127.0.0.1:8083/api/analysis/plans/9bd317d9-8019-4cec-9649-9c3d017e7211)。
