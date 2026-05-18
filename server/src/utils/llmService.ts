import OpenAI from 'openai';
import dotenv from 'dotenv';
import { ProxyAgent, setGlobalDispatcher } from 'undici'; // 引入 ProxyAgent

dotenv.config();

// ================= [核心网络修复] =================
// 强行把 Node.js 底层的请求路由到你 curl 跑通的那个代理端口上
const proxyUrl = process.env.https_proxy || process.env.http_proxy || 'http://127.0.0.1:33210';
const proxyAgent = new ProxyAgent(proxyUrl);
setGlobalDispatcher(proxyAgent);
// ==================================================

const apiKey = process.env.ALIYUN_API_KEY;
console.log(`\n[系统自检] 正在读取 .env 文件...`);
console.log(`[系统自检] ALIYUN_API_KEY 加载状态: ${apiKey ? '成功 (以 ' + apiKey.substring(0, 5) + ' 开头)' : '【失败】未找到该变量！'}`);
console.log(`[系统自检] 已强制挂载网络代理: ${proxyUrl}`); // 确认代理已注入

const openai = new OpenAI({
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: apiKey, 
    timeout: 180 * 1000, 
});

export interface AIGeneratedModel {
    modelName: string;
    displayName: string;
    description: string;
    requiredColumns?: string[];
    parameters: Array<{ name: string; type: string; description: string }>; 
    pythonCode: string;
}

const SYSTEM_PROMPT = `
你是一位顶尖的 WebGIS 算法工程师与空间统计学专家。你的任务是根据用户的自然语言需求，抽象并封装一个通用的地理空间分析模型。

【 交互逻辑转变（极其重要）】
你生成的代码必须是**高度通用、可复用的算子**。绝对不要把具体的列名写死在 Python 代码里！
需要在 \`parameters\` 中定义这个模型需要哪些列，并在 Python 代码中通过 \`parameters.get('参数名')\` 动态读取。如果是诸如“计算每个要素周长/面积”等不需要外部参数的基础几何计算，parameters 可以为空数组 []。

【严格的输出规范】
你必须且只能输出一个合法的 JSON 对象。绝对不要包含任何 Markdown 标记（不要使用 \`\`\`json 包装），绝对不要输出多余的思考过程、废话或开头结尾的客套话！你的输出必须直接以 { 开始，以 } 结束。
JSON 的结构必须严格如下：
{
  "modelName": "推导出的模型英文名，全大写字母，用下划线分隔，如 GEO_DETECTOR",
  "displayName": "推导出的模型中文名，如 地理探测器(因子探测)",
  "description": "对算法逻辑的简短中文描述，不超过50个字",
  "parameters": [
      { 
        "name": "y_column", 
        "type": "column", 
        "displayName": "因变量(Y)列名",
        "description": "请选择要分析的目标变量列，必须是连续数值型。" 
      }
  ],
  "pythonCode": "完整的纯 Python 代码字符串，注意代码内部的换行符必须严谨转义 (\\\\n)"
}

【Python 代码编写 架构逻辑（必读！！！）】
1. 必须且只能包含一个主执行函数：\`def execute(df, parameters):\`
2. \`parameters\`: 这是一个字典，包含了用户在前端传入的动态列名或数值。
   - 必须通过 \`col_name = parameters.get('y_column')\` 获取。
3. \`df\`: 代表底层引擎传入的 GeoDataFrame 数据。
   - 【极其重要的脏数据处理原则】：必须先将无效的 0、空字符串替换为 np.nan。
4. 【专业地理空间避坑指南】：
   - **严禁静默吞噬错误**：不允许使用 \`except Exception: pass\`，必须打印错误。
   - **优先使用 Pandas 向量化操作**。
   - **【极其重要】几何计算必须先投影**：如果要求计算**距离、长度（周长）或面积**，必须先使用 \`df.to_crs(df.estimate_utm_crs())\` 将其转换为以米为单位的局部 UTM 投影坐标系后，再进行几何计算！例如：\`projected_gdf = df.to_crs(df.estimate_utm_crs()); length = projected_gdf.geometry.length\`。
5. **【强制】返回值必须是字典 (Dictionary) 且长度绝对对齐**：
   - Key 是新增列名，Value 是一维 Python List 或 Pandas Series，且长度【必须与传入的 df 行数一致】！
`;

export const generateModelCodeFromAI = async (userPrompt: string): Promise<AIGeneratedModel> => {
    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-v3", 
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: `请根据以下需求设计并编写模型：\n${userPrompt}` }
            ],
            temperature: 0.1, 
            max_tokens: 5000,
        });

        let rawContent = response.choices[0].message.content || "{}";
        console.log("\n[LLM 原始返回内容]：\n", rawContent); 

        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("大模型返回的内容中找不到合法的 JSON 结构。");
        }
        
        let extractedJsonStr = jsonMatch[0];

        //   删掉之前那个 replace(/\\n/g, "\\\\n")，直接让 JSON 原生解析
        const parsedData = JSON.parse(extractedJsonStr) as AIGeneratedModel;
        
        if (!parsedData.modelName || !parsedData.pythonCode) {
            throw new Error("AI 返回的数据结构缺失关键字段 modelName 或 pythonCode");
        }

        // ================= [核心修复：给 Python 代码洗澡] =================
        let cleanPythonCode = parsedData.pythonCode;
        
        // 1. 如果大模型在字符串首尾加了 ```python 和 ```，无情扒掉它！
        cleanPythonCode = cleanPythonCode.replace(/^```python\s*/i, '');
        cleanPythonCode = cleanPythonCode.replace(/^```\s*/, '');
        cleanPythonCode = cleanPythonCode.replace(/```\s*$/i, '');

        // 2. 如果字符串里有字面量 "\\n" (由于大模型转义过度)，强制还原为真实换行符
        cleanPythonCode = cleanPythonCode.split('\\n').join('\n');

        // 3. 剔除首尾的空白字符
        cleanPythonCode = cleanPythonCode.trim();

        // 将洗干净的代码重新赋给对象
        parsedData.pythonCode = cleanPythonCode;
        // ===================================================================

        return parsedData;

    } catch (error: any) {
        console.error("\n[GeoAI Agent 错误] 生成模型代码失败:", error.message || error);
        throw new Error(`AI 智能体未能生成合法的模型代码，原因：${error.message || '格式解析失败'}。请调整指令后重试。`);
    }
};

export interface WorkflowBlueprint {
    task_type: string;
    reuse_code?: boolean;
    data_dependencies: Array<{
        file_id: string;
        role: string;
        description: string;
        type: string;
    }>;
    parameters: Array<{
        name: string;
        type: string;
        defaultValue: any;
        description: string;
    }>;
    visualization_spec: {
        engine?: string;
        chart_type: string;
        chart_library?: string;
        dimensions: string[];
        metrics: string[];
    };
    explanation: string;             
}

const cleanCodeBlock = (rawContent: string): string => {
    const blockMatch = rawContent.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
    if (blockMatch && blockMatch[1]) {
        return blockMatch[1].trim();
    }
    // const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    // if (jsonMatch) {
    //     return jsonMatch[0].trim();
    // }
    return rawContent.trim();
};

export const planWorkflow = async (userPrompt: string, availableFiles: any[], context?: any, agentMode: string = 'pivot'): Promise<WorkflowBlueprint> => {
    const filesInfo = availableFiles.map(f => `- 文件ID: ${f.fileId}, 名称: ${f.name}, 几何类型: ${f.geomType}, 字段包含: [${f.columns?.join(', ')}]`).join('\n');
    
    // 动态根据模式调整规划器的 Prompt
    let modeInstruction = ``;
    if (agentMode === 'feature_calc') {
        modeInstruction = `【特征计算模式】：你的目标是规划一个“特征计算”任务，将结果作为新列追加到 target_gdf 中。`;
    } else if (agentMode === 'pro_model') {
        modeInstruction = `【专业模型模式】：你的目标是调用高级空间统计模型（如地理探测器）。必须返回一个独立的分析结果表格（List of Dict），不需要保留原始的几何或 id 列。`;
    } else {
        modeInstruction = `【数据透视模式】：你的目标是规划一个“聚合透视”任务。`;
    }

    const contextPrompt = context 
    ? `\n\n【注意：历史执行上下文 (Context Memory)】:\n用户之前执行了以下操作：\n${JSON.stringify(context, null, 2)}\n\n用户的当前对话很可能是针对上述上下文的补充修改，例如“请再次生成雷达图”、“将结果换成热力图”。如果判定用户的意图不需要改变底层数据透视逻辑，请在你的返回 JSON 中加入 "reuse_code": true，并调整对应图表的 \`visualization_spec\` 即可。`
    : "";

    const PLANNER_PROMPT = `
你是一位顶尖的 WebGIS 数据分析架构师（Planner Agent）。
你的任务是将用户的自然语言需求，基于当前工作区可用的图层 Schema，严格拆解为标准化的执行蓝图 (Blueprint)。

${modeInstruction}

【当前可用的图层数据集】：
${filesInfo || '暂无详细表结构，请根据用户描述推断'}
${contextPrompt}

【 任务分析规范】：
1. 绝对不要写任何 Python 代码。
2. 必须且只能输出一个合法的 JSON 对象。绝对不要包含 \`\`\`json 等 Markdown 包裹符。
3. 请考虑多轮对话的连贯性。如果用户是"追问"或者要求"换个图表/仅改变渲染维度"，你只需修改 visualization_spec，并输出 "reuse_code": true 即可，无需重新定义数据抽取！
4. 请严格按照以下 JSON Schema 输出：
5. 【绝对红线】：在生成 parameters 或 visualization_spec 的 metrics/dimensions 时，引用的字段名【必须 100% 照抄原数据集中的真实列名】（如"威胁财"），绝对禁止自作主张将其翻译为英文！
【JSON 语法绝对红线】：
你生成的必须是标准的、可被严格 JSON.parse() 解析的格式。
绝对禁止在 JSON 数组或数值中使用 Infinity、-Infinity 或 NaN！
如果用户的需求中包含“以上”、“最大”等无穷大的开区间概念（例如：2000米以上），请统一使用极其安全的超大普通整数 999999 来代替无穷大！

{
  "task_type": "任务类型，例如 spatial_join_pivot, buffer_analysis, chart_modification 等",
  "reuse_code": true, // 若仅判定为图表更换/属性过滤且计算逻辑不变，设为 true。否则省略或 false。
  "data_dependencies": [
    {
      "file_id": "被选中的文件ID",
      "role": "该文件在计算中的角色, 必须为以下三者之一：1. TargetLayer (要进行分组/透视统计的主体图层，如滑坡点)；2. JoinLayer (被关联的客体图层)；3. ConstraintLayer (仅提供空间范围过滤边界的图层，例如用于筛选出'凉山州'的行政边界图层)",
      "type": "数据类型，如果是栅格数据(如.tif文件、高程DEM、土地利用CLCD等)必须填 Raster，矢量数据填 Vector",
      "description": "简短描述该数据用途"
    }
  ],
  "spatial_predicate": "空间关系模式，例如 within (包含), intersects (相交), nearest (最近邻), buffer_intersects (缓冲相交)",
  "parameters": [
    {
      "name": "需要被抽离的通用参数名，例如 buffer_radius",
      "type": "参数类型如 number, string",
      "defaultValue": 1000,
      "description": "参数描述"
    }
  ],
  "visualization_spec": {
    "engine": "【严格路由分类】：如果需求涉及基础准则数据分析图表（如柱状图、折线图、饼图、雷达图、散点图等），【强制填写 'echarts'】。绝对不要生成 HTML！只有当用户要求极度复杂的高度定制空间专题相关图时，才可使用 'html_iframe'。",
    "chart_type": "图表类型",
    "chart_library": "如果 engine 是 'html_iframe'，请明确指定绘图底层库：'plotly'（用于旭日图、树状图、3D散点等统计与抽象图表）或 'folium'（用于带真实街道底图的交互式地图）。如果 engine 是 'echarts'，填 null。",
    "dimensions": ["展示维度的输出列名（X轴/类目）"],
    "metrics": ["要统计展示的数据列名（Y轴/数值）"]
  },
  "explanation": "你对整个拆解逻辑的简短解释"
}
`;

    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-v3", // 统一修改为 deepseek-v3
            messages: [
                { role: "system", content: PLANNER_PROMPT },
                { role: "user", content: `用户的需求是：\n${userPrompt}` }
            ],
            temperature: 0.1,
        });

        const rawContent = response.choices[0].message.content || "{}";

        let resultStr = cleanCodeBlock(rawContent);
        
        // 只在 Planner 节点尝试提取 JSON
        if (!resultStr.startsWith('{')) {
            const jsonMatch = resultStr.match(/\{[\s\S]*\}/);
            if (jsonMatch) resultStr = jsonMatch[0];
        }

        return JSON.parse(resultStr) as WorkflowBlueprint;
    } catch (error) {
        console.error("拆解节点解析失败:", error);
        throw new Error("规划失败，请检查需求描述。");
    }
};

export const generatePivotCode = async (blueprint: WorkflowBlueprint, availableFiles: any[] = []): Promise<string> => {
    // 组装真实的表结构字典，给大模型开启上帝视角
    let filesInfoStr = "暂无详细表结构";
    if (availableFiles && availableFiles.length > 0) {
        filesInfoStr = availableFiles.map(f => `- 文件ID: ${f.fileId}, 真实可用字段: [${f.columns?.join(', ')}]`).join('\n');
    }
    // 1. 提取引擎路由
    const engine = blueprint.visualization_spec?.engine || 'echarts';
    // 2. 基础 Prompt (SDK与5+1原则)
    const BASE_PROMPT = `
你是一位高级 GeoAI 空间调度工程师。
系统底层已经为你内置了绝对安全的领域特定算子库 (GeoPivot SDK)。
你的任务是：根据用户的【执行蓝图】，严格进行【5+1 意图映射】，并组合调用 SDK 完成计算。
【执行蓝图】：
${JSON.stringify(blueprint, null, 2)}

【当前可用的图层真实数据字典 (极其重要)】：
${filesInfoStr}

【绝对红线（违反必导致系统崩溃！）】：
1. 【列名红线】：绝对禁止臆造英文列名（如 'name'、'city'）！你必须且只能从上方的【真实数据字典】中挑选正确的中文列名！
2. 【参数红线】：在运行时 parameters 字典始终为空 {}！绝对禁止在代码里写 parameters['xxx']！蓝图中的过滤条件（如 '巴中市'），必须直接硬编码为字符串！
3. 【字符过滤红线】：使用 .str.contains 之前，必须强制类型转换并开启 na=False。标准语法：df['真实列名'].astype(str).str.contains('巴中', na=False)
4. 【几何合并红线】：求 union 时，必须显式调用 .geometry.unary_union。标准语法：limit_geom = df[mask].geometry.unary_union
"5. 【多指标红线】：如果用户要求统计多个指标（如总数和平均值），你必须在 groupby 后面使用 .agg()。" +
"例如：agg_df = target_gdf.groupby(row_col).agg(count_val=('any_col','size'), avg_height=('height_col','mean'))"

【核心决策：属性透视 vs 空间透视（绝对红线）】
在写代码前，请根据蓝图中的数据依赖数量和意图做出判断：
情境A【纯属性透视】：如果蓝图仅包含 1 个图层，或者只是对网格已有的分类字段（如坡度等级）和数值字段（如滑坡数量）进行普通统计展示。
   - 绝对禁止使用 safe_intersects 等任何空间算子！
   - 绝对禁止使用 safe_aggregate！
   - 必须直接使用 Pandas 原生的 .groupby() 进行分组聚合！
情境B【空间跨层透视】：如果蓝图明确包含 2 个不同图层（如面和点），且需要根据空间位置统计。
   - 必须调用空间连接算子（如 safe_intersects），再调用 safe_aggregate 计算。

【SDK 核心算子 API 文档】（仅在情境B中使用，已隐式 import，可直接调用）：
1. 空间连接算子：
   - safe_buffer_intersects(target_gdf, join_gdf, radius) -> 返回安全的相交 GeoDataFrame
   - safe_intersects(target_gdf, join_gdf) -> 面与面/线与面的精确相交
   - safe_within_contains(target_gdf, join_gdf, relation='within'或'contains')
   - safe_nearest(target_gdf, join_gdf, max_distance=None)
   注意：面包含点必须用 relation='contains'！点被面包含用 relation='within'。
   【拓扑传参绝对红线】：绝对禁止互换 target_gdf 和 join_gdf 的传入顺序！target_gdf 必须永远作为第一个参数，以保证左表索引不丢失！
   - 举例：如果 target_gdf 是面（区县），join_gdf 是点（POI），为了判断面包含点，必须写：safe_within_contains(target_gdf, join_gdf, relation='contains')，
           或者直接用 safe_intersects(target_gdf, join_gdf)！绝对不许把 join_gdf 写在前面！

2. 智能数据聚合：safe_aggregate(joined_gdf, agg_method, value_col=None, col_dim=None)
3. 坐标提取算子：
   - safe_get_centroid_coords(gdf, x_col='lon', y_col='lat') -> 返回增加了坐标列的 GeoDataFrame
   注意：专门用于为前端绘图提供精确的 X/Y 经纬度。它会自动计算多边形/线的质心并转换为 WGS84 经纬度。

【大模型红线：5+1 空间数据透视核心范式 (The 5+1 Spatial Pivot Paradigm)】
不要盲目应用普通的 Pandas 数据透视知识。空间数据透视必须基于『空间拓扑约束』，且基于6个标准要素：
1. 空间约束 (Spatial Constraint)：
   - 拓扑连接：如 buffer, intersects, nearest (用于 TargetLayer 和 JoinLayer 之间)。
   - 空间过滤/裁剪 (极其重要)：如果蓝图中存在 ConstraintLayer (如某州市的行政边界)，你必须先使用属性查询找到该边界 (如 "limit_geom = constraint_gdf[constraint_gdf['某列名'].str.contains('凉山')].unary_union")，然后使用 "target_gdf = target_gdf[target_gdf.geometry.intersects(limit_geom)]" 将目标图层过滤出该范围，然后再进行后续透视！
2. 透视对象 (Target)：作为主体的主表（基准表，即左表）。
3. 行维度 (Row)：按主表的分类分组（处理时必须依托主表的 Index）。
4. 列维度 (Col)：是否需要将关联表的某个分类字段展开（无则为空）。
5. 透视方法 (Agg Method)：如 size, sum, mean。
6. 透视字段 (Value)：对哪个字段进行计算。

在执行核心逻辑前，你【必须首先使用多行注释】写出完整的要素梳理：
# 【意图映射】
# 透视对象(Target): ...
# 空间约束: ...
# 行维度(Row): ...
# 列维度(Col): ...
# 透视方法: ...
# 透视字段: ...

    `;
    // 3. ECharts 专用的数据契约 
    const ECHARTS_CONTRACT = `
【前端数据流规范 (极度重要)】：
你返回的 DataFrame 必须严格符合 React 前端的数据格式，否则前端图表无法渲染！
1. 提取合并：绝对不要把 target_gdf 的所有列都 join 进来！必须只提取【行维度列】与 agg_result 进行 join！
2. 规范命名：必须将【行维度列】重命名为 'rowKey'！
3. 纯净输出：返回值绝对不能包含 'geometry'、'id' 等无关属性！

【执行与代码规范】：
1. 第一步写出 #【5+1 意图映射】 注释。
2. 将数据中的空值/0替换为 np.nan。
3. 调用一个空间连接算子得到 joined。
4. 调用 safe_aggregate，并将结果与主表进行 join 合并。
   写法范例：\`result_gdf = target_gdf.join(safe_aggregate(joined, agg_method='size', col_dim=parameters.get('col_dim'))).fillna(0)\`
5. 返回不含 geometry 列的纯 DataFrame 数据。

# 极致简洁的标准 Few-Shot 示例代码：
def execute_pivot(gdf_dict, parameters):
    target_gdf = gdf_dict['target_id'].copy().replace(['', 0], np.nan)
    join_gdf = gdf_dict['join_id'].copy().replace(['', 0], np.nan)
    
    # 1. 空间拓扑 (例如：区县面 包含 风景名胜点)
    joined = safe_within_contains(target_gdf, join_gdf, relation='contains')
    
    # 2. 智能聚合 (传入 col_dim 可自动触发二维透视)
    agg_result = safe_aggregate(
        joined, 
        agg_method='size', 
        col_dim=parameters.get('col_dim'),
        value_col=parameters.get('value_col')
    )
    
    # 3.强制规范降维：仅选择行维度列参与合并，杜绝冗余字段！
    # 请根据蓝图中的【行维度(Row)】动态推断此处的实际列名（例如 'NAME'、'区县' 等）
    row_dim_col = '这里填入推断出的行维度真实列名' 
    final_gdf = target_gdf[[row_dim_col]].join(agg_result).fillna(0)
    
    # 4. 强制重命名：将行维度列名改为 'rowKey'，适配前端 ECharts 引擎
    final_gdf.rename(columns={row_dim_col: 'rowKey'}, inplace=True)
    
    return pd.DataFrame(final_gdf)

# 示例 2：带空间范围约束的二维交叉透视 (极其重要！)
def execute_pivot(gdf_dict, parameters):
    target_gdf = gdf_dict['target_id'].copy() 
    constraint_gdf = gdf_dict['constraint_id'].copy()
    
    # 1. 提取空间约束范围并过滤
    mask = constraint_gdf['真实的市州列名'].astype(str).str.contains('巴中', na=False)
    if mask.any():
        limit_geom = constraint_gdf[mask].geometry.unary_union
        target_gdf = target_gdf[target_gdf.geometry.intersects(limit_geom)]
    
    # 2. 纯属性二维聚合 (无需再做 safe_intersects)
    row_col = '真实的行维度列名'
    col_dim = '真实的列维度列名'
    value_col = '真实的数值列名' 
    
    if value_col and value_col in target_gdf.columns:
        target_gdf[value_col] = pd.to_numeric(target_gdf[value_col], errors='coerce')
        agg_df = target_gdf.groupby([row_col, col_dim])[value_col].sum().unstack(fill_value=0)
    else:
        agg_df = target_gdf.groupby([row_col, col_dim]).size().unstack(fill_value=0)
    
    agg_df.index.name = 'rowKey'
    final_df = agg_df.reset_index()
    
    # 【核心重构】：返回字典，把透视结果和过滤后存活的网格 ID 列表一起返回！
    return {
        "chart_data": final_df,
        "valid_ids": target_gdf['id'].tolist() if 'id' in target_gdf.columns else []
    }

# 示例 3：带空间范围约束的 多指标/单指标 透视 (极其重要！)
def execute_pivot(gdf_dict, parameters):
    target_gdf = gdf_dict['target_id'].copy() 
    
    # 1. 空间过滤逻辑 (如果蓝图中有 constraint_id)
    if 'constraint_id' in gdf_dict:
        constraint_gdf = gdf_dict['constraint_id'].copy()
        mask = constraint_gdf['真实的行政区列名'].astype(str).str.contains('推断的城市名', na=False)
        if mask.any():
            limit_geom = constraint_gdf[mask].geometry.unary_union
            target_gdf = target_gdf[target_gdf.geometry.intersects(limit_geom)]
    
    # 2. 数据安全清洗 (绝对禁止对整个 gdf 使用 replace，必须针对具体列！)
    row_col = '真实的行维度列名'
    target_gdf[row_col] = target_gdf[row_col].fillna('未知') 
    
    # 如果用户要求对连续数值分段 (如“年代段”、“高度段”)，使用 pd.cut 进行安全分箱
    # target_gdf[row_col] = pd.cut(pd.to_numeric(target_gdf[row_col], errors='coerce'), bins=[0, 10, 20, 30, float('inf')], labels=['0-10', '10-20', '20-30', '30+'])
    
    # 将需要计算均值、总和的指标列，强制转为数值型，错误的值转为 NaN
    target_gdf['真实的建筑高度列名'] = pd.to_numeric(target_gdf['真实的建筑高度列名'], errors='coerce')
    
    # 3. 核心透视逻辑
    # 【情况 1：如果是多指标统计（如：统计总数量和平均高度）】--> 必须使用 .agg()
    # 注意：统计 size 时必须使用刚刚转为数值的安全列！
    agg_df = target_gdf.groupby(row_col).agg(
        建筑总数量=('真实的建筑高度列名', 'size'), 
        平均高度=('真实的建筑高度列名', 'mean')
    )
    
    # 【情况 2：如果是单指标二维交叉透视】--> 使用 unstack()
    # col_dim = '真实的列维度列名'
    # agg_df = target_gdf.groupby([row_col, col_dim])['真实的数值列名'].sum().unstack(fill_value=0)
    
    # 4. 强制重命名索引为 rowKey 并重置索引
    agg_df.index.name = 'rowKey'
    final_df = agg_df.reset_index()
    # 剔除 rowKey 为空或未知的脏数据
    final_df = final_df[final_df['rowKey'].astype(str) != 'nan']
    
    return {
        "chart_data": final_df,
        "valid_ids": target_gdf['id'].tolist() if 'id' in target_gdf.columns else []
    }
`;
    // 4. HTML/Iframe 专用的数据契约 (保留层级)
    const IFRAME_CONTRACT = `
【数据流规范 (Python 复杂交互制图专用)】：
因为后续节点需要使用 Plotly/Folium 绘制复杂层级图表或地图，必须保留真实的维度名称和空间坐标。你必须：
1. 绝对不要重命名任何列为 'rowKey'！请保留原始字段名。
2. 【极其重要】：如果使用了 \`safe_aggregate\` 进行了二维聚合（传入了 col_dim），你**必须**先将其与 \`target_gdf\` 的【行维度列】关联，然后调用 \`.melt()\` 将其还原为扁平化的明细表。
3. 【坐标提取红线】：如果后续绘图需要用到空间坐标，你必须在去除 geometry 之前，调用 \`target_gdf = safe_get_centroid_coords(target_gdf, 'lon', 'lat')\` 从底层几何中安全提取真实的经纬度！
4. 【终极清洗】：最后必须去除底层的几何列（可能名为 'geom' 或 'geometry'），返回纯 DataFrame。

# 示例代码：
def execute_pivot(gdf_dict, parameters):
    target_gdf = gdf_dict['target_id'].copy().replace(['', 0], np.nan)
    join_gdf = gdf_dict['join_id'].copy().replace(['', 0], np.nan)
    
    # 提取真实的经纬度坐标用于绘图
    target_gdf = safe_get_centroid_coords(target_gdf, x_col='lon', y_col='lat')
    
    # 空间拓扑与聚合
    joined = safe_within_contains(target_gdf, join_gdf, relation='contains')
    agg_result = safe_aggregate(joined, agg_method='size', col_dim=parameters.get('col_dim'))
    
    # 关联并扁平化
    row_dim_col = '推断的行维度列名' 
    merged_df = target_gdf[[row_dim_col, 'lon', 'lat']].join(agg_result).fillna(0)
    flat_df = merged_df.melt(id_vars=[row_dim_col, 'lon', 'lat'], var_name='列维度名', value_name='count')
    
    #   必须同时 Drop 掉 geom 和 geometry
    return pd.DataFrame(flat_df).drop(columns=['geom', 'geometry'], errors='ignore')
`;
    
    const FINAL_INSTRUCTION = `
【执行与代码输出规范】(极其重要)：
1. 你必须首先使用多行注释写出 #【5+1 意图映射】。
2. 你必须包含并实现主函数 \`def execute_pivot(gdf_dict, parameters):\`。
3. 严格遵守上面的数据流规范（重命名降维 或 扁平化）。
4. 你的输出必须是纯粹的 Python 代码，绝对不要使用 \`\`\`python ... \`\`\` 这种 Markdown 标签包裹！只输出代码本身！不要输出任何多余的解释！
`;

    // 5. 动态路由组装 Prompt
    const PIVOT_CODER_PROMPT = BASE_PROMPT + (engine === 'html_iframe' ? IFRAME_CONTRACT : ECHARTS_CONTRACT) + FINAL_INSTRUCTION;
    
    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-v3", // 统一修改为 deepseek-v3
            messages: [
                { role: "system", content: PIVOT_CODER_PROMPT },
                { role: "user", content: "请开始编写健壮的空间透视Python代码" }
            ],
            temperature: 0.1,
            max_tokens: 6000,
        });

        return cleanCodeBlock(response.choices[0].message.content || "");
    } catch (error) {
        console.error("Pivot Coder 生成失败:", error);
        throw new Error("AI 生成数据透视代码失败。");
    }
};

export const fixPivotCode = async (blueprint: any, buggyCode: string, errorTraceback: string): Promise<string> => {
    const CODE_FIXER_PROMPT = `
你是一个极其资深的 GeoPandas 修复专家 (The Code Fixer Agent)。
刚才生成的空间透视代码在沙盒中运行崩溃了，请你担任专业的审查员，排查报错堆栈并返回修正后的纯 Python 代码。

【1. 架构师意图蓝图 (Blueprint)】:
${JSON.stringify(blueprint, null, 2)}

【2. 崩溃的异常代码 (Buggy Code)】:
\`\`\`python
${buggyCode}
\`\`\`

【3. Python 沙盒真实报错 (Traceback)】:
\`\`\`text
${errorTraceback}
\`\`\`

【修复红线 - 系统已内置 SDK】：
沙盒中已全局注入了以下安全算子，你绝对不能手写底层 GeoPandas 方法（如 sjoin、buffer），必须直接调用：
1. \`safe_buffer_intersects(target_gdf, join_gdf, radius)\` -> 返回相交后的 GeoDataFrame
2. \`safe_aggregate(joined_gdf, agg_method, value_col=None)\` -> 返回安全聚合后的 Series

请分析报错原因（如参数类型不对、字典键错误等），重新调用 SDK 编写完整的 \`def execute_pivot(gdf_dict, parameters):\` 函数。
只输出纯 Python 代码，绝对不要包含 \`\`\`python 标签！
`;

    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-v3",
            messages: [
                { role: "system", content: CODE_FIXER_PROMPT },
                { role: "user", content: "请进行代码纠错自愈并仅返回纯代码" }
            ],
            temperature: 0.2, 
            max_tokens: 6000,
        });

        return cleanCodeBlock(response.choices[0].message.content || "");
    } catch (error) {
        console.error("代码修复自愈节点执行失败:", error);
        throw new Error("自愈修复请求失败");
    }
};

export const generateChartCode = async (blueprint: WorkflowBlueprint, dataSample: any[]): Promise<string> => {
    // 1. 获取前面 Planner 决定的图表库（默认降级为 plotly）
    const library = blueprint.visualization_spec?.chart_library || 'plotly';

// 2. 在代码里硬编码两个纯粹的代码片段
    const PLOTLY_SNIPPET = `
【📚 Plotly 绘图规范 (强制要求)】：
1. 导入库：\`import plotly.express as px\` 或 \`import plotly.graph_objects as go\`。
2. 数据格式：如果之前提取过坐标，数据中会有 'lon' 和 'lat' 列，请直接使用它们作为坐标。
3. 【极其重要】：你必须调用系统预置的 \`apply_system_theme_plotly(fig, title)\` 来统一图表主题！不要自己写 update_layout 改颜色！
4. 必须设置 \`include_plotlyjs='cdn'\`。

3. 示例架构：
\`\`\`python
def execute_chart(df, parameters):
    import plotly.express as px
    # 自由发挥 px 的制图逻辑
    fig = px.sunburst(df, path=['区县名称', '中类'], values='count')
    
    # 强制应用系统暗黑主题
    fig = apply_system_theme_plotly(fig, title="图表标题")
    
    html_str = fig.to_html(full_html=False, include_plotlyjs='cdn')
    return {"html_string": html_str}
\`\`\`
`;

    const FOLIUM_SNIPPET = `
【📚 Folium 制图规范 (强制要求)】：
1. 底图生成：你必须调用预置算子 \`m = create_system_base_map(lat, lon)\` 来初始化地图，绝对不要自己用 folium.Map！
2. 坐标使用：传入的 df 中如果包含空间点，必定已有 'lon' 和 'lat' 两列，直接使用，无需再做投影转换。
3. 渲染导出：必须调用预置算子 \`safe_render_folium(m)\` 导出 HTML 字符串！

示例架构：
\`\`\`python
def execute_chart(df, parameters):
    import folium
    # 计算地图中心点
    center_lat, center_lon = df['lat'].mean(), df['lon'].mean()
    
    # 1. 强制使用系统底图算子
    m = create_system_base_map(center_lat, center_lon)
    
    # 2. 自由发挥添加交互元素
    for idx, row in df.iterrows():
        folium.CircleMarker([row['lat'], row['lon']], popup=row.get('区县名称', '点'), color='#22d3ee', radius=5).add_to(m)
        
    # 3. 强制使用系统渲染算子
    return {"html_string": safe_render_folium(m)}
\`\`\`
`;

    // 3. 按需只注入一个 Snippet
    const activeSnippet = library.toLowerCase() === 'folium' ? FOLIUM_SNIPPET : PLOTLY_SNIPPET;
    const CHART_CODER_PROMPT = `
你是一位顶级的 Python 数据可视化极客 (Visual Artist Agent)。
【执行蓝图】：${JSON.stringify(blueprint, null, 2)}
【真实数据样本 (前 5 行)】：${JSON.stringify(dataSample, null, 2)}

你需要编写一个名为 \`execute_chart(df, parameters)\` 的主函数。
【数据契约】：
1. 必须根据传入的 DataFrame (df) 的【真实列名】（见数据样本）进行维度映射！绝对不能臆造列名！
2. 函数必须返回字典：\`{"html_string": 你的html内容字符串}\`。
3. 只输出纯 Python 代码，无 markdown 标签。

${activeSnippet}

请利用上述规范，发挥创造力，生成最适合当前数据的可视化代码。
`;

    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-v3", 
            messages: [
                { role: "system", content: CHART_CODER_PROMPT },
                { role: "user", content: "请根据蓝图中的 engine（渲染引擎策略）以及真实数据样本，编写完美且极具审美的绘图代码。请注意不要遗漏必要的 import 语句。" }
            ],
            temperature: 0.2,
            max_tokens: 6000
        });

        return cleanCodeBlock(response.choices[0].message.content || "");
    } catch (error) {
        console.error("Chart Coder 生成失败:", error);
        throw new Error("AI 生成图表绘制代码失败。");
    }
};

export const fixChartCode = async (blueprint: any, buggyCode: string, errorTraceback: string): Promise<string> => {
    const CODE_FIXER_PROMPT = `
你是一个极度资深的 Python 数据可视化修复专家。
刚才生成的图表渲染代码在沙盒中运行崩溃了，请你担任专业的审查员，排查报错堆栈并返回修正后的纯 Python 代码。

【1. 架构师意图蓝图 (Blueprint)】:
${JSON.stringify(blueprint, null, 2)}

【2. 崩溃的异常绘图代码 (Buggy Code)】:
\`\`\`python
${buggyCode}
\`\`\`

【3. Python 沙盒真实绘图报错 (Traceback)】:
\`\`\`text
${errorTraceback}
\`\`\`

请分析报错原因（例如缺少 \`import\` 包如 plotly/pyecharts、变量 \`Figure\` 或 \`px\` 未定义、取非法的 DataFrame 列名、字典键 \`KeyError\` 等）。彻底修复它并仅返回修复后的完整执行代码（保留 \`def execute_chart(df, parameters):\` 封装）。
严格遵守原本的【分支渲染策略】，只返回纯代码！
`;

    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-v3",
            messages: [
                { role: "system", content: CODE_FIXER_PROMPT },
                { role: "user", content: "请进行图表代码的纠错自愈并仅返回纯代码" }
            ],
            temperature: 0.2, 
            max_tokens: 6000,
        });

        return cleanCodeBlock(response.choices[0].message.content || "");
    } catch (error) {
        console.error("图表自愈修复节点执行失败:", error);
        throw new Error("图表自愈修复请求失败");
    }
};

export const generateFeatureCalcCode = async (blueprint: any, validFileIds: string[], availableFiles: any[] = []): Promise<string> => {
    let dataLoadingSkeleton = "";
    let filesInfoStr = "暂无详细表结构";
    if (availableFiles && availableFiles.length > 0) {
        filesInfoStr = availableFiles.map(f => `- 文件ID: ${f.fileId}, 真实可用字段: [${f.columns?.join(', ')}]`).join('\n');
    }
    let joinCounter = 0; 
    
    if (blueprint.data_dependencies && Array.isArray(blueprint.data_dependencies)) {
        blueprint.data_dependencies.forEach((dep: any, index: number) => {
            // 🌟 UUID 幻觉自愈匹配器 (保持原样)
            let realUuid = dep.file_id;
            if (validFileIds && validFileIds.length > 0) {
                const cleanDepId = String(dep.file_id).replace(/-/g, '').toLowerCase();
                const fingerprint = cleanDepId.substring(0, 8);
                const match = validFileIds.find(id => {
                    const cleanId = id.replace(/-/g, '').toLowerCase();
                    return cleanId.includes(fingerprint);
                });
                if (match) {
                    realUuid = match; 
                } else {
                    realUuid = validFileIds[index] || dep.file_id; 
                }
            }

            // 【核心重构】：根据类型变量，生成完全不同的安全骨架
            let depType = (dep.type || 'Vector').toLowerCase();
            
            dataLoadingSkeleton += `    # 角色: ${dep.role} (${dep.description || ''}) - 类型: ${dep.type || 'Vector'}\n`;
            
            if (depType === 'raster') {
                // 如果是栅格，绝对不碰 gdf_dict，直接生成物理路径变量
                joinCounter++;
                let rasterVarName = joinCounter === 1 ? 'join_raster_path' : `join_raster_path_${joinCounter}`;
                dataLoadingSkeleton += `    ${rasterVarName} = file_paths_dict['${realUuid}']\n`;
            } else {
                // 如果是矢量，正常分配 GeoDataFrame 变量
                let varName = `layer_${index}_gdf`;
                if (dep.role === 'TargetLayer' || dep.role === 'Target') {
                    varName = 'target_gdf';
                } else if (dep.role === 'JoinLayer') {
                    joinCounter++;
                    varName = joinCounter === 1 ? 'join_gdf' : `join_gdf_${joinCounter}`;
                }
                dataLoadingSkeleton += `    ${varName} = gdf_dict['${realUuid}'].copy()\n`;
            }
        });
    } else {
        dataLoadingSkeleton = `    # 兜底获取方式\n    target_gdf = list(gdf_dict.values())[0].copy()\n`;
        if (validFileIds && validFileIds.length > 1) {
            dataLoadingSkeleton += `    join_gdf = list(gdf_dict.values())[1].copy()\n`;
        }
    }
    const PROMPT = `
你是一位高级 GeoAI 空间特征计算工程师。系统底层已经内置了强大的特征计算 SDK。
你的任务是：根据用户的【执行蓝图】，编写 Python 代码计算新特征。

【内置 SDK API】（已隐式 import，可直接调用）：
1. safe_zonal_stats(vector_gdf, raster_file_path, stat='mean', col_name='raster_val')
   - 作用：计算矢量面要素在栅格影像上的统计值（如平均高程 DEM）。
   - 参数 stat 支持：'mean', 'max', 'min', 'sum'。返回已新增 col_name 列的 GeoDataFrame。
2. safe_shortest_distance(target_gdf, ref_gdf, col_name='min_dist')
   - 作用：计算 target_gdf 每个要素距离 ref_gdf (如河流、道路) 的最短距离(单位:米)。返回已新增 col_name 列的 GeoDataFrame。
3. safe_intersects_count(target_gdf, join_gdf, col_name='count_val')
   - 作用：计算 target_gdf 每个要素内包含或相交的 join_gdf 要素数量。
4. safe_calc_geometry(gdf, calc_type='area', col_name='geom_val')
   - calc_type支持 'area'(平方米), 'length'(米)。
5. safe_spatial_join_attribute(target_gdf, ref_gdf, extract_col, join_type='nearest', col_name='ref_val')
   - 从参考图层提取属性，join_type 支持 'nearest', 'intersects'。
6. safe_buffer_count(target_gdf, join_gdf, buffer_dist=500, col_name='buf_count')
   - 计算目标要素外扩 buffer_dist 米内包含的其他要素数量。
7. safe_categorical_zonal_stats(vector_gdf, raster_file_path, col_name='majority_class')
   - 作用：提取分类栅格(如土地利用类型)在网格中的众数(占比最大的类别值)。
   - 绝对重要：如果你发现代码骨架为你提供了名为 “join_raster_path” 的变量，请直接将其作为 raster_file_path 参数传入！
   - 正确示例：target_gdf = safe_categorical_zonal_stats(target_gdf, join_raster_path, col_name='LandUse_Majority')
   - 函数内部必须设置 categorical=True 参数，否则分类栅格的众数统计会失效返回空值！
8. safe_natural_breaks(gdf, target_col, k=5, col_name='jenks_class', labels=None)
   - 作用：使用 Jenks 自然断点法将连续数值列离散化。
   - 参数要求：请务必根据用户的自然语言需求，动态提取并传入真实的 k 值。
   - 【极其重要】：如果用户要求给分级后的类别赋予具体文字名称（如"低降水区", "高降水区"），绝对不要自己写 apply 或 lambda 映射！你必须直接通过 labels 参数传入一个列表。
   - 正确示例：safe_natural_breaks(gdf, 'rain', k=5, col_name='Rain_C', labels=['低降水区', '较低降水区', '中等降水区', '高降水区', '极高降水区'])
9. safe_rule_reclassify(gdf, target_col, bins, labels, col_name='reclass_val', default_val='其他')
   - 作用：根据规则列表将数值离散化。支持重复的 label（如两个'北'）。
   - 【绝对禁令】：千万不要试图从 \`parameters\` 字典中读取 target_col、bins 或 labels！你必须在代码中**直接写死（Hardcode）**这些变量。
   - 正确示范（必须照做）：
     如果需求是“0-22.5是北，22.5-67.5是东北，其他是平面”，你必须直接在代码中写：
     \`bins = [0, 22.5, 67.5]\`
     \`labels = ['北', '东北']\`
     \`safe_rule_reclassify(gdf, target_col='Aspect', bins=bins, labels=labels, col_name='Aspect_Class', default_val='平面')\`
10. safe_sum_intersecting_length(target_gdf, line_gdf, col_name='total_length')
   - ：当需要计算 面内相交线(如路网、水网)的总长度 时，务必调用此算子！它会返回包含路网总长的新图层。
11. safe_spatial_join_agg(target_gdf, join_gdf, agg_col, agg_func='sum', col_name='agg_val')
   - 作用：将相交的客体要素（如滑坡点）的指定数值字段（agg_col）进行聚合（求和、均值等），并赋给目标面图层（如网格）。
   - agg_func 支持：'sum' (求和), 'mean' (求平均), 'max', 'min'。
   - 绝对指令：只要用户需求中包含“计算总和”、“求和”、“平均值”并涉及跨图层属性转移时，【必须使用本算子】，绝对不要使用 safe_spatial_join_attribute！
12.safe_spatial_categorical_summary(target_gdf, join_gdf, cat_col, col_prefix='cat')
   - 功能：统计目标图层(面)内，客体图层(点/线/面)不同分类的数量、占比及占比最高的主导分类。
   - 适用场景：计算街道内不同建筑质量的占比、不同土地利用类型占比、寻找最主要的 POI 类型等。
   - 返回：包含各类数量(count)、占比(ratio)、主导分类(dominant)和总数(total)的 GeoDataFrame。

   【蓝图】：
${JSON.stringify(blueprint, null, 2)}

   【当前可用的图层真实数据字典 (极其重要)】：
${filesInfoStr}

【严格要求】：
1. 必须写一个 \`def execute_feature_calc(gdf_dict, file_paths_dict, parameters):\` 函数。
2. gdf_dict 是包含已加载矢量的字典，file_paths_dict 是包含所有文件物理绝对路径的字典。
3. 必须将目标图层 (Target) 新增计算出的特征列，并**务必保留原始的 'id' 列**。
4. 返回值必须是将带有 'id' 和新特征列的结果转为 List of Dict。例如：\`return target_gdf[['id', '新列名']].to_dict(orient='records')\`。
5. 只输出纯 Python 代码，绝对不要包含 \`\`\`python 标签！
6. 【UUID防呆】：我已经为你自动生成了绝对安全的『数据加载代码骨架』！你必须原封不动地使用我给你的变量（如 target_gdf），绝对禁止你自己手写 gdf_dict['uuid']！
7. 【列名获取绝对规则 —— 最高优先级，违反必错】：
   parameters 字典在运行时始终为空 {}，从中读取任何键都会触发 KeyError 导致崩溃！
   
   ★ 如果用户需求中已明确列出列名（如 "Count_住宿、Count_医院..."），必须直接在代码中将其硬编码为 Python 列表：
       ✅ 正确：poi_columns = ['Count_住宿', 'Count_医院', 'Count_购物']
       ❌ 绝对禁止：poi_columns = parameters['poi_columns']   # 运行时 parameters={} → KeyError!
       ❌ 绝对禁止：poi_columns = parameters.get('poi_columns', [])  # 返回 [] → 后续计算全错!
   
   ★ 如果列名规律明显但未全部列出，使用模式匹配动态提取：
       poi_columns = [c for c in target_gdf.columns if c.startswith('Count_')]
   
   ★ 无论使用哪种方式，绝对禁止从 parameters 中读取任何列名或数值参数！

8. 【原生矩阵运算】：当用户要求计算复杂空间经济学公式时，你必须使用原生 Pandas/Numpy 的 DataFrame 向量化运算来实现，并务必处理除 0 异常（如使用 np.errstate, fillna, 或 np.divide）。
9. 【动态列名红线】：调用 safe_spatial_categorical_summary 时，由于产生的列名是动态的（包含分类名称），【绝对禁止】在 return 时手动枚举或筛选列名！必须使用 \`return target_gdf.drop(columns=['geometry']).to_dict(orient='records')\` 返回全量数据。

【代码填充】
请严格按照以下代码骨架填充你的逻辑：
def execute_feature_calc(gdf_dict, file_paths_dict, parameters):
${dataLoadingSkeleton}
    # --- 在下方编写你的空间特征计算逻辑 ---
    # ⚠️ 警告：parameters 在运行时始终为空 {}，绝对不要用 parameters['任何key'] 或 parameters.get()！
    # 
    # 【列名获取示例 - 二选一】：
    # 方式A (推荐，当用户已明确列出列名时): 直接硬编码！
    #   poi_columns = ['Count_住宿', 'Count_医院', 'Count_购物', 'Count_休闲娱乐', 'Count_居民小区', 'Count_政府单位', 'Count_科研教育']
    # 方式B (当需要动态匹配时): 用列名模式过滤
    #   poi_columns = [c for c in target_gdf.columns if c.startswith('Count_') and c != 'Count_total']
    
    
    # --- 收尾与返回 ---
    if 'id' not in target_gdf.columns:
        target_gdf['id'] = target_gdf.index
        
    return target_gdf[['id', '此处填入你计算的所有新特征列名']].to_dict(orient='records')

# 示例 2：分类占比与主导类型提取 (如：计算各街道内不同建筑质量的占比及最高占比类型)
def execute_feature_calc(gdf_dict, file_paths_dict, parameters):
    target_gdf = gdf_dict['target_layer_id'].copy()
    join_gdf = gdf_dict['join_layer_id'].copy()
    
    # 遇到提取最高占比、主导类型，直接调用分类统计算子！
    result_gdf = safe_spatial_categorical_summary(
        target_gdf=target_gdf, 
        join_gdf=join_gdf, 
        cat_col='Quality',  # 真实的分类字段名
        col_prefix='bldg_qual' # 自定义一个列前缀
    )
    
    if 'id' not in result_gdf.columns:
        result_gdf['id'] = result_gdf.index

    # 绝对红线：原始数据中可能含有列表(如cp)等无法序列化的脏列，会导致 to_dict 抛出 真值报错！
    # 绝对禁止返回全表！必须通过您设置的 col_prefix (如 'bldg_qual') 动态筛选，仅返回 id 和新生成的特征列！
    return_cols = ['id'] + [c for c in result_gdf.columns if str(c).startswith('bldg_qual_')]
    
    return result_gdf[return_cols].to_dict(orient='records')
`;

    
    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-v3", // 你用的 deepseek 模型非常适合这种代码填空逻辑！
            messages: [{ role: "system", content: PROMPT }, { role: "user", content: "请开始编写特征计算Python代码" }],
            temperature: 0.1 // 保持 0.1 的低温度，让它严格遵守骨架
        });
        
        let rawContent = response.choices[0].message.content || "";
        
        // 双重保险清理：先用你的 cleanCodeBlock，再用正则强制剔除可能残留的 ```python
        let cleanedCode = cleanCodeBlock(rawContent);
        cleanedCode = cleanedCode.replace(/```python/gi, '').replace(/```/g, '').trim();
        
        return cleanedCode;
        
    } catch (error) {
        console.error("[LLM Error] 生成特征计算代码失败:", error);
        throw error;
    }

};

export const fixFeatureCalcCode = async (blueprint: any, buggyCode: string, errorTraceback: string): Promise<string> => {
    const FIXER_PROMPT = `
你是一个极度资深的 GeoPandas 特征计算修复专家 (Feature Calc Fixer Agent)。
刚才生成的特征计算代码在沙盒中运行崩溃了，请你担任专业的审查员，排查报错堆栈并返回修正后的纯 Python 代码。

【1. 架构师意图蓝图 (Blueprint)】:
${JSON.stringify(blueprint, null, 2)}

【2. 崩溃的异常代码 (Buggy Code)】:
\`\`\`python
${buggyCode}
\`\`\`

【3. Python 沙盒真实报错 (Traceback)】:
\`\`\`text
${errorTraceback}
\`\`\`

【修复绝对红线 —— 违反必再次崩溃】：
❌ 最常见的错误根因：代码用了 parameters['某个key'] 或 parameters.get('某个key')。
   parameters 字典在运行时始终为空 {}，从中读取任何键都会触发 KeyError！
   
✅ 修复方案：
   - 如果错误是 KeyError 或 parameters 相关：立即将所有 parameters 读取替换为硬编码的列名列表或动态模式匹配：
     硬编码示例：poi_columns = ['Count_住宿', 'Count_医院', 'Count_购物', 'Count_休闲娱乐', 'Count_居民小区', 'Count_政府单位', 'Count_科研教育']
     动态提取示例：poi_columns = [c for c in target_gdf.columns if c.startswith('Count_')]
   - 其他错误（如 KeyError 在 gdf_dict 上）：检查 UUID 是否正确，使用 list(gdf_dict.values())[0] 兜底
   - 除零错误：用 np.where(denominator == 0, np.nan, numerator / denominator) 或 .replace(0, np.nan)

请分析报错原因，彻底修复并返回完整的 \`def execute_feature_calc(gdf_dict, file_paths_dict, parameters):\` 函数。
只输出纯 Python 代码，绝对不要包含 \`\`\`python 标签！
【补充】：
❌ 错误根因1：代码用了 parameters['某个key'] 或 parameters.get('某个key')。
   parameters 字典在运行时始终为空 {}，从中读取任何键都会触发 KeyError！
   ✅ 修复方案：直接将所有 parameters 读取替换为硬编码的列名列表或动态模式匹配。

❌ 错误根因2 (致命幻觉)：使用了 "if df:" 或 "if not df:" 来判断 GeoDataFrame 变量（如 target_gdf 或 join_gdf）！
   这会直接引发 "The truth value of a GeoDataFrame is ambiguous" 的底层崩溃！
   ✅ 修复方案：判空或校验数据框的有效性时，必须且只能使用这种语法：\`if df is not None and not df.empty:\`。

❌ 错误根因3：KeyError: 'uuid字符串'。
   说明你试图从 gdf_dict 获取栅格数据！栅格数据不存在于 gdf_dict，只存在于 file_paths_dict。
   ✅ 修复方案：删除 gdf_dict 的调用，改为 \`raster_path = file_paths_dict['出错的uuid']\`。
`;
    const response = await openai.chat.completions.create({
        model: "deepseek-v3",
        messages: [
            { role: "system", content: FIXER_PROMPT },
            { role: "user", content: "请进行特征计算代码的纠错自愈并仅返回纯代码" }
        ],
        temperature: 0.1
    });
    return cleanCodeBlock(response.choices[0].message.content || "");
};

export const generateProModelCode = async (blueprint: any): Promise<string> => {
    const PROMPT = `
你是一位顶级 GeoAI 空间数据科学家。系统已内置专业模型 SDK。
任务：根据用户的【执行蓝图】，编写 Python 代码调用专业模型。

【内置 SDK API】：
1. safe_geodetector_factor(gdf, y_col, x_cols)
   - 作用：执行地理探测器（因子探测）。
2. safe_geodetector_interaction(gdf, y_col, x_cols)
   - 作用：执行地理探测器（交互探测），计算自变量叠加后的 q(A∩B)，自动输出适合热力图的对称矩阵数据。
   - 返回列包含：'因子A', '因子B', '交互q值', '交互类型'。

【蓝图】：
${JSON.stringify(blueprint, null, 2)}

【严格要求】：
1. 必须写一个 \`def execute_pro_model(gdf_dict, file_paths_dict, parameters):\` 主函数。
2. 【绝对禁令】：千万不要试图从 \`parameters\` 字典中读取变量！你必须直接在代码中写死真实的列名字符串。
3. 【正确示范】：
   如果用户要求分析交互探测，只需这样写：
   \`return safe_geodetector_interaction(target_gdf, y_col='Landslide_Count', x_cols=['Elev_Class', 'Rain_Class'])\`
4. 只输出纯 Python 代码，绝对不要包含 \`\`\`python 标签！
`;
    const response = await openai.chat.completions.create({
        model: "deepseek-v3", // 或你使用的模型
        messages: [{ role: "system", content: PROMPT }, { role: "user", content: "请编写专业模型执行代码" }],
        temperature: 0.1
    });
    return cleanCodeBlock(response.choices[0].message.content || "");
};

export const fixProModelCode = async (blueprint: any, buggyCode: string, errorTraceback: string): Promise<string> => {
    const FIXER_PROMPT = `代码运行崩溃：\n${errorTraceback}\n请修复以下 execute_pro_model 代码并返回纯Python：\n${buggyCode}`;
    const response = await openai.chat.completions.create({
        model: "deepseek-v3",
        messages: [{ role: "system", content: FIXER_PROMPT }],
        temperature: 0.1
    });
    return cleanCodeBlock(response.choices[0].message.content || "");
};