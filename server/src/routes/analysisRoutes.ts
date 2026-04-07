import { Router } from 'express';
import { pivotAnalysis, generateGrid, exportGrid, 
    getRegisteredModels, registerModelByAI, 
    executeTableFormula, createModelViaNaturalLanguage, executeDynamicPipeline, rerunPivotCode } from '../controllers/analysisController';

const router = Router();

// POST /api/analysis/pivot
router.post('/pivot', pivotAnalysis);

// 空间网格聚合接口
router.post('/grid', generateGrid);

// 导出接口
router.post('/export-grid', exportGrid);

// 查询可用模型接口
router.get('/models', getRegisteredModels);

// 注册 AI 代理写入路由
router.post('/register-ai', registerModelByAI);

// 注册前端公式执行路由
router.post('/execute-formula', executeTableFormula);

// 通过自然语言进行动态分析 (Multi-Agent 分析入口)
router.post('/agent/generate-model', executeDynamicPipeline);


// 沙盒重跑接口 (用户修改代码后跳过 LLM 重新执行)
router.post('/agent/rerun-code', rerunPivotCode);

// 动态管道接口
router.post('/dynamic-pipeline', executeDynamicPipeline);

export default router;