# WebGIS Data Pivot AI System - Development Rules

在迁移到新的 IDE (如 Cursor, Windsurf) 后，请将以下规则存入全局系统设定或项目的 `.cursorrules` 文件中，以保持大模型对本项目的深刻理解和绝对遵循。

## 1. 🌍 全局项目上下文 (Global Context)
本项目是一个 **AI驱动的地理模型与数据透视服务平台**，旨在将自然语言转化为极其健壮的空间计算算子，并驱动复杂的 WebGIS 可视化。
- **前端架构**: React 18, TypeScript, TailwindCSS, Ant Design, Mapbox GL JS / Maplibre, ECharts (`echarts-for-react`)。
- **BFF 调度层**: Node.js, Express, TypeScript, Axios。负责意图分发调度与前端状态桥接。
- **空间计算基座**: Python (FastAPI, GeoPandas, Pandas)。纯无状态沙盒引擎，专职执行空间算子解析并返回 JSON 化数据。
- **数据库**: PostgreSQL + PostGIS（处理极速矢量切片与核心数据存储）。
- **架构哲学**: "数据与表现完全分离"。禁止由后端生成 HTML DOM 或 Folium 地图；大模型仅输出纯计算逻辑或前端可读的 ECharts Option JSON 状态树；允许 Human-in-the-loop 人机协作闭环。

## 2. 🧠 空间分析架构核心范式 (The 5+1 Spatial Pivot Paradigm)
**🚨 绝对红线：在写任何 Python (GeoPandas) 分析代码时强制遵守！**
不要盲目应用普通的 Pandas 数据透视知识。空间数据透视必须基于『空间拓扑约束』，且包含 **6个标准要素**。

- **空间约束 (Spatial Constraint)**: (如 buffer, intersects, nearest)。
- **透视对象 (Target)**: 主体表 (基准表，即左表)。
- **行维度 (Row)**: 按主表的分类分组。
- **列维度 (Col)**: 关联表的分类字段 (无则为空)。
- **透视方法 (Agg Method)**: (如 size, sum, mean, max, min)。
- **透视字段 (Value)**: 被计算的数值字段。

### 🐍 强制性 Python 代码片段规范 (Snippet Constraint)
无论需求多庞杂，必须使用以下套路对齐逻辑，**绝对禁止使用 `pd.merge` 引发主键崩溃！**

**Step 1: 处理空间约束**
```python
joined = gpd.sjoin(target_gdf, join_gdf, how='inner', predicate='intersects')
```

**Step 2: 聚合处理 (安全分组机制)**
**绝对禁止使用** `.groupby(列名)` 或 `.groupby(target.index.name)`（默认 name 常抛空异常）。
必须利用 `sjoin` 底层必定保留左表索引 (Index) 的天生特性，**直接使用 `level=0` 安全分组**！
```python
# 计数例子：
agg_result = joined.groupby(level=0).size()
# 求和例子：
agg_result = joined.groupby(level=0)['目标字段'].sum()
```

**Step 3: 结果映射 (零损耗绑定)**
利用 Pandas 索引的自动对齐特性直接给原始主表赋值，避开危险的 `pd.merge`。
```python
target_gdf['计算结果'] = agg_result
target_gdf['计算结果'] = target_gdf['计算结果'].fillna(0)  # 必须兜底空值
```

**Step 4: 降维格式化输出**
过滤掉不需要的属性列并丢弃 `geometry` 引擎负担，仅返回前端 UI UI 需要展示的数据透视表列表。

## 3. 🧩 局部代码规约与开发指导 (Local Rules)

### 3.1 LLM 提示词 (Prompting) 开发要求
- 更新任何位于 `llmService.ts` 中的 Prompt 前，务必确保向模型植入上述 **5+1 新范式**，并强制 AI 在代码开始前先使用 `# 注释` 梳理映射，想好了再写代码。

### 3.2 Human-in-the-loop (人机协作)
- 组件 `<GeoAIAgent>` 拥有双通道：
  1. `/api/analysis/agent/generate-model` (LLM意图分解+代码生成)。
  2. `/api/analysis/agent/rerun-code` (绕过大语言模型，将用户的 textarea 代码直传沙盒执行计算与绘图)。
- 新数据落盘时，必须调用 `useAnalysisStore` 将分析态直接渲染进原本的 WebGIS 地图 `<ChartOverlay>`。

## 4. 🚀 遗留代办清单 (Future To-Dos for the Next Session)

这部分是你到达新环境后，首要继续进行的开发工作方向：
1. **多轮对话上下文连贯性支持 (Context Memory)**
   - **痛点预期**：当前执行一次透视后，若说“请再生成雷达图”，系统会丢失之前的执行环境。
   - **重构目标**：前端扩展消息体系，将当前已生成的 `blueprint`（意图蓝图）、`tableData`（原始统计结果）在追问时以 Context 的形式再次发往后端。基于历史蓝图，后端仅需拉起 Step 4(绘图 Agent) 而无需重新执行算子代码。
2. **彻底接入 MVT 矢量瓦片系统**
   - 彻底废弃 Folium 等后端绘图库在海量数据上的使用；确保底层数据接入 PostGIS `ST_AsMVT` 接口；结合 MapLibre GL 达到百万数据下极其顺畅的高亮与图表结合联动展示能力。
