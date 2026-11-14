import { Router } from 'express';
import {
    pivotAnalysis,
    generateGrid,
    exportGrid,
    getRegisteredModels,
    registerModelByAI,
    executeTableFormula,
    executeDynamicPipeline,
    rerunPivotCode,
    computeParkAccessibilityScore,
    computeLandslideSensitivityScore,
    computeSpatialAutocorrelation,
} from '../controllers/analysisController';

const router = Router();

router.post('/pivot', pivotAnalysis);
router.post('/grid', generateGrid);
router.post('/export-grid', exportGrid);
router.get('/models', getRegisteredModels);
router.post('/register-ai', registerModelByAI);
router.post('/execute-formula', executeTableFormula);
router.post('/agent/generate-model', executeDynamicPipeline);
router.post('/agent/rerun-code', rerunPivotCode);
router.post('/dynamic-pipeline', executeDynamicPipeline);
router.post('/park-accessibility-score', computeParkAccessibilityScore);
router.post('/landslide-sensitivity-score', computeLandslideSensitivityScore);
router.post('/spatial-autocorrelation', computeSpatialAutocorrelation);

export default router;
