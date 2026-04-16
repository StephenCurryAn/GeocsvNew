import { WorkflowState } from "../types/agent"; // 根据你的实际路径调整
import { 
  runPlannerAgent, 
  runFeatureAgent, 
  runPivotAgent, 
  runExpertAgent 
} from "../utils/llmService"; // 根据你的实际路径调整
import axios from 'axios';

/**
 * 核心：多智能体工作流引擎
 * @param initialState 初始状态
 * @returns 最终完成的状态
 */
export async function executeGeoAIWorkflow(initialState: WorkflowState): Promise<WorkflowState> {
  // 深拷贝一份状态，避免污染原始输入
  let state: WorkflowState = JSON.parse(JSON.stringify(initialState)); 
  
  const MAX_LOOPS = 10; // 防死循环保险丝：最多循环 10 次
  let loopCount = 0;

  console.log("🚀 [Workflow Engine] 启动多智能体协同工作流...");

  // 主事件循环：只要没说结束，也没报错，且没超时，就一直跑
  while (state.currentAgent !== "end" && state.currentAgent !== "error" && loopCount < MAX_LOOPS) {
    loopCount++;
    console.log(`\n🔄 [迭代 ${loopCount}] 当前激活智能体: 【${state.currentAgent.toUpperCase()}】`);

    try {
      switch (state.currentAgent) {
        
        // ==========================================
        // 1. 总控大脑：负责决策和派单
        // ==========================================
        case "planner": {
          const plan = await runPlannerAgent(state);
          console.log(`[Planner 思考]: ${plan.thought_process}`);
          console.log(`[Planner 决策]: 下一步交接给 -> ${plan.next_agent}`);
          
          state.executionLog.push(`[Planner] 决定路由给: ${plan.next_agent}. 指令: ${plan.instruction_for_next_agent}`);
          
          // 状态转移：把下一棒交出去，并把大总管的详细指令覆盖掉 userQuery
          state.currentAgent = plan.next_agent;
          state.userQuery = plan.instruction_for_next_agent; 
          break;
        }

        // ==========================================
        // 2. 特征工程工人：干脏活累活，造新列
        // ==========================================
        case "feature": {
          const featurePlan = await runFeatureAgent(state);
          state.executionLog.push(`[Feature] 执行算子: ${featurePlan.tool_name}, 准备生成新列: ${featurePlan.output_column_name}`);
          
          console.log(`[Feature] 正在向 Python 沙盒 (8000端口) 下发特征计算指令...`);
          
          // 发起真实的物理沙盒调用
          const PYTHON_API_URL = 'http://127.0.0.1:8000/api';
          const response = await axios.post(`${PYTHON_API_URL}/agent/feature`, {
              data_ref: state.currentDataRef || state.originalDataRef, // 核心：告诉沙盒数据在哪
              tool_name: featurePlan.tool_name,
              parameters: featurePlan.parameters,
              output_column_name: featurePlan.output_column_name
          });

          // 沙盒执行完毕后，会把包含新列的临时文件路径和新表结构返回回来
          state.currentDataRef = (response.data as any).new_data_ref;
          state.schemaInfo = (response.data as any).new_schema_info;
          
          console.log(`[Feature] 沙盒计算完成！数据指针更新为: ${state.currentDataRef}`);
          
          // 干完活，乖乖把控制权交还给总控大脑
          state.currentAgent = "planner"; 
          break;
        }

        // ==========================================
        // 3. 空间透视工人：代码生成 + 沙盒执行 + 报错自愈
        // ==========================================
        case "pivot": {
          console.log(`[Pivot] 开始代码生成与透视逻辑分析...`);
          let pivotPlan = await runPivotAgent(state);
          let currentCode = pivotPlan.python_code;
          state.executionLog.push(`[Pivot] AI 生成了透视 Python 代码。`);
          
          let success = false;
          let retryCount = 0;
          const MAX_RETRIES = 3; // 最多允许自愈 3 次
          
          while (!success && retryCount < MAX_RETRIES) {
              try {
                  console.log(`[Sandbox] 正在向 Python 沙盒投递代码执行 (尝试 ${retryCount + 1}/${MAX_RETRIES})...`);
                  const PYTHON_API_URL = 'http://127.0.0.1:8000/api';
                  const axios = require('axios');
                  const response = await axios.post(`${PYTHON_API_URL}/agent/pivot`, {
                      data_ref: state.currentDataRef || state.originalDataRef,
                      python_code: currentCode // 把 AI 写的代码发给底层
                  });
                  
                  // 如果执行成功，保存结果文件引用，并把这段成功的代码存入背包供前端展示
                  state.currentDataRef = (response.data as any).new_data_ref;
                  state.uiResponse = state.uiResponse || {};
                  state.uiResponse.pythonCode = currentCode; // 装进背包给前端编辑器！
                  
                  console.log(`[Sandbox] 沙盒执行成功！`);
                  success = true;
                  
              } catch (error: any) {
                  retryCount++;
                  const traceback = error.response?.data?.detail || error.message;
                  console.error(`[Sandbox] 沙盒执行崩溃，报错信息：\n${traceback}`);
                  state.executionLog.push(`[Sandbox] 第 ${retryCount} 次执行失败，触发 Fixer 智能体自愈...`);
                  
                  if (retryCount >= MAX_RETRIES) {
                      throw new Error(`自愈失败次数过多，最终报错: ${traceback}`);
                  }
                  
                  // 🚀 唤醒自愈体！
                  const { runFixerAgent } = require('../utils/llmService');
                  const fixPlan = await runFixerAgent(currentCode, traceback, state);
                  currentCode = fixPlan.fixed_python_code;
                  console.log(`[Fixer] 自愈完成，获得新代码，准备重新投递！`);
              }
          }

          state.currentAgent = "planner"; 
          break;
        }

        // ==========================================
        // 4. 专家模型工人：跑地学模型
        // ==========================================
        case "expert": {
          const expertPlan = await runExpertAgent(state);
          state.executionLog.push(`[Expert] 决定调用专业模型: ${expertPlan.model_name}`);
          
          console.log(`[Expert] 正在查询工具注册中心 (PostgreSQL)... 寻找: ${expertPlan.model_name}`);
          
          // 1. 去 PostgreSQL 动态查询微服务 API 地址
          const { findToolByName } = require('../models/AgentTool');
          const toolMeta = await findToolByName(expertPlan.model_name);
          
          // 兜底机制：为了你现阶段能跑通论文案例，如果数据库里还没录入，先写死一个本地地址
          // 注意端口是 8001，避免和你主业务的 FastAPI (8000) 冲突！
          const apiEndpoint = toolMeta ? toolMeta.api_endpoint : "http://127.0.0.1:8001/api/expert/geodetector";

          if (!apiEndpoint) {
              throw new Error(`未找到可用且激活的专业模型微服务: ${expertPlan.model_name}`);
          }

          console.log(`[Expert] 寻址成功！向算力集群发起运算请求... 参数: Y=${expertPlan.y_variable}, X=${expertPlan.x_variables}`);
          
          // 2. 发起跨容器/跨服务 HTTP POST 请求
          const axios = require('axios');
          const response = await axios.post(apiEndpoint, {
              // 告诉 Python 当前已经处理好的数据指针 (例如之前 Feature Agent 算好的结果)
              data_ref: state.currentDataRef || state.originalDataRef, 
              y_variable: expertPlan.y_variable,
              x_variables: expertPlan.x_variables
          });

          // 3. 接收运算结果
          const qValuesResult = (response.data as any).result;
          console.log(`[Expert] 模型计算完毕！获取到 ${qValuesResult.length} 个因子的 Q 值。`);
          
          // 4. 将高阶分析结果以临时 JSON 的形式存下来，更新全局数据指针
          const fs = require('fs');
          const path = require('path');
          const tmpDir = path.join(process.cwd(), 'tmp');
          const resultFilePath = path.join(tmpDir, `geodetector_result_${Date.now()}.json`);
          
          // 确保 tmp 目录存在
          if (!fs.existsSync(tmpDir)) {
              fs.mkdirSync(tmpDir, { recursive: true });
          }
          
          fs.writeFileSync(resultFilePath, JSON.stringify(qValuesResult, null, 2));
          
          state.currentDataRef = `file://${resultFilePath}`; // 数据状态变更为 Q值结果表
          
          // 任务完成，交还总控
          state.currentAgent = "planner";
          break;
        }

        // ==========================================
        // 5. 渲染工人：画图收尾并组装发给前端的 UI 数据包
        // ==========================================
        case "visualization": {
          console.log(`[Visualization] 正在将数据组装为前端渲染契约...`);
          
          // ⚠️ 这里本来应该调用 Visualization Agent 决定画什么图。
          // 现阶段，我们直接读取上一环节(Pivot 或 Expert) 生成的最终数据，装进背包。
          
          let tableData: any[] = [];
          
          // 如果数据是临时文件，我们把它读出来发给前端
          if (state.currentDataRef && state.currentDataRef.startsWith('file://')) {
              const fs = require('fs');
              const filePath = state.currentDataRef.replace('file://', '');
              if (fs.existsSync(filePath)) {
                  tableData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              }
          }

          // 将数据装入状态机的 uiResponse 背包
          state.uiResponse = {
              tableData: tableData,
              engine: 'echarts', // 统一交给前端强大的 ECharts 自适应组件去渲染
              aiChartType: 'bar', // 默认柱状图，后续可以由 Viz Agent 动态决定
              blueprint: { explanation: state.executionLog.join('\n') } // 巧妙地把思考过程伪装成 blueprint 发给前端
          };

          state.executionLog.push(`[Visualization] 成功打包前端渲染 JSON，准备退出状态机。`);
          
          // 画完图，打包完，整个任务彻底结束，退出循环
          state.currentAgent = "end";
          break;
        }

        default: {
          throw new Error(`未知的 Agent 角色: ${state.currentAgent}`);
        }
      }
    } catch (error: any) {
      console.error("❌ [Workflow] 运行时异常:", error);
      state.currentAgent = "error";
      state.executionLog.push(`[Error] 流程崩溃: ${error.message}`);
    }
  }

  if (loopCount >= MAX_LOOPS) {
    console.warn("⚠️ [Workflow] 触发防死循环熔断机制，强制终止。");
    state.executionLog.push("[System] 因超过最大循环次数而强制终止。");
  }

  console.log("🏁 [Workflow Engine] 工作流执行完毕。");
  return state; // 将最终状态返回给控制器/前端
}