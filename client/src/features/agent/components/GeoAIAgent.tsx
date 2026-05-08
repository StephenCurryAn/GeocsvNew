import React, { useState, useRef, useEffect } from 'react';
import { Button, Input, Avatar, Badge, Segmented, App, Modal } from 'antd';
import {
    SendOutlined, UserOutlined, ClearOutlined,
    CloseOutlined, ThunderboltOutlined, CodeOutlined, SettingOutlined, CheckCircleOutlined,
    LoadingOutlined, DeploymentUnitOutlined, FullscreenOutlined
} from '@ant-design/icons';
import { geoService } from '../../../services/geoService';
import ReactECharts from 'echarts-for-react';
import { useAnalysisStore, type ChartType } from '../../../stores/useAnalysisStore';

// ============================================================
// 类型定义
// ============================================================
interface PipelineStep {
    id: number;
    message: string;
    status: 'loading' | 'success' | 'error';
    timestamp: string;
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
}

interface GeoAIAgentProps {
    selectedFileIds?: string[];
    isOpen?: boolean;
    onClose?: () => void;
}

const QUICK_PROMPTS = [
    '统计各图层的要素数量',
    '计算缓冲区并显示结果',
    '找出两图层的空间交集',
    '分析点数据的空间分布',
];

// ✨ 重新设计的AI头像 — DeploymentUnitOutlined 代表神经网络/知识图谱
const AIAvatar = () => (
    <div
        className="shrink-0 flex items-center justify-center"
        style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: 'linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)',
            boxShadow: '0 0 16px rgba(99,102,241,0.45), 0 2px 8px rgba(0,0,0,0.4)',
            position: 'relative',
            overflow: 'hidden',
        }}
    >
        {/* 内层光晕 */}
        <div style={{
            position: 'absolute', inset: 0,
            background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.18) 0%, transparent 60%)',
        }} />
        <DeploymentUnitOutlined style={{ fontSize: 20, color: '#fff', position: 'relative', zIndex: 1 }} />
    </div>
);

const GeoAIAgent: React.FC<GeoAIAgentProps> = ({
    selectedFileIds = [],
    isOpen = false,
    onClose,
}) => {
    const { message } = App.useApp();
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
        setHighlightedCategory // 🌟 新增：提取高亮设置函数
    } = useAnalysisStore();

    const syncToGlobalStore = (res: any) => {
        if (!res.tableData || res.tableData.length === 0) return;
        let rawData = res.tableData;
        let displayData = rawData;
        if (rawData.length > 100) displayData = [...rawData.slice(0, 50), ...rawData.slice(-50)];
        const columns = Object.keys(displayData[0] || {}).filter(k => k !== 'geometry');
        if (columns.length === 0) return;
        const rowKeyName = columns[0];
        const valueColumns = columns.slice(1);
        const formattedPivotData = displayData.map((row: any) => ({ rowKey: row[rowKeyName] ?? 'Unknown', ...row }));
        setPivotResult(formattedPivotData, valueColumns);

        // 🌟 核心修复点：不要盲目使用 rowKeyName，尝试从蓝图中提取真实的原始透视字段（例如 "NAME"）
        const realRowField = res.blueprint?.visualization_spec?.dimensions?.[0] || rowKeyName;
        // 动态推断透视方法（如果有的话，否则默认 sum/count）
        const realMethod = res.blueprint?.visualization_spec?.metrics?.[0] || 'sum';

        setPivotConfig({ 
            groupByRow: realRowField, // 🌟 传给地图真实的字段名 
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

    const [messages, setMessages] = useState<ChatMessage[]>([
        {
            id: 'welcome',
            role: 'assistant',
            content: '你好！我是 GeoAI 空间智能助手。\n\n请先在左侧资源管理器中勾选数据图层，然后输入你的分析需求。\n例如："统计南京每个区县包含的风景名胜数量"',
            timestamp: Date.now(),
        }
    ]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<any>(null);

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [messages, pipelineSteps]);

    useEffect(() => {
        if (isOpen) setTimeout(() => inputRef.current?.focus(), 300);
    }, [isOpen]);

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
        const context = lastAssistantMsg ? { lastBlueprint: lastAssistantMsg.blueprint, lastPythonCode: lastAssistantMsg.pythonCode } : undefined;

        try {
            const response = await fetch('http://localhost:3000/api/analysis/dynamic-pipeline', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userPrompt: currentInput, fileIds: selectedFileIds, context, agentMode })
            });

            if (!response.body) throw new Error('ReadableStream not supported.');
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let stepCounter = 0;
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newlineIndex = buffer.indexOf('\n');
                while (newlineIndex !== -1) {
                    const line = buffer.slice(0, newlineIndex).trim();
                    buffer = buffer.slice(newlineIndex + 1);
                    newlineIndex = buffer.indexOf('\n');
                    if (!line) continue;
                    try {
                        const parsedData = JSON.parse(line);
                        if (parsedData.type === 'step') {
                            localPipelineSteps = [
                                ...localPipelineSteps.map(p => ({ ...p, status: 'success' as const })),
                                { id: stepCounter++, message: parsedData.message, status: 'loading', timestamp: getTimeString() }
                            ];
                            setPipelineSteps(localPipelineSteps);
                        } else if (parsedData.type === 'result') {
                            const resData = parsedData.data;
                            localPipelineSteps = localPipelineSteps.map(p => ({ ...p, status: 'success' as const }));
                            setPipelineSteps(localPipelineSteps);
                            if (agentMode === 'pro_model' && resData.newFileId) {
                                message.success(resData.message || "模型运算完成！");
                                window.dispatchEvent(new CustomEvent('REFRESH_FILE_TREE'));
                                setMessages(oldMsgs => {
                                    const filtered = oldMsgs.filter(m => m.id !== thinkingId);
                                    return [...filtered, {
                                        id: Date.now().toString(), role: 'assistant',
                                        content: `运算完成！分析结果已保存为独立文件，可在左侧资源树中预览或下载。`,
                                        timestamp: Date.now(), pythonCode: resData.pythonCode,
                                        pipelineSteps: localPipelineSteps,
                                        agentMode: agentMode
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
                                        pipelineSteps: localPipelineSteps,
                                        agentMode: agentMode
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
                                        agentMode: agentMode
                                    }];
                                });
                            }
                        } else if (parsedData.type === 'error') {
                            throw parsedData.data;
                        }
                    } catch (e) {}
                }
            }
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', color: '#64748b', fontSize: 13, fontFamily: 'monospace' }}>
                    <LoadingOutlined style={{ color: '#38bdf8', fontSize: 16 }} spin />
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
                                background: step.status === 'error' ? 'rgba(239,68,68,0.06)' : 'rgba(15,23,42,0.6)',
                                border: `1px solid ${step.status === 'error' ? 'rgba(239,68,68,0.25)' : 'rgba(51,65,85,0.6)'}`,
                                borderRadius: 10,
                                padding: '10px 14px',
                                animation: 'geoFadeUp 0.35s ease forwards',
                            }}
                        >
                            {/* 步骤标题行 */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#475569', flexShrink: 0 }}>
                                    {step.timestamp}
                                </span>
                                <span style={{ fontSize: 14, flexShrink: 0, lineHeight: 1 }}>
                                    {step.status === 'success'
                                        ? <CheckCircleOutlined style={{ color: '#34d399' }} />
                                        : step.status === 'error'
                                        ? <CloseOutlined style={{ color: '#f87171' }} />
                                        : <LoadingOutlined style={{ color: '#38bdf8' }} spin />}
                                </span>
                                <span style={{
                                    fontSize: 13,
                                    fontFamily: 'monospace',
                                    fontWeight: 600,
                                    color: step.status === 'loading' ? '#7dd3fc' : step.status === 'error' ? '#fca5a5' : '#cbd5e1',
                                    lineHeight: 1.5,
                                }}>
                                    {title}
                                </span>
                            </div>

                            {/* 参数子块 */}
                            {details.length > 0 && (
                                <div style={{
                                    marginTop: 10,
                                    background: 'rgba(2,6,23,0.6)',
                                    border: '1px solid rgba(30,41,59,0.9)',
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
                                                        borderBottom: idx < details.length - 1 ? '1px solid rgba(30,41,59,0.7)' : 'none',
                                                        minHeight: 34,
                                                    }}
                                                >
                                                    {/* Key 标签列 — 固定宽度、深底色 */}
                                                    <div style={{
                                                        flexShrink: 0,
                                                        width: 96,
                                                        padding: '8px 10px',
                                                        background: 'rgba(15,23,42,0.8)',
                                                        borderRight: '1px solid rgba(30,41,59,0.7)',
                                                        fontSize: 11.5,
                                                        fontFamily: 'monospace',
                                                        fontWeight: 700,
                                                        color: '#94a3b8',
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
                                                        color: '#7dd3fc',
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
                                                color: 'rgba(186,230,253,0.65)', lineHeight: 1.6,
                                                borderBottom: idx < details.length - 1 ? '1px solid rgba(30,41,59,0.5)' : 'none',
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
                        background: 'rgba(10,15,24,0.9)',
                        border: '1px solid rgba(51,65,85,0.7)',
                        borderRadius: '0 14px 14px 14px',
                        overflow: 'hidden',
                    }}>
                        {/* 面板标题 */}
                        <div style={{
                            height: 40, background: 'rgba(17,24,39,0.9)',
                            borderBottom: '1px solid rgba(51,65,85,0.5)',
                            display: 'flex', alignItems: 'center', paddingLeft: 16, gap: 8,
                        }}>
                            <DeploymentUnitOutlined style={{ color: '#38bdf8', fontSize: 14 }} />
                            <span style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 700, color: '#64748b', letterSpacing: '0.08em' }}>
                                SPATIAL PIPELINE
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
                        size={40}
                        icon={<UserOutlined style={{ fontSize: 18 }} />}
                        style={{
                            flexShrink: 0, background: '#2563eb',
                            border: '2px solid rgba(96,165,250,0.3)',
                            borderRadius: 12, boxShadow: '0 2px 8px rgba(37,99,235,0.4)',
                        }}
                    />
                ) : (
                    <AIAvatar />
                )}

                {/* 气泡区域 */}
                <div style={{
                    display: 'flex', flexDirection: 'column', gap: 10,
                    minWidth: 0, maxWidth: 'calc(100% - 56px)',
                    alignItems: isUser ? 'flex-end' : 'flex-start',
                }}>
                    {/* 主文本气泡 */}
                    <div style={{
                        padding: '11px 16px',
                        fontSize: 14,
                        lineHeight: 1.7,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        borderRadius: isUser ? '14px 4px 14px 14px' : '4px 14px 14px 14px',
                        background: isUser
                            ? 'linear-gradient(135deg, #1d4ed8 0%, #2563eb 100%)'
                            : 'rgba(30,41,59,0.85)',
                        border: isUser
                            ? '1px solid rgba(96,165,250,0.25)'
                            : '1px solid rgba(51,65,85,0.5)',
                        color: isUser ? '#f0f9ff' : '#cbd5e1',
                        boxShadow: isUser
                            ? '0 4px 16px rgba(37,99,235,0.25)'
                            : '0 2px 8px rgba(0,0,0,0.2)',
                        backdropFilter: 'blur(8px)',
                    }}>
                        {msg.content}
                    </div>

                    {/* 历史执行日志 */}
                    {!isUser && msg.pipelineSteps && msg.pipelineSteps.length > 0 && (
                        <div style={{
                            width: '100%',
                            background: 'rgba(10,15,24,0.85)',
                            border: '1px solid rgba(51,65,85,0.6)',
                            borderRadius: 12,
                            overflow: 'hidden',
                        }}>
                            <div style={{
                                height: 38, background: 'rgba(17,24,39,0.85)',
                                borderBottom: '1px solid rgba(51,65,85,0.4)',
                                display: 'flex', alignItems: 'center', paddingLeft: 14, gap: 8,
                            }}>
                                <CodeOutlined style={{ color: '#38bdf8', fontSize: 13 }} />
                                <span style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: '#64748b', letterSpacing: '0.08em' }}>
                                    EXECUTION LOG
                                </span>
                            </div>
                            {renderPipelineStepsViewer(msg.pipelineSteps, false)}
                        </div>
                    )}

                    {/* 代码 & 图表区 */}
                    {!isUser && (msg.pythonCode || msg.engine) && (
                        <div style={{
                            width: '100%',
                            background: 'rgba(13,17,23,0.95)',
                            border: '1px solid rgba(51,65,85,0.6)',
                            borderRadius: 12,
                            overflow: 'hidden',
                        }}>
                            {/* ECharts 图表 */}
                            {msg.engine === 'echarts' && msg.chartOption && (
                                <div style={{ background: '#111827', borderBottom: '1px solid rgba(51,65,85,0.4)', padding: 12 }}>
                                    <ReactECharts option={msg.chartOption} style={{ height: 280, width: '100%' }} onEvents={{ click: handleChartClick }}/>
                                </div>
                            )}

                            {/* HTML iframe 图表 */}
                            {msg.engine === 'html_iframe' && msg.chartHtml && (
                                <div style={{ height: 280, background: '#fff', borderBottom: '1px solid rgba(51,65,85,0.4)' }}>
                                    <iframe
                                        srcDoc={msg.chartHtml}
                                        title="Spatial Chart"
                                        style={{ width: '100%', height: '100%', border: 'none' }}
                                        sandbox="allow-scripts"
                                    />
                                </div>
                            )}

                            {/* 错误栈 */}
                            {msg.status === 'failed' && msg.traceback && (
                                <div style={{ padding: '12px 16px', background: 'rgba(239,68,68,0.05)', borderBottom: '1px solid rgba(239,68,68,0.2)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f87171', fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
                                        <CloseOutlined style={{ fontSize: 12 }} /> 沙盒执行崩溃 / 修复超时
                                    </div>
                                    <div style={{
                                        background: 'rgba(30,30,30,0.8)', borderRadius: 8,
                                        padding: '10px 12px', overflowX: 'auto',
                                        fontSize: 12, color: '#fca5a5',
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
                                            color: msg.status === 'failed' ? '#f87171' : '#38bdf8',
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
                                            style={{ color: '#94a3b8', background: 'rgba(255,255,255,0.05)' }}
                                        />
                                    </div>
                                    <textarea
                                        style={{
                                            width: '100%', height: 200,
                                            background: '#1e1e1e', color: '#ce9178',
                                            fontFamily: 'monospace', fontSize: 13,
                                            lineHeight: 1.65, padding: '12px 14px',
                                            borderRadius: 8, border: '1px solid #334155',
                                            outline: 'none', resize: 'vertical',
                                            boxSizing: 'border-box',
                                            boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.3)',
                                        }}
                                        value={editedCodeMap[msg.id] ?? msg.pythonCode}
                                        onChange={e => setEditedCodeMap(prev => ({ ...prev, [msg.id]: e.target.value }))}
                                        spellCheck={false}
                                    />
                                    <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                                        <Button
                                            size="middle"
                                            type="primary"
                                            loading={rerunLoadingMap[msg.id]}
                                            icon={<SettingOutlined />}
                                            style={{
                                                flex: 1.5, fontWeight: 700, fontSize: 13,
                                                background: '#0369a1', borderColor: '#0ea5e9',
                                                boxShadow: '0 2px 10px rgba(14,165,233,0.25)',
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
                                                background: 'rgba(30,41,59,0.8)',
                                                borderColor: '#334155', color: '#94a3b8',
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
    // 主体渲染
    // ─────────────────────────────────────────────
    return (
        <div style={{
            display: 'flex', flexDirection: 'column',
            height: '100%', width: '100%',
            background: '#080c14',
            borderLeft: '1px solid rgba(30,41,59,0.8)',
            overflow: 'hidden',
        }}>
            {/* ── 顶栏 ── */}
            <div style={{
                height: 56, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0 18px',
                background: 'rgba(10,14,22,0.95)',
                borderBottom: '1px solid rgba(30,41,59,0.8)',
                backdropFilter: 'blur(12px)',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: '#22d3ee',
                        boxShadow: '0 0 8px rgba(34,211,238,0.8)',
                    }} />
                    <span style={{
                        fontSize: 14, fontWeight: 800,
                        color: '#e2e8f0', letterSpacing: '0.1em',
                        fontFamily: 'monospace',
                    }}>
                        GEO-Pivot 空间智能
                    </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {selectedFileIds.length > 0 && (
                        <Badge count={selectedFileIds.length} color="#0ea5e9" style={{ marginRight: 6 }}>
                            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>已载入</span>
                        </Badge>
                    )}
                    <Button
                        type="text" size="small"
                        icon={<ClearOutlined style={{ fontSize: 15 }} />}
                        onClick={handleClear}
                        title="清空对话"
                        style={{ color: '#64748b' }}
                    />
                    <Button
                        type="text" size="small"
                        icon={<CloseOutlined style={{ fontSize: 15 }} />}
                        onClick={onClose}
                        title="关闭"
                        style={{ color: '#64748b' }}
                    />
                </div>
            </div>

            {/* ── 警告条 ── */}
            {selectedFileIds.length === 0 && (
                <div style={{
                    margin: '12px 16px 0',
                    padding: '10px 14px',
                    borderRadius: 10,
                    background: 'rgba(120,53,15,0.2)',
                    border: '1px solid rgba(180,83,9,0.3)',
                    display: 'flex', alignItems: 'center', gap: 10,
                    fontSize: 13, color: '#fbbf24', fontWeight: 600,
                }}>
                    <ThunderboltOutlined style={{ fontSize: 15, flexShrink: 0 }} />
                    请先在左侧资源树中勾选需要分析的数据集
                </div>
            )}

            {/* ── 消息列表 ── */}
            <div
                ref={scrollRef}
                style={{
                    flex: 1, overflowY: 'auto', overflowX: 'hidden',
                    padding: '16px',
                    display: 'flex', flexDirection: 'column', gap: 16,
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#1e293b transparent',
                }}
            >
                {messages.map(renderMessage)}
            </div>

            {/* ── 快捷指令 ── */}
            {messages.length <= 2 && selectedFileIds.length > 0 && (
                <div style={{ padding: '0 16px 12px' }}>
                    <p style={{ fontSize: 11, color: '#475569', fontWeight: 700, letterSpacing: '0.1em', marginBottom: 8, fontFamily: 'monospace' }}>
                        快捷指令
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {QUICK_PROMPTS.map(prompt => (
                            <button
                                key={prompt}
                                onClick={() => setInputValue(prompt)}
                                style={{
                                    fontSize: 12.5, padding: '6px 14px', cursor: 'pointer',
                                    borderRadius: 20, border: '1px solid #334155',
                                    background: 'rgba(22,31,46,0.8)', color: '#94a3b8',
                                    fontWeight: 500, transition: 'all 0.2s',
                                }}
                                onMouseEnter={e => {
                                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#0ea5e9';
                                    (e.currentTarget as HTMLButtonElement).style.color = '#38bdf8';
                                    (e.currentTarget as HTMLButtonElement).style.background = 'rgba(14,165,233,0.08)';
                                }}
                                onMouseLeave={e => {
                                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#334155';
                                    (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8';
                                    (e.currentTarget as HTMLButtonElement).style.background = 'rgba(22,31,46,0.8)';
                                }}
                            >
                                {prompt}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* ── 输入区 ── */}
            <div style={{
                flexShrink: 0, padding: '12px 16px 16px',
                borderTop: '1px solid rgba(30,41,59,0.8)',
                background: 'rgba(10,14,22,0.9)',
                backdropFilter: 'blur(12px)',
            }}>
                {/* 模式切换 */}
                <Segmented
                    options={[
                        { label: '数据透视', value: 'pivot' },
                        { label: '空间推算', value: 'feature_calc' },
                        { label: '专业模型', value: 'pro_model' },
                    ]}
                    value={agentMode}
                    onChange={(val) => setAgentMode(val as 'pivot' | 'feature_calc' | 'pro_model')}
                    style={{ marginBottom: 10, width: '100%', fontSize: 12 }}
                    block
                />

                {/* 输入框 + 发送按钮 */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                    <Input.TextArea
                        ref={inputRef}
                        value={inputValue}
                        onChange={e => setInputValue(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSend();
                            }
                        }}
                        placeholder={
                            selectedFileIds.length > 0
                                ? '输入分析需求（Enter 发送，Shift+Enter 换行）'
                                : '等待接入地理图层...'
                        }
                        disabled={loading}
                        autoSize={{ minRows: 2, maxRows: 5 }}
                        style={{
                            flex: 1, fontSize: 14, lineHeight: 1.6,
                            background: '#0f1822', border: '1px solid #1e293b',
                            borderRadius: 10, padding: '10px 13px',
                            color: '#f1f5f9', resize: 'none',
                            boxShadow: 'inset 0 1px 4px rgba(0,0,0,0.3)',
                        }}
                    />
                    <Button
                        type="primary"
                        icon={<SendOutlined style={{ fontSize: 16 }} />}
                        loading={loading}
                        onClick={handleSend}
                        disabled={!inputValue.trim() || loading}
                        style={{
                            width: 44, height: 44, borderRadius: 10,
                            flexShrink: 0, marginBottom: 1,
                            background: 'linear-gradient(135deg, #0369a1, #0ea5e9)',
                            border: 'none',
                            boxShadow: '0 4px 14px rgba(14,165,233,0.35)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                    />
                </div>
            </div>

            {/* 动画注入 */}
            <style>{`
                @keyframes geoFadeUp {
                    from { opacity: 0; transform: translateY(8px); }
                    to   { opacity: 1; transform: translateY(0); }
                }
                textarea:focus {
                    border-color: #0ea5e9 !important;
                    box-shadow: inset 0 1px 4px rgba(0,0,0,0.3), 0 0 0 2px rgba(14,165,233,0.15) !important;
                    outline: none !important;
                }
                .dark-modal-wrap .ant-modal-content {
                    background-color: #1e293b !important;
                    border: 1px solid #334155;
                    border-radius: 16px;
                    overflow: hidden;
                }
                .dark-modal-wrap .ant-modal-header {
                    background-color: #1e293b !important;
                    border-bottom: none !important;
                }
            `}</style>

            {/* 🌟 新增：全屏沉浸式代码编辑器弹窗 */}
            <Modal
                title={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#e2e8f0', fontFamily: 'monospace', fontSize: 16 }}>
                        <CodeOutlined style={{ color: '#38bdf8' }} />
                        <span>算子沙盒全屏编辑器</span>
                    </div>
                }
                open={codeModalVisible} // ⚠️ 如果这里报错，请把它改成 visible={codeModalVisible}
                width={900}
                centered
                destroyOnClose
                bodyStyle={{ 
                    padding: '20px 24px', 
                    background: '#0f172a',
                    borderBottom: '1px solid #334155',
                    borderTop: '1px solid #334155'
                }}
                okText="保存修改"
                cancelText="取消"
                okButtonProps={{ 
                    style: { background: '#0ea5e9', borderColor: '#0ea5e9', fontWeight: 'bold' } 
                }}
                cancelButtonProps={{
                    style: { color: '#94a3b8', borderColor: '#475569', background: 'transparent' }
                }}
                onCancel={() => setCodeModalVisible(false)}
                onOk={() => {
                    if (activeCodeMsgId) {
                        setEditedCodeMap(prev => ({ ...prev, [activeCodeMsgId]: tempModalCode }));
                    }
                    setCodeModalVisible(false);
                }}
                /* 强制背景色，覆盖默认的白色 */
                wrapClassName="dark-modal-wrap"
            >
                <div style={{ display: 'flex', flexDirection: 'column', height: '65vh' }}>
                    <div style={{ color: '#64748b', fontSize: 13, marginBottom: 12, display: 'flex', justifyContent: 'space-between' }}>
                        <span>编辑完成后点击“保存修改”，即可在面板中使用“应用修改并重跑”测试代码。</span>
                        <span style={{ fontFamily: 'monospace' }}>Python 3.9+ 环境</span>
                    </div>
                    <textarea
                        style={{
                            flex: 1, width: '100%',
                            background: '#1e1e1e', color: '#ce9178',
                            fontFamily: 'monospace', fontSize: 14.5,
                            lineHeight: 1.7, padding: '20px',
                            borderRadius: 10, border: '1px solid #334155',
                            outline: 'none', resize: 'none',
                            boxShadow: 'inset 0 4px 12px rgba(0,0,0,0.5)',
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