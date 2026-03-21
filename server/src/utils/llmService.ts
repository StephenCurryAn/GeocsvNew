import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// 使用 OpenAI SDK 接入大模型 (DeepSeek 或 Qwen)
const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com', // 或者你的阿里云 baseURL
    apiKey: process.env.DEEPSEEK_API_KEY, // 确保 .env 里有这个配置
});

// 1. 替换顶部的接口定义，增加 parameters 字段
export interface AIGeneratedModel {
    modelName: string;
    displayName: string;
    description: string;
    requiredColumns?: string[]; // 🌟 新增：接收 AI 解析出的必须列名
    parameters: Array<{ name: string; type: string; description: string }>; // 🌟 新增：参数签名数组
    pythonCode: string;
}

const SYSTEM_PROMPT = `
你是一位顶尖的 WebGIS 算法工程师与空间统计学专家。你的任务是根据用户的自然语言需求，抽象并封装一个通用的地理空间分析模型。

【核心交互逻辑转变（极其重要）】
你生成的代码必须是**高度通用、可复用的算子**。绝对不要把具体的列名硬编码写死在 Python 代码里！
相反，你需要在 \`parameters\` 中定义这个模型需要哪些列或配置，并在 Python 代码中通过 \`parameters.get('参数名')\` 动态读取。

【严格的输出规范】
你必须且只能输出一个合法的 JSON 对象。绝对不要包含任何 Markdown 标记，绝对不要输出多余文字！
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
  "pythonCode": "完整的纯 Python 代码字符串，注意代码内部的换行符转义 (\\n)"
}

【Python 代码编写核心架构与极致性能规范（必读！！！）】
1. 必须且只能包含一个主执行函数：\`def execute(df, parameters):\`

2. 【极致防空与类型安全】（最高优先级）：
   - 任何通过 \`parameters.get('key')\` 获取的参数，**极有可能是 None**！
   - **绝对禁止**在未判空的情况下直接调用字符串方法！✅ 必须：\`geom_type = parameters.get('type'); geom_type = geom_type.lower() if isinstance(geom_type, str) else ""\`
   - 获取列名后，必须验证：\`if col_name and col_name not in df.columns: raise ValueError(...)\`
   - 【前端参数强制转换】：前端传入的数值极可能是字符串。必须安全转换：\`val = float(parameters.get('threshold') or 0.0)\`。

3. 【GIS 极致性能与向量化准则】（性能生死线）：
   - **【绝对禁止使用 for 循环遍历空间关系】**：在计算两两相交、包含、近邻关系、或生成缓冲区时，绝对禁止使用 \`for\` 循环嵌套！必须使用 \`gpd.sjoin\` (空间连接) 或向量化操作。
   - 生成缓冲区：直接使用向量化 \`buffer_gdf = df.copy(); buffer_gdf.geometry = df.geometry.buffer(distance)\`
   - 计算面积/长度：直接调用 \`df.geometry.area\` 或 \`df.geometry.length\`。
   - **几何投影前提**：计算距离、面积、长度、缓冲区时，若 CRS 为地理坐标系或未定义，必须转换：\`try: projected_gdf = df.to_crs(df.estimate_utm_crs())\`。

4. 【空间连接(sjoin)的致命逻辑陷阱（必读！）】：
   - **【坐标系必须绝对对齐】**：执行 \`gpd.sjoin(A, B)\` 时，A 和 B 必须在**同一个投影坐标系**下！绝不能用投影后的 A 和未投影的 B 进行连接，这会在物理空间上永远不相交！
   - **【Left Join 的 NaN 幽灵计数陷阱】**：使用 \`how='left'\` 连接后，如果没有相交，右表的列全为 \`NaN\`。在执行排除自身的过滤（如 \`id_x != id_y\`）前，**【必须】先通过 \`dropna\` 剔除 \`NaN\` 的行**（例如 \`joined = joined.dropna(subset=['右表ID列'])\`）。否则 \`NaN != id_x\` 为 True，会导致完全不相交的要素被荒谬地计数为 1。

5. 【底层脏数据处理与容错】：
   - 必须先将无效文本替换为 np.nan：\`df[col] = df[col].replace([0, '', r'^\\s*$'], np.nan, regex=True)\`。
   - 比较大小前，必须使用 \`pd.to_numeric(df[col], errors='coerce')\` 强制转换为浮点数。
   - 在任何空间计算前，利用 \`df.geometry.is_valid\` 和 \`df.geometry.notna()\` 清理无效几何。

6. 【强制返回值规范】：
   - 必须返回字典 (dict)，Key 为新增列名，Value 为 List 或 Series。
   - **【最核心底线】**：字典中每一个 Value 列表的长度，**必须与最原始输入 df 的总行数 (len(df)) 绝对对齐一致**！缺失值用 np.nan 或 0 填充。
`;

/**
 * 调度大模型生成结构化模型数据
 */
export const generateModelCodeFromAI = async (userPrompt: string): Promise<AIGeneratedModel> => {
    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-coder", // 或你的阿里模型名
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: `请根据以下需求设计并编写模型：\n${userPrompt}` }
            ],
            temperature: 0.1, // 极低的温度，保证 JSON 格式的稳定性
            max_tokens: 5000,
        });

        let rawContent = response.choices[0].message.content || "{}";
        
        // 🌟 防御性编程：清洗可能出现的 Markdown 标记
        rawContent = rawContent.trim();
        if (rawContent.startsWith("```json")) {
            rawContent = rawContent.replace(/^```json\n?/, "");
        }
        if (rawContent.startsWith("```")) {
            rawContent = rawContent.replace(/^```\n?/, "");
        }
        if (rawContent.endsWith("```")) {
            rawContent = rawContent.replace(/\n?```$/, "");
        }

        // 解析大模型返回的 JSON
        const parsedData = JSON.parse(rawContent.trim()) as AIGeneratedModel;
        
        if (!parsedData.modelName || !parsedData.pythonCode) {
            throw new Error("AI 返回的数据结构缺失关键字段");
        }

        return parsedData;

    } catch (error: any) {
        console.error("调用大模型 API 解析失败:", error);
        throw new Error("AI 智能体未能生成合法的模型代码，请调整指令语后重试。");
    }
};