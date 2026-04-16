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

        // ⚠️ 删掉之前那个 replace(/\\n/g, "\\\\n")，直接让 JSON 原生解析
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

export const planWorkflow = async (userPrompt: string, availableFiles: any[], context?: any): Promise<WorkflowBlueprint> => {
    const filesInfo = availableFiles.map(f => `- 文件ID: ${f.fileId}, 名称: ${f.name}, 几何类型: ${f.geomType}, 字段包含: [${f.columns?.join(', ')}]`).join('\n');
    
    const contextPrompt = context 
    ? `\n\n【注意：历史执行上下文 (Context Memory)】:\n用户之前执行了以下操作：\n${JSON.stringify(context, null, 2)}\n\n用户的当前对话很可能是针对上述上下文的补充修改，例如“请再次生成雷达图”、“将结果换成热力图”。如果判定用户的意图不需要改变底层数据透视逻辑，请在你的返回 JSON 中加入 "reuse_code": true，并调整对应图表的 \`visualization_spec\` 即可。`
    : "";

    const PLANNER_PROMPT = `
你是一位顶尖的 WebGIS 数据分析架构师（Planner Agent）。
你的任务是将用户的自然语言需求，基于当前工作区可用的图层 Schema，严格拆解为标准化的执行蓝图 (Blueprint)。

【当前可用的图层数据集】：
${filesInfo || '暂无详细表结构，请根据用户描述推断'}
${contextPrompt}

【 任务分析规范】：
1. 绝对不要写任何 Python 代码。
2. 必须且只能输出一个合法的 JSON 对象。绝对不要包含 \`\`\`json 等 Markdown 包裹符。
3. 请考虑多轮对话的连贯性。如果用户是"追问"或者要求"换个图表/仅改变渲染维度"，你只需修改 visualization_spec，并输出 "reuse_code": true 即可，无需重新定义数据抽取！
4. 请严格按照以下 JSON Schema 输出：
{
  "task_type": "任务类型，例如 spatial_join_pivot, buffer_analysis, chart_modification 等",
  "reuse_code": true, // 若仅判定为图表更换/属性过滤且计算逻辑不变，设为 true。否则省略或 false。
  "data_dependencies": [
    {
      "file_id": "被选中的文件ID",
      "role": "该文件在计算中的角色, 必须为 TargetLayer (基准层/面图层) 或 JoinLayer (客体关联点/线图层)",
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

export const generatePivotCode = async (blueprint: WorkflowBlueprint): Promise<string> => {
    // 1. 提取引擎路由
    const engine = blueprint.visualization_spec?.engine || 'echarts';
    // 2. 基础 Prompt (SDK与5+1原则)
    const BASE_PROMPT = `
你是一位高级 GeoAI 空间调度工程师。
系统底层已经为你内置了绝对安全的领域特定算子库 (GeoPivot SDK)。
你的任务是：根据用户的【执行蓝图】，严格进行【5+1 意图映射】，并组合调用 SDK 完成计算。
【执行蓝图】：
${JSON.stringify(blueprint, null, 2)}

【SDK 核心算子 API 文档】（已隐式 import，可直接调用）：
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
1. 空间约束 (Spatial Constraint)：如 buffer, intersects, nearest。
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
    
    # 🚨 必须同时 Drop 掉 geom 和 geometry
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