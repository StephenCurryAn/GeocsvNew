---
description: 
---

###拟技术框架逻辑：
第一步：Workspace Schema Mapper (从“单文件感知”升级为“全局视野”)
痛点： 以前大模型只知道当前选中文件长什么样。如果它不知道你工作区里还有“停车场”数据，它根本无法拆解意图。

技术逻辑： 当用户发送那段复杂需求时，Node.js 端的 llmService.ts 不能只提取一个文件的 Schema。它必须从 file_nodes 和 spatial_features 表中，把当前用户（或当前项目）下所有活跃文件的摘要打包发给大模型。

注入给大模型的 Context 示例：

"当前工作区可用数据列表：
[ID: f1, Name: '南京市公园.geojson', Type: Polygon, Columns: ['park_name', 'area']]
[ID: f2, Name: '南京市停车场.geojson', Type: Point, Columns: ['park_id', 'capacity']]
[ID: f3, Name: '南京市路网.geojson', Type: LineString, Columns: ['road_name', 'length']]"

第二步：多模态意图拆解 Router (AI 大脑的核心逻辑)
大模型在接收到全局视野和用户的自然语言后，需要进行极其严密的三维拆解。我们要通过 Prompt 强迫 LLM 输出一个标准化的 JSON 结构。

针对“南京市每个公园周围1000m内谁的停车场最多，并用雷达图展示”这个需求，拆解结果必须长这样：

JSON
{
  "task_type": "cross_layer_spatial_pivot",
  "data_dependencies": [
    {"file_id": "f1", "role": "target_area", "description": "南京市公园"},
    {"file_id": "f2", "role": "spatial_join_points", "description": "南京市停车场"}
  ],
  "operator_code": "# 这里由 LLM 生成使用 GeoPandas 处理两个文件的 Python 逻辑",
  "visualization": {
    "type": "radar_chart",
    "dimension_col": "park_name",
    "metric_col": "parking_count"
  }
}
第三步：Python 算力沙盒的“多源容器化”执行 (你已经有基础了！)
其实在你的 python_engine/main.py 里，你已经极具前瞻性地写了一个 PivotInput 模型，它接收的是 file_ids: List[str]，并在 execute_pivot_only 函数里组装成了 gdf_dict。这就说明你的底层已经具备了跨图层计算的雏形！

执行逻辑（大模型生成的 operator_code 该长什么样？）：

系统会将大模型生成的 Python 代码放入沙盒。对于这个具体的例子，AI 必须懂 GIS 专业知识（尤其是投影变换，这也是你地理空间信息工程专业的强项）：

Python
def execute_pivot(gdf_dict, parameters):
    # 1. 获取动态注入的两个图层
    parks = gdf_dict['f1']
    parking = gdf_dict['f2']
    
    # 2. 空间学核心：为了计算 1000m 缓冲区，必须从 EPSG:4326 转为投影坐标系 (如 EPSG:3857 或 UTM)
    parks_proj = parks.to_crs(epsg=3857)
    parking_proj = parking.to_crs(epsg=3857)
    
    # 3. 构建 1000 米缓冲区
    parks_proj['geometry'] = parks_proj.geometry.buffer(1000)
    
    # 4. 空间连接 (Spatial Join)：找出落入缓冲区内的停车场
    joined = gpd.sjoin(parking_proj, parks_proj, how='inner', predicate='within')
    
    # 5. 数据透视/分组聚合：统计每个公园的停车场数量
    pivot_result = joined.groupby('park_name').size().reset_index(name='parking_count')
    
    # 6. 取 Top 10 防止雷达图爆炸，并转为纯数据字典返回给前端
    top_parks = pivot_result.nlargest(10, 'parking_count')
    return top_parks.to_dict('records')
第四步：数据与可视化的解耦 (Chart Sandbox)
计算阶段： 上面的步骤三只负责在 PostgreSQL 和 GeoPandas 之间狂飙算力，最后吐出的结果是一个干净的 JSON 数组（比如 [{"park_name": "玄武湖公园", "parking_count": 45}, ...]）。

渲染阶段： Node.js 拿到这个数组后，结合第二步拆解出的 radar_chart 指令，调用你 main.py 里的 execute_chart_only，或者直接在前端使用 ECharts 的 Radar 模块进行渲染。

###拟交互逻辑
阶段 1：探索与研发 (AI Sandbox 阶段)
数据勾选： 用户在左侧的文件树中，勾选了“南京市公园”和“南京市停车场”两个图层，将它们加入当前的工作区（Workspace）。

自然语言交互： 用户在右侧的 Agent 对话框输入：“我想计算每个公园周围 1000m 内的停车场数量，取前 10 名并画个雷达图。”

沙盒预览 (Dry Run)：

系统后台大模型（通过意图拆解和 Schema 注入）生成了 GeoPandas 代码，并在沙盒中拿取部分数据执行。

前端弹出预览窗口：左侧显示 AI 写的 Python 逻辑代码，右侧直接展示计算出的表格结果和雷达图。

修正与确认： 用户看了一眼雷达图，说“不对，缓冲区改成 500m 试试”。AI 修改代码再次预览。确认无误后，用户点击一个至关重要的按钮：【注册为模型服务】。

阶段 2：模型固化与服务化 (Model Registry 阶段)
参数化抽离： 系统会自动将代码中的“1000m”提取出来，变成一个可配置的参数 buffer_distance。

存入数据库： 这段代码和参数定义被永久写入你数据库的 models_registry 表中，并命名为“公园周边设施统计模型”。

热加载引擎生效： Python 端的 MODEL_REGISTRY 字典动态挂载了这个新算子，它现在成为了系统自带的 API 接口。

阶段 3：沉淀为 UI 按钮 (普通用户阶段)
这也是回答你疑惑的最关键一步。对于后续的其他用户，或者换了一批数据（比如上海市公园和公厕），他们就不需要再打字和 AI 聊天了！

用户打开系统的“模型工具箱”面板。

里面出现了一个名为【公园周边设施统计】的卡片（这就是前面固化下来的成果）。

用户点击卡片，弹出一个极其清爽的 UI 表单：

选择中心点数据： [下拉框选：上海公园]

选择目标数据： [下拉框选：上海公厕]

分析范围 (米)： [输入框：500]

用户点击【执行计算】，系统底层直接调用 Python 引擎中被挂载的那个算子，极速返回结果。