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
    pivot_strategy: {
        files_needed: string[];      
        operations: string[];        
        output_schema: string[];     
    };
    chart_strategy: {
        chart_type: string;          
        requirements: string;        
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
    const filesInfo = availableFiles.map(f => `- 文件ID: ${f.id}, 文件名: ${f.fileName}, 字段包含: [${f.columns?.join(', ')}]`).join('\n');

    const PLANNER_PROMPT = `
你是一位顶尖的 WebGIS 数据分析架构师。
你的任务是将用户的自然语言需求，严格拆解为“数据透视(空间聚合)”和“数据可视化(绘图)”两个独立阶段的蓝图。

【当前可用的数据集】：
${filesInfo || '暂无详细表结构，请根据用户描述推断'}

【 规范】：
1. 绝对不要写任何 Python 代码
2. pivot_strategy 负责将海量明细数据聚合成精简的统计表。如果涉及空间计算，必须明确写在 operations 中。
3. chart_strategy 负责根据聚合后的精简数据画图。
4. 必须且只能输出一个合法的 JSON 对象。绝对不要输出其他任何说明文字。
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

export const generatePivotCode = async (pivotStrategy: any): Promise<string> => {
    const PIVOT_CODER_PROMPT = `
你是一位顶级的 Python 空间数据挖掘专家。
请根据架构师提供的【数据透视策略】，编写一段极其健壮的 Python 空间聚合代码。
【透视策略】：
${JSON.stringify(pivotStrategy, null, 2)}

【Python 代码严格规范】：
1. 必须且只能包含一个主执行函数：\`def execute_pivot(gdf_dict, parameters):\`
2. 必须先将无效的 0、空字符串、纯空格替换为 np.nan
3. 几何计算前，必须转为局部投影：\`df.to_crs(df.estimate_utm_crs())\`
4. 【返回值强制要求】：必须将最终聚合完成的 DataFrame 转换为【列表字典】返回，绝对不要返回 HTML 或画图
5. 只输出纯 Python 代码，绝对不要包含 Markdown 的 \`\`\`python 标签！
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

export const generateChartCode = async (chartStrategy: any, dataSample: any[]): Promise<string> => {
    const CHART_CODER_PROMPT = `
你是一位顶级的 Python 数据可视化专家。请根据提供的【图表策略】及【数据样本】，编写专业的绘图代码。
【图表策略】：${JSON.stringify(chartStrategy, null, 2)}
【数据样本】：${JSON.stringify(dataSample, null, 2)}

【严格规范】：
1. 包含主执行函数：\`def execute_chart(df, parameters):\`
2. 使用 \`plotly.express\` 绘图，并调用 \`fig.to_html(full_html=False, include_plotlyjs='cdn')\` 导出
3. 返回字典，包含 'html_string' 这个 key
4. 只输出纯 Python 代码，绝对不要包含 Markdown 的 \`\`\`python 标签！
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