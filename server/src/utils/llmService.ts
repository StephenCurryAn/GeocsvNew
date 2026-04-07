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
        chart_type: string;
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
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        return jsonMatch[0].trim();
    }
    return rawContent.trim();
};

export const planWorkflow = async (userPrompt: string, availableFiles: any[]): Promise<WorkflowBlueprint> => {
    const filesInfo = availableFiles.map(f => `- 文件ID: ${f.fileId}, 名称: ${f.name}, 几何类型: ${f.geomType}, 字段包含: [${f.columns?.join(', ')}]`).join('\n');

    const PLANNER_PROMPT = `
你是一位顶尖的 WebGIS 数据分析架构师（Planner Agent）。
你的任务是将用户的自然语言需求，基于当前工作区可用的图层 Schema，严格拆解为标准化的执行蓝图 (Blueprint)。

【当前可用的图层数据集】：
${filesInfo || '暂无详细表结构，请根据用户描述推断'}

【 规范】：
1. 绝对不要写任何 Python 代码。
2. 必须且只能输出一个合法的 JSON 对象。绝对不要包含 \`\`\`json 等 Markdown 包裹符。
3. 请严格按照以下 JSON Schema 输出：
{
  "task_type": "任务类型，例如 spatial_join_pivot, buffer_analysis 等",
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
    "engine": "渲染引擎策略。如果需求是基础统计图（柱状/雷达/饼图/折线/散点），必须填 'echarts'；如果要求地图热力图等 ECharts 较难画的空间专题图，则填 'html_iframe'",
    "chart_type": "图表类型",
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
        return JSON.parse(cleanCodeBlock(rawContent)) as WorkflowBlueprint;
    } catch (error) {
        console.error("拆解节点解析失败:", error);
        throw new Error("规划失败，请检查需求描述。");
    }
};

export const generatePivotCode = async (blueprint: WorkflowBlueprint): Promise<string> => {
    const PIVOT_CODER_PROMPT = `
你是一位顶级的 Python 空间数据挖掘专家（Coder Agent）。
请根据架构师提供的【执行蓝图(Blueprint)】，编写一段极其健壮的 Python 空间聚合代码。
【执行蓝图】：
${JSON.stringify(blueprint, null, 2)}

【Python 代码严格规范】：
1. 必须且只能包含一个主执行函数：\`def execute_pivot(gdf_dict, parameters):\`
2. \`gdf_dict\` 包含了蓝图中 \`data_dependencies\` 声明的各个 \`file_id\` 对应的 GeoDataFrame。
3. 系统已自动为你将所有 GeoDataFrame 的坐标系统一为 EPSG:3857 (米制)，可直接进行 buffer/空间距离计算。
4. 必须先将无效的 0、空字符串、纯空格替换为 np.nan
5. 【返回值强制要求】：请将最终聚合完成的结果转换为 Pandas DataFrame 直接返回（推荐），或者转为字典列表。系统会自动为你丢弃 geometry 并序列化。
6. 只输出纯 Python 代码，绝对不要包含 Markdown 的 \`\`\`python 标签！

【空间相交操作避坑指南】：
- 缓冲相交 (Buffer Intersection): 
  对于点寻面缓冲，或者面寻点缓冲，最佳实践：\`target['geometry'] = target.geometry.buffer(radius)\`，然后再用 \`gpd.sjoin(target, join_layer, how='inner', predicate='intersects')\`。
- 距离找最近 (Nearest): 
  如果需要查找周围最近的要素：\`gpd.sjoin_nearest(points, targets, distance_col="dist")\`。
- 分组关联与聚合 (Spatial Join & Groupby):
  千万不要盲目使用极其缓慢且容易出错的 \`pd.merge\`！推荐做法是：执行 \`gpd.sjoin\` 前，为主图层临时添加一个明确的辅助列，例如 \`target['target_id'] = range(len(target))\`，进行 sjoin 后，直接使用 \`grouped = joined.groupby('target_id').size().reset_index(name='count')\`。然后再通过 \`target_id\` 把原始表的重要属性拼回来，或者根据实际需要通过别的唯一列聚合。绝对不要写 \`groupby(target.index.name)\`，因为默认 index.name 通常为空 (None) 会导致崩溃！
- **排序规范 (Sorting)**:
  使用 \`sort_values\` 时必须显式指定 \`by\` 参数，例如：\`df.sort_values(by='count', ascending=False)\`。绝对不要省略 \`by\`！
- **字段引用**: 
  确保引用 \`gdf_dict\` 中列出的原始字段名，或者是在计算过程中新产生的字段名（如 \`count\`, \`dist\`）。
`;

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

export const generateChartCode = async (blueprint: WorkflowBlueprint, dataSample: any[]): Promise<string> => {
    const CHART_CODER_PROMPT = `
你是一位顶级的 Python 数据可视化专家。请根据提供的【图表策略】及【数据样本】，编写专业的绘图代码。
【执行蓝图】：${JSON.stringify(blueprint, null, 2)}
【数据样本】：${JSON.stringify(dataSample, null, 2)}

【严格规范】：
1. 包含主执行函数：\`def execute_chart(df, parameters):\`
2. **分支渲染策略**：检查执行蓝图中的 \`visualization_spec.engine\`：
   - 如果是 \`'echarts'\`：你的 Python 代码需要利用传入的 df，组装出一个能够完美匹配 ECharts 的 Option 字典对象，并直接返回 \`{"echarts_option": option_dict}\`。推荐你在这个字典中发挥设计审美，比如设置深色主题、酷炫颜色和 Tooltip 联动体验。
   - 如果是 \`'html_iframe'\`：你需要使用 \`plotly.express\` 或 \`folium\` 等 Python 绘图库进行绘制，并导出为 HTML 字符串，返回 \`{"html_string": html_content}\`（切记不要包括外部的巨大 js 库直接嵌入源码，使用 cdn）。
3. 只输出纯 Python 代码，绝对不要包含 Markdown 的 \`\`\`python 标签！
`;

    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-v3", // 统一修改为 deepseek-v3
            messages: [
                { role: "system", content: CHART_CODER_PROMPT },
                { role: "user", content: "请根据真实数据样本，编写完美的 Plotly 绘图代码。" }
            ],
            temperature: 0.1,
            max_tokens: 3500
        });

        return cleanCodeBlock(response.choices[0].message.content || "");
    } catch (error) {
        console.error("Chart Coder 生成失败:", error);
        throw new Error("AI 生成图表绘制代码失败。");
    }
};