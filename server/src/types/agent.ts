import { z } from "zod";

// ==========================================
// 1. 全局状态机 State (Node.js 内存流转使用)
// ==========================================
export interface WorkflowState {
  originalDataRef: string;       // 原始数据引用 (如 "file:///uploads/raw.csv")
  currentDataRef?: string;       // 当前处理后的临时数据引用 (如 "file:///tmp/step1.csv")
  userQuery: string;             // 用户当前的指令或 Planner 下发的子任务
  chatHistory: any[];            // 历史对话上下文数组
  schemaInfo: any;               // 当前数据表的元数据 (列名、数据类型等)

  // 智能体路由状态
  currentAgent: "planner" | "feature" | "pivot" | "expert" | "visualization" | "end" | "error";
  executionLog: string[];        // 记录已执行的操作，防止死循环并提供上下文

  // 【新增】：用于装载最终发给前端的渲染数据
  uiResponse?: {
    tableData?: any[];
    engine?: string;
    aiChartType?: string;
    chartHtml?: string;
    chartOption?: any;
    blueprint?: any; // 把 Planner 的规划也传回前端，方便展示 CoT 思维链
    pythonCode?: string;
  };

}

// ==========================================
// 2. 总控规划智能体契约 (Planner Agent)
// ==========================================
export const PlannerSchema = z.object({
  thought_process: z.string().describe("详细的思考过程。分析当前数据的schema、历史日志以及用户的最终目标，明确下一步需要哪种专职 Agent 来处理。"),
  next_agent: z.enum(["feature", "pivot", "expert", "visualization", "end"]).describe("下一个接手任务的智能体角色。如果用户需求已全部完成并已渲染图表，请选择 end。"),
  instruction_for_next_agent: z.string().describe("给下一个智能体下达的明确且具体的指令，包含它需要执行的具体操作细节。")
});
export type PlannerContract = z.infer<typeof PlannerSchema>;

// ==========================================
// 3. 空间特征工程智能体契约 (Feature Agent)
// ==========================================
export const FeatureSchema = z.object({
  thought_process: z.string().describe("分析任务指令，明确需要为基础数据衍生哪些新的空间特征列（如面积、距离、坡度等）。"),
  tool_name: z.enum([
    "calculate_area",       // 计算面积
    "calculate_distance",   // 计算最短距离
    "buffer_count",         // 计算缓冲区内要素数量
    "extract_raster_value"  // 从栅格(DEM)提取值，如高程、坡度
  ]).describe("需要调用的特征算子名称。"),
  parameters: z.record(z.string(), z.any()).describe("传给该算子的具体参数，必须以键值对形式提供，如 {'target_layer': 'river', 'distance': 500}。"),
  output_column_name: z.string().describe("预期生成的新特征列的列名，必须是合法的英文字段名（如 dist_to_river）。")
});
export type FeatureContract = z.infer<typeof FeatureSchema>;

// ==========================================
// 4. 空间数据透视智能体契约 (Pivot Agent) - 【5+1范式】
// ==========================================
export const PivotSchema = z.object({
  thought_process: z.string().describe("基于【5+1】范式，分析空间拓扑约束与多维关系代数聚合逻辑。"),
  target_object: z.string().describe("[T] 透视对象/主表标识"),
  spatial_constraint: z.object({
    predicate: z.enum(["none", "intersects", "within", "contains", "buffer", "nearest"]),
    distance: z.number().nullable().optional(),
    unit: z.string().nullable().optional()
  }).describe("[S] 空间约束条件。若无拓扑约束则 predicate 为 none。"),
  row_dimension: z.string().nullable().describe("[R] 行维度字段 (groupby的分组依据，如'行政区名'、'坡度分级')"),
  col_dimension: z.string().nullable().describe("[C] 列维度字段 (交叉透视列)"),
  agg_method: z.enum(["count", "size", "sum", "mean", "max", "min", "none"]).describe("[M] 聚合算子。"),
  value_field: z.string().nullable().describe("[V] 透视测度字段 (被聚合计算的数值列)"),

  // 【新增】：强制输出可执行的代码
  python_code: z.string().describe(`
    请提供完整的 Python 胶水代码。
    要求：
    1. 必须包含一个主函数 def execute(gdf_dict, parameters):
    2. gdf_dict 是包含所有图层数据的字典，键为 fileId，值为 GeoDataFrame。
    3. 你可以直接 import 并在代码中调用系统内置的 geo_feature_sdk 和 geo_pivot_sdk。
    4. 函数必须返回一个 list of dicts (即标准的 JSON 数组格式)。
  `)
});
// 【新增】：自愈智能体契约
export const FixerSchema = z.object({
  thought_process: z.string().describe("分析报错原因（Traceback）以及原始代码的问题所在。"),
  fixed_python_code: z.string().describe("修复后的完整 Python 代码，必须保持 def execute(...) 结构不变。")
});

export type PivotContract = z.infer<typeof PivotSchema>;

// ==========================================
// 5. 专家模型智能体契约 (Expert Agent)
// ==========================================
export const ExpertSchema = z.object({
  thought_process: z.string().describe("分析用户的归因分析需求，确认适用的地学模型，并明确因变量(Y)和自变量(X)。"),
  model_name: z.enum(["geodetector"]).describe("需要调用的领域专家模型名称。"),
  y_variable: z.string().describe("因变量 (Y) 的字段名，通常为要研究的现象（如：滑坡密度 landslide_density）。"),
  x_variables: z.array(z.string()).describe("自变量 (X) 的字段名列表（如：['elevation', 'slope', 'dist_to_river']）。")
});
export type FixerContract = z.infer<typeof FixerSchema>;
export type ExpertContract = z.infer<typeof ExpertSchema>;