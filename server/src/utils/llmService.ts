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
    "engine": "【严格路由分类】：如果需求涉及基础准则数据分析图表（如柱状图、条形图 Bar、折线图 Line、饼图 Pie、雷达图 Radar、箱线图 Boxplot 等），【强制填写 'echarts'】。绝对不要生成 HTML！只有当用户要求极度复杂的高度定制空间专题拓扑网络图时，才可使用 'html_iframe'。",
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

【🚨大模型红线：5+1 空间数据透视核心范式 (The 5+1 Spatial Pivot Paradigm)🚨】
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

【🐍 强制代码 Snippet 规范（不遵守将引发系统崩溃）】
无论需求多庞杂，执行空间汇聚必须严格遵循以下四步走套路。
绝对禁止使用 \`pd.merge\` 引发主键丢失！绝对禁止使用 \`.groupby(列名)\` 或 \`.groupby(target.index.name)\` 抛空异常！

Step 0: 数据准备 (Data Clean)
必须统一采用极其安全的全表矢量化方法替换异常值（绝对禁止使用循环遍历或 df.dtypes 判断）：
\`\`\`python
target_gdf = target_gdf.replace(['', ' ', '0', 0], np.nan)
join_gdf = join_gdf.replace(['', ' ', '0', 0], np.nan)
\`\`\`

Step 1: 处理空间约束 (Spatial Constraint)
\`\`\`python
# 例如缓冲相交、最近距离等
target_gdf['geometry'] = target_gdf.geometry.buffer(...) # 可选
joined = gpd.sjoin(target_gdf, join_gdf, how='inner', predicate='intersects')
\`\`\`

Step 2: 聚合处理 (安全分组机制)
必须利用 \`sjoin\` 保留左表索引的特性，直接使用 \`level=0\` 进行安全分组！
\`\`\`python
# 计数 (Count): 
agg_result = joined.groupby(level=0).size()
# 或者求和 (Sum): 
agg_result = joined.groupby(level=0)['目标字段'].sum()
\`\`\`

Step 3: 结果映射 (Result Mapping)
利用 Pandas 索引自动对齐特性直接给原始主表赋值，彻底避开 pd.merge。
\`\`\`python
target_gdf['计算结果'] = agg_result
target_gdf['计算结果'] = target_gdf['计算结果'].fillna(0)
\`\`\`

Step 4: 降维输出
使用 \`sort_values\` 时必须显式指定 \`by\`（例如 \`df.sort_values(by='count', ascending=False)\`）。
过滤掉不需要的属性列并丢弃 \`geometry\` 引擎负担，仅返回前端 UI 需要展示的属性列组合即可。
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

请分析报错原因（如 Pandas 列名冲突、空值异常、非法合并方法、属性不存在等），彻底修复它并返回修复后的完整 Python 代码。
你返回的代码必须继续严格遵守 【5+1 聚合规范】，特别是：
1. 绝对禁止使用 \`pd.merge\`！
2. 绝对禁止使用 \`.groupby(列名)\`，必须使用 \`joined.groupby(level=0)\` 进行安全分组并直接向主表索引赋值对齐！
3. 返回修正后的完整 \`def execute_pivot(gdf_dict, parameters):\`。只输出代码，绝对不要包括任何代码包裹符例如 \`\`\`python。
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
    const CHART_CODER_PROMPT = `
你是一位顶级的 Python 数据可视化专家。请根据提供的【图表策略】及【数据样本】，编写专业的绘图代码。
【执行蓝图】：${JSON.stringify(blueprint, null, 2)}
【数据样本】：${JSON.stringify(dataSample, null, 2)}

【严格规范】：
1. 包含主执行函数：\`def execute_chart(df, parameters):\`
2. **安全参数提取 (Safe Parameter Extraction)**：在为图表生成标题（Title）或获取绘图参考量时，绝对禁止硬编码提取未知的字典键（如直接写 \`parameters['buffer_radius']\`，这会直接抛出 KeyError 导致系统回滚）。必须使用绝对安全的兜底获取方式（如 \`parameters.get('buffer_radius', 1000)\`），或者直接根据蓝图意图硬书写中文语义标题，彻底脱离对动态特定参数键的依赖！
3. **分支渲染策略**：检查执行蓝图中的 \`visualization_spec.engine\`：
   - 如果是 \`'echarts'\`：
     🚨【ECharts 引擎红线 — 绝对禁止导入任何第三方绘图库】🚨
     当 engine 为 'echarts' 时，严禁出现任何 \`import matplotlib\`、\`import plotly\`、\`import pyecharts\`、\`import folium\` 等第三方绘图库导入语句！你只需使用 Python 原生字典 + Pandas 的 \`.tolist()\` 方法完成数据注入即可。
     
     你必须严格参考以下【强制代码骨架模板（Few-Shot）】进行编写，不得偏离此结构：
     \`\`\`python
     def execute_chart(df, parameters):
         # 直接从 df 中提取列表用于 xAxis 和 series（利用 Pandas tolist() 完成数据注入）
         x_data = df.iloc[:, 0].astype(str).tolist() if not df.empty else []
         y_data = df.iloc[:, 1].tolist() if not df.empty else []
         
         option_dict = {
             "title": {"text": "请根据语义生成标题"},
             "tooltip": {"trigger": "axis"},
             "xAxis": {"type": "category", "data": x_data},
             "yAxis": {"type": "value"},
             "series": [{"type": "bar", "data": y_data}]
         }
         return {"echarts_option": option_dict}
     \`\`\`
     在此骨架基础上，发挥你的设计审美，比如设置深色主题、酷炫的渐变颜色（itemStyle.color 渐变）和 Tooltip 联动体验。最终必须仅返回 \`{"echarts_option": option_dict}\`。
   - 如果是 \`'html_iframe'\`：你需要使用 \`plotly.express\` 或 \`folium\` 进行绘制，并导出为 HTML 字符串，返回 \`{"html_string": html_content}\`。⚠️请注意网络环境！生成的 HTML 源码中，强制使用国内稳定的 CDN（如 staticfile 或 bootcdn）替换掉一切原本库携带的外部脚本！如果不做替换将导致国内节点白屏以及 ERR_CONNECTION_RESET！
4. 只输出纯 Python 代码，绝对不要包含 Markdown 的 \`\`\`python 标签！
`;

    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-v3", 
            messages: [
                { role: "system", content: CHART_CODER_PROMPT },
                { role: "user", content: "请根据蓝图中的 engine（渲染引擎策略）以及真实数据样本，编写完美且极具审美的绘图代码。请注意不要遗漏必要的 import 语句。" }
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