import OpenAI from 'openai';
import dotenv from 'dotenv';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { 
    WorkflowState, PlannerSchema, PlannerContract,
    FeatureSchema, FeatureContract, 
    PivotSchema, PivotContract, 
    ExpertSchema, ExpertContract ,
    FixerSchema, FixerContract
} from "../types/agent"; 

dotenv.config();

// ================= [核心网络] =================
const proxyUrl = process.env.https_proxy || process.env.http_proxy || 'http://127.0.0.1:33210';
const proxyAgent = new ProxyAgent(proxyUrl);
setGlobalDispatcher(proxyAgent);

const apiKey = process.env.ALIYUN_API_KEY;
console.log(`\n[系统自检] 正在读取 .env 文件...`);
console.log(`[系统自检] ALIYUN_API_KEY 加载状态: ${apiKey ? '成功' : '【失败】未找到该变量！'}`);

const openai = new OpenAI({
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: apiKey, 
    timeout: 180 * 1000, 
});

// ==================================================
// 多智能体架构核心底座
// ==================================================
async function callAgentWithSchema<T>(
  systemPrompt: string,
  userPrompt: string,
  zodSchema: z.ZodSchema<T>,
  agentName: string
): Promise<T> {
  const jsonSchema = zodToJsonSchema(zodSchema as any, agentName);

  const finalSystemPrompt = `
${systemPrompt}

【强制输出规范】
你必须严格遵守以下 JSON Schema 格式进行输出。不要包含任何 markdown 代码块标识（如 \`\`\`json），请直接输出纯净的 JSON 字符串：
${JSON.stringify(jsonSchema, null, 2)}
  `;

  const response = await openai.chat.completions.create({
    model: "deepseek-v3", 
    response_format: { type: "json_object" }, 
    messages: [
      { role: "system", content: finalSystemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.1, 
  });

  const resultText = response.choices[0].message.content || "{}";
  
  try {
    return zodSchema.parse(JSON.parse(resultText));
  } catch (error) {
    console.error(`[${agentName}] 输出格式解析失败:`, error);
    throw new Error(`智能体 ${agentName} 生成了不符合契约的 JSON。`);
  }
}

export async function runPlannerAgent(state: WorkflowState): Promise<PlannerContract> {
  const systemPrompt = `
你是一个 GeoAI 系统的总控规划大脑 (Supervisor Agent)。
你的唯一任务是：理解用户的空间分析需求，并决定工作流的下一步该交给哪个专职 Worker Agent。

【你的下属团队】
- feature: 特征工程 Agent。专门算面积、距离、提取高程等，为表格增加新列。
- pivot: 空间透视 Agent。专门做数据筛选、空间相交、GroupBy 聚合（5+1范式）。
- expert: 专家模型 Agent。专门跑地理探测器等复杂学术模型。
- visualization: 渲染 Agent。专门负责画图（生成 ECharts 等）。
- end: 所有任务已完成，无需继续调度。

【当前数据状态】
数据引用：${state.currentDataRef || state.originalDataRef}
表结构(列名与类型)：${JSON.stringify(state.schemaInfo)}

【已执行日志 (Execution Log)】
${state.executionLog.length > 0 ? state.executionLog.join("\n") : "这是任务的第一步，暂无操作。"}

请仔细思考，如果当前数据缺少某些字段（如距离、坡度），请务必先将 next_agent 设为 'feature'。
`;
  return await callAgentWithSchema(systemPrompt, `用户当前指令：${state.userQuery}`, PlannerSchema, "PlannerContract");
}

export async function runFeatureAgent(state: WorkflowState): Promise<FeatureContract> {
  const systemPrompt = `
你是一个 GeoAI 系统的空间特征工程智能体 (Feature Agent)。
你的唯一任务是：基于用户需求，决定调用哪个底层的特征算子，并给出参数。

【当前数据状态】
表结构：${JSON.stringify(state.schemaInfo)}

【你的可用算子工具箱】
1. calculate_area: 计算面要素面积。
2. calculate_distance: 计算当前要素离目标要素的最短距离。
3. buffer_count: 计算缓冲区内其他要素的数量。
4. extract_raster_value: 从栅格(DEM)提取值，如高程、坡度。

请严格判断用户指令，输出对应的工具名和参数。输出的新列名必须是合法的英文字段。
`;
  return await callAgentWithSchema(systemPrompt, `需要执行的子任务：${state.userQuery}`, FeatureSchema, "FeatureAgent");
}

// 重构：带 SDK 感知能力的代码生成透视智能体
export async function runPivotAgent(state: WorkflowState): Promise<PivotContract> {
  const systemPrompt = `
你是一个 GeoAI 系统的空间透视智能体 (Pivot Agent) 兼高级 Python 程序员。
用户的需求涉及复杂的空间关联与数据聚合。请你根据需求，编写一段能被系统沙盒动态执行的 Python 胶水代码。

【当前数据状态】
表结构：${JSON.stringify(state.schemaInfo)}

【沙盒环境与 SDK API 文档】
以下模块已作为全局变量预先注入沙盒，【绝不允许写 import 语句导入它们】，请直接通过模块前缀调用：

1. 空间特征算子 (geo_feature_sdk)：
   - geo_feature_sdk.ensure_metric_crs(gdf) -> 确保米制坐标系
   - geo_feature_sdk.calculate_area(gdf, output_col='area_sqm') -> 计算面积
   - geo_feature_sdk.calculate_distance_to_layer(gdf, join_gdf, output_col='dist_to_target') -> 计算最短距离
   - geo_feature_sdk.buffer_count(gdf, join_gdf, radius=500, output_col='buffer_count') -> 计算缓冲区内要素数量

2. 空间拓扑与透视算子 (geo_pivot_sdk)：
   - geo_pivot_sdk.safe_buffer_intersects(target_gdf, join_gdf, radius=0) -> 缓冲相交
   - geo_pivot_sdk.safe_intersects(target_gdf, join_gdf) -> 面与面/线与面的精确相交
   - geo_pivot_sdk.safe_within_contains(target_gdf, join_gdf, relation='within'或'contains') -> 包含关系
   - geo_pivot_sdk.safe_nearest(target_gdf, join_gdf, max_distance=None) -> 最近邻
   - geo_pivot_sdk.safe_get_centroid_coords(gdf, x_col='lon', y_col='lat') -> 安全提取质心坐标 (绘图必须)
   - geo_pivot_sdk.safe_aggregate(joined_gdf, agg_method, value_col=None, col_dim=None) -> 安全聚合透视

3. 专家模型算子 (geo_expert_sdk)：
   - geo_expert_sdk.run_geodetector(df, y_col, x_cols) -> 运行地理探测器，返回包含因子的解释力 Q 值的 JSON 字符串

【大模型红线：代码编写规范】
1. 必须封装为 \`def execute_pivot(gdf_dict, parameters):\` 主函数。
2. 直接调用 SDK，例如：\`joined = geo_pivot_sdk.safe_intersects(target_gdf, join_gdf)\`。
3. 必须处理好空值，调用空间算子前建议先清理脏数据。
4. 返回值必须是纯粹的 Pandas DataFrame 或 list of dicts，绝对不允许包含 'geometry' 几何列！

【代码编写规范要求】
1. 必须封装为 \`def execute(gdf_dict, parameters):\`。
2. 提取需要的图层进行运算（如 df = list(gdf_dict.values())[0]）。
3. 尽可能调用 geo_pivot_sdk 和 geo_feature_sdk 来处理核心逻辑，不要手写复杂的底层的空间相交。
4. 函数必须返回 \`list of dicts\`。
`;

  return await callAgentWithSchema(
    systemPrompt,
    `需要执行的透视任务：${state.userQuery}`,
    PivotSchema,
    "PivotAgent"
  );
}


// 唤醒：自愈智能体 (Fixer Agent)
export async function runFixerAgent(buggyCode: string, traceback: string, state: WorkflowState): Promise<FixerContract> {
  const systemPrompt = `
你是一个极其资深的 Python Debug 专家兼系统自愈智能体 (Fixer Agent)。
刚才 Pivot Agent 生成的代码在执行时崩溃了。请审查报错堆栈，彻底修复它。

【当前数据表结构】：${JSON.stringify(state.schemaInfo)}

【崩溃的代码】：
${buggyCode}

【沙盒真实报错堆栈】：
${traceback}

请仔细排查（例如拼错了列名、调用了不存在的函数、缺少 import 等），并返回修复后的完整执行代码。
`;

  return await callAgentWithSchema(
    systemPrompt,
    `请修复这段代码。`,
    FixerSchema,
    "FixerAgent"
  );
}


export async function runExpertAgent(state: WorkflowState): Promise<ExpertContract> {
  const systemPrompt = `
你是一个 GeoAI 系统的专家模型智能体 (Expert Agent)。
你的唯一任务是：根据归因分析需求，提取因变量(Y)和自变量(X)。

【当前数据状态】
表结构：${JSON.stringify(state.schemaInfo)}
(你只能从上述表结构中挑选已有的列作为 Y 和 X)
`;
  return await callAgentWithSchema(systemPrompt, `需要执行的建模任务：${state.userQuery}`, ExpertSchema, "ExpertAgent");
}

// ==================================================
// 独立模型生成模块 (供表格工具箱调用)
// ==================================================
export interface AIGeneratedModel {
    modelName: string;
    displayName: string;
    description: string;
    requiredColumns?: string[];
    parameters: Array<{ name: string; type: string; description: string }>; 
    pythonCode: string;
}

const SYSTEM_PROMPT = `
你是一位顶尖的 WebGIS 算法工程师。根据用户需求，抽象通用地理空间分析模型。
【严格的输出规范】只输出合法的 JSON 对象，不含任何 Markdown 标记。
{
  "modelName": "模型名全大写字母_下划线",
  "displayName": "中文名",
  "description": "简短描述",
  "parameters": [
      { "name": "y_column", "type": "column", "displayName": "因变量", "description": "说明" }
  ],
  "pythonCode": "def execute(df, parameters):\\\\n    pass"
}
`;

export const generateModelCodeFromAI = async (userPrompt: string): Promise<AIGeneratedModel> => {
    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-v3", 
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: `请设计并编写模型：\n${userPrompt}` }
            ],
            temperature: 0.1, 
        });

        let rawContent = response.choices[0].message.content || "{}";
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("找不到 JSON 结构。");
        
        const parsedData = JSON.parse(jsonMatch[0]) as AIGeneratedModel;
        
        let cleanPythonCode = parsedData.pythonCode
            .replace(/^```python\s*/i, '')
            .replace(/^```\s*/, '')
            .replace(/```\s*$/i, '')
            .split('\\n').join('\n').trim();

        parsedData.pythonCode = cleanPythonCode;
        return parsedData;

    } catch (error: any) {
        throw new Error(`AI 生成模型失败: ${error.message}`);
    }
};