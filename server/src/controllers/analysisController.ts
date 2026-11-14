import { Request, Response } from 'express';
import * as Feature from '../models/Feature';
import pool from '../config/db';
import { queryAttributePivot } from '../modules/attributePivot';
import { AnalysisInputError } from '../modules/spatialPivot/plan';
import * as ModelRegistry from '../models/ModelRegistry';
import { generateModelCodeFromAI, planWorkflow, generatePivotCode, 
        generateChartCode, fixPivotCode, fixChartCode,
        generateFeatureCalcCode, fixFeatureCalcCode,
        generateProModelCode, fixProModelCode,
        type WorkflowBlueprint
         /* ... */  } from '../utils/llmService';
import * as turf from '@turf/turf';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import * as FileNode from '../models/FileNode'; // 用于写库

// WSL2 中 FastAPI 运行的地址
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000/api';
// 更新后的 Python API 返回结构 (API 契约)
interface PythonApiResponse {
  status: string;
  result_col_names: string[];
  result_data: Array<any>; // 明确告诉 TS 这是一个包含 id 和 score 的对象数组
  execution_time_ms: number;
}

// [Phase 5] Python SDK 物理直注字符串
// 直接拼接在执行代码前方，彻底解决沙盒 import 找不到路径的问题
// ==========================================
type AgentMode = 'pivot' | 'feature_calc' | 'pro_model';

interface InteractionPairSummary {
    factorA: string;
    factorB: string;
    qValue: number;
    interactionType?: string;
}

interface GeodetectorSpecSummary {
    analysisType: 'interaction' | 'factor' | 'unknown';
    yCol: string | null;
    xCols: string[];
}

interface PipelineContextMemory {
    lastBlueprint?: WorkflowBlueprint | any;
    lastPythonCode?: string;
    lastTableData?: Array<Record<string, any>>;
    lastResultMeta?: {
        agentMode?: AgentMode;
        sourceFileIds?: string[];
        resultFileId?: string;
        resultRowCount?: number;
        topInteractionPair?: InteractionPairSummary | null;
        geodetectorSpec?: GeodetectorSpecSummary;
    };
}

const INTERACTION_FACTOR_A_KEY = '因子A';
const INTERACTION_FACTOR_B_KEY = '因子B';
const INTERACTION_Q_KEY = '交互q值';
const INTERACTION_TYPE_KEY = '交互类型';
const FOLLOWUP_HINT_PATTERNS = [
    /刚才/,
    /上次/,
    /上一轮/,
    /交互.*q值最高/,
    /最高的两个因子/,
    /最高交互/,
    /组合下/,
];

const uniqueStrings = (values: unknown[]): string[] => {
    return Array.from(new Set((values || []).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)));
};

const resolveFeatureCalcWriteTarget = async (
    candidateFileIds: unknown[],
    rows: Array<{ id?: string | number }>,
    fallbackFileId?: string,
): Promise<{ targetFileId: string; matchedCount: number }> => {
    const ids = rows
        .map(row => row?.id)
        .filter((id): id is string | number => id !== undefined && id !== null && String(id).length > 0);
    const candidates = uniqueStrings([...candidateFileIds, fallbackFileId]);

    let bestFileId = candidates[0] || fallbackFileId || '';
    let bestMatchCount = -1;

    for (const fileId of candidates) {
        const matchCount = await Feature.countMatchingFeatureIds(fileId, ids);
        if (matchCount > bestMatchCount) {
            bestFileId = fileId;
            bestMatchCount = matchCount;
        }
    }

    return { targetFileId: bestFileId, matchedCount: Math.max(bestMatchCount, 0) };
};

const toFiniteNumber = (value: unknown): number | null => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
};

const inferTopInteractionPairFromRows = (rows?: Array<Record<string, any>>): InteractionPairSummary | null => {
    if (!Array.isArray(rows) || rows.length === 0) return null;

    let bestPair: InteractionPairSummary | null = null;
    for (const row of rows) {
        const factorA = row?.[INTERACTION_FACTOR_A_KEY];
        const factorB = row?.[INTERACTION_FACTOR_B_KEY];
        const qValue = toFiniteNumber(row?.[INTERACTION_Q_KEY]);

        if (!factorA || !factorB || qValue === null || factorA === factorB) continue;
        if (!bestPair || qValue > bestPair.qValue) {
            bestPair = {
                factorA: String(factorA),
                factorB: String(factorB),
                qValue,
                interactionType: row?.[INTERACTION_TYPE_KEY] ? String(row[INTERACTION_TYPE_KEY]) : undefined,
            };
        }
    }

    return bestPair;
};

const extractGeodetectorSpecFromCode = (pythonCode?: string): GeodetectorSpecSummary => {
    if (!pythonCode) {
        return { analysisType: 'unknown', yCol: null, xCols: [] };
    }

    const analysisType = pythonCode.includes('safe_geodetector_interaction')
        ? 'interaction'
        : pythonCode.includes('safe_geodetector_factor')
        ? 'factor'
        : 'unknown';

    const yMatch = pythonCode.match(/y_col\s*=\s*['"]([^'"]+)['"]/);
    const xMatch = pythonCode.match(/x_cols\s*=\s*\[([^\]]*)\]/);
    const xCols = xMatch
        ? Array.from(xMatch[1].matchAll(/['"]([^'"]+)['"]/g)).map(match => match[1])
        : [];

    return {
        analysisType,
        yCol: yMatch?.[1] ?? null,
        xCols,
    };
};

const inferYColumnFromContext = (context?: PipelineContextMemory): string | null => {
    const metaSpec = context?.lastResultMeta?.geodetectorSpec;
    if (metaSpec?.yCol) return metaSpec.yCol;

    const codeSpec = extractGeodetectorSpecFromCode(context?.lastPythonCode);
    if (codeSpec.yCol) return codeSpec.yCol;

    const parameterMatch = context?.lastBlueprint?.parameters?.find((parameter: any) => {
        const key = String(parameter?.name || '').toLowerCase();
        return key.includes('y') && key.includes('col') && parameter?.defaultValue;
    });

    return parameterMatch?.defaultValue ? String(parameterMatch.defaultValue) : null;
};

const inferTargetFileIdFromContext = (context: PipelineContextMemory | undefined, fallbackFileIds: string[]): string | null => {
    const targetDep = context?.lastBlueprint?.data_dependencies?.find((dependency: any) => {
        return typeof dependency?.role === 'string' && dependency.role.toLowerCase().includes('target');
    });

    return targetDep?.file_id
        || uniqueStrings(context?.lastResultMeta?.sourceFileIds || [])[0]
        || fallbackFileIds[0]
        || null;
};

const isInteractionFollowupPrompt = (userPrompt: string): boolean => {
    return FOLLOWUP_HINT_PATTERNS.some(pattern => pattern.test(userPrompt));
};

const buildFollowupPivotBlueprint = (
    userPrompt: string,
    availableFileIds: string[],
    context?: PipelineContextMemory,
): WorkflowBlueprint | null => {
    if (!context || !isInteractionFollowupPrompt(userPrompt)) return null;

    const topInteractionPair = context.lastResultMeta?.topInteractionPair
        || inferTopInteractionPairFromRows(context.lastTableData);
    const geodetectorSpec = context.lastResultMeta?.geodetectorSpec
        || extractGeodetectorSpecFromCode(context.lastPythonCode);
    const yCol = geodetectorSpec.yCol || inferYColumnFromContext(context);
    const targetFileId = inferTargetFileIdFromContext(context, availableFileIds);

    if (!topInteractionPair || !yCol || !targetFileId) return null;

    return {
        task_type: 'context_followup_pivot',
        reuse_code: false,
        data_dependencies: [
            {
                file_id: targetFileId,
                role: 'TargetLayer',
                description: '沿用上一轮专业模型分析所使用的主体网格图层',
                type: 'Vector',
            },
        ],
        parameters: [],
        visualization_spec: {
            engine: 'echarts',
            chart_type: 'heatmap',
            dimensions: [topInteractionPair.factorA, topInteractionPair.factorB],
            metrics: [`sum(${yCol})`],
        },
        explanation: `识别为基于上一轮交互探测结果的连续追问：已从上下文中提取交互q值最高的两个因子 ${topInteractionPair.factorA} 与 ${topInteractionPair.factorB}，并以它们作为二维透视的行列维度，对 ${yCol} 执行组合统计。`,
    };
};

const resolveExecutionMode = (requestedMode: AgentMode, blueprint: WorkflowBlueprint): AgentMode => {
    if (requestedMode === 'pro_model' && blueprint.task_type === 'context_followup_pivot') {
        return 'pivot';
    }
    return requestedMode;
};

interface SensitivityScoreOperatorParams {
    targetFileId: string;
    yField: string;
    factorFields: string[];
    scoreFieldName?: string;
    levelFieldName?: string;
    levelCount?: number;
}

interface SensitivityScoreOperatorResult {
    targetFileId: string;
    yField: string;
    factorFields: string[];
    scoreFieldName: string;
    levelFieldName: string;
    levelCount: number;
    updatedCount: number;
    scoreRows: Array<Record<string, any>>;
    weightRows: Array<Record<string, any>>;
    weightFileId: string;
    weightFileName: string;
    summary?: Record<string, any>;
}

interface SpatialAutocorrelationParams {
    targetFileId: string;
    valueField: string;
    nameField?: string | null;
    contiguity?: 'queen' | 'rook';
    permutations?: number;
    significanceLevel?: number;
    localIFieldName?: string;
    pValueFieldName?: string;
    clusterFieldName?: string;
    hotspotFieldName?: string;
    spatialLagFieldName?: string;
    zScoreFieldName?: string;
    neighborCountFieldName?: string;
}

interface SpatialAutocorrelationResult {
    targetFileId: string;
    valueField: string;
    nameField?: string | null;
    contiguity: 'queen' | 'rook';
    permutations: number;
    significanceLevel: number;
    localIFieldName: string;
    pValueFieldName: string;
    clusterFieldName: string;
    hotspotFieldName: string;
    spatialLagFieldName: string;
    zScoreFieldName: string;
    neighborCountFieldName: string;
    updatedCount: number;
    localRows: Array<Record<string, any>>;
    mapPayload: Array<Record<string, any>>;
    resultFileId: string;
    resultFileName: string;
    summary?: Record<string, any>;
}

interface ParkAccessibilityParams {
    gridFileId: string;
    streetFileId: string;
    distanceField: string;
    streetNameField?: string | null;
    normalizationMethod?: 'linear_reverse' | 'log_reverse';
    gridScoreFieldName?: string;
    streetScoreFieldName?: string;
}

interface ParkAccessibilityResult {
    gridFileId: string;
    streetFileId: string;
    distanceField: string;
    streetNameField?: string | null;
    normalizationMethod: 'linear_reverse' | 'log_reverse';
    gridScoreFieldName: string;
    streetScoreFieldName: string;
    gridUpdatedCount: number;
    streetUpdatedCount: number;
    streetRows: Array<Record<string, any>>;
    resultFileId: string;
    resultFileName: string;
    summary?: Record<string, any>;
}

const SENSITIVITY_PROMPT_PATTERNS = [
    /q值.*权重/,
    /q\s*值.*归一化/,
    /归一化为权重/,
    /综合评分/,
    /敏感性综合评分/,
];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isSensitivityScoringPrompt = (userPrompt: string): boolean => {
    const normalized = userPrompt || '';
    return SENSITIVITY_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
};

const normalizePromptToken = (value: string): string => {
    return String(value || '').toLowerCase().replace(/[\s_\-（）()]/g, '');
};

const SENSITIVITY_COLUMN_ALIASES: Array<{ terms: string[]; hints: string[] }> = [
    { terms: ['滑坡发生数量', '滑坡数量', '滑坡发生', '因变量'], hints: ['landslidecount', 'landslide', 'hazard', 'disaster'] },
    { terms: ['坡度等级', '坡度'], hints: ['slopec', 'slope'] },
    { terms: ['高程等级', '高程', '海拔'], hints: ['demc', 'elev', 'elevation', 'dem'] },
    { terms: ['植被覆盖等级', '植被覆盖', '植被', 'ndvi'], hints: ['ndvic', 'ndvi', 'vegetation'] },
    { terms: ['降水等级', '降水', '雨量'], hints: ['rainc', 'rain', 'precip'] },
    { terms: ['到断裂带距离等级', '断裂带距离', '断裂带', '断层'], hints: ['duanc', 'fault', 'duan'] },
    { terms: ['到道路距离等级', '道路距离', '道路'], hints: ['roadc', 'road'] },
    { terms: ['到河流距离等级', '河流距离', '河流'], hints: ['riverc', 'river', 'stream'] },
    { terms: ['土地利用类型', '土地利用'], hints: ['landusec', 'landuse', 'land'] },
    { terms: ['坡向等级', '坡向'], hints: ['aspectclass', 'aspect'] },
];

const findColumnByHints = (columns: string[], hints: string[]): string | null => {
    const normalizedColumns = columns.map((column) => ({
        raw: column,
        normalized: normalizePromptToken(column),
    }));

    for (const hint of hints) {
        const normalizedHint = normalizePromptToken(hint);
        const matchedColumn = normalizedColumns.find(({ normalized }) => normalized.includes(normalizedHint));
        if (matchedColumn) return matchedColumn.raw;
    }

    return null;
};

const inferColumnsByPromptAliases = (userPrompt: string, columns: string[]) => {
    const matched = new Set<string>();
    const aliasesHit = SENSITIVITY_COLUMN_ALIASES.filter((alias) => {
        return alias.terms.some((term) => userPrompt.includes(term));
    });

    for (const alias of aliasesHit) {
        const column = findColumnByHints(columns, alias.hints);
        if (column) matched.add(column);
    }

    return Array.from(matched);
};

const pickSensitivityTargetSchema = (userPrompt: string, availableFiles: any[]) => {
    const scored = (availableFiles || []).map((file) => {
        const columns = Array.isArray(file?.columns) ? file.columns : [];
        const exactHitCount = columns.filter((column: string) => userPrompt.includes(column)).length;
        const aliasHitCount = inferColumnsByPromptAliases(userPrompt, columns).length;
        const hitCount = exactHitCount + aliasHitCount;
        return { file, hitCount };
    });

    scored.sort((a, b) => b.hitCount - a.hitCount);
    return scored[0]?.file || availableFiles?.[0] || null;
};

const inferSensitivitySpecFromPrompt = (
    userPrompt: string,
    availableFiles: any[],
): SensitivityScoreOperatorParams | null => {
    if (!isSensitivityScoringPrompt(userPrompt)) return null;

    const targetSchema = pickSensitivityTargetSchema(userPrompt, availableFiles);
    if (!targetSchema?.fileId || !Array.isArray(targetSchema.columns) || targetSchema.columns.length === 0) {
        return null;
    }

    const columns = targetSchema.columns as string[];
    const mentionedColumns = Array.from(new Set([
        ...columns.filter((column: string) => userPrompt.includes(column)),
        ...inferColumnsByPromptAliases(userPrompt, columns),
    ]));
    if (mentionedColumns.length < 2) return null;

    const yField = mentionedColumns.find((column: string) => {
        const escaped = escapeRegExp(column);
        return new RegExp(`以\\s*${escaped}\\s*为因变量`).test(userPrompt)
            || new RegExp(`${escaped}\\s*为因变量`).test(userPrompt)
            || new RegExp(`${escaped}[^，。；,\\n]{0,20}因变量`).test(userPrompt);
    }) || findColumnByHints(mentionedColumns, ['landslidecount', 'landslide', 'hazard', 'disaster'])
        || mentionedColumns.find((column: string) => /滑坡|灾害|发生/.test(column));

    if (!yField) return null;

    const factorFields = mentionedColumns.filter((column: string) => column !== yField);
    if (factorFields.length === 0) return null;

    return {
        targetFileId: targetSchema.fileId,
        yField,
        factorFields,
        scoreFieldName: '滑坡敏感性综合评分',
        levelFieldName: '滑坡敏感性等级',
        levelCount: 5,
    };
};

const SPATIAL_AUTOCORR_PROMPT_PATTERNS = [
    /moran/i,
    /lisa/i,
    /空间自相关/,
    /局部自相关/,
    /热点街道/,
    /高-高/,
    /低-低/,
];

const SPATIAL_AUTOCORR_VALUE_HINTS = [
    '可达性得分',
    '可达性评分',
    '公园可达性',
    '医疗设施可达性',
    '可达性',
    'accessibilityscore',
    'accessibility',
    'parkaccessscore',
    'parkaccess',
    'accessscore',
    'access',
    'score',
];

const SPATIAL_AUTOCORR_NAME_HINTS = [
    '街道名称',
    '街道名',
    '街道',
    '名称',
    'name',
    'street',
    'town',
    'subdistrict',
];

const PARK_ACCESSIBILITY_PROMPT_PATTERNS = [
    /公园可达性/,
    /park.*access/i,
    /距公园距离/,
    /最近公园距离/,
];

const PARK_DISTANCE_FIELD_HINTS = [
    'distance_to_nearest_park',
    'nearest_park_distance',
    'nearestparkdistance',
    'nearest_park',
    '距公园距离',
    '到公园距离',
    '最近公园距离',
    '公园距离',
    'park_distance',
    'distance_to_park',
    'dist_park',
    'parkdist',
];

const isParkAccessibilityPrompt = (userPrompt: string): boolean => {
    const normalized = userPrompt || '';
    const hasAccessibility = PARK_ACCESSIBILITY_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
    const hasComputeIntent = /计算|构建|生成|测算|标准化|聚合/.test(normalized);
    const hasStreetIntent = /街道|主城区|聚合到街道/.test(normalized);
    return hasAccessibility && hasComputeIntent && hasStreetIntent;
};

const isSpatialAutocorrelationPrompt = (userPrompt: string): boolean => {
    const normalized = userPrompt || '';
    return SPATIAL_AUTOCORR_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
};

const isPolygonGeomType = (geomType?: string): boolean => /polygon/i.test(String(geomType || ''));

const findSpatialAutocorrelationNameField = (columns: string[]): string | null => {
    const exactCandidates = ['街道名称', '街道名', '街道', '名称', 'name', 'Name', 'street_name'];
    for (const candidate of exactCandidates) {
        const matched = columns.find((column) => column === candidate);
        if (matched) return matched;
    }

    return findColumnByHints(columns, SPATIAL_AUTOCORR_NAME_HINTS);
};

const findSpatialAutocorrelationValueField = (userPrompt: string, columns: string[]): string | null => {
    const exactMentioned = columns.filter((column) => userPrompt.includes(column));
    for (const hint of SPATIAL_AUTOCORR_VALUE_HINTS) {
        const normalizedHint = normalizePromptToken(hint);
        const exactMatched = exactMentioned.find((column) => normalizePromptToken(column).includes(normalizedHint));
        if (exactMatched) return exactMatched;
    }

    for (const hint of SPATIAL_AUTOCORR_VALUE_HINTS) {
        const matched = findColumnByHints(columns, [hint]);
        if (matched) return matched;
    }

    return exactMentioned.sort((a, b) => b.length - a.length)[0] || null;
};

const inferSpatialAutocorrelationSpecFromPrompt = (
    userPrompt: string,
    availableFiles: any[],
): SpatialAutocorrelationParams | null => {
    if (!isSpatialAutocorrelationPrompt(userPrompt)) return null;

    const candidates = (availableFiles || [])
        .map((file) => {
            const columns = Array.isArray(file?.columns) ? file.columns : [];
            const valueField = findSpatialAutocorrelationValueField(userPrompt, columns);
            const nameField = findSpatialAutocorrelationNameField(columns);
            let score = 0;

            if (isPolygonGeomType(file?.geomType)) score += 8;
            if (valueField) score += 10;
            if (nameField) score += 2;
            if (columns.some((column: string) => userPrompt.includes(column))) score += 3;
            if (/街道|street|subdistrict/i.test(`${String(file?.name || '')} ${columns.join(' ')}`)) score += 2;

            return { file, valueField, nameField, score };
        })
        .filter((candidate) => candidate.file?.fileId && isPolygonGeomType(candidate.file?.geomType) && candidate.valueField)
        .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    if (!best?.file?.fileId || !best.valueField) return null;

    return {
        targetFileId: best.file.fileId,
        valueField: best.valueField,
        nameField: best.nameField,
        contiguity: 'queen',
        permutations: 199,
        significanceLevel: 0.05,
        localIFieldName: `${best.valueField}_LISA局部I`,
        pValueFieldName: `${best.valueField}_LISA_P值`,
        clusterFieldName: `${best.valueField}_LISA聚类`,
        hotspotFieldName: `${best.valueField}_热点类型`,
        spatialLagFieldName: `${best.valueField}_空间滞后`,
        zScoreFieldName: `${best.valueField}_标准化Z值`,
        neighborCountFieldName: `${best.valueField}_邻居数`,
    };
};

const findParkDistanceField = (userPrompt: string, columns: string[]): string | null => {
    const exactMentioned = columns.filter((column) => userPrompt.includes(column));
    for (const hint of PARK_DISTANCE_FIELD_HINTS) {
        const matched = exactMentioned.find((column) => normalizePromptToken(column).includes(normalizePromptToken(hint)));
        if (matched) return matched;
    }
    for (const hint of PARK_DISTANCE_FIELD_HINTS) {
        const matched = findColumnByHints(columns, [hint]);
        if (matched) return matched;
    }
    return null;
};

const inferParkAccessibilitySpecFromPrompt = (
    userPrompt: string,
    availableFiles: any[],
): ParkAccessibilityParams | null => {
    if (!isParkAccessibilityPrompt(userPrompt)) return null;

    const gridCandidates = (availableFiles || [])
        .map((file) => {
            const columns = Array.isArray(file?.columns) ? file.columns : [];
            const distanceField = findParkDistanceField(userPrompt, columns);
            let score = 0;

            if (isPolygonGeomType(file?.geomType)) score += 6;
            if (distanceField) score += 10;
            if (/网格|grid/i.test(String(file?.name || ''))) score += 4;
            if (columns.some((column: string) => userPrompt.includes(column))) score += 2;

            return { file, distanceField, score };
        })
        .filter((candidate) => candidate.file?.fileId && candidate.distanceField)
        .sort((a, b) => b.score - a.score);

    const gridMatch = gridCandidates[0];
    if (!gridMatch?.file?.fileId || !gridMatch.distanceField) return null;

    const streetCandidates = (availableFiles || [])
        .filter((file) => file?.fileId !== gridMatch.file.fileId)
        .map((file) => {
            const columns = Array.isArray(file?.columns) ? file.columns : [];
            const streetNameField = findSpatialAutocorrelationNameField(columns);
            let score = 0;

            if (isPolygonGeomType(file?.geomType)) score += 6;
            if (streetNameField) score += 6;
            if (/街道|street|subdistrict/i.test(`${String(file?.name || '')} ${columns.join(' ')}`)) score += 4;

            return { file, streetNameField, score };
        })
        .filter((candidate) => candidate.file?.fileId && isPolygonGeomType(candidate.file?.geomType))
        .sort((a, b) => b.score - a.score);

    const streetMatch = streetCandidates[0];
    if (!streetMatch?.file?.fileId) return null;

    return {
        gridFileId: gridMatch.file.fileId,
        streetFileId: streetMatch.file.fileId,
        distanceField: gridMatch.distanceField,
        streetNameField: streetMatch.streetNameField || null,
        normalizationMethod: /对数|log/i.test(userPrompt) ? 'log_reverse' : 'linear_reverse',
        gridScoreFieldName: '公园可达性得分',
        streetScoreFieldName: '公园可达性得分',
    };
};

const persistTabularRowsAsCsv = async (rows: Array<Record<string, any>>, fileName: string) => {
    const csvString = '\uFEFF' + Papa.unparse(rows || []);
    const uploadDir = path.join(process.cwd(), 'uploads');
    await fs.promises.mkdir(uploadDir, { recursive: true });

    const newFilePath = path.join(uploadDir, fileName);
    await fs.promises.writeFile(newFilePath, csvString, 'utf8');

    const fileNodeObj = FileNode.createFileNodeObject({
        name: fileName,
        type: 'file',
        parent_id: null,
        path: newFilePath,
        size: Buffer.byteLength(csvString, 'utf8'),
        extension: '.csv',
        mime_type: 'text/csv',
    });
    const savedNode = await FileNode.insertFileNode(fileNodeObj);

    if (rows && rows.length > 0) {
        const featuresToInsert = rows.map((row: any, index: number) => ({
            fileId: savedNode.id,
            type: 'Feature',
            geometry: null,
            properties: { id: `score_weight_${Date.now()}_${index}`, ...row },
        }));
        await Feature.insertFeaturesBatch(savedNode.id, featuresToInsert);
    }

    return savedNode;
};

const executeSensitivityScoreOperator = async (
    params: SensitivityScoreOperatorParams,
): Promise<SensitivityScoreOperatorResult> => {
    const {
        targetFileId,
        yField,
        factorFields,
        scoreFieldName = '滑坡敏感性综合评分',
        levelFieldName = '滑坡敏感性等级',
        levelCount = 5,
    } = params;

    const response = await axios.post<any>(`${PYTHON_API_URL}/models/landslide_sensitivity_score`, {
        target_file_id: targetFileId,
        y_column: yField,
        factor_columns: factorFields,
        score_column: scoreFieldName,
        level_column: levelFieldName,
        level_count: levelCount,
    });

    const scoreRows = Array.isArray(response.data?.score_rows) ? response.data.score_rows : [];
    const weightRows = Array.isArray(response.data?.weight_rows) ? response.data.weight_rows : [];
    if (scoreRows.length === 0) {
        throw new Error('综合评分算子未返回可写回的网格评分结果');
    }
    if (weightRows.length === 0) {
        throw new Error('综合评分算子未返回 q 值和权重结果表');
    }

    const updateRows = scoreRows
        .filter((row: any) => row.id !== undefined && row.id !== null)
        .map((row: any) => {
            const { id, ...patch } = row;
            return { id, patch };
        });
    const updatedCount = await Feature.updateFeaturePropertiesBatch(targetFileId, updateRows);

    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const weightFileName = `landslide_q_weights_${timestamp}.csv`;
    const savedNode = await persistTabularRowsAsCsv(weightRows, weightFileName);

    return {
        targetFileId,
        yField,
        factorFields,
        scoreFieldName,
        levelFieldName,
        levelCount,
        updatedCount,
        scoreRows,
        weightRows,
        weightFileId: savedNode.id,
        weightFileName,
        summary: response.data?.summary,
    };
};

const executeSpatialAutocorrelationOperator = async (
    params: SpatialAutocorrelationParams,
): Promise<SpatialAutocorrelationResult> => {
    const {
        targetFileId,
        valueField,
        nameField = null,
        contiguity = 'queen',
        permutations = 199,
        significanceLevel = 0.05,
        localIFieldName = `${valueField}_LISA局部I`,
        pValueFieldName = `${valueField}_LISA_P值`,
        clusterFieldName = `${valueField}_LISA聚类`,
        hotspotFieldName = `${valueField}_热点类型`,
        spatialLagFieldName = `${valueField}_空间滞后`,
        zScoreFieldName = `${valueField}_标准化Z值`,
        neighborCountFieldName = `${valueField}_邻居数`,
    } = params;

    const response = await axios.post<any>(`${PYTHON_API_URL}/models/spatial_autocorrelation`, {
        target_file_id: targetFileId,
        value_column: valueField,
        name_column: nameField,
        contiguity,
        permutations,
        significance_level: significanceLevel,
        local_i_column: localIFieldName,
        p_value_column: pValueFieldName,
        cluster_column: clusterFieldName,
        hotspot_column: hotspotFieldName,
        spatial_lag_column: spatialLagFieldName,
        z_score_column: zScoreFieldName,
        neighbor_count_column: neighborCountFieldName,
    });

    const localRows = Array.isArray(response.data?.local_rows) ? response.data.local_rows : [];
    const mapPayload = Array.isArray(response.data?.map_payload) ? response.data.map_payload : [];
    if (localRows.length === 0) {
        throw new Error('空间自相关算子未返回街道级局部 LISA 结果');
    }

    const updateRows = localRows
        .filter((row: any) => row.id !== undefined && row.id !== null)
        .map((row: any) => {
            const { id, ...patch } = row;
            return { id, patch };
        });
    const updatedCount = await Feature.updateFeaturePropertiesBatch(targetFileId, updateRows);

    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const resultFileName = `spatial_autocorrelation_${timestamp}.csv`;
    const savedNode = await persistTabularRowsAsCsv(localRows, resultFileName);

    return {
        targetFileId,
        valueField,
        nameField,
        contiguity,
        permutations,
        significanceLevel,
        localIFieldName,
        pValueFieldName,
        clusterFieldName,
        hotspotFieldName,
        spatialLagFieldName,
        zScoreFieldName,
        neighborCountFieldName,
        updatedCount,
        localRows,
        mapPayload,
        resultFileId: savedNode.id,
        resultFileName,
        summary: response.data?.summary,
    };
};

const executeParkAccessibilityOperator = async (
    params: ParkAccessibilityParams,
): Promise<ParkAccessibilityResult> => {
    const {
        gridFileId,
        streetFileId,
        distanceField,
        streetNameField = null,
        normalizationMethod = 'linear_reverse',
        gridScoreFieldName = '公园可达性得分',
        streetScoreFieldName = '公园可达性得分',
    } = params;

    const response = await axios.post<any>(`${PYTHON_API_URL}/models/park_accessibility_score`, {
        grid_file_id: gridFileId,
        street_file_id: streetFileId,
        distance_field: distanceField,
        street_name_field: streetNameField,
        normalization_method: normalizationMethod,
        grid_score_field: gridScoreFieldName,
        street_score_field: streetScoreFieldName,
    });

    const gridScoreRows = Array.isArray(response.data?.grid_score_rows) ? response.data.grid_score_rows : [];
    const streetScoreRows = Array.isArray(response.data?.street_score_rows) ? response.data.street_score_rows : [];
    if (gridScoreRows.length === 0) {
        throw new Error('公园可达性算子未返回网格评分结果');
    }
    if (streetScoreRows.length === 0) {
        throw new Error('公园可达性算子未返回街道聚合结果');
    }

    const gridUpdateRows = gridScoreRows
        .filter((row: any) => row.id !== undefined && row.id !== null)
        .map((row: any) => {
            const { id, ...patch } = row;
            return { id, patch };
        });
    const streetUpdateRows = streetScoreRows
        .filter((row: any) => row.id !== undefined && row.id !== null)
        .map((row: any) => {
            const { id, ...patch } = row;
            return { id, patch };
        });

    const gridUpdatedCount = await Feature.updateFeaturePropertiesBatch(gridFileId, gridUpdateRows);
    const streetUpdatedCount = await Feature.updateFeaturePropertiesBatch(streetFileId, streetUpdateRows);

    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const resultFileName = `park_accessibility_street_${timestamp}.csv`;
    const savedNode = await persistTabularRowsAsCsv(streetScoreRows, resultFileName);

    return {
        gridFileId,
        streetFileId,
        distanceField,
        streetNameField,
        normalizationMethod,
        gridScoreFieldName,
        streetScoreFieldName,
        gridUpdatedCount,
        streetUpdatedCount,
        streetRows: streetScoreRows,
        resultFileId: savedNode.id,
        resultFileName,
        summary: response.data?.summary,
    };
};

const buildSpatialAutocorrelationPreviewRows = (
    result: SpatialAutocorrelationResult,
): Array<Record<string, any>> => {
    const clusterCounts = result.summary?.cluster_counts || {};
    const hotspotNames = Array.isArray(result.summary?.hotspot_names) ? result.summary.hotspot_names : [];
    const coldspotNames = Array.isArray(result.summary?.coldspot_names) ? result.summary.coldspot_names : [];

    return [
        {
            指标: '全局 Moran\'s I',
            数值: result.summary?.global_moran_i ?? null,
            说明: result.summary?.positive_spatial_autocorrelation ? '显著正相关' : '未达到显著正相关',
        },
        {
            指标: '全局 p 值',
            数值: result.summary?.global_p_value ?? null,
            说明: `邻接方式: ${result.contiguity}`,
        },
        {
            指标: '高-高聚集街道数',
            数值: clusterCounts['高-高聚集'] ?? 0,
            说明: hotspotNames.slice(0, 5).join('、') || '无',
        },
        {
            指标: '低-低聚集街道数',
            数值: clusterCounts['低-低聚集'] ?? 0,
            说明: coldspotNames.slice(0, 5).join('、') || '无',
        },
        {
            指标: '高-低 / 低-高异常数',
            数值: (clusterCounts['高-低异常'] ?? 0) + (clusterCounts['低-高异常'] ?? 0),
            说明: `不显著: ${clusterCounts['不显著'] ?? 0}`,
        },
    ];
};

const isSensitivitySpatialMapPrompt = (userPrompt: string): boolean => {
    const normalized = userPrompt || '';
    const hasScoreIntent = /敏感性|综合评分|评分/.test(normalized);
    const hasMapIntent = /地图|热力|渐变|专题图|可视化|渲染/.test(normalized);
    const hasPointIntent = /滑坡点|点位|历史滑坡|灾害点|叠加/.test(normalized);
    return hasScoreIntent && hasMapIntent && hasPointIntent;
};

const findSensitivityScoreField = (columns: string[]): string | null => {
    const exactCandidates = [
        '滑坡敏感性综合评分',
        '滑坡敏感性评分',
        '综合敏感性评分',
        '综合评分',
    ];
    for (const candidate of exactCandidates) {
        const matched = columns.find((column) => column === candidate);
        if (matched) return matched;
    }

    const fuzzyCandidates = [
        /滑坡.*敏感.*评分/,
        /敏感.*综合.*评分/,
        /综合.*评分/,
        /sensitivity.*score/i,
    ];
    for (const pattern of fuzzyCandidates) {
        const matched = columns.find((column) => pattern.test(column));
        if (matched) return matched;
    }
    return null;
};

const findSensitivityLevelField = (columns: string[]): string | null => {
    const exactCandidates = [
        '滑坡敏感性等级',
        '敏感性等级',
        '综合敏感性等级',
    ];
    for (const candidate of exactCandidates) {
        const matched = columns.find((column) => column === candidate);
        if (matched) return matched;
    }

    const matched = columns.find((column) => /敏感.*等级|level/i.test(column));
    return matched || null;
};

const findPointLabelField = (columns: string[]): string | null => {
    const exactCandidates = ['名称', 'name', 'Name', '灾害点名称', '滑坡名称', '编号', 'ID'];
    for (const candidate of exactCandidates) {
        const matched = columns.find((column) => column === candidate);
        if (matched) return matched;
    }

    const matched = columns.find((column) => /名称|name|编号|code|id/i.test(column));
    return matched || null;
};

const buildSensitivitySpatialMapBlueprint = (
    userPrompt: string,
    availableFiles: any[],
    context?: PipelineContextMemory,
): WorkflowBlueprint | null => {
    if (!isSensitivitySpatialMapPrompt(userPrompt)) return null;

    const contextTargetId = inferTargetFileIdFromContext(context, []);
    const gridCandidates = (availableFiles || []).map((file) => {
        const columns = Array.isArray(file?.columns) ? file.columns : [];
        const geomType = String(file?.geomType || '').toLowerCase();
        const scoreField = findSensitivityScoreField(columns);
        let score = 0;

        if (geomType.includes('polygon')) score += 6;
        if (scoreField) score += 8;
        if (findSensitivityLevelField(columns)) score += 1;
        if (file?.fileId && contextTargetId && file.fileId === contextTargetId) score += 6;
        if (/网格|grid/i.test(String(file?.name || ''))) score += 3;
        if (/四川/.test(String(file?.name || ''))) score += 1;

        return { file, scoreField, score };
    }).sort((a, b) => b.score - a.score);

    const gridMatch = gridCandidates.find((candidate) => candidate.scoreField && candidate.score >= 10) || gridCandidates[0];
    if (!gridMatch?.file?.fileId || !gridMatch.scoreField) {
        return null;
    }

    const pointCandidates = (availableFiles || [])
        .filter((file) => file?.fileId !== gridMatch.file.fileId)
        .map((file) => {
            const columns = Array.isArray(file?.columns) ? file.columns : [];
            const geomType = String(file?.geomType || '').toLowerCase();
            const nameText = `${String(file?.name || '')} ${columns.join(' ')}`;
            let score = 0;

            if (geomType.includes('point')) score += 6;
            if (/滑坡|landslide|灾害/.test(nameText)) score += 5;
            if (/历史|history|historical/i.test(nameText)) score += 2;
            if (/点|point/i.test(nameText)) score += 1;

            return {
                file,
                score,
                labelField: findPointLabelField(columns),
            };
        })
        .sort((a, b) => b.score - a.score);

    const pointMatch = pointCandidates.find((candidate) => candidate.score >= 6) || null;
    const levelField = findSensitivityLevelField(Array.isArray(gridMatch.file.columns) ? gridMatch.file.columns : []);

    return {
        task_type: 'landslide_sensitivity_map',
        reuse_code: false,
        data_dependencies: [
            {
                file_id: gridMatch.file.fileId,
                role: 'TargetLayer',
                description: '包含滑坡敏感性综合评分字段的网格面图层',
                type: 'Vector',
            },
            ...(pointMatch?.file?.fileId ? [{
                file_id: pointMatch.file.fileId,
                role: 'JoinLayer',
                description: '用于叠加显示的历史滑坡点图层',
                type: 'Vector',
            }] : []),
        ],
        parameters: [
            {
                name: 'scoreFieldName',
                type: 'column',
                defaultValue: gridMatch.scoreField,
                description: '网格图层中的滑坡敏感性综合评分字段',
            },
            {
                name: 'levelFieldName',
                type: 'column',
                defaultValue: levelField,
                description: '网格图层中的敏感性等级字段，可用于悬浮提示',
            },
            {
                name: 'pointLabelField',
                type: 'column',
                defaultValue: pointMatch?.labelField || null,
                description: '历史滑坡点的标注字段，可为空',
            },
        ],
        visualization_spec: {
            engine: 'html_iframe',
            chart_type: 'thematic_map',
            chart_library: 'folium',
            dimensions: [gridMatch.scoreField],
            metrics: [gridMatch.scoreField],
        },
        explanation: pointMatch?.file?.fileId
            ? `识别为滑坡敏感性专题制图任务：使用网格面图层字段 ${gridMatch.scoreField} 进行热力渐变渲染，并叠加历史滑坡点图层形成独立地图视图。`
            : `识别为滑坡敏感性专题制图任务：使用网格面图层字段 ${gridMatch.scoreField} 进行热力渐变渲染；当前未明确识别到历史滑坡点图层，将优先输出评分面专题图。`,
    };
};

const buildLandslideSensitivityMapPivotCode = (blueprint: WorkflowBlueprint): string => {
    const gridLayerId = blueprint.data_dependencies.find((dependency) => dependency.role === 'TargetLayer')?.file_id;
    const pointLayerId = blueprint.data_dependencies.find((dependency) => dependency.role === 'JoinLayer')?.file_id;
    const scoreFieldName = String(blueprint.parameters.find((parameter) => parameter.name === 'scoreFieldName')?.defaultValue || '滑坡敏感性综合评分');
    const levelFieldName = blueprint.parameters.find((parameter) => parameter.name === 'levelFieldName')?.defaultValue ?? null;
    const pointLabelField = blueprint.parameters.find((parameter) => parameter.name === 'pointLabelField')?.defaultValue ?? null;

    if (!gridLayerId) {
        throw new Error('专题地图蓝图缺少 TargetLayer，无法生成确定性专题地图代码。');
    }

    return `
# [Deterministic thematic map] landslide sensitivity map extractor
def execute_pivot(gdf_dict, parameters):
    import geopandas as gpd
    import pandas as pd
    import json

    def round_nested_coords(value, digits=5):
        if isinstance(value, list):
            return [round_nested_coords(item, digits) for item in value]
        if isinstance(value, float):
            return round(value, digits)
        return value

    grid_gdf = gdf_dict[${JSON.stringify(gridLayerId)}].copy()
    point_gdf = gdf_dict[${JSON.stringify(pointLayerId || '')}].copy() if ${pointLayerId ? 'True' : 'False'} else None

    score_col = parameters.get('scoreFieldName') or ${JSON.stringify(scoreFieldName)}
    level_col = parameters.get('levelFieldName') or ${JSON.stringify(levelFieldName)}
    point_label_col = parameters.get('pointLabelField') or ${JSON.stringify(pointLabelField)}

    if score_col not in grid_gdf.columns:
        raise ValueError(f"目标网格图层缺少评分字段: {score_col}")

    grid_gdf = grid_gdf.dropna(subset=[grid_gdf.geometry.name]).copy()
    if grid_gdf.empty:
        raise ValueError("目标网格图层为空，无法绘制专题地图")

    if grid_gdf.crs is None:
        grid_gdf = grid_gdf.set_crs(epsg=3857)
    grid_gdf = grid_gdf.to_crs(epsg=4326)
    grid_gdf[score_col] = pd.to_numeric(grid_gdf[score_col], errors='coerce')
    grid_gdf = grid_gdf.dropna(subset=[score_col]).copy()

    if grid_gdf.empty:
        raise ValueError(f"评分字段 {score_col} 没有可用于绘图的有效数值")

    grid_gdf = safe_get_centroid_coords(grid_gdf, x_col='lon', y_col='lat')

    # Keep GeoJSON payload minimal to avoid oversized iframe rendering requests.
    grid_export_columns = [score_col]
    if level_col and level_col in grid_gdf.columns:
        grid_export_columns.append(level_col)
    grid_export_columns.append(grid_gdf.geometry.name)

    grid_export = gpd.GeoDataFrame(
        grid_gdf[grid_export_columns].copy(),
        geometry=grid_gdf.geometry.name,
        crs=grid_gdf.crs
    )
    grid_geojson = json.loads(grid_export.to_json(drop_id=True))
    for feature in grid_geojson.get('features', []):
        geometry = feature.get('geometry') or {}
        if 'coordinates' in geometry:
            geometry['coordinates'] = round_nested_coords(geometry['coordinates'], digits=5)

    point_rows = []
    if point_gdf is not None and not point_gdf.empty:
        point_gdf = point_gdf.dropna(subset=[point_gdf.geometry.name]).copy()
        if not point_gdf.empty:
            if point_gdf.crs is None:
                point_gdf = point_gdf.set_crs(epsg=3857)
            point_gdf = point_gdf.to_crs(epsg=4326)
            point_gdf = safe_get_centroid_coords(point_gdf, x_col='lon', y_col='lat')

            export_cols = ['lon', 'lat']
            if point_label_col and point_label_col in point_gdf.columns:
                export_cols.append(point_label_col)
            if 'id' in point_gdf.columns:
                export_cols.append('id')

            point_rows = point_gdf[export_cols].dropna(subset=['lon', 'lat']).to_dict(orient='records')
            for row in point_rows:
                row['lon'] = round(float(row['lon']), 5)
                row['lat'] = round(float(row['lat']), 5)

    center_lat = float(grid_gdf['lat'].mean())
    center_lon = float(grid_gdf['lon'].mean())

    payload = {
        'map_title': '四川省滑坡敏感性综合评分与历史滑坡点叠加图',
        'score_column': score_col,
        'level_column': level_col if level_col in grid_gdf.columns else None,
        'point_label_column': point_label_col if point_rows else None,
        'grid_feature_count': int(len(grid_gdf)),
        'landslide_point_count': int(len(point_rows)),
        'score_min': round(float(grid_gdf[score_col].min()), 6),
        'score_max': round(float(grid_gdf[score_col].max()), 6),
        'center_lat': center_lat,
        'center_lon': center_lon,
        'grid_geojson': grid_geojson,
        'landslide_points': point_rows,
    }

    valid_ids = grid_gdf['id'].tolist() if 'id' in grid_gdf.columns else []
    return {
        'chart_data': pd.DataFrame([payload]),
        'valid_ids': valid_ids
    }
`.trim();
};

const buildLandslideSensitivityMapChartCode = (): string => `
def execute_chart(df, parameters):
    import json
    import math
    import folium
    from branca.colormap import LinearColormap
    from branca.element import Element

    if df.empty:
        raise ValueError("专题地图绘图数据为空")

    payload = df.iloc[0].to_dict()

    def ensure_object(value):
        if isinstance(value, str):
            value = value.strip()
            return json.loads(value) if value else None
        return value

    grid_geojson = ensure_object(payload.get('grid_geojson')) or {}
    landslide_points = ensure_object(payload.get('landslide_points')) or []
    score_col = payload.get('score_column') or '滑坡敏感性综合评分'
    level_col = payload.get('level_column')
    point_label_col = payload.get('point_label_column')
    map_title = payload.get('map_title') or '滑坡敏感性综合评分空间分布'

    features = grid_geojson.get('features', [])
    if not features:
        raise ValueError("网格 GeoJSON 为空，无法绘图")

    score_values = []
    min_lon, min_lat = 180.0, 90.0
    max_lon, max_lat = -180.0, -90.0

    def update_bounds(coords):
        nonlocal min_lon, min_lat, max_lon, max_lat
        if isinstance(coords, (list, tuple)):
            if len(coords) == 2 and all(isinstance(v, (int, float)) for v in coords):
                lon, lat = float(coords[0]), float(coords[1])
                min_lon = min(min_lon, lon)
                max_lon = max(max_lon, lon)
                min_lat = min(min_lat, lat)
                max_lat = max(max_lat, lat)
            else:
                for item in coords:
                    update_bounds(item)

    for feature in features:
        props = feature.get('properties', {}) or {}
        raw_score = props.get(score_col)
        try:
            score = float(raw_score)
            if math.isfinite(score):
                score_values.append(score)
        except Exception:
            pass
        update_bounds(feature.get('geometry', {}).get('coordinates', []))

    if not score_values:
        raise ValueError(f"字段 {score_col} 没有可用于渲染的有效数值")

    center_lat = float(payload.get('center_lat')) if payload.get('center_lat') is not None else (min_lat + max_lat) / 2
    center_lon = float(payload.get('center_lon')) if payload.get('center_lon') is not None else (min_lon + max_lon) / 2

    m = create_system_base_map(center_lat, center_lon, zoom=7)
    if min_lon < max_lon and min_lat < max_lat:
        m.fit_bounds([[min_lat, min_lon], [max_lat, max_lon]])

    color_scale = LinearColormap(
        colors=['#143d59', '#1f6f8b', '#22c1c3', '#fdbb2d', '#f97316', '#dc2626'],
        vmin=min(score_values),
        vmax=max(score_values)
    )
    color_scale.caption = score_col

    def style_function(feature):
        props = feature.get('properties', {}) or {}
        raw_value = props.get(score_col)
        try:
            value = float(raw_value)
            fill_color = color_scale(value) if math.isfinite(value) else '#334155'
        except Exception:
            fill_color = '#334155'
        return {
            'fillColor': fill_color,
            'color': '#0f172a',
            'weight': 0.7,
            'fillOpacity': 0.78
        }

    tooltip_fields = [score_col]
    tooltip_aliases = ['综合评分']
    if level_col and any(level_col in (feature.get('properties', {}) or {}) for feature in features):
        tooltip_fields.append(level_col)
        tooltip_aliases.append('敏感性等级')

    folium.GeoJson(
        grid_geojson,
        name='敏感性评分网格',
        style_function=style_function,
        highlight_function=lambda _: {'weight': 1.3, 'color': '#f8fafc', 'fillOpacity': 0.92},
        tooltip=folium.GeoJsonTooltip(
            fields=tooltip_fields,
            aliases=tooltip_aliases,
            sticky=False,
            labels=True,
            localize=True,
            style="""
                background-color: rgba(15, 23, 42, 0.92);
                border: 1px solid rgba(56, 189, 248, 0.35);
                border-radius: 8px;
                box-shadow: 0 8px 22px rgba(2, 6, 23, 0.35);
                color: #e2e8f0;
                font-size: 12px;
                padding: 8px 10px;
            """
        )
    ).add_to(m)

    color_scale.add_to(m)

    point_layer = folium.FeatureGroup(name='历史滑坡点', show=True)
    for point in landslide_points:
        lat = point.get('lat')
        lon = point.get('lon')
        if lat is None or lon is None:
            continue

        label_parts = []
        if point_label_col and point.get(point_label_col):
            label_parts.append(f"{point_label_col}: {point.get(point_label_col)}")
        if point.get('id') is not None:
            label_parts.append(f"id: {point.get('id')}")

        popup_html = '<br>'.join(label_parts) if label_parts else '历史滑坡点'
        folium.CircleMarker(
            location=[float(lat), float(lon)],
            radius=4.5,
            weight=0.8,
            color='#fff7ed',
            fill=True,
            fill_color='#fb7185',
            fill_opacity=0.9,
            opacity=0.95,
            popup=folium.Popup(popup_html, max_width=260)
        ).add_to(point_layer)
    point_layer.add_to(m)

    folium.LayerControl(collapsed=False, position='topright').add_to(m)

    info_card = f"""
    <div style="
        position: fixed;
        top: 18px;
        left: 18px;
        z-index: 9999;
        min-width: 240px;
        max-width: 320px;
        padding: 14px 16px;
        border-radius: 14px;
        background: rgba(8, 15, 30, 0.88);
        color: #e2e8f0;
        border: 1px solid rgba(56, 189, 248, 0.22);
        box-shadow: 0 14px 38px rgba(2, 6, 23, 0.42);
        backdrop-filter: blur(10px);
        font-family: Arial, sans-serif;
    ">
        <div style="font-size: 15px; font-weight: 700; color: #f8fafc; margin-bottom: 6px;">{map_title}</div>
        <div style="font-size: 12px; line-height: 1.6; color: #cbd5e1;">
            网格数: {payload.get('grid_feature_count', 0)}<br>
            历史滑坡点: {payload.get('landslide_point_count', 0)}<br>
            评分范围: {round(min(score_values), 3)} - {round(max(score_values), 3)}
        </div>
    </div>
    """
    m.get_root().html.add_child(Element(info_card))

    return {"html_string": safe_render_folium(m)}
`.trim();

const buildSpatialAutocorrelationMapChartCode = (): string => `
def execute_chart(df, parameters):
    import json
    import math
    import folium
    from branca.element import Element

    if df.empty:
        raise ValueError("空间自相关专题图绘图数据为空")

    payload = df.iloc[0].to_dict()

    def ensure_object(value):
        if isinstance(value, str):
            value = value.strip()
            return json.loads(value) if value else None
        return value

    geojson = ensure_object(payload.get('geojson')) or {}
    features = geojson.get('features', [])
    if not features:
        raise ValueError("空间自相关 GeoJSON 为空，无法绘图")

    name_col = payload.get('name_column')
    value_col = payload.get('value_column')
    local_i_col = payload.get('local_i_column')
    p_value_col = payload.get('p_value_column')
    cluster_col = payload.get('cluster_column')
    hotspot_col = payload.get('hotspot_column')
    lag_col = payload.get('spatial_lag_column')
    z_col = payload.get('z_score_column')
    neighbor_col = payload.get('neighbor_count_column')
    map_title = payload.get('map_title') or '空间自相关聚类图'

    cluster_palette = {
        '高-高聚集': '#ef4444',
        '低-低聚集': '#2563eb',
        '高-低异常': '#f59e0b',
        '低-高异常': '#14b8a6',
        '不显著': '#64748b',
        '孤立街道': '#0f172a',
    }

    min_lon, min_lat = 180.0, 90.0
    max_lon, max_lat = -180.0, -90.0

    def update_bounds(coords):
        nonlocal min_lon, min_lat, max_lon, max_lat
        if isinstance(coords, (list, tuple)):
            if len(coords) == 2 and all(isinstance(v, (int, float)) for v in coords):
                lon, lat = float(coords[0]), float(coords[1])
                min_lon = min(min_lon, lon)
                max_lon = max(max_lon, lon)
                min_lat = min(min_lat, lat)
                max_lat = max(max_lat, lat)
            else:
                for item in coords:
                    update_bounds(item)

    for feature in features:
        update_bounds((feature.get('geometry') or {}).get('coordinates', []))

    center_lat = float(payload.get('center_lat')) if payload.get('center_lat') is not None else (min_lat + max_lat) / 2
    center_lon = float(payload.get('center_lon')) if payload.get('center_lon') is not None else (min_lon + max_lon) / 2

    m = create_system_base_map(center_lat, center_lon, zoom=10)
    if min_lon < max_lon and min_lat < max_lat:
        m.fit_bounds([[min_lat, min_lon], [max_lat, max_lon]])

    def style_function(feature):
        props = feature.get('properties', {}) or {}
        cluster_value = props.get(cluster_col)
        fill_color = cluster_palette.get(cluster_value, '#334155')
        return {
            'fillColor': fill_color,
            'color': '#020617',
            'weight': 0.8,
            'fillOpacity': 0.82,
        }

    tooltip_fields = []
    tooltip_aliases = []
    if name_col and any(name_col in (feature.get('properties', {}) or {}) for feature in features):
        tooltip_fields.append(name_col)
        tooltip_aliases.append('街道')
    for field_name, alias in [
        (value_col, '得分'),
        (cluster_col, '聚类类型'),
        (hotspot_col, '热点类型'),
        (local_i_col, '局部 Moran\\'s I'),
        (p_value_col, 'P 值'),
        (lag_col, '空间滞后'),
        (z_col, '标准化 Z 值'),
        (neighbor_col, '邻居数'),
    ]:
        if field_name and any(field_name in (feature.get('properties', {}) or {}) for feature in features):
            tooltip_fields.append(field_name)
            tooltip_aliases.append(alias)

    folium.GeoJson(
        geojson,
        name='LISA 聚类',
        style_function=style_function,
        highlight_function=lambda _: {'weight': 1.4, 'color': '#f8fafc', 'fillOpacity': 0.96},
        tooltip=folium.GeoJsonTooltip(
            fields=tooltip_fields,
            aliases=tooltip_aliases,
            sticky=False,
            labels=True,
            localize=True,
            style="""
                background-color: rgba(15, 23, 42, 0.94);
                border: 1px solid rgba(56, 189, 248, 0.35);
                border-radius: 8px;
                box-shadow: 0 8px 22px rgba(2, 6, 23, 0.35);
                color: #e2e8f0;
                font-size: 12px;
                padding: 8px 10px;
            """
        )
    ).add_to(m)

    legend_items = [
        ('高-高聚集', cluster_palette['高-高聚集']),
        ('低-低聚集', cluster_palette['低-低聚集']),
        ('高-低异常', cluster_palette['高-低异常']),
        ('低-高异常', cluster_palette['低-高异常']),
        ('不显著', cluster_palette['不显著']),
        ('孤立街道', cluster_palette['孤立街道']),
    ]
    legend_html = ''.join([
        f"<div style='display:flex;align-items:center;gap:8px;margin:4px 0;'><span style='display:inline-block;width:12px;height:12px;border-radius:3px;background:{color};border:1px solid rgba(255,255,255,0.18);'></span><span>{label}</span></div>"
        for label, color in legend_items
    ])

    info_card = f"""
    <div style="
        position: fixed;
        top: 18px;
        left: 18px;
        z-index: 9999;
        min-width: 250px;
        max-width: 360px;
        padding: 14px 16px;
        border-radius: 14px;
        background: rgba(8, 15, 30, 0.9);
        color: #e2e8f0;
        border: 1px solid rgba(56, 189, 248, 0.22);
        box-shadow: 0 14px 38px rgba(2, 6, 23, 0.42);
        backdrop-filter: blur(10px);
        font-family: Arial, sans-serif;
    ">
        <div style="font-size: 15px; font-weight: 700; color: #f8fafc; margin-bottom: 8px;">{map_title}</div>
        <div style="font-size: 12px; line-height: 1.65; color: #cbd5e1;">
            全局 Moran's I: {payload.get('global_moran_i')}<br>
            全局 p 值: {payload.get('global_p_value')}<br>
            邻接方式: {payload.get('contiguity')}<br>
            高-高聚集: {payload.get('hotspot_count', 0)}<br>
            低-低聚集: {payload.get('coldspot_count', 0)}
        </div>
        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(148, 163, 184, 0.2); font-size: 12px; color: #e2e8f0;">
            {legend_html}
        </div>
    </div>
    """
    m.get_root().html.add_child(Element(info_card))

    return {"html_string": safe_render_folium(m)}
`.trim();

const buildLandslideSensitivityMapPreviewRows = (rows: any[]): any[] => {
    const payload = rows?.[0] || {};
    if (!payload || typeof payload !== 'object') return rows;

    return [
        {
            图层: '敏感性评分网格',
            评分字段: payload.score_column || '滑坡敏感性综合评分',
            要素数量: payload.grid_feature_count || 0,
            最小值: payload.score_min ?? null,
            最大值: payload.score_max ?? null,
        },
        {
            图层: '历史滑坡点',
            标注字段: payload.point_label_column || '无',
            要素数量: payload.landslide_point_count || 0,
        },
    ];
};

const PYTHON_SDK_INJECTION = `
import geopandas as gpd
import pandas as pd
import numpy as np
import warnings
from shapely.errors import ShapelyDeprecationWarning
warnings.filterwarnings("ignore", category=ShapelyDeprecationWarning)

# ==========================================
# 模块一：空间基底与投影安全模块 (Spatial Foundation)
# ==========================================

def ensure_metric_crs(gdf):
    if gdf.empty: 
        return gdf
    # 【核心防御1】：使用 .values.all() 强制将任何可能的 DataFrame 降维成单一布尔值，彻底消灭 truth value ambiguity 报错！
    try:
        if gdf.geometry.isnull().values.all():
            return gdf
    except:
        pass
        
    if getattr(gdf, 'crs', None) is None: 
        gdf = gdf.set_crs(epsg=4326)
    if gdf.crs.is_geographic: 
        return gdf.to_crs(epsg=3857)
    return gdf

# ==========================================
# 模块二：空间拓扑连接算子 (Spatial Topology Layer - The "S")
# ==========================================

def safe_buffer_intersects(target_gdf, join_gdf, radius=0):
    """
    【缓冲相交算子】: 解决 点-线、点-点 无法精确相交的问题。
    包含活跃几何陷阱的彻底修复。
    """
    if target_gdf.empty or join_gdf.empty:
        return gpd.GeoDataFrame()
        
    target_gdf = ensure_metric_crs(target_gdf)
    join_gdf = join_gdf.to_crs(target_gdf.crs) if join_gdf.crs != target_gdf.crs else join_gdf
    
    radius = float(radius)
    if radius > 0:
        # 强制使用 set_geometry 更新活跃几何列，防止全 0 Bug
        buffer_geom = target_gdf.geometry.buffer(radius)
        safe_target = target_gdf.set_geometry(buffer_geom)
    else:
        safe_target = target_gdf.copy()
        
    return gpd.sjoin(safe_target, join_gdf, how='inner', predicate='intersects')

def safe_intersects(target_gdf, join_gdf):
    """
    【精准相交算子】: 适用于 面-面、线-面 等原生具有面积交叉的要素。
    """
    if target_gdf.empty or join_gdf.empty:
        return gpd.GeoDataFrame()
    
    join_gdf = join_gdf.to_crs(target_gdf.crs) if join_gdf.crs else join_gdf
    return gpd.sjoin(target_gdf, join_gdf, how='inner', predicate='intersects')

def safe_within_contains(target_gdf, join_gdf, relation='within'):
    """
    【包含关系算子】: 适用于 统计行政区内的 POI (contains) 或 POI 属于哪个区 (within)。
    relation 可选: 'within' (被包含), 'contains' (包含)
    """
    if target_gdf.empty or join_gdf.empty:
        return gpd.GeoDataFrame()
        
    join_gdf = join_gdf.to_crs(target_gdf.crs) if join_gdf.crs else join_gdf
    return gpd.sjoin(target_gdf, join_gdf, how='inner', predicate=relation)

def safe_nearest(target_gdf, join_gdf, max_distance=None):
    """
    【最近邻算子】: 适用于 寻找最近的地铁站、医院等。
    """
    if target_gdf.empty or join_gdf.empty:
        return gpd.GeoDataFrame()

    target_gdf = ensure_metric_crs(target_gdf)
    join_gdf = join_gdf.to_crs(target_gdf.crs) if join_gdf.crs != target_gdf.crs else join_gdf
    
    if max_distance:
        return gpd.sjoin_nearest(target_gdf, join_gdf, how='inner', max_distance=float(max_distance))
    return gpd.sjoin_nearest(target_gdf, join_gdf, how='inner')

def safe_get_centroid_coords(gdf, x_col='lon', y_col='lat'):
    """
    【坐标提取算子】: 专门用于为前端绘图提供精确的 X/Y 经纬度坐标。
    """
    # 不可硬编码判断 'geometry' 字符串，因为底层列名可能是 'geom'
    # 使用 getattr 和 isinstance 动态判断是否具备空间属性
    if gdf.empty or not isinstance(gdf, gpd.GeoDataFrame) or getattr(gdf, 'geometry', None) is None:
        return gdf
        
    # 1. 先用米制投影算质心，保证几何中心绝对准确且不报 Warning
    metric_gdf = ensure_metric_crs(gdf)
    
    # 2. 将质心转回 Web 通用的 WGS84 经纬度
    # metric_gdf.geometry.centroid 直接返回 GeoSeries，调用 to_crs 即可
    centroids_wgs84 = metric_gdf.geometry.centroid.to_crs(epsg=4326)
    
    # 3. 将坐标赋给原表
    result_gdf = gdf.copy()
    result_gdf[x_col] = centroids_wgs84.x
    result_gdf[y_col] = centroids_wgs84.y
    
    return result_gdf

# ==========================================
# 模块三：空间数据透视聚合算子 (OLAP Aggregation - The "M" & "V")
# ==========================================

def safe_aggregate(joined_gdf, agg_method='size', value_col=None, col_dim=None):
    if joined_gdf.empty: return pd.DataFrame() if col_dim else pd.Series(name='value', dtype=float)
    agg_method = str(agg_method).lower()
    
    # ==== 二维透视逻辑 ====
    if col_dim and col_dim in joined_gdf.columns:
        if agg_method in ['size', 'count']: return joined_gdf.groupby([joined_gdf.index, col_dim]).size().unstack(fill_value=0)
        joined_gdf[value_col] = pd.to_numeric(joined_gdf[value_col], errors='coerce')
        if agg_method == 'sum': return joined_gdf.groupby([joined_gdf.index, col_dim])[value_col].sum().unstack(fill_value=0)
        elif agg_method == 'mean': return joined_gdf.groupby([joined_gdf.index, col_dim])[value_col].mean().unstack(fill_value=0)
        return pd.DataFrame()
        
    # ==== 一维透视逻辑 (强制命名为 value，对接前端规范) ====
    else:
        grouped = joined_gdf.groupby(level=0)
        if agg_method in ['size', 'count']: return grouped.size().rename('value')
        if value_col:
            joined_gdf[value_col] = pd.to_numeric(joined_gdf[value_col], errors='coerce')
            if agg_method == 'sum': return grouped[value_col].sum().rename('value')
            if agg_method == 'mean': return grouped[value_col].mean().rename('value')
            if agg_method == 'max': return grouped[value_col].max().rename('value')
            if agg_method == 'min':  return grouped[value_col].min().rename('value')
        return grouped.size().rename('value')
`

// 2. 注入特征计算专属的 Python SDK 字符串
const FEATURE_CALC_SDK_INJECTION = `
import geopandas as gpd
import pandas as pd
import numpy as np
import warnings
from shapely.errors import ShapelyDeprecationWarning
warnings.filterwarnings("ignore")
from rasterstats import zonal_stats
import rasterio
import mapclassify as mc

def ensure_metric_crs(gdf):
    if gdf.crs is None: gdf = gdf.set_crs(epsg=4326)
    if gdf.crs.is_geographic: return gdf.to_crs(epsg=3857)
    return gdf

def safe_zonal_stats(vector_gdf, raster_file_path, stat='mean', col_name='raster_val'):
    # 【SDK防线1】：兼容判断空值，防止大模型传入 None 导致 .empty 报错
    if vector_gdf is None or (hasattr(vector_gdf, 'empty') and vector_gdf.empty):
        return vector_gdf

    # 【SDK防线2】：拦截参数类型错误
    if not isinstance(raster_file_path, str):
        raise TypeError(
            f"\\n[SDK 拦截] 参数错误！raster_file_path 必须是文件的绝对路径字符串，"
            f"但当前收到的是 {type(raster_file_path)}。\\n"
            f"修复指导：请检查是否将 vector_gdf 和 raster_file_path 的传参顺序写反了，"
            f"或者错误地传入了 GeoDataFrame 对象。"
        )

    # 修复 1：读取栅格物理文件的真实 CRS...
    try:
        with rasterio.open(raster_file_path) as src:
            raster_crs = src.crs
            if raster_crs and vector_gdf.crs != raster_crs:
                vector_gdf = vector_gdf.to_crs(raster_crs)
    except Exception as e:
        pass # 如果读取失败，降级依赖 rasterstats 的默认行为

    stats = zonal_stats(vector_gdf, raster_file_path, stats=[stat], all_touched=True, geojson_out=False)
    vector_gdf[col_name] = [s[stat] if s[stat] is not None else 0 for s in stats]
    return vector_gdf

def safe_shortest_distance(target_gdf, ref_gdf, col_name='min_dist'):
    if target_gdf.empty or ref_gdf.empty: 
        target_gdf[col_name] = np.nan
        return target_gdf
    t_gdf = ensure_metric_crs(target_gdf)
    r_gdf = ensure_metric_crs(ref_gdf).to_crs(t_gdf.crs)
    joined = gpd.sjoin_nearest(t_gdf, r_gdf, how='left', distance_col=col_name)
    joined = joined[~joined.index.duplicated(keep='first')]
    target_gdf[col_name] = joined[col_name]
    return target_gdf

def safe_intersects_count(target_gdf, join_gdf, col_name='count_val'):
    t_gdf = ensure_metric_crs(target_gdf)
    j_gdf = ensure_metric_crs(join_gdf).to_crs(t_gdf.crs)
    joined = gpd.sjoin(t_gdf, j_gdf, how='inner', predicate='intersects')
    counts = joined.groupby(level=0).size()
    target_gdf[col_name] = counts
    target_gdf[col_name] = target_gdf[col_name].fillna(0)
    return target_gdf

def safe_calc_geometry(gdf, calc_type='area', col_name='geom_val'):
    if gdf.empty: 
        gdf[col_name] = np.nan
        return gdf
    t_gdf = ensure_metric_crs(gdf)
    if calc_type == 'area':
        gdf[col_name] = t_gdf.geometry.area
    elif calc_type == 'length':
        gdf[col_name] = t_gdf.geometry.length
    return gdf

def safe_spatial_join_attribute(target_gdf, ref_gdf, extract_col, join_type='nearest', col_name='ref_val'):
    if target_gdf.empty or ref_gdf.empty:
        target_gdf[col_name] = np.nan
        return target_gdf
        
    if extract_col not in ref_gdf.columns:
        raise KeyError(
            f"\\n[SDK 拦截] 列名错误！在客体图层中找不到名为 '{extract_col}' 的字段！\\n"
            f"请不要自创英文列名，必须使用原始数据的真实列名。\\n"
            f"当前客体图层真实的可用列名包括: {list(ref_gdf.columns)}"
        )

    t_gdf = ensure_metric_crs(target_gdf)
    r_gdf = ensure_metric_crs(ref_gdf).to_crs(t_gdf.crs)
    
    # 【核心修复】：使用 .geometry.name 动态获取真实的几何列名（兼容 geom 和 geometry）
    r_gdf_sub = r_gdf[[r_gdf.geometry.name, extract_col]]
    
    if join_type == 'nearest':
        joined = gpd.sjoin_nearest(t_gdf, r_gdf_sub, how='left')        
    else:
        joined = gpd.sjoin(t_gdf, r_gdf_sub, how='left', predicate='intersects')
    joined = joined[~joined.index.duplicated(keep='first')]
    target_gdf[col_name] = joined[extract_col]
    return target_gdf

def safe_buffer_count(target_gdf, join_gdf, buffer_dist=500, col_name='buf_count'):
    if target_gdf.empty or join_gdf.empty:
        target_gdf[col_name] = 0
        return target_gdf
    t_gdf = ensure_metric_crs(target_gdf)
    j_gdf = ensure_metric_crs(join_gdf).to_crs(t_gdf.crs)
    
    t_buffered = t_gdf.copy()
    # 【核心修复】：使用 set_geometry 确保活跃几何列被正确替换，而不是强行创建名为'geometry'的新列
    t_buffered = t_buffered.set_geometry(t_buffered.geometry.buffer(buffer_dist))
    
    joined = gpd.sjoin(t_buffered, j_gdf, how='inner', predicate='intersects')
    counts = joined.groupby(level=0).size()
    target_gdf[col_name] = counts
    target_gdf[col_name] = target_gdf[col_name].fillna(0)
    return target_gdf

def safe_categorical_zonal_stats(vector_gdf, raster_file_path, col_name='majority_class'):
    # 【SDK防线1】
    if vector_gdf is None or (hasattr(vector_gdf, 'empty') and vector_gdf.empty):
        return vector_gdf

    # 【SDK防线2】
    if not isinstance(raster_file_path, str):
        raise TypeError(
            f"\\n[SDK 拦截] 参数错误！raster_file_path 必须是文件的绝对路径字符串..."
        )

    print(f"[*] 准备进行大规模栅格分区统计 (Zonal Stats)，共有 {len(vector_gdf)} 个多边形需要计算，这可能需要较长时间，请耐心等待...")

    try:
        with rasterio.open(raster_file_path) as src:
            raster_crs = src.crs
            if raster_crs and vector_gdf.crs != raster_crs:
                print(f"[*] 正在将矢量投影转换为栅格一致的 CRS: {raster_crs} ...")
                vector_gdf = vector_gdf.to_crs(raster_crs)
    except:
        pass

    import time
    start_time = time.time()
    
    # 【重要修复】：您之前的 SDK 里硬编码了 categorical=False，这可能会导致某些分类栅格统计失败，必须改为 categorical=True
    stats = zonal_stats(
        vector_gdf, 
        raster_file_path, 
        stats=['majority'], 
        all_touched=True, 
        categorical=True,  # <-- 修复这里
        geojson_out=False
    )
    
    print(f"[*] 栅格统计计算完成！耗时: {round(time.time() - start_time, 2)} 秒")
    
    # 核心修复：坚决不使用 np.nan，改用 None。因为一旦流入 to_dict 会造成后续 JSON 500 崩溃
    vector_gdf[col_name] = [s.get('majority') if (s and 'majority' in s and s['majority'] is not None) else None for s in stats]
    
    return vector_gdf

def safe_natural_breaks(gdf, target_col, k=5, col_name='jenks_class', labels=None): 
    """
    Jenks 自然断点法分级 (Feature Binning)
    支持直接传入 labels 列表进行文本标签映射
    """
    if gdf.empty or target_col not in gdf.columns:
        gdf[col_name] = np.nan
        return gdf

    # 过滤掉空值参与计算
    valid_data = gdf[target_col].dropna()
    if len(valid_data) < k:
        gdf[col_name] = np.nan # 数据量太少无法分级
        return gdf

    try:
        # 使用 mapclassify 计算断点
        classifier = mc.NaturalBreaks(valid_data, k=k)
        
        # 核心升级：如果传入了 labels 并且长度匹配，直接映射为文本！
        if labels and len(labels) >= k:
            # classifier.yb 是 0 到 k-1 的索引，完美对应 Python List
            mapping = dict(zip(valid_data.index, [labels[i] for i in classifier.yb]))
        else:
            # 否则回退到默认的 1, 2, 3...
            mapping = dict(zip(valid_data.index, classifier.yb + 1))
            
        gdf[col_name] = gdf.index.map(mapping)
    except Exception as e:
        print(f"Jenks分级失败: {e}")
        gdf[col_name] = np.nan

    return gdf

def safe_rule_reclassify(gdf, target_col, bins, labels, col_name='reclass_val', default_val='其他'):
    """
    规则重分类 (支持同名标签和兜底值)
    """
    if gdf.empty or target_col not in gdf.columns:
        print(f"[Warning] 未找到目标列: {target_col}")
        gdf[col_name] = None
        return gdf
    
    # 核心修复：设置 labels=False，让 pd.cut 只返回数字索引 (0, 1, 2...)
    # 这样就完美绕过了 Pandas 严禁 labels 出现重复名称（如两个'北'）的底层限制！
    codes = pd.cut(gdf[target_col], bins=bins, labels=False, right=False)
    
    # 手动建立索引到真实标签的映射字典
    label_map = {i: lbl for i, lbl in enumerate(labels)}
    gdf[col_name] = codes.map(label_map)
    
    # 把不包含在区间内的值（比如 <0 或 >360 的值），统一填充为用户要求的 default_val（如“平面”）
    if default_val:
        gdf[col_name] = gdf[col_name].fillna(default_val)
        
    # 转为字符串防止前端 JSON 解析问题
    gdf[col_name] = gdf[col_name].astype(str)
    return gdf

def safe_sum_intersecting_length(target_gdf, line_gdf, col_name='total_length'):
    """
    【线面相交求长算子】: 安全计算目标图层(面)内相交的线要素(如道路)的总长度(米)。
    它在底层完美处理了几何继承反转和分组求和逻辑，杜绝幻觉报错。
    """
    if target_gdf.empty or line_gdf.empty:
        target_gdf[col_name] = 0
        return target_gdf
        
    t_gdf = ensure_metric_crs(target_gdf)
    l_gdf = ensure_metric_crs(line_gdf).to_crs(t_gdf.crs)

    # 核心原理：线在左，面在右，保留线的 Geometry 去算长度
    joined = gpd.sjoin(l_gdf, t_gdf, how='inner', predicate='intersects')
    joined['calc_len'] = joined.geometry.length
    
    # 按街道面图层的索引进行分组求和
    length_sum = joined.groupby('index_right')['calc_len'].sum()

    target_gdf[col_name] = length_sum
    target_gdf[col_name] = target_gdf[col_name].fillna(0)
    return target_gdf

def safe_spatial_join_agg(target_gdf, join_gdf, agg_col, agg_func='sum', col_name='agg_val'):
    """
    【空间连接聚合算子】: 将相交的客体图层数值字段进行聚合计算赋给目标图层。
    """
    if target_gdf.empty or join_gdf.empty:
        target_gdf[col_name] = 0 if agg_func == 'sum' else np.nan       
        return target_gdf

    if agg_col not in join_gdf.columns:
        raise KeyError(
            f"\\n[SDK 拦截] 列名错误！在客体图层中找不到名为 '{agg_col}' 的字段！\\n"
            f"请不要自创英文列名，必须使用原始数据的真实列名。\\n"
            f"当前客体图层真实的可用列名包括: {list(join_gdf.columns)}"
        )

    t_gdf = ensure_metric_crs(target_gdf)
    j_gdf = ensure_metric_crs(join_gdf).to_crs(t_gdf.crs)

    j_gdf_sub = j_gdf[[j_gdf.geometry.name, agg_col]]
    joined = gpd.sjoin(t_gdf, j_gdf_sub, how='left', predicate='intersects')

    # 【核心防御】：强悍的正则洗数据！把 "100万", "未知", "50.5元" 等乱七八糟的格式强行洗成纯数字
    # 1. 提取所有数字和小数点
    extracted_nums = joined[agg_col].astype(str).str.extract(r'([\\d\\.]+)', expand=False)
    # 2. 转换为浮点数，提取不到的变成 NaN
    joined[agg_col] = pd.to_numeric(extracted_nums, errors='coerce')

    agg_series = joined.groupby(joined.index)[agg_col].agg(agg_func)   
    target_gdf[col_name] = agg_series

    if agg_func in ['sum', 'count']:
        target_gdf[col_name] = target_gdf[col_name].fillna(0)

    return target_gdf

def safe_spatial_categorical_summary(target_gdf, join_gdf, cat_col, col_prefix='cat'):
    """
    【分类统计算子】(终极防弹版): 统计目标面内，客体要素不同分类的数量、占比及主导分类。
    """
    if target_gdf.empty or join_gdf.empty or cat_col not in join_gdf.columns:
        target_gdf[f'{col_prefix}_dominant'] = '未知'
        return target_gdf

    # 1. 彻底清洗列名，防止重复列名导致的 DataFrame 歧义
    t_gdf = target_gdf.loc[:, ~target_gdf.columns.duplicated()].copy()
    j_gdf = join_gdf.loc[:, ~join_gdf.columns.duplicated()].copy()

    # 处理可能的重名冲突（如果目标图层也刚好有这个分类字段，先删掉防止后缀污染）
    if cat_col in t_gdf.columns:
        t_gdf = t_gdf.drop(columns=[cat_col])

    t_gdf = ensure_metric_crs(t_gdf)
    j_gdf = ensure_metric_crs(j_gdf).to_crs(t_gdf.crs)

    # 2. 【核心防御2】：注入绝对唯一的临时主键，规避一切 Join 索引报错！
    t_gdf['_temp_uid'] = range(len(t_gdf))

    # 3. 空间连接
    joined = gpd.sjoin(t_gdf, j_gdf, how='left', predicate='intersects')
    valid_joined = joined.dropna(subset=[cat_col])
    
    if valid_joined.empty:
        t_gdf[f'{col_prefix}_dominant'] = '无'
        return t_gdf.drop(columns=['_temp_uid'])

    # 4. 基于临时主键进行绝对安全的分组
    counts = valid_joined.groupby(['_temp_uid', cat_col]).size().unstack(fill_value=0)

    # 5. 计算指标
    total = counts.sum(axis=1)
    ratios = counts.div(total.replace(0, np.nan), axis=0).fillna(0)
    dominant = ratios.idxmax(axis=1)

    counts.columns = [f'{col_prefix}_{c}_count' for c in counts.columns]
    ratios.columns = [f'{col_prefix}_{c}_ratio' for c in ratios.columns]

    summary_df = pd.concat([counts, ratios], axis=1)
    summary_df[f'{col_prefix}_dominant'] = dominant
    summary_df[f'{col_prefix}_total'] = total

    # 6. 安全合并回主表 (通过明确的 left_on 规避 multi-index 错误)
    result_gdf = t_gdf.merge(summary_df, left_on='_temp_uid', right_index=True, how='left')
    result_gdf = result_gdf.drop(columns=['_temp_uid'])

    # 7. 优雅填充
    for c in summary_df.columns:
        if c.endswith('_count') or c.endswith('_total') or c.endswith('_ratio'):
            result_gdf[c] = result_gdf[c].fillna(0)
    result_gdf[f'{col_prefix}_dominant'] = result_gdf[f'{col_prefix}_dominant'].fillna('无')

    return result_gdf

`;


// 3. 注入专业模型专属的 Python SDK 字符串
const PRO_MODEL_SDK_INJECTION = `
import geopandas as gpd
import pandas as pd
import numpy as np
import warnings
warnings.filterwarnings("ignore")

def safe_geodetector_factor(gdf, y_col, x_cols):
    """
    地理探测器 - 因子探测 (Factor Detector)
    计算自变量 X 们对 因变量 Y 的空间分异解释力 q 值。
    """
    if gdf.empty or y_col not in gdf.columns:
        return [{"Error": "数据为空或因变量不存在"}]
        
    results = []
    # 确保因变量是纯数字
    gdf[y_col] = pd.to_numeric(gdf[y_col], errors='coerce')
    
    # 循环计算每个 X 的解释力 q
    for x_col in x_cols:
        if x_col not in gdf.columns: continue
        
        # 提取有效数据（剔除缺失值）
        valid_df = gdf[[y_col, x_col]].dropna()
        if valid_df.empty: continue
        
        N = len(valid_df)
        if N < 2: continue
        
        # 全局总方差 (SST)
        sst = valid_df[y_col].var(ddof=0) * N
        if sst == 0:
            results.append({'因变量 (Y)': y_col, '自变量 (X)': x_col, 'q值 (解释力)': 0.0})
            continue
            
        # 层内方差之和 (SSW)
        ssw = 0
        grouped = valid_df.groupby(x_col)[y_col]
        for name, group in grouped:
            nh = len(group)
            if nh > 1:
                ssw += group.var(ddof=0) * nh
                
        # 计算 q 值
        q = 1 - (ssw / sst)
        results.append({
            '因变量 (Y)': y_col, 
            '自变量 (X)': x_col, 
            'q值 (解释力)': round(max(0.0, q), 4) # 限制最低为0，保留4位小数
        })
        
    # 按解释力大小降序排列
    results.sort(key=lambda item: item.get('q值 (解释力)', 0), reverse=True)
    return results

def safe_geodetector_interaction(gdf, y_col, x_cols):
    """
    地理探测器 - 交互探测 (Interaction Detector)
    计算两两因子叠加后的解释力 q(A∩B)，并判断交互类型。
    为完美适配前端二维热力图，输出对称矩阵格式的 List of Dict。
    """
    import itertools
    if gdf.empty or y_col not in gdf.columns or len(x_cols) < 2:
        return [{"Error": "数据为空，或因变量不存在，或自变量不足2个"}]
        
    results = []
    gdf[y_col] = pd.to_numeric(gdf[y_col], errors='coerce')
    
    # 闭包辅助函数：计算单因子的 q 值
    def calc_q(df, x_c, y_c):
        valid = df[[y_c, x_c]].dropna()
        N = len(valid)
        if N < 2: return 0.0
        sst = valid[y_c].var(ddof=0) * N
        if sst == 0: return 0.0
        ssw = sum(g.var(ddof=0) * len(g) for _, g in valid.groupby(x_c)[y_c] if len(g) > 1)
        return max(0.0, 1 - (ssw / sst))

    # 1. 计算对角线（自身 q 值）
    for x in x_cols:
        if x not in gdf.columns: continue
        q_self = calc_q(gdf, x, y_col)
        results.append({'因子A': x, '因子B': x, '交互q值': round(q_self, 4), '交互类型': '单因子自身'})

    # 2. 计算两两交互
    for x1, x2 in itertools.combinations(x_cols, 2):
        if x1 not in gdf.columns or x2 not in gdf.columns: continue
        
        temp_df = gdf[[y_col, x1, x2]].dropna().copy()
        if temp_df.empty: continue
        
        # 生成叠加后的大类
        temp_df['interact'] = temp_df[x1].astype(str) + "_" + temp_df[x2].astype(str)
        
        q1 = calc_q(temp_df, x1, y_col)
        q2 = calc_q(temp_df, x2, y_col)
        q12 = calc_q(temp_df, 'interact', y_col)
        
        # 判断交互类型
        if q12 < min(q1, q2): int_type = "非线性减弱"
        elif min(q1, q2) <= q12 <= max(q1, q2): int_type = "单因子非线性减弱"
        elif q12 > max(q1, q2) and q12 < (q1 + q2): int_type = "双因子增强"
        elif q12 == (q1 + q2): int_type = "独立"
        else: int_type = "非线性增强"
            
        q12_round = round(q12, 4)
        # 补齐对称面（A-B 和 B-A 都压入，热力图才能形成正方形）
        results.append({'因子A': x1, '因子B': x2, '交互q值': q12_round, '交互类型': int_type})
        results.append({'因子A': x2, '因子B': x1, '交互q值': q12_round, '交互类型': int_type})
        
    return results

def safe_geodetector_weighted_sensitivity(
    gdf,
    y_col,
    x_cols,
    score_col='滑坡敏感性综合评分',
    level_col='滑坡敏感性等级',
    level_count=5
):
    """
    地理探测器 q 值转权重，并计算综合敏感性评分。
    返回结构化结果：
    {
        "result_type": "sensitivity_score",
        "score_rows": [...],
        "weight_rows": [...],
        "summary": {...}
    }
    """
    if gdf.empty or y_col not in gdf.columns:
        return {
            "result_type": "sensitivity_score",
            "score_rows": [],
            "weight_rows": [],
            "summary": {"error": "empty_gdf_or_missing_y"}
        }

    def _coerce_factor_to_numeric(series):
        direct_numeric = pd.to_numeric(series, errors='coerce')
        valid_ratio = direct_numeric.notna().sum() / max(len(series), 1)
        if valid_ratio >= 0.6:
            return direct_numeric.astype(float)

        extracted = series.astype(str).str.extract(r'(-?\\d+(?:\\.\\d+)?)', expand=False)
        extracted_numeric = pd.to_numeric(extracted, errors='coerce')
        extracted_ratio = extracted_numeric.notna().sum() / max(len(series), 1)
        if extracted_ratio >= 0.6:
            return extracted_numeric.astype(float)

        ordered_label_map = {
            '低': 1, '较低': 2, '中': 3, '中等': 3, '较高': 4, '高': 5, '极高': 6,
            'low': 1, 'medium': 3, 'high': 5,
        }
        normalized_text = series.astype(str).str.strip()
        if normalized_text.dropna().isin(ordered_label_map.keys()).all():
            return normalized_text.map(ordered_label_map).astype(float)

        codes, _ = pd.factorize(normalized_text, sort=True)
        result = pd.Series(codes + 1, index=series.index, dtype='float64')
        result[series.isna()] = np.nan
        return result

    def _calc_q(df, x_c, y_c):
        valid = df[[y_c, x_c]].dropna().copy()
        if valid.empty:
            return 0.0, 0, 0

        valid[y_c] = pd.to_numeric(valid[y_c], errors='coerce')
        valid = valid.dropna(subset=[y_c])
        n = len(valid)
        if n < 2:
            return 0.0, n, int(valid[x_c].nunique())

        sst = valid[y_c].var(ddof=0) * n
        if pd.isna(sst) or not np.isfinite(sst) or sst <= 0:
            return 0.0, n, int(valid[x_c].nunique())

        ssw = 0.0
        for _, group in valid.groupby(x_c)[y_c]:
            group_n = len(group)
            if group_n > 1:
                group_var = group.var(ddof=0)
                if pd.notna(group_var) and np.isfinite(group_var):
                    ssw += float(group_var) * group_n

        q_value = max(0.0, 1 - (ssw / sst))
        return round(float(q_value), 6), n, int(valid[x_c].nunique())

    def _classify_levels(score_series, k):
        labels = ['低', '较低', '中', '较高', '高', '极高', '超高'][:max(1, k)]
        valid_scores = score_series.dropna()
        result = pd.Series(index=score_series.index, dtype='object')

        if valid_scores.empty:
            return result

        unique_count = int(valid_scores.nunique())
        if unique_count == 1:
            middle_label = labels[min(len(labels) - 1, len(labels) // 2)]
            result.loc[valid_scores.index] = middle_label
            return result

        class_count = min(k, unique_count)
        active_labels = labels[:class_count]

        try:
            import mapclassify as mc
            classifier = mc.NaturalBreaks(valid_scores.to_numpy(), k=class_count)
            bins = classifier.bins
            classified = pd.cut(
                valid_scores,
                bins=[-np.inf] + list(bins[:-1]) + [np.inf],
                labels=active_labels,
                include_lowest=True
            )
            result.loc[valid_scores.index] = classified.astype(str)
            return result
        except Exception:
            ranked = valid_scores.rank(method='average')
            classified = pd.qcut(ranked, q=class_count, labels=active_labels, duplicates='drop')
            result.loc[valid_scores.index] = classified.astype(str)
            return result

    working = gdf.copy()
    working[y_col] = pd.to_numeric(working[y_col], errors='coerce')
    record_ids = working['id'] if 'id' in working.columns else pd.Series(range(len(working)), index=working.index)

    weight_rows = []
    usable_factors = []
    q_values = []
    factor_numeric_map = {}

    for x_col in x_cols:
        if x_col not in working.columns:
            continue
        numeric_x = _coerce_factor_to_numeric(working[x_col])
        working[x_col] = numeric_x
        q_value, sample_count, class_count = _calc_q(working, x_col, y_col)
        weight_rows.append({
            '因子字段': x_col,
            'q值': q_value,
            '权重': 0.0,
            '有效样本数': sample_count,
            '类别数': class_count,
        })
        usable_factors.append(x_col)
        q_values.append(q_value)
        factor_numeric_map[x_col] = numeric_x

    if not usable_factors:
        return {
            "result_type": "sensitivity_score",
            "score_rows": [],
            "weight_rows": [],
            "summary": {"error": "no_usable_factors", "y_col": y_col}
        }

    q_sum = float(np.nansum(q_values))
    if q_sum > 0:
        weights = [float(q) / q_sum for q in q_values]
    else:
        equal_weight = 1.0 / len(usable_factors)
        weights = [equal_weight for _ in usable_factors]

    for row, weight in zip(weight_rows, weights):
        row['权重'] = round(weight, 6)

    weighted_sum = pd.Series(0.0, index=working.index, dtype='float64')
    applied_weight_sum = pd.Series(0.0, index=working.index, dtype='float64')

    for x_col, weight in zip(usable_factors, weights):
        factor_values = factor_numeric_map[x_col]
        valid_mask = factor_values.notna()
        weighted_sum = weighted_sum.add(factor_values.fillna(0) * weight, fill_value=0)
        applied_weight_sum = applied_weight_sum.add(valid_mask.astype(float) * weight, fill_value=0)

    score_series = weighted_sum.where(applied_weight_sum > 0, np.nan)
    score_series = score_series / applied_weight_sum.replace(0, np.nan)
    level_series = _classify_levels(score_series, level_count)

    score_rows = []
    for idx in working.index:
        score_value = score_series.loc[idx]
        level_value = level_series.loc[idx] if idx in level_series.index else None
        score_rows.append({
            'id': record_ids.loc[idx],
            score_col: None if pd.isna(score_value) else round(float(score_value), 6),
            level_col: None if pd.isna(level_value) else str(level_value),
        })

    return {
        "result_type": "sensitivity_score",
        "score_rows": score_rows,
        "weight_rows": weight_rows,
        "summary": {
            "y_col": y_col,
            "x_cols": usable_factors,
            "score_col": score_col,
            "level_col": level_col,
            "level_count": level_count
        }
    }
`
;

// ==========================================
// [Phase 5] 绘图沙盒专属 SDK (Chart SDK)
// 包含所有制图相关的标准化辅助函数，统一暗黑科技主题 UI
// ==========================================
const CHART_SDK_INJECTION = `
import pandas as pd
import numpy as np
import json

# ==========================================
# 绘图标准化辅助模块 (Visualization Utilities)
# ==========================================

def apply_system_theme_plotly(fig, title=""):
    """
    【Plotly 统一样式算子】: 保证所有生成的 Plotly 图表符合系统极客深色 UI 规范。
    强行覆盖大模型可能生成的丑陋默认白底样式。
    """
    fig.update_layout(
        title=dict(text=title, font=dict(color='#22d3ee', size=16)),
        template="plotly_dark",
        paper_bgcolor='rgba(11, 17, 33, 0)',  # 完全透明，适配前端玻璃拟态
        plot_bgcolor='rgba(11, 17, 33, 0)',
        font=dict(color='#e5e7eb', family='sans-serif'),
        margin=dict(t=50, l=10, r=10, b=10),
        coloraxis_colorbar=dict(title=dict(font=dict(color='#9ca3af')), tickfont=dict(color='#9ca3af'))
    )
    return fig

def create_system_base_map(center_lat, center_lon, zoom=11):
    """
    【Folium 底图算子】: 统一生成极客风格的暗色态街道底图。
    """
    import folium
    # 使用 CartoDB dark_matter 作为默认赛博风底图
    m = folium.Map(location=[center_lat, center_lon], zoom_start=zoom, tiles='CartoDB dark_matter')
    return m

def safe_render_folium(m):
    """
    【Folium 渲染算子】: 安全提取 HTML 并注入响应式 CSS，确保地图充满前端 Iframe。
    """
    html_str = m.get_root().render()
    # 强制 iframe 内部地图 100% 充满容器，消除滚动条
    html_str = html_str.replace(
        '<style>html, body {width: 100%;height: 100%;margin: 0;padding: 0;}</style>', 
        '<style>html, body {width: 100vw;height: 100vh;margin: 0;padding: 0;overflow:hidden;}</style>'
    )
    return html_str
`;

// 简易空间索引
class SimpleGridIndex {
    private buckets: Map<string, any[]> = new Map();
    private cellSize: number;

    constructor(bbox: number[], resolution: number = 20) { // 稍微调大 resolution 提高精度
        const width = bbox[2] - bbox[0];
        const height = bbox[3] - bbox[1];
        this.cellSize = Math.max(width, height) / resolution;
    }

    insert(item: any) {
        const bbox = turf.bbox(item);
        const minX = Math.floor(bbox[0] / this.cellSize);
        const maxX = Math.floor(bbox[2] / this.cellSize);
        const minY = Math.floor(bbox[1] / this.cellSize);
        const maxY = Math.floor(bbox[3] / this.cellSize);

        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                const key = `${x},${y}`;
                if (!this.buckets.has(key)) this.buckets.set(key, []);
                this.buckets.get(key)!.push(item);
            }
        }
    }

    query(feature: any): any[] {
        const bbox = turf.bbox(feature);
        return this.queryByBbox(bbox);
    }

    //   [新增] 支持直接通过 bbox 查询，方便做邻域搜索
    queryByBbox(bbox: number[]): any[] {
        const candidates = new Set<any>();
        const minX = Math.floor(bbox[0] / this.cellSize);
        const maxX = Math.floor(bbox[2] / this.cellSize);
        const minY = Math.floor(bbox[1] / this.cellSize);
        const maxY = Math.floor(bbox[3] / this.cellSize);

        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                const key = `${x},${y}`;
                const items = this.buckets.get(key);
                if (items) items.forEach(item => candidates.add(item));
            }
        }
        return Array.from(candidates);
    }
}

function safeIntersect(poly1: any, poly2: any): any {
    try {
        // @ts-ignore
        let intersection = turf.intersect(poly1, poly2);
        if (!intersection) {
             // @ts-ignore
             intersection = turf.intersect(turf.featureCollection([poly1, poly2]));
        }
        return intersection;
    } catch (e) {
        try {
            // @ts-ignore
            return turf.intersect(turf.featureCollection([poly1, poly2]));
        } catch (e2) {
            return null;
        }
    }
}

export const pivotAnalysis = async (req: Request, res: Response) => {
    try {
        res.json(await queryAttributePivot(pool, req.body || {}));
    } catch (error: any) {
        const status = error instanceof AnalysisInputError || error.code === '22P02' ? 400 : 500;
        res.status(status).json({ message: status === 400 ? (error.code === '22P02' ? '统计字段包含非数值内容，请先清理数据' : error.message) : '透视分析失败' });
    }
};

export const generateGrid = async (req: Request, res: Response): Promise<void> => {
    try {
        const { fileId, shape, size, method, targetField } = req.body;

        if (!fileId || !shape || !size) {
            res.status(400).json({ error: 'Missing required parameters' });
            return;
        }
        
        //   [配置] 定义缓冲区圈数 n (可在此处 ，或从前端传入)
        const BUFFER_RINGS = 2; // 显示周围 2 圈网格

        console.log(`[Grid] Generating ${shape} grid (${size}km) for file ${fileId}`);
        
        const rawFeatures = await Feature.findFeaturesByFileId(fileId);
        if (!rawFeatures || rawFeatures.length === 0) {
                res.status(404).json({ error: 'No features found' });
                return;
        }

        const features = rawFeatures.map((f: any) => turf.feature(f.geometry, f.properties));
        
        //   [新增] 预判数据类型，用于覆盖率计算
        const firstGeom = features[0]?.geometry.type;
        const isPolygonLayer = firstGeom?.includes('Polygon');
        const isLineLayer = firstGeom?.includes('Line');
        
        const featureCollection = turf.featureCollection(features);
        const bbox = turf.bbox(featureCollection);
        
        // 2. 生成网格
        const options: any = { units: 'kilometers' };
        let grid: any;
        try {
            if (shape === 'hex') {
                grid = turf.hexGrid(bbox, size, options);
            } else {
                grid = turf.squareGrid(bbox, size, options);
            }
        } catch (e) {
            res.status(500).json({ error: 'Grid generation error' });
            return;
        }

        // 初始化属性，并给每个网格打上唯一 ID 方便索引
        grid.features.forEach((cell: any, index: number) => {
            cell.properties = { 
                value: 0, 
                count: 0,
                _id: index // 内部临时 ID
            };
        });

        // 3. 建立索引
        const gridIndex = new SimpleGridIndex(bbox, 25);
        grid.features.forEach((cell: any) => gridIndex.insert(cell));

        // 4. 聚合计算
        // 记录所有“活跃”网格的 ID (即与数据相交的网格)
        const activeCellIds = new Set<number>();

        let processedCount = 0;
        let intersectCount = 0;

        features.forEach((feature: any) => {
            const geometryType = feature.geometry.type;
            let rawValue = 1;
            
            //   [ ] 确定 rawValue (根据模式)
            if (method === 'coverage') {
                // 覆盖率模式：计算几何体自身的绝对量（面积或长度）
                if (isPolygonLayer) {
                    // 面：使用平方米
                    rawValue = turf.area(feature); 
                } else if (isLineLayer) {
                    // 线：使用千米
                    rawValue = turf.length(feature, { units: 'kilometers' });
                } else {
                    // 点数据不支持覆盖率，忽略
                    return; 
                }
            } else if (method !== 'count' && targetField) {
                // 属性聚合模式
                const val = Number(feature.properties[targetField]);
                if (isNaN(val)) return;
                rawValue = val;
            }
            // 计数模式 rawValue 默认为 1

            const candidateCells = gridIndex.query(feature);
            
            candidateCells.forEach((cell: any) => {
                let ratio = 0;
                try {
                    // A. 点数据
                    if (geometryType === 'Point') {
                        if (turf.booleanPointInPolygon(feature, cell)) ratio = 1;
                    } 
                    // B. 线数据
                    else if (geometryType === 'LineString' || geometryType === 'MultiLineString') {
                        if (!turf.booleanIntersects(cell, feature)) return;
                        const totalLen = turf.length(feature);
                        if (totalLen === 0) return;

                        if (turf.booleanContains(cell, feature)) {
                            ratio = 1;
                        } else {
                            const cellBoundary = turf.polygonToLine(cell);
                            // @ts-ignore
                            const splitLines = turf.lineSplit(feature, cellBoundary);
                            let insideLen = 0;
                            splitLines.features.forEach((seg: any) => {
                                const len = turf.length(seg);
                                if (len > 0) {
                                    const mid = turf.along(seg, len / 2);
                                    if (turf.booleanPointInPolygon(mid, cell)) insideLen += len;
                                }
                            });
                            if (splitLines.features.length === 0) {
                                    const mid = turf.along(feature, totalLen / 2);
                                    if (turf.booleanPointInPolygon(mid, cell)) ratio = 1;
                            } else {
                                    ratio = insideLen / totalLen;
                            }
                        }
                    } 
                    // C. 面数据
                    else if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') {
                        if (!turf.booleanIntersects(cell, feature)) return;
                        if (turf.booleanContains(cell, feature)) {
                            ratio = 1; 
                        } else if (turf.booleanContains(feature, cell)) {
                            const cellArea = turf.area(cell);
                            const featArea = turf.area(feature);
                            if (featArea > 0) ratio = cellArea / featArea;
                        } else {
                            const intersection = safeIntersect(cell, feature);
                            if (intersection) {
                                const totalArea = turf.area(feature);
                                const partArea = turf.area(intersection);
                                if (totalArea > 0) ratio = partArea / totalArea;
                            }
                        }
                    }

                    if (ratio > 0) {
                        cell.properties.value += rawValue * ratio;
                        cell.properties.count += 1;
                        intersectCount++;
                        //   [标记] 该网格是活跃的
                        activeCellIds.add(cell.properties._id);
                    }
                } catch (err) {}
            });
            processedCount++;
        });

        console.log(`[Grid] Processed ${processedCount} features. Active cells: ${activeCellIds.size}`);

        //   [新增] 覆盖率模式的后处理：除以网格面积
        if (method === 'coverage') {
            grid.features.forEach((cell: any) => {
                if (activeCellIds.has(cell.properties._id)) {
                    const cellAreaSqM = turf.area(cell); // 网格面积 (m²)
                    
                    if (isPolygonLayer) {
                        // 面覆盖率 = (网格内建筑总面积 m²) / (网格面积 m²)
                        // 结果范围 0.0 - 1.0
                        cell.properties.value = cell.properties.value / cellAreaSqM;
                        // 修正可能的浮点误差，最大不超过 1
                        if (cell.properties.value > 1) cell.properties.value = 1;
                    } else if (isLineLayer) {
                        // 线密度 = (网格内道路总长 km) / (网格面积 km²)
                        // 结果单位：km/km²
                        const cellAreaSqKm = cellAreaSqM / 1_000_000;
                        if (cellAreaSqKm > 0) {
                            cell.properties.value = cell.properties.value / cellAreaSqKm;
                        }
                    }
                }
            });
        }

        // 5. 修约数值
        grid.features.forEach((cell: any) => {
            // 覆盖率通常保留更多小数位
            const decimals = method === 'coverage' ? 4 : 2;
            cell.properties.value = Number(cell.properties.value.toFixed(decimals));
        });

        //   [新增] 缓冲区过滤逻辑
        // 无论点、线、面，都执行这个通用的视觉优化
        if (activeCellIds.size > 0) {
            const cellsToKeep = new Set<number>(activeCellIds);
            
            // 将所有活跃网格对象找出来
            const activeCells = grid.features.filter((f: any) => activeCellIds.has(f.properties._id));
            
            // 计算缓冲区半径 (km)
            // 假设 size 是半径或边长，我们向外扩展 n * size * 2 (确保覆盖够宽)
            // 这里用一个近似值：size * 1.5 * n
            const bufferDist = size * 1.5 * BUFFER_RINGS;

            // 对每个活跃网格，寻找其周边的邻居
            activeCells.forEach((cell: any) => {
                const cellBbox = turf.bbox(cell);
                // 扩大 BBox
                const expandedBbox = [
                    cellBbox[0] - 0.02 * size * BUFFER_RINGS, // 经度简易换算
                    cellBbox[1] - 0.02 * size * BUFFER_RINGS, // 纬度简易换算
                    cellBbox[2] + 0.02 * size * BUFFER_RINGS,
                    cellBbox[3] + 0.02 * size * BUFFER_RINGS
                ];
                
                // 利用 turf.buffer 更精确 (但这比较慢)，或者直接用 GridIndex 查邻居 (极快)
                // 这里我们用 GridIndex + 几何中心距离判断
                const center = turf.centroid(cell);
                // 搜索范围略大于缓冲区
                const neighbors = gridIndex.queryByBbox(expandedBbox);
                
                neighbors.forEach((neighbor: any) => {
                    if (cellsToKeep.has(neighbor.properties._id)) return;
                    
                    // 计算距离，判断是否在 n 圈内
                    const dist = turf.distance(center, turf.centroid(neighbor), { units: 'kilometers' });
                    // 两个相邻六边形中心距离约为 size * 1.732
                    // n 圈大约是 n * 2 * size
                    if (dist <= size * 2.0 * BUFFER_RINGS) {
                        cellsToKeep.add(neighbor.properties._id);
                    }
                });
            });

            console.log(`[Grid Filter] Buffer expansion (${BUFFER_RINGS} rings): ${activeCellIds.size} -> ${cellsToKeep.size} cells`);
            
            // 执行过滤
            grid.features = grid.features.filter((f: any) => cellsToKeep.has(f.properties._id));
        } else {
            // 如果没有任何相交，返回空
            grid.features = [];
        }

        // 清理临时 ID
        grid.features.forEach((f: any) => delete f.properties._id);

        res.json({ success: true, data: grid });

    } catch (error) {
        console.error('Grid generation failed:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// 辅助函数：确保 Key 生成逻辑在“初始化阶段”和“聚合阶段”完全一致
const getSafeKey = (field: string, val: any) => {
    const strVal = String(val); // 强制转字符串
    const safeVal = strVal.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_');
    return `${field}_${safeVal}`;
};

export const exportGrid = async (req: Request, res: Response): Promise<void> => {
    try {
        const { fileId, shape, size, method, categoryFields } = req.body;

        if (!fileId || !shape || !size) {
            res.status(400).json({ error: 'Missing required parameters' });
            return;
        }

        const selectedCategories: string[] = Array.isArray(categoryFields) 
            ? categoryFields 
            : (categoryFields ? [categoryFields] : []);

        console.log(`[Export] Exporting ${shape} grid (${size}km) for file ${fileId}. Method: ${method}`);

        const getSafeKey = (field: string, val: any) => {
            const strVal = String(val);
            const safeVal = strVal.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_');
            return `${field}_${safeVal}`;
        };

        // 1. 获取原始数据
        const rawFeatures = await Feature.findFeaturesByFileId(fileId);
        if (!rawFeatures || rawFeatures.length === 0) {
                res.status(404).json({ error: 'No features found' });
                return;
        }

        //   [Fix: 移动定义到这里] 统一在最前面将原始数据转为 Turf Feature，供后续所有步骤使用
        const features = rawFeatures.map((f: any) => turf.feature(f.geometry, f.properties));
        
        //   [新增] 预判数据类型 (用于覆盖率计算)
        const firstGeom = features[0]?.geometry.type;
        const isPolygonLayer = firstGeom?.includes('Polygon');
        const isLineLayer = firstGeom?.includes('Line');

        // 2. 识别字段 & 收集分类值
        const numericFields = new Set<string>();
        const categoryValueMap = new Map<string, Set<string>>();

        selectedCategories.forEach(field => categoryValueMap.set(field, new Set()));

        rawFeatures.forEach((f: any) => {
            if (f.properties) {
                Object.keys(f.properties).forEach(key => {
                    if (typeof f.properties[key] === 'number') {
                        numericFields.add(key);
                    }
                });
                selectedCategories.forEach(field => {
                    const val = f.properties[field];
                    if (val !== undefined && val !== null) {
                        categoryValueMap.get(field)?.add(String(val));
                    }
                });
            }
        });

        const fieldsToAggregate = Array.from(numericFields);
        const allCategoryColumns: string[] = [];
        categoryValueMap.forEach((values, field) => {
            Array.from(values).sort().forEach(val => {
                allCategoryColumns.push(getSafeKey(field, val));
            });
        });

        // 3. 准备网格
        //   [删除] 原来的 const features = ... 删掉，防止重复声明错误
        const featureCollection = turf.featureCollection(features);
        const bbox = turf.bbox(featureCollection);
        
        const options: any = { units: 'kilometers' };
        let grid: any;
        try {
            if (shape === 'hex') {
                grid = turf.hexGrid(bbox, size, options);
            } else {
                grid = turf.squareGrid(bbox, size, options);
            }
        } catch (e) {
            res.status(500).json({ error: 'Grid generation error' });
            return;
        }

        // 初始化网格属性
        grid.features.forEach((cell: any) => {
            const props: any = { 
                count: 0, 
                value: 0, //   [新增] 显式初始化 value 字段
                _weight: 0 
            };
            
            // A. 常规数值
            fieldsToAggregate.forEach(field => {
                props[field] = (method === 'max' || method === 'min') 
                    ? (method === 'max' ? -Infinity : Infinity) 
                    : 0;
            });

            // B. 分类列
            allCategoryColumns.forEach(key => {
                props[key] = 0;
            });

            cell.properties = props;
        });

        // 4. 建立索引 & 聚合
        const gridIndex = new SimpleGridIndex(bbox, 25);
        grid.features.forEach((cell: any) => gridIndex.insert(cell));

        features.forEach((feature: any) => {
            const geometryType = feature.geometry.type;
            const candidateCells = gridIndex.query(feature);

            //   [新增] 计算 rawValue ( 指标)
            let rawValue = 1; // 默认为计数 (count)
            if (method === 'coverage') {
                if (isPolygonLayer) {
                    rawValue = turf.area(feature); // m²
                } else if (isLineLayer) {
                    rawValue = turf.length(feature, { units: 'kilometers' }); // km
                }
            } else if (method !== 'count' && method !== 'coverage') {
                 // 其他模式下 value 默认记为 1 (类似 count)，主要看具体属性字段
                 rawValue = 1; 
            }

            const activeCategoryKeys: string[] = [];
            selectedCategories.forEach(field => {
                const rawCat = feature.properties[field];
                if (rawCat !== undefined && rawCat !== null) {
                    activeCategoryKeys.push(getSafeKey(field, rawCat));
                }
            });

            candidateCells.forEach((cell: any) => {
                let ratio = 0;
                try {
                    // --- 几何计算 ---
                    if (geometryType === 'Point') {
                        if (turf.booleanPointInPolygon(feature, cell)) ratio = 1;
                    } 
                    else if (geometryType.includes('Line')) {
                        if (turf.booleanIntersects(cell, feature)) {
                            // 简化处理，若需要更高精度可换回 lineSplit
                            if (turf.booleanContains(cell, feature)) ratio = 1;
                            else ratio = 0.5; 
                        }
                    }
                    else if (geometryType.includes('Polygon')) {
                        if (turf.booleanIntersects(cell, feature)) {
                            const intersect = safeIntersect(cell, feature);
                            if (intersect) ratio = turf.area(intersect) / turf.area(feature);
                        }
                    }
                    // ------------------------------

                    if (ratio > 0) {
                        cell.properties.count += 1;
                        cell.properties._weight += ratio;
                        
                        //   [新增] 累加  Value
                        // Count模式: 1 * ratio
                        // Coverage模式: Area * ratio (即网格内的实际面积)
                        cell.properties.value += rawValue * ratio;

                        // 1. 常规聚合
                        if (method !== 'count' && method !== 'coverage') {
                            fieldsToAggregate.forEach(field => {
                                const val = Number(feature.properties[field]);
                                if (!isNaN(val)) {
                                    if (method === 'sum' || method === 'avg') cell.properties[field] += val * ratio;
                                    else if (method === 'max') cell.properties[field] = Math.max(cell.properties[field], val);
                                    else if (method === 'min') cell.properties[field] = Math.min(cell.properties[field], val);
                                }
                            });
                        }

                        // 2. 多分类拆分聚合
                        activeCategoryKeys.forEach(key => {
                            if (typeof cell.properties[key] === 'undefined') cell.properties[key] = 0;
                            cell.properties[key] += ratio;
                        });
                    }
                } catch (e) {}
            });
        });

        // 5. 后处理
        const resultFeatures = grid.features.filter((f: any) => f.properties.count > 0);
        
        resultFeatures.forEach((cell: any) => {
            //   [新增] 覆盖率模式归一化处理
            if (method === 'coverage') {
                const cellAreaSqM = turf.area(cell);
                
                if (isPolygonLayer) {
                    // 面覆盖率 = 网格内总面积 / 网格面积
                    cell.properties.value = cell.properties.value / cellAreaSqM;
                    if (cell.properties.value > 1) cell.properties.value = 1;
                } else if (isLineLayer) {
                    // 线密度 = 网格内总长度(km) / 网格面积(km²)
                    const cellAreaSqKm = cellAreaSqM / 1_000_000;
                    if (cellAreaSqKm > 0) {
                        cell.properties.value = cell.properties.value / cellAreaSqKm;
                    }
                }
                cell.properties.value = Number(cell.properties.value.toFixed(4));
            } else {
                // 其他模式保留两位小数
                cell.properties.value = Number(cell.properties.value.toFixed(2));
            }

            // 常规字段修约
            fieldsToAggregate.forEach(field => {
                if (method === 'avg' && cell.properties._weight > 0) {
                    cell.properties[field] = Number((cell.properties[field] / cell.properties._weight).toFixed(2));
                } else if (method !== 'count' && method !== 'coverage') {
                    if (cell.properties[field] !== Infinity && cell.properties[field] !== -Infinity) {
                            cell.properties[field] = Number(cell.properties[field].toFixed(2));
                    } else {
                            cell.properties[field] = 0;
                    }
                }
            });
            
            // 分类字段修约
            allCategoryColumns.forEach(key => {
                if (typeof cell.properties[key] !== 'undefined') {
                    cell.properties[key] = Number(cell.properties[key].toFixed(3));
                }
            });
            
            delete cell.properties._weight;
        });

        const finalGeoJSON = turf.featureCollection(resultFeatures);
        const fileName = `grid_export_${fileId}_${method}_${Date.now()}.geojson`;
        res.setHeader('Content-Type', 'application/geo+json');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.send(JSON.stringify(finalGeoJSON));

    } catch (error) {
        console.error('Export failed:', error);
        res.status(500).json({ error: 'Export failed' });
    }
}

// 获取所有已注册的活跃模型
export const computeLandslideSensitivityScore = async (req: Request, res: Response): Promise<void> => {
    try {
        const {
            targetFileId,
            yField,
            factorFields,
            scoreFieldName,
            levelFieldName,
            levelCount,
        } = req.body || {};

        if (!targetFileId || !yField || !Array.isArray(factorFields) || factorFields.length === 0) {
            res.status(400).json({
                code: 400,
                message: '缺少 targetFileId、yField 或 factorFields 参数',
            });
            return;
        }

        const result = await executeSensitivityScoreOperator({
            targetFileId,
            yField,
            factorFields,
            scoreFieldName,
            levelFieldName,
            levelCount,
        });

        res.json({
            code: 200,
            message: `综合评分计算完成，已将 [${result.scoreFieldName}, ${result.levelFieldName}] 回写至目标图层，并导出 q 值权重文件 [${result.weightFileName}]`,
            refreshSchema: true,
            targetFileId: result.targetFileId,
            newFileId: result.weightFileId,
            weightFileName: result.weightFileName,
            scoreFieldName: result.scoreFieldName,
            levelFieldName: result.levelFieldName,
            factorFields: result.factorFields,
            yField: result.yField,
            updatedCount: result.updatedCount,
            tableData: result.weightRows,
            summary: result.summary,
        });
    } catch (error: any) {
        const details = error.response?.data?.detail || error.message;
        console.error('[Sensitivity Score Error]', details);
        res.status(500).json({
            code: 500,
            message: '滑坡敏感性综合评分计算失败',
            details,
        });
    }
};

export const computeParkAccessibilityScore = async (req: Request, res: Response): Promise<void> => {
    try {
        const {
            gridFileId,
            streetFileId,
            distanceField,
            streetNameField,
            normalizationMethod,
            gridScoreFieldName,
            streetScoreFieldName,
        } = req.body || {};

        if (!gridFileId || !streetFileId || !distanceField) {
            res.status(400).json({
                code: 400,
                message: '缺少 gridFileId、streetFileId 或 distanceField 参数',
            });
            return;
        }

        const result = await executeParkAccessibilityOperator({
            gridFileId,
            streetFileId,
            distanceField,
            streetNameField,
            normalizationMethod,
            gridScoreFieldName,
            streetScoreFieldName,
        });

        res.json({
            code: 200,
            message: `公园可达性计算完成，已将 [${result.gridScoreFieldName}] 回写至网格图层，并将 [${result.streetScoreFieldName}] 聚合回写至街道图层，同时导出结果文件 [${result.resultFileName}]`,
            refreshSchema: true,
            targetFileId: result.streetFileId,
            newFileId: result.resultFileId,
            resultFileName: result.resultFileName,
            gridUpdatedCount: result.gridUpdatedCount,
            streetUpdatedCount: result.streetUpdatedCount,
            tableData: result.streetRows,
            summary: result.summary,
        });
    } catch (error: any) {
        const details = error.response?.data?.detail || error.message;
        console.error('[Park Accessibility Error]', details);
        res.status(500).json({
            code: 500,
            message: '公园可达性计算失败',
            details,
        });
    }
};

export const computeSpatialAutocorrelation = async (req: Request, res: Response): Promise<void> => {
    try {
        const {
            targetFileId,
            valueField,
            nameField,
            contiguity,
            permutations,
            significanceLevel,
            localIFieldName,
            pValueFieldName,
            clusterFieldName,
            hotspotFieldName,
            spatialLagFieldName,
            zScoreFieldName,
            neighborCountFieldName,
        } = req.body || {};

        if (!targetFileId || !valueField) {
            res.status(400).json({
                code: 400,
                message: '缺少 targetFileId 或 valueField 参数',
            });
            return;
        }

        const result = await executeSpatialAutocorrelationOperator({
            targetFileId,
            valueField,
            nameField,
            contiguity,
            permutations,
            significanceLevel,
            localIFieldName,
            pValueFieldName,
            clusterFieldName,
            hotspotFieldName,
            spatialLagFieldName,
            zScoreFieldName,
            neighborCountFieldName,
        });

        res.json({
            code: 200,
            message: `空间自相关分析完成，已将 [${result.clusterFieldName}, ${result.hotspotFieldName}] 等字段回写至目标图层，并导出结果文件 [${result.resultFileName}]`,
            refreshSchema: true,
            targetFileId: result.targetFileId,
            newFileId: result.resultFileId,
            resultFileName: result.resultFileName,
            updatedCount: result.updatedCount,
            tableData: buildSpatialAutocorrelationPreviewRows(result),
            summary: result.summary,
        });
    } catch (error: any) {
        const details = error.response?.data?.detail || error.message;
        console.error('[Spatial Autocorrelation Error]', details);
        res.status(500).json({
            code: 500,
            message: '空间自相关分析失败',
            details,
        });
    }
};

export const getRegisteredModels = async (req: Request, res: Response) => {
  try {
    const allModels = await ModelRegistry.getAllModels();
    // 过滤 active 状态并在返回时展平 JSONB
    const models = allModels
        .filter(m => m.parameters_schema?.status !== 'inactive')
        .map(m => ({
            modelName: m.model_name,
            displayName: m.parameters_schema?.displayName || m.model_name,
            description: m.description,
            parameters: m.parameters_schema?.parameters || [],
            status: m.parameters_schema?.status || 'active'
        }));
    res.json({ code: 200, data: models });
  } catch (error) {
    console.error("获取模型列表失败:", error);
    res.status(500).json({ error: '获取模型列表失败' });
  }
};

// ==========================================
// LLM 智能体代理注册接口 (API 机械臂)
// ==========================================
export const registerModelByAI = async (req: Request, res: Response) => {
  try {
    // 接收 LLM 生成的模型名称、描述、参数规范，以及最关键的：Python 源代码字符串
    const { modelName, displayName, description, parameters, pythonCode } = req.body;

    if (typeof modelName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(modelName)) {
      return res.status(400).json({ error: '模型名称必须以字母开头，仅包含字母、数字和下划线' });
    }
    if (typeof pythonCode !== 'string' || !pythonCode.trim()) {
      return res.status(400).json({ error: '智能体未能提供有效的 Python 代码' });
    }

    // 步骤 A：物理隔离写入（绝对不碰 main.py，只向 models 文件夹注入“零件”）
    // 解析出 python_engine/models 的绝对路径 (根据你的目录结构可能需要微调 ../ 的数量)
    const modelsDir = path.join(process.cwd(), '../python_engine/models');
    
    // 确保 models 文件夹存在
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true });
    }

    // 将 AI 写的代码保存为 .py 文件（例如 lsi_ahp.py）
    const fileName = `${modelName.toLowerCase()}.py`;
    const filePath = path.join(modelsDir, fileName);
    fs.writeFileSync(filePath, pythonCode, 'utf8');

    // 步骤 B：元数据落库（记录在案，供前端动态读取公式列表）
    const newModelData = {
      model_name: modelName.toUpperCase(),
      description: description,
      parameters_schema: {
        displayName,
        parameters,
        status: 'active'
      }
    };
    const newModel = await ModelRegistry.registerOrUpdateModel(newModelData);

    res.json({ 
      code: 200, 
      message: `智能体已成功将模型 ${modelName} 注入系统并注册完毕！`, 
      data: newModel 
    });
  } catch (error: any) {
    res.status(500).json({ error: '模型代理注册失败: ' + error.message });
  }
};

// ==========================================
// 2.  模型函数计算 (高速调度网关 BFF)
// ==========================================
export const executeTableFormula = async (req: Request, res: Response) => {
  try {
    const { fileId, modelName, rawArgs } = req.body;
    
    // 兼容老代码接口
    let reqColumns: string[] = req.body.columns || [];
    let reqParams: Record<string, any> = req.body.params || {};

    let modelDefRaw = await ModelRegistry.findModelByName(modelName.toUpperCase());
    let modelDef: any;
    if (!modelDefRaw) {
        console.warn(`[BFF 警告] DB 未找到模型元数据: ${modelName}，将尝试直接穿透调度到底层引擎...`);
        // 构造一个虚拟的 modelDef，防止后面映射参数时报错
        modelDef = { parameters: [] } as any; 
    } else {
        modelDef = {
            parameters: modelDefRaw.parameters_schema?.parameters || [],
            requiredColumns: modelDefRaw.parameters_schema?.requiredColumns || []
        };
    }

    //    ：动态参数分类与路由 (保持原有优秀逻辑)
    if (rawArgs && Array.isArray(rawArgs)) {
        reqColumns = [];
        reqParams = {};
        
        rawArgs.forEach((arg: string, index: number) => {
            const numVal = Number(arg);
            const paramName = modelDef?.parameters?.[index]?.name || `param_${index}`;

            if (!isNaN(numVal) && arg.trim() !== '') {
                reqParams[paramName] = numVal;
            } else if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
                reqParams[paramName] = arg.slice(1, -1);
            } else {
                reqColumns.push(arg);
                reqParams[paramName] = arg;       //   2. 【新增这一行】：绑定参数键值对！
            }
        });
    }

    console.log(`[BFF调度层] 向底层空间引擎下发计算指令... 文件: ${fileId}, 模型: ${modelName}`);

    // ==========================================
    //   终极瘦身：彻底斩断 Node.js 的数据搬运！
    // ==========================================

    //   新增：合并前端传来的列（reqColumns）与模型注册时 AI 提取的必填列（requiredColumns）
    // 用 Set 去重，防止同一个列名传两遍
    const finalColumns = Array.from(new Set([
        ...reqColumns, 
        ...(modelDef?.requiredColumns || []) // 👈 从 MongoDB 里读出 AI 存下的列名
    ]));

    // 发送给 Python
    const response = await axios.post<PythonApiResponse>(`${PYTHON_API_URL}/models/execute`, {
      model_name: modelName,
      file_id: fileId,         
      columns: finalColumns,   //   将合并后的终极列名数组发给 Python 引擎
      parameters: reqParams    
    });

    // ==========================================
    //   接收轻量级结果与协同渲染
    // ==========================================
    // 此时 Python 已经在底层完成了“拉取 -> 计算 -> MongoDB 回写”的闭环！
    // Node.js 只需要拿到轻量级的绘图数据返回给前端即可。
    const { result_col_names, result_data, execution_time_ms } = response.data;

    console.log(`[BFF调度层] 底层引擎计算并落盘完毕，新增 ${result_col_names.length} 列，总耗时 ${execution_time_ms.toFixed(2)}ms`);

    // 直接返回给前端更新 UI
    res.json({ 
        code: 200, 
        resultColName: result_col_names, 
        resultData: result_data 
    });

  } catch (error: any) {
    console.error("模型执行错误:", error.response?.data || error.message);
    res.status(500).json({ error: '模型执行异常', details: error.response?.data?.detail || error.message });
  }
};


// 模型智能生成与元数据提取
export const createModelViaNaturalLanguage = async (req: Request, res: Response) => {
    try {
        const { userDescription } = req.body;

        if (!userDescription) {
            return res.status(400).json({ error: "需求描述不能为空" });
        }

        console.log(`[GeoAI Agent] 收到用户指令: ${userDescription}`);
        console.log(`[GeoAI Agent] 正在思考并提取模型特征...`);

        // 1. 唤醒大模型，返回结构化的 JSON 数据（包含名字、描述、参数、代码）
        const aiResult = await generateModelCodeFromAI(userDescription);
        
        //   关键 ：在这里解构出 parameters
        const { modelName, displayName, description, parameters, requiredColumns, pythonCode } = aiResult;

        console.log(`[GeoAI Agent] 思考完成！模型名: ${modelName}，提取到 ${parameters?.length || 0} 个参数。准备注入系统。`);

        // 2. 物理隔离写入 (存入 python_engine/models)
        const modelsDir = path.join(process.cwd(), '../python_engine/models');
        if (!fs.existsSync(modelsDir)) {
            fs.mkdirSync(modelsDir, { recursive: true });
        }
        
        const fileName = `${modelName.toLowerCase()}.py`;
        const filePath = path.join(modelsDir, fileName);
        fs.writeFileSync(filePath, pythonCode, 'utf8');

        const newModelData = {
            model_name: modelName.toUpperCase(),
            description: description,
            parameters_schema: {
                displayName,
                parameters: parameters || [],
                requiredColumns: requiredColumns || [],
                status: 'active'
            }
        };
        const newModel = await ModelRegistry.registerOrUpdateModel(newModelData);

        res.json({ 
            code: 200, 
            message: `🎉 成功！GeoAI 为您构建了 ${displayName} (${modelName})。`, 
            data: newModel,
            previewCode: pythonCode 
        });

    } catch (error: any) {
        console.error("大模型 Agent 执行失败:", error);
        res.status(500).json({ error: error.message || '系统内部异常' });
    }
};


// 数据透视API期望的返回类型
interface PivotApiResponse {
    status: string;
    data: any[]; // 一个包含字典的数组
}

// 绘图API期望的返回类型
interface ChartApiResponse {
    status: string;
    engine?: 'echarts' | 'html_iframe';
    html_string?: string;
    chart_option?: any;
}

// ==========================================
// 沙盒重跑：用户编辑代码后跳过 LLM 直接执行
// ==========================================
export const rerunPivotCode = async (req: Request, res: Response): Promise<void> => {
    try {
        // 🌟 1. 接收前端传来的 agentMode
        const { pythonCode, fileIds, blueprint, agentMode } = req.body;

        if (!pythonCode || !fileIds || fileIds.length === 0) {
            res.status(400).json({ error: "缺少 pythonCode 或 fileIds" });
            return;
        }

        console.log(`\n[Rerun] 收到用户手动修改后的代码，文件数: ${fileIds.length}`);
        console.log(`[Rerun] 管线模式: [${agentMode || 'pivot'}]，跳过 LLM 直接执行...`);

        // 🌟 2. 智能路由：根据 agentMode 决定去哪个沙盒
        let endpointUrl = (agentMode === 'feature_calc' || agentMode === 'pro_model') 
            ? `${PYTHON_API_URL}/models/feature_calc_only`
            : `${PYTHON_API_URL}/models/pivot_only`;

        // 调用 Python 执行（沙盒重跑）
        const rerunParams: Record<string, any> = {};
        if (blueprint?.parameters && Array.isArray(blueprint.parameters)) {
            blueprint.parameters.forEach((p: any) => {
                if (p.defaultValue !== undefined && p.defaultValue !== null && p.defaultValue !== '') {
                    rerunParams[p.name] = p.defaultValue;
                }
            });
        }
        const sandboxResponse = await axios.post<any>(endpointUrl, {
            python_code: pythonCode,
            file_ids: fileIds,
            parameters: rerunParams   // ✅ 防御 parameters['key'] 模式
        });

        const aggregatedData = sandboxResponse.data.data;
        if (!aggregatedData || aggregatedData.length === 0) {
            throw new Error("执行结果为空，请检查代码逻辑或数据是否匹配");
        }
        console.log(`[Rerun] 沙盒执行成功！共 ${aggregatedData.length} 条记录。`);

        // ========================================================
        // 🌟 3. 分支 A：如果是【特征计算】，需要回写数据库，不需要画图
        // ========================================================
        if (agentMode === 'feature_calc') {
            console.log(`[Rerun] 正在将重新计算的特征同步回写至数据库...`);
            
            // 找到主目标图层ID，如果没有 blueprint 就取第一个 fileId
            const fallbackTargetFileId = blueprint?.data_dependencies?.find((d: any) => d.role.includes('Target'))?.file_id || fileIds[0];
            
            // 找出新生成的列名（排除掉 id）
            const newCols = Object.keys(aggregatedData[0] || {}).filter(
                k => k !== 'id' && k !== 'rowKey' && k !== '__record_id__'
            );

            // 执行数据库同步
            const updateRows = aggregatedData
                .filter((row: any) => row.id)
                .map((row: any) => {
                    const { id, rowKey, __record_id__, ...newProps } = row;
                    return { id, patch: newProps };
                });
            const { targetFileId, matchedCount } = await resolveFeatureCalcWriteTarget(
                [
                    ...(blueprint?.data_dependencies || []).map((d: any) => d?.file_id),
                    ...(fileIds || []),
                ],
                updateRows,
                fallbackTargetFileId
            );
            console.log(`[Rerun] 自动匹配写回目标图层: ${targetFileId} (${matchedCount}/${updateRows.length})`);
            const updatedCount = await Feature.updateFeaturePropertiesBatch(targetFileId, updateRows);
            console.log(`[Rerun] 批量同步完成: ${updatedCount} / ${updateRows.length}`);

            // 🌟 3. 返回一个特殊的 'refreshSchema' 标志位，告诉前端去刷新文件属性
            res.json({
                code: 200,
                tableData: aggregatedData,
                engine: null,
                refreshSchema: true, // 关键：通知前端
                targetFileId: targetFileId,
                message: `特征重算成功！[${newCols.join(', ')}] 已持久化至数据库。`,
                pythonCode,
                agentMode,
                sourceFileIds: fileIds
            });
            return; 
        }

        // ========================================================
        // 🌟 4. 分支 B：如果是默认的【数据透视】，走你原来的绘图流程
        // ========================================================
        let engine: string | undefined;
        let html_string: string | undefined;
        let chart_option: any;
        const clientTableData = blueprint?.task_type === 'landslide_sensitivity_map'
            ? buildLandslideSensitivityMapPreviewRows(aggregatedData)
            : aggregatedData;

        // 如果图表引擎是 echarts，其实可以直接复用原有图表类型，跳过 LLM
        if (blueprint && blueprint.visualization_spec?.engine === 'echarts') {
             console.log(`[Rerun] 命中 Echarts，将数据返回给前端 TS 引擎渲染`);
             engine = 'echarts';
             // AI Chart Type 可以从 blueprint 获取
        } 
        else if (blueprint) {
            console.log(`[Rerun] 正在生成 HTML 渲染图表...`);
            const chartCode = blueprint.task_type === 'landslide_sensitivity_map'
                ? buildLandslideSensitivityMapChartCode()
                : await generateChartCode(blueprint, aggregatedData.slice(0, 3));
            const chartResponse = await axios.post<any>(`${PYTHON_API_URL}/models/chart_only`, {
                python_code: CHART_SDK_INJECTION + "\n\n" + chartCode,
                data: aggregatedData
            }, {
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            } as any);
            engine = chartResponse.data.engine;
            html_string = chartResponse.data.html_string;
            chart_option = chartResponse.data.chart_option;
            console.log(`[Rerun] 图表渲染完成，引擎: ${engine}`);
        }

        res.json({
            code: 200,
            tableData: clientTableData,
            engine,
            aiChartType: blueprint?.visualization_spec?.chart_type?.toLowerCase(),
            chartHtml: html_string,
            chartOption: chart_option,
            agentMode,
            sourceFileIds: fileIds,
            pythonCode // 回传修改后的代码
        });

    } catch (error: any) {
        const details = error.response?.data?.detail || error.response?.data?.details || error.message;
        console.error("[Rerun错误]", details);
        res.status(500).json({ error: '重跑失败', details });
    }
};

// 多节点进行可扩展的透视和绘图
export const executeDynamicPipeline = async (req: Request, res: Response): Promise<void> => {
    let blueprint: any = null;
    let pythonCode: string = ""; 

    // 🌟 开启流式传输
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    const emitStep = (msg: string) => {
        res.write(JSON.stringify({ type: 'step', message: msg }) + '\n');
    };

    try {
        const {
            userPrompt,
            fileIds,
            context,
            agentMode = 'pivot',
        }: {
            userPrompt: string;
            fileIds?: string[];
            context?: PipelineContextMemory;
            agentMode?: AgentMode;
        } = req.body;

        const contextSourceFileIds = uniqueStrings(context?.lastResultMeta?.sourceFileIds || []);
        const requestedFileIds = uniqueStrings(fileIds || []);
        const resolvedFileIds = uniqueStrings([...requestedFileIds, ...contextSourceFileIds]);

        if (!userPrompt || resolvedFileIds.length === 0) {
            res.write(JSON.stringify({ type: 'error', data: { error: "缺少用户需求或未选择任何文件" } }) + '\n');
            res.end();
            return;
        }

        console.log(`\n======================================================`);
        console.log(`[Pipeline] 分析文件数: ${resolvedFileIds.length}`);
        console.log(`[Pipeline] 用户意图: "${userPrompt}"`);
        console.log(`[Pipeline] 当前工作模式: [${agentMode}]`);

        // 1 意图拆解节点
        console.log(`[Pipeline] 节点1正在拆解意图...`);
        emitStep('正在读取数据结构并识别自然语言意图...');
        
        const availableFiles = [];
        for (const fId of resolvedFileIds) {
            const schema = await Feature.getFileSchemaSummary(fId);
            availableFiles.push(schema);
        }

        const parkAccessibilitySpec = inferParkAccessibilitySpecFromPrompt(userPrompt, availableFiles);
        if (parkAccessibilitySpec) {
            console.log(`[Pipeline] 命中【公园可达性】确定性算子，直接计算网格得分并聚合到街道...`);
            emitStep('识别为公园可达性计算任务，正在执行“距离反向标准化 + 街道聚合”确定性算子...');

            blueprint = {
                task_type: 'park_accessibility_score',
                data_dependencies: [
                    {
                        file_id: parkAccessibilitySpec.gridFileId,
                        role: 'TargetGridLayer',
                        description: '包含距公园距离字段的网格面图层',
                        type: 'Vector',
                    },
                    {
                        file_id: parkAccessibilitySpec.streetFileId,
                        role: 'TargetStreetLayer',
                        description: '用于承接街道尺度公园可达性得分的街道面图层',
                        type: 'Vector',
                    },
                ],
                parameters: [
                    { name: 'distanceField', defaultValue: parkAccessibilitySpec.distanceField },
                    { name: 'streetNameField', defaultValue: parkAccessibilitySpec.streetNameField || null },
                    { name: 'normalizationMethod', defaultValue: parkAccessibilitySpec.normalizationMethod || 'linear_reverse' },
                    { name: 'gridScoreFieldName', defaultValue: parkAccessibilitySpec.gridScoreFieldName || '公园可达性得分' },
                    { name: 'streetScoreFieldName', defaultValue: parkAccessibilitySpec.streetScoreFieldName || '公园可达性得分' },
                ],
                visualization_spec: {
                    engine: 'echarts',
                    chart_type: 'bar',
                    dimensions: [parkAccessibilitySpec.streetNameField || 'id'],
                    metrics: [parkAccessibilitySpec.streetScoreFieldName || '公园可达性得分'],
                },
                explanation: `识别为公园可达性计算任务：基于网格字段 ${parkAccessibilitySpec.distanceField} 进行距离反向标准化，生成网格公园可达性得分，并按街道单元求平均聚合，回写街道尺度公园可达性得分。`,
            } as any;

            const result = await executeParkAccessibilityOperator(parkAccessibilitySpec);
            emitStep(`公园可达性计算完成：已更新 ${result.gridUpdatedCount} 个网格与 ${result.streetUpdatedCount} 个街道要素。`);
            res.write(JSON.stringify({
                type: 'result',
                data: {
                    code: 200,
                    blueprint,
                    tableData: result.streetRows,
                    engine: 'echarts',
                    aiChartType: 'bar',
                    chartHtml: null,
                    chartOption: null,
                    pythonCode: null,
                    agentMode,
                    sourceFileIds: resolvedFileIds,
                    refreshSchema: true,
                    targetFileId: result.streetFileId,
                    newFileId: result.resultFileId,
                    resultFileName: result.resultFileName,
                    summary: { ...(result.summary || {}), gridUpdatedCount: result.gridUpdatedCount, streetUpdatedCount: result.streetUpdatedCount },
                    message: `公园可达性计算完成，已将 [${result.gridScoreFieldName}] 回写至网格图层，并将 [${result.streetScoreFieldName}] 聚合回写至街道图层，同时导出结果文件 [${result.resultFileName}]`,
                }
            }) + '\n');
            res.end();
            return;
        }

        const spatialAutocorrSpec = inferSpatialAutocorrelationSpecFromPrompt(userPrompt, availableFiles);
        if (spatialAutocorrSpec) {
            console.log(`[Pipeline] 命中【空间自相关】确定性算子，直接计算全局 Moran's I 与局部 LISA...`);
            emitStep('识别为空间自相关分析任务，正在调用 Moran\'s I / LISA 确定性算子...');

            blueprint = {
                task_type: 'spatial_autocorrelation',
                data_dependencies: [
                    {
                        file_id: spatialAutocorrSpec.targetFileId,
                        role: 'TargetLayer',
                        description: '用于空间自相关分析的街道面图层',
                        type: 'Vector',
                    },
                ],
                parameters: [
                    { name: 'valueField', defaultValue: spatialAutocorrSpec.valueField },
                    { name: 'nameField', defaultValue: spatialAutocorrSpec.nameField || null },
                    { name: 'contiguity', defaultValue: spatialAutocorrSpec.contiguity || 'queen' },
                    { name: 'permutations', defaultValue: spatialAutocorrSpec.permutations || 199 },
                    { name: 'significanceLevel', defaultValue: spatialAutocorrSpec.significanceLevel || 0.05 },
                    { name: 'clusterFieldName', defaultValue: spatialAutocorrSpec.clusterFieldName },
                    { name: 'hotspotFieldName', defaultValue: spatialAutocorrSpec.hotspotFieldName },
                ],
                visualization_spec: {
                    engine: 'html_iframe',
                    chart_type: 'thematic_map',
                    chart_library: 'folium',
                    dimensions: [spatialAutocorrSpec.valueField],
                    metrics: [spatialAutocorrSpec.clusterFieldName || 'LISA_Cluster'],
                },
                explanation: `识别为空间自相关分析任务：对字段 ${spatialAutocorrSpec.valueField} 计算全局 Moran's I 与局部 LISA，识别高-高聚集、低-低聚集及空间异常街道，并将聚类标签回写到目标街道图层。`,
            } as any;

            const result = await executeSpatialAutocorrelationOperator(spatialAutocorrSpec);
            emitStep(`空间自相关计算完成：Moran's I=${result.summary?.global_moran_i ?? 'N/A'}，p=${result.summary?.global_p_value ?? 'N/A'}。`);

            let engine: 'echarts' | 'html_iframe' | null = null;
            let chartHtml: string | null = null;
            let chartOption: any = null;
            if (Array.isArray(result.mapPayload) && result.mapPayload.length > 0) {
                try {
                    const chartResponse = await axios.post<any>(`${PYTHON_API_URL}/models/chart_only`, {
                        python_code: CHART_SDK_INJECTION + "\n\n" + buildSpatialAutocorrelationMapChartCode(),
                        data: result.mapPayload,
                    });
                    engine = chartResponse.data?.engine || null;
                    chartHtml = chartResponse.data?.html_string || null;
                    chartOption = chartResponse.data?.chart_option || null;
                } catch (chartError: any) {
                    const chartDetails = chartError.response?.data?.detail || chartError.message;
                    console.error('[Spatial Autocorrelation Map Error]', chartDetails);
                    emitStep('聚类专题图生成失败，已保留数值结果与回写字段。');
                }
            }

            res.write(JSON.stringify({
                type: 'result',
                data: {
                    code: 200,
                    blueprint,
                    tableData: buildSpatialAutocorrelationPreviewRows(result),
                    engine,
                    aiChartType: null,
                    chartHtml,
                    chartOption,
                    pythonCode: null,
                    agentMode,
                    sourceFileIds: resolvedFileIds,
                    refreshSchema: true,
                    targetFileId: result.targetFileId,
                    newFileId: result.resultFileId,
                    resultFileName: result.resultFileName,
                    valueField: result.valueField,
                    clusterFieldName: result.clusterFieldName,
                    hotspotFieldName: result.hotspotFieldName,
                    summary: { ...(result.summary || {}), updatedCount: result.updatedCount },
                    message: `空间自相关分析完成，已将 [${result.clusterFieldName}, ${result.hotspotFieldName}] 等字段回写至目标图层，并导出结果文件 [${result.resultFileName}]`,
                }
            }) + '\n');
            res.end();
            return;
        }

        const sensitivityMapBlueprint = buildSensitivitySpatialMapBlueprint(userPrompt, availableFiles, context);
        if (sensitivityMapBlueprint) {
            blueprint = sensitivityMapBlueprint;
            emitStep('识别为滑坡敏感性专题地图任务，已切换到确定性专题制图通道');
        }

        const sensitivitySpec = !sensitivityMapBlueprint && agentMode === 'pro_model'
            ? inferSensitivitySpecFromPrompt(userPrompt, availableFiles)
            : null;
        if (sensitivitySpec) {
            console.log(`[Pipeline] 命中【专业模型-综合评分】确定性算子，跳过 LLM 代码生成，直接计算并回写评分字段...`);
            emitStep(`识别为“q值归一化为权重 + 综合评分”任务，正在调用综合评分算子...`);

            blueprint = {
                task_type: 'landslide_sensitivity_score',
                data_dependencies: [
                    {
                        file_id: sensitivitySpec.targetFileId,
                        role: 'TargetLayer',
                        description: '用于滑坡敏感性综合评分的目标网格图层',
                        type: 'Vector',
                    },
                ],
                parameters: [
                    { name: 'yField', defaultValue: sensitivitySpec.yField },
                    { name: 'factorFields', defaultValue: sensitivitySpec.factorFields },
                    { name: 'scoreFieldName', defaultValue: sensitivitySpec.scoreFieldName },
                    { name: 'levelFieldName', defaultValue: sensitivitySpec.levelFieldName },
                    { name: 'levelCount', defaultValue: sensitivitySpec.levelCount },
                ],
                visualization_spec: {
                    engine: 'echarts',
                    chart_type: 'bar',
                    dimensions: ['因子字段'],
                    metrics: ['权重'],
                },
                explanation: `识别为滑坡敏感性综合评分任务：以 ${sensitivitySpec.yField} 为因变量，对 ${sensitivitySpec.factorFields.join('、')} 做因子探测，将 q 值归一化为权重，并把评分字段回写到目标网格图层。`,
            };

            const result = await executeSensitivityScoreOperator(sensitivitySpec);
            emitStep(`综合评分回写完成，并已生成 q 值权重文件`);
            res.write(JSON.stringify({
                type: 'result',
                data: {
                    code: 200,
                    blueprint,
                    tableData: result.weightRows,
                    engine: 'echarts',
                    aiChartType: 'bar',
                    chartHtml: null,
                    chartOption: null,
                    pythonCode: null,
                    agentMode,
                    sourceFileIds: resolvedFileIds,
                    refreshSchema: true,
                    targetFileId: result.targetFileId,
                    newFileId: result.weightFileId,
                    weightFileName: result.weightFileName,
                    scoreFieldName: result.scoreFieldName,
                    levelFieldName: result.levelFieldName,
                    factorFields: result.factorFields,
                    yField: result.yField,
                    summary: { ...(result.summary || {}), updatedCount: result.updatedCount },
                    message: `综合评分计算完成，已将 [${result.scoreFieldName}, ${result.levelFieldName}] 回写至目标图层，并导出权重结果文件 [${result.weightFileName}]`
                }
            }) + '\n');
            res.end();
            return;
        }

        const followupBlueprint = !sensitivityMapBlueprint && agentMode === 'pro_model'
            ? buildFollowupPivotBlueprint(userPrompt, resolvedFileIds, context)
            : null;
        const effectiveAgentMode = followupBlueprint
            ? resolveExecutionMode(agentMode, followupBlueprint)
            : agentMode;
        blueprint = blueprint || followupBlueprint || await planWorkflow(userPrompt, availableFiles, context, agentMode);
        if (followupBlueprint) {
            emitStep('识别为基于上一轮交互分析结果的连续追问，已自动提取最高交互因子并转为二维透视任务');
        }
        console.log(`[Pipeline] 拆解意图完成:`, blueprint.explanation);
        emitStep('意图拆解分析完成');
        emitStep(`意图解析\n${blueprint.explanation || '已成功建立空间计算逻辑链'}`);
        // 2 节点生成代码
        if (effectiveAgentMode !== agentMode) {
            emitStep(`执行路由已从 ${agentMode} 自动切换为 ${effectiveAgentMode}`);
        }

        let rawCode = "";
        let endpointUrl = "";
        let specialResultType: string | null = null;
        let specialScoreRows: any[] = [];
        let specialWeightRows: any[] = [];
        let specialSummary: any = null;

        if (effectiveAgentMode === 'feature_calc') {
            console.log(`[Pipeline] 命中【特征计算】专属管线，节点2正在编写特征计算代码...`);
            emitStep('命中【特征计算】管线，正在生成空间算子代码...');
            rawCode = await generateFeatureCalcCode(blueprint, resolvedFileIds);
            pythonCode = FEATURE_CALC_SDK_INJECTION + "\n\n" + rawCode;
            endpointUrl = `${PYTHON_API_URL}/models/feature_calc_only`;
        }
        else if (effectiveAgentMode === 'pro_model') {
            console.log(`[Pipeline] 命中【专业模型】专属管线，正在构建底层模型调用代码...`);
            emitStep('命中【专业模型】管线，正在构建底层调度逻辑...');
            rawCode = await generateProModelCode(blueprint, availableFiles);
            pythonCode = PRO_MODEL_SDK_INJECTION + "\n\n" + rawCode;
            endpointUrl = `${PYTHON_API_URL}/models/feature_calc_only`; 
        } 
        else {
            console.log(`[Pipeline] 命中【数据透视】原有管线...`);
            if (blueprint.reuse_code && context?.lastPythonCode) {
                console.log(`[Pipeline] 检测到意图为图表切换/追问，直接复用上一轮数据抽取代码。`);
                emitStep('识别为连续追问，直接复用上一轮数据抽取代码');
                rawCode = context.lastPythonCode;
                pythonCode = PYTHON_SDK_INJECTION + "\n\n" + rawCode;
            } else {
                console.log(`[Pipeline] 节点2正在编写透视代码...`);
                emitStep('命中【数据透视】管线，正在分配空间统计算子...');

                // 精准提取大模型输出的 6 大透视参数
                const targetDesc = blueprint.data_dependencies?.find((d: any) => d.role === 'TargetLayer' || d.role === 'Target')?.description || '主计算图层';
                const spatialPred = blueprint.spatial_predicate || 'None';
                const rowDim = blueprint.visualization_spec?.dimensions?.[0] || 'None';
                const colDim = blueprint.visualization_spec?.dimensions?.[1] || 'None';
                
                let pivotMethod = 'size';
                let pivotField = 'None';
                const rawMetric = blueprint.visualization_spec?.metrics?.[0]; 
                if (rawMetric && rawMetric !== 'count') {
                    // 如果大模型返回了如 sum(area) 这样的格式，拆解它
                    if (rawMetric.includes('(') && rawMetric.includes(')')) {
                        pivotMethod = rawMetric.split('(')[0];
                        pivotField = rawMetric.substring(rawMetric.indexOf('(')+1, rawMetric.indexOf(')'));
                    } else {
                        pivotMethod = rawMetric;
                        pivotField = 'Value'; // 兜底
                    }
                }

                // 使用特殊的 ' : ' 分隔符，方便前端切分渲染成精美的表格
                let pivotDetails = `【数据透视参数映射】\n`;
                pivotDetails += `• 透视对象(Target) : ${targetDesc}\n`;
                pivotDetails += `• 空间约束 : ${spatialPred}\n`;
                pivotDetails += `• 行维度(Row) : ${rowDim}\n`;
                pivotDetails += `• 列维度(Col) : ${colDim}\n`;
                pivotDetails += `• 透视方法 : ${pivotMethod}\n`;
                pivotDetails += `• 透视字段 : ${pivotField}`;
                
                emitStep(pivotDetails);

                rawCode = blueprint.task_type === 'landslide_sensitivity_map'
                    ? buildLandslideSensitivityMapPivotCode(blueprint)
                    : await generatePivotCode(blueprint, availableFiles);
                pythonCode = PYTHON_SDK_INJECTION + "\n\n" + rawCode;
            }
            endpointUrl = `${PYTHON_API_URL}/models/pivot_only`;
        }

        // 3 Python执行 (带自愈修复环)
        let aggregatedData: any = null;
        let validIds: any[] = []; // 🌟 【新增】：用于接收并暂存后端的有效网格 ID
        specialResultType = null;
        specialScoreRows = [];
        specialWeightRows = [];
        specialSummary = null;
        let lastErrorDetails = "";
        const MAX_RETRIES = 2;
        let retries = 0;

        // ======================================================
        // 从 Blueprint 提取 parameters，传入沙盒（防止 LLM 偶尔用 parameters 读值）
        // ======================================================
        const sandboxParameters: Record<string, any> = {};
        if (blueprint?.parameters && Array.isArray(blueprint.parameters)) {
            blueprint.parameters.forEach((p: any) => {
                if (p.defaultValue !== undefined && p.defaultValue !== null && p.defaultValue !== '') {
                    sandboxParameters[p.name] = p.defaultValue;
                }
            });
        }
        // 从可用文件 Schema 自动注入常见的多列参数（如 POI 列、Count 列等）
        for (const fileSchema of availableFiles) {
            if (fileSchema.columns && Array.isArray(fileSchema.columns)) {
                const poiCols = fileSchema.columns.filter((c: string) =>
                    /^count_/i.test(c) || /^poi_/i.test(c)
                );
                if (poiCols.length > 0 && !sandboxParameters['poi_columns']) {
                    sandboxParameters['poi_columns'] = poiCols;
                }
            }
        }

        console.log(`\n======================python代码================================`);
        console.log(pythonCode);
        console.log(`======================python代码================================\n`);

        let calculationSucceeded = false;
        while (retries <= MAX_RETRIES) {
            try {
                console.log(`[Pipeline] 节点3正在执行沙盒运算... (尝试 ${retries + 1}/${MAX_RETRIES + 1})`);
                emitStep(`开始执行Python计算... (尝试 ${retries + 1}/${MAX_RETRIES + 1})`);
                
                const sandboxResponse = await axios.post<any>(endpointUrl, {
                    python_code: pythonCode,
                    file_ids: resolvedFileIds,
                    parameters: sandboxParameters   // ✅ 传入参数，防御 parameters['key'] 模式
                });
                
                const returnedData = sandboxResponse.data.data;
                if (!Array.isArray(returnedData)) throw new Error("计算引擎返回了无效的结果格式");
                aggregatedData = returnedData;
                specialResultType = sandboxResponse.data.result_type || null;
                specialScoreRows = Array.isArray(sandboxResponse.data.score_rows) ? sandboxResponse.data.score_rows : [];
                specialWeightRows = Array.isArray(sandboxResponse.data.weight_rows) ? sandboxResponse.data.weight_rows : [];
                specialSummary = sandboxResponse.data.summary || null;
                validIds = sandboxResponse.data.valid_ids || []; // 🌟 【核心提取】：捕获 Python 传过来的巴中市网格 ID！
             
                if (!aggregatedData || aggregatedData.length === 0) {
                    throw new Error("计算结果为空，请检查需求或数据是否匹配");
                }
                calculationSucceeded = true;
                console.log(`[Pipeline] 沙盒计算成功，返回 ${aggregatedData.length} 条记录`);
                emitStep(`计算成功，返回 ${aggregatedData.length} 条记录`);
                break; 
            } catch (err: any) {
                lastErrorDetails = err.response?.data?.detail || err.message;
                console.error(`\n[Pipeline 容错捕捉] 沙盒执行引发异常: ${lastErrorDetails}`);

                if (retries >= MAX_RETRIES) break;
                
                retries++;
                console.log(`[Pipeline] 节点发觉错误，启动自愈修复环 (第 ${retries} 次重试)...`);
                emitStep(`捕捉到执行异常，启动自动修复 (第 ${retries} 次)...`);
                try {
                    if (effectiveAgentMode === 'feature_calc') {
                        rawCode = await fixFeatureCalcCode(blueprint, rawCode, lastErrorDetails);
                        pythonCode = FEATURE_CALC_SDK_INJECTION + "\n\n" + rawCode;
                    } else if (effectiveAgentMode === 'pro_model') {
                        rawCode = await fixProModelCode(blueprint, rawCode, lastErrorDetails);
                        pythonCode = PRO_MODEL_SDK_INJECTION + "\n\n" + rawCode;
                    } else {
                        rawCode = await fixPivotCode(blueprint, rawCode, lastErrorDetails);
                        pythonCode = PYTHON_SDK_INJECTION + "\n\n" + rawCode;
                    }
                    console.log(`[Pipeline] FixerAgent 自愈重写完成，准备再次向沙盒投入代码...`);
                } catch (fixErr) { break; }
            }
        }

        // 终局判定：如果重试已耗尽且依旧没有数据，走优雅降级方案
        if (!calculationSucceeded) {
            console.log(`======================================================\n`);
            res.write(JSON.stringify({
                type: 'result',
                data: {
                    status: "failed",
                    error_message: "AI 多次尝试修复代码失败，已切换至人工接管模式。",
                    traceback: lastErrorDetails,
                    pythonCode: pythonCode,
                    agentMode: effectiveAgentMode,
                    sourceFileIds: resolvedFileIds
                }
            }) + '\n');
            res.end();
            return;
        }

        if (effectiveAgentMode === 'pro_model' && specialResultType === 'sensitivity_score') {
            console.log(`[Pipeline] Pro model returned sensitivity_score; writing scores back and exporting q weights...`);
            emitStep(`专业模型已返回综合评分结果，正在回写图层并导出权重文件...`);

            const targetFileId = blueprint.data_dependencies?.find((d: any) => typeof d.role === 'string' && d.role.includes('Target'))?.file_id || resolvedFileIds[0];
            const updateRows = specialScoreRows
                .filter((row: any) => row.id !== undefined && row.id !== null)
                .map((row: any) => {
                    const { id, ...newProps } = row;
                    return { id, patch: newProps };
                });

            if (updateRows.length === 0) {
                throw new Error('综合评分结果缺少可回写的 id 字段，无法更新目标图层');
            }

            const updatedCount = await Feature.updateFeaturePropertiesBatch(targetFileId, updateRows);

            const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            const newFileName = `landslide_q_weights_${timestamp}.csv`;
            const savedNode = await persistTabularRowsAsCsv(specialWeightRows, newFileName);

            emitStep(`综合评分回写完成，并已生成 q 值权重文件`);
            res.write(JSON.stringify({
                type: 'result',
                data: {
                    code: 200,
                    blueprint,
                    tableData: specialWeightRows,
                    engine: 'echarts',
                    aiChartType: 'bar',
                    chartHtml: null,
                    chartOption: null,
                    pythonCode,
                    agentMode: effectiveAgentMode,
                    sourceFileIds: resolvedFileIds,
                    refreshSchema: true,
                    targetFileId,
                    newFileId: savedNode.id,
                    weightFileName: newFileName,
                    summary: { ...(specialSummary || {}), updatedCount },
                    message: `综合评分计算完成，已回写目标图层评分字段，并导出权重结果文件 [${newFileName}]`
                }
            }) + '\n');
            res.end();
            return;
        }

        if (effectiveAgentMode === 'feature_calc') {
            console.log(`[Pipeline] 特征计算完成，正在将结果同步更新回原始数据层...`);
            emitStep(`特征计算完成，正在将结果同步...`);
            const fallbackTargetFileId = blueprint.data_dependencies?.find((d: any) => d.role.includes('Target'))?.file_id || resolvedFileIds[0];
            const newCols = Object.keys(aggregatedData[0] || {}).filter(
                k => k !== 'id' && k !== 'rowKey' && k !== '__record_id__'
            );

            console.log(`[Pipeline] 准备同步 ${aggregatedData.length} 条记录，采用分批并发策略...`);
            console.log(`[Pipeline] 准备同步 ${aggregatedData.length} 条记录，采用批量 SQL 写回策略...`);
            const updateRows = aggregatedData
                .filter((row: any) => row.id)
                .map((row: any) => {
                    const { id, rowKey, __record_id__, ...newProps } = row;
                    return { id, patch: newProps };
                });
            const { targetFileId, matchedCount } = await resolveFeatureCalcWriteTarget(
                [
                    ...(blueprint.data_dependencies || []).map((d: any) => d?.file_id),
                    ...resolvedFileIds,
                ],
                updateRows,
                fallbackTargetFileId
            );
            console.log(`[Pipeline] 自动匹配写回目标图层: ${targetFileId} (${matchedCount}/${updateRows.length})`);
            const updatedCount = await Feature.updateFeaturePropertiesBatch(targetFileId, updateRows);
            console.log(`[Pipeline] 数据库批量同步完成: ${updatedCount} / ${updateRows.length}`);
            console.log(`======================================================\n`);
            emitStep(`同步完成`);
            res.write(JSON.stringify({
                type: 'result',
                data: {
                    code: 200, blueprint: blueprint, tableData: aggregatedData, engine: null,
                    message: ` 计算成功！已将新特征 [${newCols.join(', ')}] 同步至要素。`,
                    pythonCode: pythonCode
                }
            }) + '\n');
            res.end();
            return; 
        }

        if (effectiveAgentMode === 'pro_model') {
            console.log(`[Pipeline] 专业模型计算完成，正在将结果导出为物理文件并挂载到文件树...`);
            emitStep(`模型计算完成，正在将结果导出为物理文件...`);
            
            const csvString = '\uFEFF' + Papa.unparse(aggregatedData);
            const modelName = blueprint.task_type || 'Model_Result';
            const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            const newFileName = `${modelName}_${timestamp}.csv`;
            const uploadDir = path.join(process.cwd(), 'uploads');
            const newFilePath = path.join(uploadDir, newFileName);
            
            await fs.promises.writeFile(newFilePath, csvString, 'utf8');
            
            const fileNodeObj = FileNode.createFileNodeObject({
                name: newFileName, type: 'file', parent_id: null, path: newFilePath,
                size: Buffer.byteLength(csvString, 'utf8'), extension: '.csv', mime_type: 'text/csv'
            });
            const savedNode = await FileNode.insertFileNode(fileNodeObj);
            
            if (aggregatedData && aggregatedData.length > 0) {
                console.log(`[Pipeline] 正在将模型结果行写入 spatial_features 表，以供前端表格渲染...`);
                const featuresToInsert = aggregatedData.map((row: any, index: number) => {
                    return {
                        fileId: savedNode.id, type: 'Feature', geometry: null,
                        properties: { id: `model_res_${Date.now()}_${index}`, ...row }
                    };
                });
                await Feature.insertFeaturesBatch(savedNode.id, featuresToInsert);
            }

            const aiChartType = blueprint.visualization_spec?.chart_type?.toLowerCase() || null;

            console.log(`======================================================\n`);
            emitStep(`文件导出成功，正在渲染图表...`);
            res.write(JSON.stringify({
                type: 'result',
                data: {
                    code: 200, blueprint: blueprint, tableData: aggregatedData, 
                    engine: aiChartType ? 'echarts' : null, aiChartType: aiChartType,
                    message: ` 模型执行成功！分析结果已自动保存为文件：[${newFileName}]`,
                    newFileId: savedNode.id, pythonCode: pythonCode,
                    agentMode: effectiveAgentMode,
                    sourceFileIds: resolvedFileIds
                }
            }) + '\n');
            res.end();
            return;
        }

        // 4 绘图代码/元数据生成节点
        console.log(`[Pipeline] 节点4正在构建图表配置/代码...`);
        emitStep(`开始构建图表渲染配置...`);
        let chartCodeOrMetadata = "";
        let chartResponseData: any = null;
        let chartErrorDetails = "";
        const clientTableData = blueprint.task_type === 'landslide_sensitivity_map'
            ? buildLandslideSensitivityMapPreviewRows(aggregatedData)
            : aggregatedData;

        if (blueprint.visualization_spec.engine === 'echarts') {
            console.log(`[Pipeline] 命中 ECharts 路由，【跳过】绘图代码生成，直接触发前端 TS 引擎接管渲染...`);
            emitStep(`命中原生 ECharts 引擎，直接渲染`);
            try {
                const aiChartType = blueprint.visualization_spec.chart_type?.toLowerCase() || 'bar';
                chartResponseData = {
                    engine: 'echarts', ai_chart_type: aiChartType, chart_option: null, html_string: ""
                };
                console.log(`[Pipeline] TS 模板引擎渲染 ECharts 成功！`);
            } catch (err: any) {
                console.error("[Pipeline] ECharts 元数据解析失败，可能是 AI 输出了非 JSON 格式:", err.message);
                chartErrorDetails = "AI 未能生成正确的图表配置元数据 (JSON 解析失败)。";
            }
        } 
        else {
            console.log(`[Pipeline] 命中 html_iframe 路由，进入 Node 4 呼叫 AI 编写 Plotly/Folium 制图代码...`);
            emitStep(`命中 HTML 渲染引擎，正在编写制图代码...`);
            chartCodeOrMetadata = blueprint.task_type === 'landslide_sensitivity_map'
                ? buildLandslideSensitivityMapChartCode()
                : await generateChartCode(blueprint, aggregatedData.slice(0, 5));

            const MAX_RETRIES = 2;
            let chartRetries = 0;

            while (chartRetries <= MAX_RETRIES) {
                try {
                    const chartResponse = await axios.post(`${PYTHON_API_URL}/models/chart_only`, {
                        python_code: CHART_SDK_INJECTION + "\n\n" + chartCodeOrMetadata, data: aggregatedData
                    }, {
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity,
                    } as any);
                    chartResponseData = chartResponse.data;
                    console.log(`[Pipeline] 图表渲染成功，渲染引擎: ${chartResponseData.engine}。`);
                    break;
                } catch (err: any) {
                    chartErrorDetails = err.response?.data?.detail || err.response?.data?.details || err.message;
                    chartRetries++;
                    if (chartRetries > MAX_RETRIES) break;
                    
                    try {
                        console.log(`[Pipeline] 呼叫 FixerAgent 进行图表代码自愈 (第 ${chartRetries} 次重试)...`);
                        emitStep(`绘图失败，启动修复 (第 ${chartRetries} 次)...`);
                        chartCodeOrMetadata = await fixChartCode(blueprint, chartCodeOrMetadata, chartErrorDetails);
                    } catch (fixErr) { break; }
                }
            }
        }

        // 终局判定
        if (!chartResponseData) {
            console.log(`======================================================\n`);
            res.write(JSON.stringify({
                type: 'result',
                data: {
                    status: "failed", error_message: "图表渲染模块崩溃，已至人工模式",
                    traceback: chartErrorDetails, pythonCode: chartCodeOrMetadata
                }
            }) + '\n');
            res.end();
            return;
        }

        const { engine, html_string, chart_option } = chartResponseData;
        console.log(`[Pipeline] 全部执行成功，最终渲染引擎: ${engine}。`);
        console.log(`======================================================\n`);
        emitStep(`所有任务执行完毕！`);

        res.write(JSON.stringify({
            type: 'result',
            data: {
                code: 200, blueprint: blueprint, tableData: clientTableData,
                validIds: validIds, // 🌟 【完美闭环】：将 ID 塞进流式通道，发给前端的 GeoAIAgent！
                engine: engine, aiChartType: chartResponseData?.ai_chart_type,
                chartHtml: html_string, chartOption: chart_option, pythonCode: pythonCode,
                agentMode: effectiveAgentMode,
                sourceFileIds: resolvedFileIds
            }
        }) + '\n');
        res.end();

    } catch (error: any) {
        const details = error.response?.data?.detail || error.response?.data?.details || error.message;
        console.error("\n[Pipeline错误]", details);
        res.write(JSON.stringify({ 
            type: 'error', 
            data: { error: '执行失败', details: details, blueprint: blueprint, pythonCode: pythonCode || null }
        }) + '\n');
        res.end();
    }
};
