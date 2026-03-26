import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// 移除所有 proxy 相关的环境变量设置
const openai = new OpenAI({
    // 替换为阿里云百炼的 OpenAI 兼容端点
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // 去阿里云百炼控制台申请一个免费的 API Key 填入 .env
    apiKey: process.env.ALIYUN_API_KEY, 
    // 强烈建议设置超时时间
    timeout: 120 * 1000, 
});

// 后续调用时，模型名称可以换成 'qwen-max' 或者阿里云托管的 'deepseek-coder'

// 模型函数接口定义
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

【 交互逻辑转变（极其重要）】
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

【Python 代码编写 架构逻辑（必读！！！）】
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

// 调度大模型生成结构化模型数据
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

        throw new Error("AI 智能体未能生成合法的模型代码，请调整指令语后重试。");
    }
};

// 意图拆解接口定义
export interface WorkflowBlueprint {
    pivot_strategy: {
        files_needed: string[];      // 需要用到的文件名列表
        operations: string[];        // 空间计算与聚合步骤（如网格化、相交、分组）
        output_schema: string[];     // 预期产出的列名（如 ['学区名', '平均房价', '房源数']）
    };
    chart_strategy: {
        chart_type: string;          // 图表类型（如 radar, heatmap, bar）
        requirements: string;        // 绘制图表的具体细节和要求
    };
    explanation: string;             // 解释给用户听的规划思路
}

// 通用 JSON/代码 字符串清理辅助函数
const cleanCodeBlock = (rawContent: string): string => {
    return rawContent
        .replace(/^```(json|python)?\n?/i, "")
        .replace(/\n?```$/, "")
        .trim();
};


// 意图拆解节点，将自然语言需求拆解为数据透视和可视化
export const planWorkflow = async (userPrompt: string, availableFiles: any[]): Promise<WorkflowBlueprint> => {
    // 动态提取当前工作区的文件信息
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
4. 必须且只能输出一个合法的 JSON 对象。

JSON 输出模板：
{
    "pivot_strategy": {
        "files_needed": ["这里填上面提供的数据集名字或ID"],(这是需要用到的文件名列表)
        "operations": ["生成5km六边形网格", "将事故点与网格进行空间连接 (sjoin)", "按网格ID分组计算总量"],(这是数据透视阶段的具体步骤，必须包含空间计算细节)
        "output_schema": ["网格ID", "事故总数"](这是预期产出的列名)
    },
    "chart_strategy": {
        "chart_type": "folium_map",(这是图表类型)
        "requirements": "以事故总数为权重，绘制带有颜色梯度的交互式热力地图"(这是绘制图表的具体细节和要求)
    },
    "explanation": "我将为您把点数据聚合成5km网格，并生成可交互的空间热力地图。"(这是解释给用户听的规划思路)
}
`;

    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-coder",
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


// 透视代码生成节点，根据拆解出的pivot_strategy生成Python代码
export const generatePivotCode = async (pivotStrategy: any): Promise<string> => {
    const PIVOT_CODER_PROMPT = `
你是一位顶级的 Python 空间数据挖掘专家。
请根据架构师提供的【数据透视策略】，编写一段极其健壮的 Python 空间聚合代码。

【透视策略】：
${JSON.stringify(pivotStrategy, null, 2)}

【Python 代码严格规范】：
1. 必须且只能包含一个主执行函数：\`def execute_pivot(gdf_dict, parameters):\`
2. 数据获取：\`gdf_dict\` 是一个字典，请通过 \`df = gdf_dict.get('文件名或ID')\` 获取对应的 GeoDataFrame。
3. 动态参数提取：涉及动态字段名，必须通过 \`parameters.get('参数名')\` 获取。
4. 【脏数据处理原则】：
   - 必须先将无效的 0、空字符串、纯空格替换为 np.nan：\`df[col] = df[col].replace([0, '', r'^\\s*$'], np.nan, regex=True)\`。
   - 文本转数字参与计算时，必须使用 \`pd.to_numeric(df[col], errors='coerce')\`。
5. 【专业空间计算】：
   - 严禁使用 for 循环逐行计算！必须使用 geopandas 的向量化操作（如 sjoin, overlay, buffer）。
   - 几何计算前，严禁直接在地理坐标系下计算！必须先 \`to_crs\` 转为以米为单位的局部 UTM 投影坐标系：\`df.to_crs(df.estimate_utm_crs())\`。
6. 【返回值强制要求】：
   - 必须将最终聚合完成的 DataFrame 转换为【列表字典】（List of Dicts）返回,绝对不要返回 HTML 或画图
   - 代码示例：\`return aggregated_df.to_dict(orient='records')\`
7. 只输出纯 Python 代码，绝对不要包含 Markdown 的 \`\`\`python 标签！
`;

    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-coder",
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


// 绘图代码生成节点，根据拆解出的chart_strategy生成Python代码
export const generateChartCode = async (chartStrategy: any, dataSample: any[]): Promise<string> => {
    const CHART_CODER_PROMPT = `
你是一位顶级的 Python 数据可视化专家。
请根据架构师提供的【图表策略】以及底层传来的【聚合数据样本】，编写一段专业的绘图代码。

【图表策略】：
${JSON.stringify(chartStrategy, null, 2)}

【当前传入的数据样本 (前2行)】：
${JSON.stringify(dataSample, null, 2)}
强烈注意：请务必直接使用样本中的 Key 作为图表的 x 轴、y 轴或指标列名，绝对不要自己凭空编造列名！

【Python 代码严格规范】：
1. 必须且只能包含一个主执行函数：\`def execute_chart(df, parameters):\`
2. \`df\` 已经是经过空间聚合后的标准 pandas DataFrame，里面装的就是上面的样本数据结构，不要再进行任何复杂的空间几何计算。
3. 【HTML 生成规范】：
   - 必须使用 \`plotly.express\` 或 \`plotly.graph_objects\` 生成美观、交互式的图表。
   - 必须调用 \`fig.to_html(full_html=False, include_plotlyjs='cdn')\` 将图表导出为 HTML 字符串片段。
4. 【返回值强制要求】：
   - 必须返回一个 Python 字典，严格包含 'html_string' 这个 key。
   - 代码示例：\`return {"html_string": html_str}\`
5. 只输出纯 Python 代码，绝对不要包含 Markdown 的 \`\`\`python 标签！
`;

    try {
        const response = await openai.chat.completions.create({
            model: "deepseek-coder",
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