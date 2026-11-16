import React, { useState, useRef, useEffect } from 'react';
import { Button, Input, Avatar, Segmented, App, Modal } from 'antd';
import {
    SendOutlined, UserOutlined, ClearOutlined,
    CloseOutlined, CodeOutlined, SettingOutlined, CheckCircleOutlined,
    LoadingOutlined, MessageOutlined, FullscreenOutlined
} from '@ant-design/icons';
import { geoService } from '../../../services/geoService';
import { getApiUrl } from '../../../services/apiConfig';
import { consumeNdjsonResponse } from '../../../services/pipelineStream';
import ReactECharts from 'echarts-for-react';
import { useAnalysisStore, type ChartType } from '../../../stores/useAnalysisStore';
import UnifiedAnalysisAssistant from '../../analysis/components/UnifiedAnalysisAssistant';

// ============================================================
// 类型定义
// ============================================================
interface PipelineStep {
    id: number;
    message: string;
    status: 'loading' | 'success' | 'error';
    timestamp: string;
}

interface LegacyPipelinePayload {
    status?: string;
    message?: string;
    newFileId?: string;
    tableData?: Record<string, unknown>[];
    aiChartType?: string;
    engine?: ChatMessage['engine'];
    chartOption?: unknown;
    chartHtml?: string;
    blueprint?: { explanation?: string; [key: string]: unknown };
    pythonCode?: string;
    sourceFileIds?: string[];
    agentMode?: 'pivot' | 'feature_calc' | 'pro_model';
    error_message?: string;
    traceback?: string;
    refreshSchema?: boolean;
    targetFileId?: string;
    validIds?: unknown[];
}

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

interface ConversationContextPayload {
    lastBlueprint: any;
    lastPythonCode: string;
    lastTableData?: any[];
    lastResultMeta: {
        agentMode?: 'pivot' | 'feature_calc' | 'pro_model';
        sourceFileIds: string[];
        resultFileId?: string;
        resultRowCount: number;
        topInteractionPair: InteractionPairSummary | null;
        geodetectorSpec: GeodetectorSpecSummary;
    };
}

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    engine?: 'echarts' | 'html_iframe';
    chartOption?: any;
    chartHtml?: string;
    pythonCode?: string;
    blueprint?: any;
    status?: 'failed' | 'success';
    traceback?: string;
    pipelineSteps?: PipelineStep[];
    agentMode?: 'pivot' | 'feature_calc' | 'pro_model';
    tableData?: any[];
    newFileId?: string;
    sourceFileIds?: string[];
}

interface GeoAIAgentProps {
    selectedFileIds?: string[];
}

const MAX_CONTEXT_ROWS = 100;
const INTERACTION_FACTOR_A_KEY = '因子A';
const INTERACTION_FACTOR_B_KEY = '因子B';
const INTERACTION_Q_KEY = '交互q值';
const INTERACTION_TYPE_KEY = '交互类型';

const toFiniteNumber = (value: unknown): number | null => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
};

const extractTopInteractionPair = (tableData?: any[]): InteractionPairSummary | null => {
    if (!Array.isArray(tableData) || tableData.length === 0) return null;

    let bestPair: InteractionPairSummary | null = null;
    for (const row of tableData) {
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

const extractGeodetectorSpec = (pythonCode?: string): GeodetectorSpecSummary => {
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

const buildConversationContext = (lastAssistantMsg?: ChatMessage): ConversationContextPayload | undefined => {
    if (!lastAssistantMsg?.blueprint || !lastAssistantMsg.pythonCode) return undefined;

    return {
        lastBlueprint: lastAssistantMsg.blueprint,
        lastPythonCode: lastAssistantMsg.pythonCode,
        lastTableData: Array.isArray(lastAssistantMsg.tableData)
            ? lastAssistantMsg.tableData.slice(0, MAX_CONTEXT_ROWS)
            : undefined,
        lastResultMeta: {
            agentMode: lastAssistantMsg.agentMode,
            sourceFileIds: lastAssistantMsg.sourceFileIds || [],
            resultFileId: lastAssistantMsg.newFileId,
            resultRowCount: Array.isArray(lastAssistantMsg.tableData) ? lastAssistantMsg.tableData.length : 0,
            topInteractionPair: extractTopInteractionPair(lastAssistantMsg.tableData),
            geodetectorSpec: extractGeodetectorSpec(lastAssistantMsg.pythonCode),
        },
    };
};

const QUICK_PROMPTS = [
    '统计各图层的要素数量',
    '计算缓冲区并显示结果',
    '找出两图层的空间交集',
    '分析点数据的空间分布',
];

const AIAvatar = () => <span className="agent-avatar" aria-hidden="true"><MessageOutlined /></span>;

const GeoAIAgent: React.FC<GeoAIAgentProps> = ({ selectedFileIds = [] }) => {
    const { message } = App.useApp();
    const [assistantMode, setAssistantMode] = useState<'operator' | 'legacy'>('operator');
    const [agentMode, setAgentMode] = useState<'pivot' | 'feature_calc' | 'pro_model'>('pivot');
    const [inputValue, setInputValue] = useState('');
    const [loading, setLoading] = useState(false);
    const [editedCodeMap, setEditedCodeMap] = useState<Record<string, string>>({});
    const [rerunLoadingMap, setRerunLoadingMap] = useState<Record<string, boolean>>({});

    // 🌟 新增：全屏代码编辑器弹窗状态
    const [codeModalVisible, setCodeModalVisible] = useState(false);
    const [activeCodeMsgId, setActiveCodeMsgId] = useState<string | null>(null);
    const [tempModalCode, setTempModalCode] = useState('');
    
    const [pipelineSteps, setPipelineSteps] = useState<PipelineStep[]>([]);
    const getTimeString = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

    const {
        setPivotResult, setPivotConfig, setPivotPanelOpen,
        setAiChartOption, setAiChartHtml, setChartMode, setChartVisible,
        setChartType,
        setHighlightedCategory, // 🌟 新增：提取高亮设置函数
        setValidIds,
    } = useAnalysisStore();

    const syncToGlobalStore = (res: any) => {
        // 🌟 [核心新增]：第一时间保存巴中市网格的有效 ID 列表！
        if (res.validIds && Array.isArray(res.validIds)) {
            setValidIds(res.validIds);
        } else {
            setValidIds([]); // 如果没有空间约束，清空 ID 列表
        }

        if (!res.tableData || res.tableData.length === 0) return;
        let rawData = res.tableData;
        const columns = Object.keys(rawData[0] || {}).filter(k => k !== 'geometry');
        if (columns.length === 0) return;
        const rowKeyName = columns[0];
        const valueColumns = columns.slice(1);
        const formattedPivotData = rawData.map((row: any) => ({ rowKey: row[rowKeyName] ?? 'Unknown', ...row }));
        setPivotResult(formattedPivotData, valueColumns);

        // 🌟 核心修复点：不要盲目使用 rowKeyName，尝试从蓝图中提取真实的原始透视字段（例如 "NAME"）
        const blueprintDims = res.blueprint?.visualization_spec?.dimensions || [];
        const realRowField = blueprintDims[0] || rowKeyName;
        const realColField = blueprintDims[1] || (valueColumns.length > 1 ? '__matrix_column__' : null);
        // 动态推断透视方法（如果有的话，否则默认 sum/count）
        const realMethod = res.blueprint?.visualization_spec?.metrics?.[0] || 'sum';

        setPivotConfig({ 
            groupByRow: realRowField, // 🌟 传给地图真实的字段名 
            groupByCol: realColField,
            method: realMethod.includes('count') ? 'count' : 'sum' 
        });

        if (res.aiChartType) {
            const formattedType = res.aiChartType.charAt(0).toUpperCase() + res.aiChartType.slice(1);
            if (['Bar', 'Line', 'Pie', 'Radar', 'Heatmap', 'Scatter', 'BoxPlot', 'Ridgeline'].includes(formattedType)) {
                setChartType(formattedType as ChartType);
            } else {
                setChartType('Bar');
            }
        }
        if (res.engine || res.chartHtml || res.chartOption || res.aiChartType) {
            setAiChartOption(res.chartOption || null);
            setAiChartHtml(res.chartHtml || null);
            if (!res.chartOption && !res.chartHtml) setChartMode('traditional');
            else setChartMode('ai');
            setChartVisible(true);
        }
        setPivotPanelOpen(true);
    };

    const handleSchemaRefresh = (res: any) => {
        if (!res?.refreshSchema) return;
        window.dispatchEvent(new CustomEvent('REFRESH_FILE_TREE'));
        if (res.targetFileId) {
            window.dispatchEvent(new CustomEvent('FORCE_RELOAD_FILE_DATA', { detail: { fileId: res.targetFileId } }));
        }
    };

    const [messages, setMessages] = useState<ChatMessage[]>([
        {
            id: 'welcome',
            role: 'assistant',
            content: '你好！我是 GeoAI 空间智能助手。\n\n请先在左侧资源管理器中勾选数据图层，然后输入你的分析需求。\n例如："统计南京每个区县包含的风景名胜数量"',
            timestamp: Date.now(),
        }
    ]);

    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [messages, pipelineSteps]);

    const handleSend = async () => {
        if (!inputValue.trim() || loading) return;

        const userMsg: ChatMessage = {
            id: `u-${Date.now()}`, role: 'user', content: inputValue, timestamp: Date.now(),
        };
        setMessages(prev => [...prev, userMsg]);
        const currentInput = inputValue;
        setInputValue('');
        setLoading(true);
        setPipelineSteps([]);
        let localPipelineSteps: PipelineStep[] = [];

        const thinkingId = `thinking-${Date.now()}`;
        setMessages(prev => [...prev, { id: thinkingId, role: 'system', content: 'thinking', timestamp: Date.now() }]);

        const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant' && m.blueprint && m.pythonCode);
        const context = buildConversationContext(lastAssistantMsg);

        try {
            const response = await fetch(getApiUrl('/analysis/dynamic-pipeline'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userPrompt: currentInput, fileIds: selectedFileIds, context, agentMode })
            });

            let stepCounter = 0;
            await consumeNdjsonResponse<LegacyPipelinePayload>(response, parsedData => {
                if (parsedData.type === 'step') {
                    localPipelineSteps = [
                        ...localPipelineSteps.map(p => ({ ...p, status: 'success' as const })),
                        { id: stepCounter++, message: parsedData.message ?? '', status: 'loading', timestamp: getTimeString() }
                    ];
                    setPipelineSteps(localPipelineSteps);
                } else if (parsedData.type === 'result') {
                    const resData = parsedData.data ?? {};
                    localPipelineSteps = localPipelineSteps.map(p => ({ ...p, status: 'success' as const }));
                    setPipelineSteps(localPipelineSteps);
                    handleSchemaRefresh(resData);
                    if (agentMode === 'pro_model' && resData.newFileId) {
                        message.success(resData.message || "模型运算完成！");
                        window.dispatchEvent(new CustomEvent('REFRESH_FILE_TREE'));
                        if (resData.tableData && resData.tableData.length > 0 && '因子A' in resData.tableData[0]) {
                            resData.aiChartType = 'heatmap';
                            resData.engine = 'echarts';
                        }
                        syncToGlobalStore(resData);
                        setMessages(oldMsgs => {
                            const filtered = oldMsgs.filter(m => m.id !== thinkingId);
                            return [...filtered, {
                                id: Date.now().toString(), role: 'assistant',
                                content: resData.message || `运算完成！分析结果已保存为独立文件，可在左侧资源树中预览或下载。`,
                                timestamp: Date.now(), engine: resData.engine,
                                chartOption: resData.chartOption, chartHtml: resData.chartHtml,
                                blueprint: resData.blueprint, pythonCode: resData.pythonCode,
                                pipelineSteps: localPipelineSteps,
                                agentMode: resData.agentMode || agentMode,
                                tableData: resData.tableData, newFileId: resData.newFileId,
                                sourceFileIds: resData.sourceFileIds || selectedFileIds
                            }];
                        });
                    } else if (resData.status === 'failed') {
                        setMessages(oldMsgs => {
                            const filtered = oldMsgs.filter(m => m.id !== thinkingId);
                            return [...filtered, {
                                id: `err-${Date.now()}`, role: 'assistant',
                                content: resData.error_message || 'AI 多次尝试修复代码失败，已切换至人工接管模式。',
                                timestamp: Date.now(), status: 'failed', traceback: resData.traceback,
                                pythonCode: resData.pythonCode, blueprint: context?.lastBlueprint,
                                pipelineSteps: localPipelineSteps, agentMode: agentMode
                            }];
                        });
                    } else {
                        syncToGlobalStore(resData);
                        setMessages(oldMsgs => {
                            const filtered = oldMsgs.filter(m => m.id !== thinkingId);
                            return [...filtered, {
                                id: `a-${Date.now()}`, role: 'assistant',
                                content: resData.blueprint?.explanation || resData.message || '分析完成！请查看分析结果和生成的执行代码。',
                                timestamp: Date.now(), engine: resData.engine, chartOption: resData.chartOption,
                                chartHtml: resData.chartHtml, pythonCode: resData.pythonCode, blueprint: resData.blueprint,
                                pipelineSteps: localPipelineSteps,
                                agentMode: resData.agentMode || agentMode,
                                tableData: resData.tableData, newFileId: resData.newFileId,
                                sourceFileIds: resData.sourceFileIds || selectedFileIds
                            }];
                        });
                    }
                }
            });
        } catch (error: any) {
            localPipelineSteps = localPipelineSteps.map(p => p.status === 'loading' ? { ...p, status: 'error' as const } : p);
            setPipelineSteps(localPipelineSteps);
            const errData = error;
            setMessages(oldMsgs => {
                const filtered = oldMsgs.filter(m => m.id !== thinkingId);
                return [...filtered, {
                    id: `err-${Date.now()}`, role: 'assistant',
                    content: `分析失败：${errData?.details || errData?.message || '未知错误'}`,
                    timestamp: Date.now(), pythonCode: errData?.pythonCode,
                    pipelineSteps: localPipelineSteps
                }];
            });
        } finally {
            setLoading(false);
        }
    };

    const handleClear = () => {
        setMessages([{
            id: 'cleared', role: 'assistant', content: '对话已清空，请重新输入指令。', timestamp: Date.now(),
        }]);
    };

    // ─────────────────────────────────────────────
    // Pipeline Steps 渲染
    // ─────────────────────────────────────────────
    const renderPipelineStepsViewer = (steps: PipelineStep[], isLive: boolean) => {
        if (steps.length === 0) {
            return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', color: 'var(--workbench-muted)', fontSize: 13, fontFamily: 'monospace' }}>
                    <LoadingOutlined style={{ color: 'var(--workbench-accent)', fontSize: 16 }} spin />
                    <span>正在初始化分析引擎...</span>
                </div>
            );
        }

        return (
            <div style={{
                padding: '12px 16px',
                display: 'flex', flexDirection: 'column', gap: 8,
                maxHeight: isLive ? 'none' : 400,
                overflowY: isLive ? 'visible' : 'auto',
            }}>
                {steps.map((step) => {
                    const parts = step.message.split('\n');
                    const title = parts[0];
                    const details = parts.slice(1).filter(Boolean);

                    return (
                        <div
                            key={step.id}
                            style={{
                                background: step.status === 'error' ? 'rgba(239,68,68,0.06)' : 'var(--workbench-inset)',
                                border: `1px solid ${step.status === 'error' ? 'rgba(239,68,68,0.25)' : 'var(--workbench-border)'}`,
                                borderRadius: 10,
                                padding: '10px 14px',
                            }}
                        >
                            {/* 步骤标题行 */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--workbench-muted)', flexShrink: 0 }}>
                                    {step.timestamp}
                                </span>
                                <span style={{ fontSize: 14, flexShrink: 0, lineHeight: 1 }}>
                                    {step.status === 'success'
                                        ? <CheckCircleOutlined style={{ color: 'var(--workbench-success)' }} />
                                        : step.status === 'error'
                                        ? <CloseOutlined style={{ color: 'var(--workbench-danger)' }} />
                                        : <LoadingOutlined style={{ color: 'var(--workbench-accent)' }} spin />}
                                </span>
                                <span style={{
                                    fontSize: 13,
                                    fontFamily: 'monospace',
                                    fontWeight: 600,
                                    color: step.status === 'loading' ? 'var(--workbench-accent)' : step.status === 'error' ? 'var(--workbench-danger)' : 'var(--workbench-text)',
                                    lineHeight: 1.5,
                                }}>
                                    {title}
                                </span>
                            </div>

                            {/* 参数子块 */}
                            {details.length > 0 && (
                                <div style={{
                                    marginTop: 10,
                                    background: 'var(--workbench-inset)',
                                    border: '1px solid var(--workbench-border)',
                                    borderRadius: 8,
                                    overflow: 'hidden',
                                }}>
                                    {details.map((line, idx) => {
                                        if (line.includes(' : ')) {
                                            const colonIdx = line.indexOf(' : ');
                                            const key = line.slice(0, colonIdx).replace('• ', '').trim();
                                            const val = line.slice(colonIdx + 3).trim();
                                            return (
                                                <div
                                                    key={idx}
                                                    style={{
                                                        display: 'flex',
                                                        alignItems: 'flex-start',
                                                        borderBottom: idx < details.length - 1 ? '1px solid var(--workbench-border)' : 'none',
                                                        minHeight: 34,
                                                    }}
                                                >
                                                    {/* Key 标签列 — 固定宽度、深底色 */}
                                                    <div style={{
                                                        flexShrink: 0,
                                                        width: 96,
                                                        padding: '8px 10px',
                                                        background: 'var(--workbench-inset)',
                                                        borderRight: '1px solid var(--workbench-border)',
                                                        fontSize: 11.5,
                                                        fontFamily: 'monospace',
                                                        fontWeight: 700,
                                                        color: 'var(--workbench-muted)',
                                                        letterSpacing: '0.02em',
                                                        lineHeight: 1.5,
                                                    }}>
                                                        {key}
                                                    </div>
                                                    {/* Value 值列 — flex:1 自动撑满，正常换行 */}
                                                    <div style={{
                                                        flex: 1,
                                                        minWidth: 0,
                                                        padding: '8px 12px',
                                                        fontSize: 12.5,
                                                        fontFamily: 'monospace',
                                                        fontWeight: 600,
                                                        color: 'var(--workbench-accent)',
                                                        lineHeight: 1.6,
                                                        wordBreak: 'break-word',
                                                        whiteSpace: 'pre-wrap',
                                                    }}>
                                                        {val}
                                                    </div>
                                                </div>
                                            );
                                        }
                                        // 普通说明行
                                        return (
                                            <div key={idx} style={{
                                                padding: '8px 12px',
                                                fontFamily: 'monospace', fontSize: 12,
                                                color: 'var(--workbench-accent)', lineHeight: 1.6,
                                                borderBottom: idx < details.length - 1 ? '1px solid var(--workbench-border)' : 'none',
                                                wordBreak: 'break-word',
                                            }}>
                                                {line}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        );
    };

    // ─────────────────────────────────────────────
    // 消息渲染
    // ─────────────────────────────────────────────
    const renderMessage = (msg: ChatMessage) => {
        // Live Pipeline 状态
        if (msg.role === 'system' && msg.content === 'thinking') {
            return (
                <div key={msg.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '4px 0' }}>
                    <AIAvatar />
                    <div style={{
                        flex: 1, minWidth: 0,
                        background: 'var(--workbench-panel)',
                        border: '1px solid var(--workbench-border)',
                        borderRadius: '0 14px 14px 14px',
                        overflow: 'hidden',
                    }}>
                        {/* 面板标题 */}
                        <div style={{
                            height: 40, background: 'var(--workbench-inset)',
                            borderBottom: '1px solid var(--workbench-border)',
                            display: 'flex', alignItems: 'center', paddingLeft: 16, gap: 8,
                        }}>
                            <MessageOutlined />
                            <span style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 700, color: 'var(--workbench-muted)', letterSpacing: '0.08em' }}>
                                分析进度
                            </span>
                        </div>
                        {renderPipelineStepsViewer(pipelineSteps, true)}
                    </div>
                </div>
            );
        }

        const handleChartClick = (params: any) => {
            if (params.name) {
                // 读取当前的全局高亮状态
                const currentHighlight = useAnalysisStore.getState().highlightedCategory;
                // 如果点击了已经高亮的柱子，则取消高亮；否则设置为新的高亮
                if (currentHighlight === String(params.name)) {
                    setHighlightedCategory(null);
                } else {
                    setHighlightedCategory(String(params.name));
                }
            }
        };

        const isUser = msg.role === 'user';

        return (
            <div
                key={msg.id}
                style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    flexDirection: isUser ? 'row-reverse' : 'row',
                    padding: '4px 0',
                }}
            >
                {/* 头像 */}
                {isUser ? (
                    <Avatar
                        size={26}
                        icon={<UserOutlined />}
                        className="agent-avatar"
                    />
                ) : (
                    <AIAvatar />
                )}

                {/* 气泡区域 */}
                <div style={{
                    display: 'flex', flexDirection: 'column', gap: 10,
                    minWidth: 0, maxWidth: 'calc(100% - 38px)',
                    alignItems: isUser ? 'flex-end' : 'flex-start',
                }}>
                    {/* 主文本气泡 */}
                    <div style={{
                        padding: '11px 16px',
                        fontSize: 13,
                        lineHeight: 1.6,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        borderRadius: isUser ? '14px 4px 14px 14px' : '4px 14px 14px 14px',
                        background: isUser ? 'var(--workbench-selected)' : 'var(--workbench-inset)',
                        border: '1px solid var(--workbench-border)',
                        color: 'var(--workbench-text)',
                    }}>
                        {msg.content}
                    </div>

                    {/* 历史执行日志 */}
                    {!isUser && msg.pipelineSteps && msg.pipelineSteps.length > 0 && (
                        <div style={{
                            width: '100%',
                            background: 'var(--workbench-panel)',
                            border: '1px solid var(--workbench-border)',
                            borderRadius: 12,
                            overflow: 'hidden',
                        }}>
                            <div style={{
                                height: 38, background: 'var(--workbench-inset)',
                                borderBottom: '1px solid var(--workbench-border)',
                                display: 'flex', alignItems: 'center', paddingLeft: 14, gap: 8,
                            }}>
                                <CodeOutlined style={{ color: 'var(--workbench-accent)', fontSize: 13 }} />
                                <span style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: 'var(--workbench-muted)', letterSpacing: '0.08em' }}>
                                    执行记录
                                </span>
                            </div>
                            {renderPipelineStepsViewer(msg.pipelineSteps, false)}
                        </div>
                    )}

                    {/* 代码 & 图表区 */}
                    {!isUser && (msg.pythonCode || msg.engine) && (
                        <div style={{
                            width: '100%',
                            background: 'var(--workbench-panel)',
                            border: '1px solid var(--workbench-border)',
                            borderRadius: 12,
                            overflow: 'hidden',
                        }}>
                            {/* ECharts 图表 */}
                            {msg.engine === 'echarts' && msg.chartOption && (
                                <div style={{ background: 'var(--workbench-panel)', borderBottom: '1px solid var(--workbench-border)', padding: 12 }}>
                                    <ReactECharts option={msg.chartOption} style={{ height: 280, width: '100%' }} onEvents={{ click: handleChartClick }}/>
                                </div>
                            )}

                            {/* HTML iframe 图表 */}
                            {msg.engine === 'html_iframe' && msg.chartHtml && (
                                <div style={{ height: 280, background: '#fff', borderBottom: '1px solid var(--workbench-border)' }}>
                                    <iframe
                                        srcDoc={msg.chartHtml}
                                        title="Spatial Chart"
                                        style={{ width: '100%', height: '100%', border: 'none', background: 'var(--workbench-panel)' }}
                                        sandbox="allow-scripts allow-same-origin"
                                    />
                                </div>
                            )}

                            {/* 错误栈 */}
                            {msg.status === 'failed' && msg.traceback && (
                                <div style={{ padding: '12px 16px', background: 'rgba(239,68,68,0.05)', borderBottom: '1px solid rgba(239,68,68,0.2)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--workbench-danger)', fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                                        <CloseOutlined style={{ fontSize: 12 }} /> 沙盒执行崩溃 / 修复超时
                                    </div>
                                    <div style={{
                                        background: 'rgba(30,30,30,0.8)', borderRadius: 8,
                                        padding: '10px 12px', overflowX: 'auto',
                                        fontSize: 12, color: 'var(--workbench-danger)',
                                        fontFamily: 'monospace', lineHeight: 1.6,
                                        border: '1px solid rgba(239,68,68,0.2)',
                                    }}>
                                        {msg.traceback}
                                    </div>
                                </div>
                            )}

                            {/* Python 代码编辑区 */}
                            {msg.pythonCode && (
                                <div style={{ padding: '14px 16px' }}>
                                    <div style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', // 🌟 改为两端对齐
                                        marginBottom: 10
                                    }}>
                                        <div style={{
                                            display: 'flex', alignItems: 'center', gap: 8,
                                            fontSize: 12, fontFamily: 'monospace', fontWeight: 700,
                                            color: msg.status === 'failed' ? 'var(--workbench-danger)' : 'var(--workbench-accent)',
                                            letterSpacing: '0.05em',
                                        }}>
                                            <CodeOutlined style={{ fontSize: 13 }} />
                                            {msg.status === 'failed' ? '请审查并修正以下算子：' : '计算算子引擎（可人工微调）'}
                                        </div>
                                        
                                        {/* 🌟 新增：全屏编辑按钮 */}
                                        <Button
                                            type="text"
                                            size="small"
                                            icon={<FullscreenOutlined />}
                                            title="全屏沉浸式编辑"
                                            onClick={() => {
                                                setActiveCodeMsgId(msg.id);
                                                // 读取当前修改过的代码，或者原始代码
                                                setTempModalCode(editedCodeMap[msg.id] ?? msg.pythonCode ?? '');
                                                setCodeModalVisible(true);
                                            }}
                                            style={{ color: 'var(--workbench-muted)', background: 'var(--workbench-inset)' }}
                                        />
                                    </div>
                                    <textarea
                                        style={{
                                            width: '100%', height: 200,
                                            background: 'var(--workbench-panel)', color: 'var(--workbench-text)',
                                            fontFamily: 'monospace', fontSize: 13,
                                            lineHeight: 1.65, padding: '12px 14px',
                                            borderRadius: 8, border: '1px solid var(--workbench-border)',
                                            outline: 'none', resize: 'vertical',
                                            boxSizing: 'border-box',
                                        }}
                                        value={editedCodeMap[msg.id] ?? msg.pythonCode}
                                        onChange={e => setEditedCodeMap(prev => ({ ...prev, [msg.id]: e.target.value }))}
                                        spellCheck={false}
                                    />
                                    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                                        <Button
                                            size="middle"
                                            type="primary"
                                            loading={rerunLoadingMap[msg.id]}
                                            icon={<SettingOutlined />}
                                            style={{
                                                flex: 1.5, fontWeight: 700, fontSize: 13,
                                            }}
                                            onClick={async () => {
                                                const codeToRun = editedCodeMap[msg.id] ?? msg.pythonCode ?? '';
                                                if (!codeToRun || selectedFileIds.length === 0) return;
                                                setRerunLoadingMap(prev => ({ ...prev, [msg.id]: true }));
                                                try {
                                                    const res = await geoService.rerunCode({ 
                                                        pythonCode: codeToRun,
                                                        fileIds: selectedFileIds, 
                                                        blueprint: msg.blueprint,
                                                        agentMode: msg.agentMode 
                                                    });

                                                    // 🌟 根源修复：如果是特征计算重跑，触发全局刷新
                                                    if (res.refreshSchema) {
                                                        message.success(res.message);
                                                        // 1. 发送刷新文件树事件（更新列信息）
                                                        window.dispatchEvent(new CustomEvent('REFRESH_FILE_TREE'));
                                                        // 2. 模拟点击一次当前正在查看的文件，让 SplitTablePanel 重新请求数据刷新列
                                                        if (res.targetFileId) {
                                                            window.dispatchEvent(new CustomEvent('FORCE_RELOAD_FILE_DATA', { detail: { fileId: res.targetFileId } }));
                                                        }
                                                    } else {
                                                        syncToGlobalStore(res);
                                                    }

                                                    // 更新当前消息的内容显示
                                                    setMessages(prev => prev.map(m => m.id !== msg.id ? m : {
                                                        ...m, 
                                                        engine: res.engine, 
                                                        chartOption: res.chartOption, 
                                                        chartHtml: res.chartHtml, 
                                                        pythonCode: codeToRun,
                                                        tableData: res.tableData ?? m.tableData,
                                                        newFileId: res.newFileId ?? m.newFileId,
                                                        sourceFileIds: res.sourceFileIds ?? m.sourceFileIds,
                                                        agentMode: res.agentMode ?? m.agentMode,
                                                        content: res.message || '重跑成功！数据已更新。'
                                                    }));
                                                } catch (err: any) {
                                                    const detail = err.response?.data?.details || err.message;
                                                    setMessages(prev => prev.map(m => m.id !== msg.id ? m : { ...m, content: `重跑失败：${detail}` }));
                                                } finally {
                                                    setRerunLoadingMap(prev => ({ ...prev, [msg.id]: false }));
                                                }
                                            }}
                                        >
                                            应用修改并重跑
                                        </Button>
                                        <Button
                                            size="middle"
                                            icon={<CheckCircleOutlined />}
                                            style={{
                                                flex: 1, fontSize: 13, fontWeight: 600,
                                                background: 'var(--workbench-inset)',
                                                borderColor: 'var(--workbench-border)', color: 'var(--workbench-muted)',
                                            }}
                                        >
                                            固化为服务模型
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // ─────────────────────────────────────────────
    return (
        <div className="agent-panel">
            <header className="workbench-heading">
                <h2 id="agent-heading"><MessageOutlined aria-hidden="true" />空间分析助手</h2>
                {assistantMode === 'legacy' && (
                    <Button
                        type="text" size="small" icon={<ClearOutlined />}
                        onClick={handleClear} aria-label="清空对话" title="清空对话"
                    />
                )}
            </header>

            <div className="agent-mode">
                <Segmented
                    aria-label="助手模式"
                    options={[{ label: '自然语言', value: 'operator' }, { label: '实验流程', value: 'legacy' }]}
                    value={assistantMode}
                    onChange={setAssistantMode}
                    size="small"
                    block
                />
            </div>

            {/* ── 消息列表 ── */}
            <div className={`min-h-0 flex-1 overflow-hidden ${assistantMode === 'operator' ? 'flex' : 'hidden'}`}>
                <UnifiedAnalysisAssistant selectedFileIds={selectedFileIds} onSwitchToLegacy={() => setAssistantMode('legacy')} />
            </div>
            <div
                ref={scrollRef}
                style={{
                    flex: 1, overflowY: 'auto', overflowX: 'hidden',
                    padding: '12px',
                    display: assistantMode === 'legacy' ? 'flex' : 'none',
                    flexDirection: 'column', gap: 16,
                    scrollbarWidth: 'thin',
                    scrollbarColor: 'var(--workbench-border) transparent',
                }}
            >
                {messages.map(renderMessage)}
            </div>

            {assistantMode === 'legacy' && (
                <div className="agent-composer">
                    {messages.length <= 2 && selectedFileIds.length > 0 && (
                        <div className="agent-prompts">
                            {QUICK_PROMPTS.map(prompt => (
                                <Button key={prompt} size="small" onClick={() => setInputValue(prompt)}>{prompt}</Button>
                            ))}
                        </div>
                    )}
                    <Segmented
                        aria-label="实验分析模式"
                        options={[
                            { label: '数据透视', value: 'pivot' },
                            { label: '空间推算', value: 'feature_calc' },
                            { label: '专业模型', value: 'pro_model' },
                        ]}
                        value={agentMode}
                        onChange={setAgentMode}
                        size="small"
                        block
                    />
                    <div className="agent-input">
                        <Input.TextArea
                            aria-label="分析需求"
                            value={inputValue}
                            onChange={event => setInputValue(event.target.value)}
                            onKeyDown={event => {
                                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                                    event.preventDefault();
                                    void handleSend();
                                }
                            }}
                            placeholder={selectedFileIds.length > 0 ? '输入分析需求' : '请先选择地理图层'}
                            disabled={loading}
                            autoSize={{ minRows: 2, maxRows: 5 }}
                        />
                        <Button
                            type="primary"
                            icon={<SendOutlined />}
                            aria-label="发送"
                            loading={loading}
                            onClick={handleSend}
                            disabled={!inputValue.trim() || loading}
                        />
                    </div>
                </div>
            )}

            {/* 🌟 新增：全屏沉浸式代码编辑器弹窗 */}
            <Modal
                title={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--workbench-text)', fontFamily: 'monospace', fontSize: 16 }}>
                        <CodeOutlined style={{ color: 'var(--workbench-accent)' }} />
                        <span>算子沙盒全屏编辑器</span>
                    </div>
                }
                open={codeModalVisible}
                width={900}
                centered
                destroyOnHidden
                styles={{
                    body: {
                        padding: '20px 24px',
                        background: 'var(--workbench-panel)',
                        borderBottom: '1px solid var(--workbench-border)',
                        borderTop: '1px solid var(--workbench-border)'
                    }
                }}
                okText="保存修改"
                cancelText="取消"
                onCancel={() => setCodeModalVisible(false)}
                onOk={() => {
                    if (activeCodeMsgId) {
                        setEditedCodeMap(prev => ({ ...prev, [activeCodeMsgId]: tempModalCode }));
                    }
                    setCodeModalVisible(false);
                }}
            >
                <div style={{ display: 'flex', flexDirection: 'column', height: '65vh' }}>
                    <div style={{ color: 'var(--workbench-muted)', fontSize: 13, marginBottom: 12, display: 'flex', justifyContent: 'space-between' }}>
                        <span>编辑完成后点击“保存修改”，即可在面板中使用“应用修改并重跑”测试代码。</span>
                        <span style={{ fontFamily: 'monospace' }}>Python 3.9+ 环境</span>
                    </div>
                    <textarea
                        style={{
                            flex: 1, width: '100%',
                            background: 'var(--workbench-panel)', color: 'var(--workbench-text)',
                            fontFamily: 'monospace', fontSize: 14.5,
                            lineHeight: 1.7, padding: '20px',
                            borderRadius: 10, border: '1px solid var(--workbench-border)',
                            outline: 'none', resize: 'none',
                        }}
                        value={tempModalCode}
                        onChange={e => setTempModalCode(e.target.value)}
                        spellCheck={false}
                    />
                </div>
            </Modal>

        </div>
    );
};

export default GeoAIAgent;
