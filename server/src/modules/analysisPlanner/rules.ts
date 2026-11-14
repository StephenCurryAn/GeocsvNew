import type { DatasetSummary } from '../spatialPivot/datasets';
import { SPATIAL_PIVOT_OPERATOR, type SpatialPivotSpec } from '../spatialPivot/plan';
import { clarification, type AnalysisView, type NaturalPlan } from './types';

const charts = [
  { chartType: 'bar' as const, pattern: /柱状图|柱形图|条形图|\bbar(?: chart)?\b/gi },
  { chartType: 'line' as const, pattern: /折线图|\bline chart\b/gi },
  { chartType: 'pie' as const, pattern: /饼图|饼状图|\bpie(?: chart)?\b/gi },
];

export const requestedCharts = (prompt: string): AnalysisView['chartType'][] => charts
  .filter(chart => new RegExp(chart.pattern).test(prompt)).map(chart => chart.chartType);

export const isViewOnly = (prompt: string) => {
  if (requestedCharts(prompt).length === 0) return false;
  let rest = prompt.toLowerCase();
  for (const chart of charts) rest = rest.replace(chart.pattern, '');
  const words = ['上一次', '上一条', '最后一次', '上次', '之前', '历史', '已有', '现有', '刚才', '这次', '这份', '那个',
    '请', '帮我', '麻烦', '把', '将', '结果', '图表', '分析', '展示', '表示', '显示', '绘制', '生成', '画', '再',
    '换', '切换', '改', '使用', '用', '一个', '一下', '为', '成', '的', '吧', '看看'].sort((a, b) => b.length - a.length);
  for (const word of words) rest = rest.split(word).join('');
  rest = rest.replace(/[，。！？、\s]/g, '');
  return rest === '';
};

const boundaryNoun = '(?:落在)?(?:面|区域|行政区)?(?:的)?边界(?:上)?(?:的)?(?:点要素|点|要素)?';
const excludeVerb = '(?:排除|不计入|不纳入|不包括|不包含|不计算|不统计|不算|不要(?:计入|纳入|计算|统计|包括|包含|算))';
const includeVerb = '(?:纳入(?:计算|统计)?|计入(?:计算|统计)?|包括|包含|算上|计上|算)';
const excludedBoundary = new RegExp(`${excludeVerb}${boundaryNoun}|${boundaryNoun}(?:也)?${excludeVerb}|\\b(?:exclude|excluding|without)\\s+(?:the\\s+)?boundary(?:\\s+points)?\\b`, 'gi');
const includedBoundary = new RegExp(`${includeVerb}${boundaryNoun}|${boundaryNoun}(?:也)?${includeVerb}|\\b(?:include|including)\\s+(?:the\\s+)?boundary(?:\\s+points)?\\b`, 'gi');

export const boundaryChoice = (prompt: string): 'exclude' | 'include' | 'conflict' | null => {
  const excluded = new RegExp(excludedBoundary).test(prompt);
  const included = new RegExp(includedBoundary).test(prompt.replace(excludedBoundary, ''));
  return excluded && included ? 'conflict' : excluded ? 'exclude' : included ? 'include' : null;
};

const stripMetadata = (prompt: string, datasets: DatasetSummary[]) => {
  let rest = prompt;
  const tokens = datasets.flatMap(dataset => [dataset.name, dataset.name.replace(/\.[^.]+$/, ''), ...dataset.fields])
    .filter(Boolean).sort((a, b) => b.length - a.length);
  for (const token of tokens) rest = rest.split(token).join(' ');
  return rest;
};

// These semantics cannot be represented by spatial_pivot@1. Never downgrade them to count.
export const unsupportedRequirement = (prompt: string): string | null => {
  // Inspect semantic requirements before removing field tokens. A field named
  // "平均面积" must never erase an averaging request and turn it into count.
  const rest = prompt.toLowerCase();
  if (/求和|总和|平均|均值|最大|最小|面积|体积|密度|距离|缓冲|周边|附近|最近|可达性|莫兰|雷达图|热力图|散点图|箱线图|\b(sum|mean|average|nearest|buffer|radar)\b|\d+\s*(米|公里|千米|km\b|m\b)/i.test(rest)) {
    return '当前已验证算子支持面内点计数，不支持这项距离、数值聚合、专业模型或图表需求。';
  }
  if (/多少[种类]|种类数|类别数量|类型数量|\bdistinct\b/.test(prompt)) {
    return '当前按点要素计数，不支持把类别去重数量作为统计指标。';
  }
  const filters = rest.replace(/只统计总数|仅统计总数|统计所有|全部统计/g, '');
  if (/只统计|仅统计|筛选|过滤|等于|大于|小于|超过|至少|不超过|[<>]=?|top\s*\d|前\s*\d+|排名|排序|\b(filter|where|top)\b|比例|百分比|权重|相交|交集|相离|邻接|相邻|之外|以外|不包含/.test(filters.replace(excludedBoundary, ''))) {
    return '当前算子尚未支持筛选、排序、其他空间关系或派生指标，请使用明确的面内计数需求。';
  }
  return null;
};

export const requestedLabel = (prompt: string): { field: string; phrase: string } | null => {
  const match = prompt.match(/(?:结果)?以([^，。；,;]{1,80}?)(?:字段)?标识|(?:使用|用)([^，。；,;]{1,80}?)(?:字段)?作为标签|标签字段(?:为|是)([^，。；,;]{1,80})/);
  if (!match) return null;
  const field = (match[1] || match[2] || match[3]).trim().replace(/^[「"'`“]|[」"'`”]$/g, '');
  return { field, phrase: match[0] };
};

const resolveDataset = (prompt: string, candidates: DatasetSummary[], previousId?: string) => {
  const named = candidates.filter(dataset => [dataset.name, dataset.name.replace(/\.[^.]+$/, '')]
    .some(name => name.length > 1 && prompt.includes(name)));
  if (named.length === 1) return named[0];
  if (named.length > 1) return null;
  if (previousId) return candidates.find(dataset => dataset.fileId === previousId) || null;
  return candidates.length === 1 ? candidates[0] : null;
};

const findField = (prompt: string, fields: string[], aliases: string[]): string | null | undefined => {
  const exact = fields.filter(field => field.length > 1 && prompt.includes(field));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const matched = fields.filter(field => aliases.includes(field.toLowerCase()));
  return matched.length === 1 ? matched[0] : undefined;
};

export const rulePlan = (prompt: string, datasets: DatasetSummary[], previous?: SpatialPivotSpec): NaturalPlan | null => {
  const boundary = boundaryChoice(prompt);
  if (boundary === 'conflict') return clarification('边界点同时被要求纳入和排除，请选择一种规则。');
  const polygon = datasets.filter(dataset => dataset.geometryTypes.length > 0 && dataset.geometryTypes.every(type =>
    (SPATIAL_PIVOT_OPERATOR.targetGeometry as readonly string[]).includes(type)));
  const points = datasets.filter(dataset => dataset.geometryTypes.length > 0 && dataset.geometryTypes.every(type =>
    (SPATIAL_PIVOT_OPERATOR.joinGeometry as readonly string[]).includes(type)));
  const target = resolveDataset(prompt, polygon, previous?.target.fileId);
  const join = resolveDataset(prompt, points, previous?.join.fileId);
  if (!target) return clarification('请选择或明确指定一个目标面图层；不能在多个面图层中猜测。');
  if (!join) return clarification('请选择或明确指定一个关联点图层；不能在多个点图层中猜测。');
  const grouped = /按.+(?:分类|分组|统计)|不同(?:类型|类别)|按(?:类型|类别)|分类统计|\bby\b/i.test(prompt);
  const totalOnly = /不分类|不分组|不按.+分类|只统计总数|仅统计总数|统计总数/.test(prompt);
  if (grouped && totalOnly && !/不按.+分类/.test(prompt)) return clarification('请确认需要分类拆分，还是只统计总数。');
  const categoryField = totalOnly ? null : grouped ? findField(prompt, join.fields, ['类型', '类别', '分类', 'category', 'type'])
    : previous?.join.fileId === join.fileId ? previous.join.categoryField : null;
  if (categoryField === undefined) return clarification(`请明确分类字段。${join.name} 的可用字段：${join.fields.join('、')}`);
  const nameFields = target.fields.filter(field => ['名称', '名字', 'name', '街道名称', '区县名称', '街道名'].includes(field.toLowerCase()));
  const explicitLabel = requestedLabel(prompt);
  if (explicitLabel && !target.fields.includes(explicitLabel.field)) return clarification(`目标图层不存在标识字段 ${explicitLabel.field}，请使用真实字段名。`);
  const labelField = explicitLabel ? explicitLabel.field : previous?.target.fileId === target.fileId ? previous.target.labelField : nameFields.length === 1 ? nameFields[0] : null;
  const spec: SpatialPivotSpec = {
    schemaVersion: 1, kind: 'spatial_pivot', operatorVersion: 1,
    target: { fileId: target.fileId, labelField }, join: { fileId: join.fileId, categoryField },
    boundaryPolicy: boundary || previous?.boundaryPolicy || 'exclude',
  };
  let rest = stripMetadata(explicitLabel ? prompt.replace(explicitLabel.phrase, '') : prompt, datasets).toLowerCase();
  for (const chart of charts) rest = rest.replace(chart.pattern, '');
  rest = rest.replace(excludedBoundary, '').replace(includedBoundary, '');
  const words = ['请', '帮我', '麻烦', '我想', '需要', '想要', '统计', '计算', '计数', '数量', '个数', '多少', '总数', '总量',
    '要素', '设施', 'poi', '点数据', '点图层', '面图层', '行政区', '区县', '街道', '不同', '类型', '类别', '分类', '分组',
    '分别', '每个', '各个', '每', '各', '包含', '落在', '内', '中', '按', '按照', '纳入', '排除', '边界', '上', '也算',
    '不分类', '不分组', '只', '仅', '所有', '全部', '改成', '改为', '换成', '并且', '并', '然后', '同时', '用', '绘制', '画',
    '展示', '显示', '生成', '把', '将', '的', '里', '在', '和', '与', '以及', '再', '吧'].sort((a, b) => b.length - a.length);
  for (const word of words) rest = rest.split(word).join('');
  rest = rest.replace(/[，。！？、：:\s"'`]/g, '');
  if (rest || (!/统计|计数|数量|个数|多少|count/i.test(prompt) && !previous)) return null;
  if (!previous && !/每|各|内|中|包含|落在/.test(prompt)) {
    return clarification('请确认是否需要“每个目标面内”的点计数；单独统计图层总数不等同于空间透视。');
  }
  const assumptions = ['每个目标要素单独计数，同名目标不合并；重叠面允许多重归属；无匹配目标保留为 0。'];
  if (previous && !grouped && !totalOnly && categoryField !== null) assumptions.push(`沿用上一分析的分类字段 ${categoryField}。`);
  if (boundary === null) assumptions.push(`沿用${previous ? '上一分析的' : '默认的'}${spec.boundaryPolicy === 'exclude' ? '排除' : '纳入'}边界规则。`);
  return {
    status: 'ready', source: 'rules', spec, view: { chartType: requestedCharts(prompt)[0] || 'bar' }, assumptions,
    inputs: { targetName: target.name, joinName: join.name }, message: '已匹配经过验证的空间透视计数算子，请检查计划后执行。',
  };
};
