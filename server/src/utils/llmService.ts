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
    requiredColumns?: string[]; //   新增：接收 AI 解析出的必须列名
    parameters: Array<{ name: string; type: string; description: string }>; //   新增：参数签名数组
    pythonCode: string;
}

const SYSTEM_PROMPT = `
你是一位顶尖的 WebGIS 算法工程师与空间统计学专家。你的任务是根据用户的自然语言需求，抽象并封装一个通用的地理空间分析模型。

【核心交互逻辑转变（极其重要）】
你生成的代码必须是**高度通用、可复用的算子**。绝对不要把具体的列名（如“毁坏房”、“人口”）硬编码写死在 Python 代码里！
相反，你需要在 \`parameters\` 中定义这个模型需要哪些列，并在 Python 代码中通过 \`parameters.get('参数名')\` 动态读取用户在前端选择的列名。

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
        "description": "请选择要分析的目标变量列，必须是连续数值型（如房价、发病率等）。" 
      },
      { 
        "name": "threshold_val", 
        "type": "number", 
        "displayName": "阈值参数",
        "description": "用于判断的数值阈值。" 
      }
  ],
  "pythonCode": "完整的纯 Python 代码字符串，注意代码内部的换行符转义 (\\n)"
}

【Python 代码编写核心架构逻辑（必读！！！）】
1. 必须且只能包含一个主执行函数：\`def execute(df, parameters):\`
2. \`parameters\`: 这是一个字典，包含了用户在前端传入的动态列名或数值。
   ★ 重点注意（动态列提取与容错）：
   - 必须通过 \`col_name = parameters.get('y_column')\` 来获取列名！
   - 必须检查该列名是否存在：\`if col_name not in df.columns: raise ValueError(...)\`
   - 【强制类型转换】：前端传入的非列名参数（如阈值）极有可能是字符串形式！在参与数学比较前，必须强制转换类型，如 \`float(parameters.get('threshold'))\`。
   -参数类型兼容陷阱：从 parameters 中获取的列名（尤其是用户可能选择单个或多个的自变量列）**极大概率是字符串(str)**而不是列表(list)！在对列名执行 + 拼接或 for 循环遍历之前，【必须】先判断其类型并强制转换为 List。
    例如：x_cols = params.get('x'); if isinstance(x_cols, str): x_cols = x_cols.split(',')。绝不能直接用列表 [y] 加上未验证类型的 x_cols，否则会引发 TypeError 崩溃！
3. \`df\`: 代表底层引擎传入的 GeoDataFrame 数据。
   - 【极其重要的脏数据处理原则】：底层可能将空值填充为 0 或空字符串。
     (1) 必须先将无效的 0、空字符串、纯空格替换为 np.nan：\`df[col] = df[col].replace([0, '', r'^\\s*$'], np.nan, regex=True)\`。
     (2) 在进行大小比较前，如果该列包含文本，【强烈要求】使用 \`pd.to_numeric(df[col], errors='coerce')\` 将其强制转换为浮点数，无法转换的字符会自动变为 NaN，绝不能直接让字符串与数字比大小！

4. 【专业地理空间与代码健壮性避坑指南】：
   - **严禁静默吞噬错误**：绝对不允许使用 \`except Exception: pass\` 或 \`except Exception: continue\`！如果必须捕获异常，请务必 \`print(f"Error: {e}")\` 打印错误，并为该行赋予 np.nan 或默认值，绝不能让程序盲目且无声地输出错误结果。
   - **优先使用 Pandas 向量化操作**：严禁使用笨重的 \`for idx in range(len(df))\` 逐行遍历去写 \`if-else\`！必须使用 Pandas 的向量化操作（如 \`df[col].apply()\`、正则表达式提取 \`df[col].str.extract()\`，或条件掩码 \`np.where()\`），这样不仅性能快百倍，而且天然免疫 NaN 报错。
   - **自适应离散化**：如果模型（如地理探测器）要求输入为【离散/类别量】，而用户传入的 x_column 是连续数值型，代码必须自动调用 \`pd.qcut\` 或自然间断点法将其强制离散化为 5 类。
   - **统计合法性拦截**：计算前必须探查有效数据的方差是否大于0，以及分类变量的类别数是否 >= 2。如果不满足，应抛出明确的 ValueError。
   - **初始化空列的类型陷阱**：当你使用 \`pd.Series(np.nan, index=df.index)\` 初始化一个空列，并准备往里面写入字符串/文本时，【必须】显式加上 \`dtype=object\`，即 \`pd.Series(np.nan, index=df.index, dtype=object)\`，否则 Pandas 会因 float64 无法强转字符串而报错崩溃。
   - **【极其重要】几何计算必须先投影**：如果要求计算**距离（Distance）、长度（Length）或面积（Area）**，且原 GeoDataFrame 的 CRS 是地理坐标系（如 EPSG:4326）或未定义，【严禁】直接调用 \`.length\` 或 \`.area\`！必须先使用 \`df.to_crs(df.estimate_utm_crs())\` 将其转换为以米为单位的局部 UTM 投影坐标系后，再进行几何计算！例如：\`projected_gdf = df.to_crs(df.estimate_utm_crs()); area = projected_gdf.geometry.area\`。

5. **【强制】返回值必须是字典 (Dictionary) 且长度绝对对齐**：
  - 你的算法可能会产生一个或多个有价值的指标序列。最终 \`execute\` 函数的返回值必须是一个 Python 字典 (dict)！
  - 字典的 Key 是你推断出的【新增列名】（必须是具有业务意义的英文字符串，如 'Risk_Level'）。
  - 字典的 Value 是一维 Python List 或 Pandas Series。
  - 【全局汇总指标的致命陷阱】：如果用户要求计算的是全局指标（如地理探测器的 q 值、总和、平均值等单一数值或短数组），【严禁】直接返回短数组！你必须将这些全局结果转换为字符串，并使用 \`[结果] * len(df)\` 的方式，将其填充复制为与原始 df 行数完全一致的列表，这时候要注意推断新增的列数。
  - 无论什么情况，字典中每个 Value 列表的长度【必须与最原始传入的 df 的行数绝对一致】！底层引擎是按行更新的，长度差 1 个都会导致 list index out of range 致命崩溃！

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
        
        //   防御性编程：清洗可能出现的 Markdown 标记
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