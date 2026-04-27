import React, { useState, useRef, useEffect } from 'react';
import { Button, Input, Avatar, Spin, Badge, Segmented, App } from 'antd';
import {
    SendOutlined, RobotOutlined, UserOutlined, ClearOutlined,
    CloseOutlined, ThunderboltOutlined, CodeOutlined, SettingOutlined, CheckCircleOutlined
} from '@ant-design/icons';
import { geoService } from '../../../services/geoService';
import ReactECharts from 'echarts-for-react';
import { useAnalysisStore, type ChartType } from '../../../stores/useAnalysisStore';

// ============================================================
// 类型定义
// ============================================================
interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    // === 混合视图扩展字段 ===
    engine?: 'echarts' | 'html_iframe';
    chartOption?: any;
    chartHtml?: string;
    pythonCode?: string;
    blueprint?: any; // 用于 rerun 时将蓝图一并回传给后端
    status?: 'failed' | 'success'; // 是否为人机接管降级
    traceback?: string;            // 真实 Python 报错沙盒栈
}

interface GeoAIAgentProps {
    selectedFileIds?: string[];
    isOpen?: boolean;
    onClose?: () => void;
}

// ============================================================
// 预设问题建议（引导用户）
// ============================================================
const QUICK_PROMPTS = [
    '统计各图层的要素数量',
    '计算缓冲区并显示结果',
    '找出两图层的空间交集',
    '分析点数据的空间分布',
];

// ============================================================
// GeoAIAgent 组件 - 嵌入式面板设计
// ============================================================
const GeoAIAgent: React.FC<GeoAIAgentProps> = ({
    selectedFileIds = [],
    isOpen = false,
    onClose,
}) => {
    const { message } = App.useApp();
    const [agentMode, setAgentMode] = useState<'pivot' | 'feature_calc' | 'pro_model'>('pivot');
    const [inputValue, setInputValue] = useState('');
    const [loading, setLoading] = useState(false);
    // 每条消息独立的「代码编辑状态」：key = msg.id, value = 当前编辑的代码文本
    const [editedCodeMap, setEditedCodeMap] = useState<Record<string, string>>({});
    // 每条消息独立的「重跑 loading 状态」
    const [rerunLoadingMap, setRerunLoadingMap] = useState<Record<string, boolean>>({});
    
    // 全局状态同步
    const { 
        setPivotResult, setPivotConfig, setPivotPanelOpen, 
        setAiChartOption, setAiChartHtml, setChartMode, setChartVisible,
        setChartType 
    } = useAnalysisStore();

    // 辅助函数：将 AI 返回的新数据结构同步到全局图表和透视表
    const syncToGlobalStore = (res: any) => {
        if (!res.tableData || res.tableData.length === 0) return;
        
        let rawData = res.tableData;
        let displayData = rawData;
        
        // 如果数据量太大，截取前 50 和 后 50
        if (rawData.length > 100) {
            displayData = [...rawData.slice(0, 50), ...rawData.slice(-50)];
        }

        // 识别行索引名和其它数值列
        const columns = Object.keys(displayData[0] || {}).filter(k => k !== 'geometry');
        if (columns.length === 0) return;

        const rowKeyName = columns[0];
        const valueColumns = columns.slice(1);

        // 转换成 SplitTablePanel 需要的格式 (必须包含 rowKey 字段)
        const formattedPivotData = displayData.map((row: any) => ({
            rowKey: row[rowKeyName] ?? 'Unknown',
            ...row
        }));

        setPivotResult(formattedPivotData, valueColumns);
        setPivotConfig({ groupByRow: rowKeyName, method: 'sum' });

        // 【核心修复】：智能切换前端的图表类型状态
        if (res.aiChartType) {
            // 将后端的 'radar' 转换为前端 store 期望的格式（如 'Radar', 'Pie'）
            const formattedType = res.aiChartType.charAt(0).toUpperCase() + res.aiChartType.slice(1);
            
            // 如果后端说是 line，我们可以映射到前端的 Line 等等
            // 请确保这里映射的值与你 ChartOverlay 中 Segmented 组件的 value 完全一致
            if (['Bar', 'Line', 'Pie', 'Radar', 'Heatmap', 'Scatter', 'BoxPlot', 'Ridgeline'].includes(formattedType)) {
                setChartType(formattedType as ChartType);
            } else {
                setChartType('Bar'); // 兜底
            }
        }

        if (res.engine || res.chartHtml || res.chartOption || res.aiChartType) {
            setAiChartOption(res.chartOption || null);
            setAiChartHtml(res.chartHtml || null);

            // 【核心修复】：智能判断渲染主导权
            // 如果后端没有强行塞过来 chartOption 和 chartHtml，说明是交由前端原生组件配置渲染的！
            if (!res.chartOption && !res.chartHtml) {
                setChartMode('traditional'); // 解除 AI 锁定，释放所有原生 UI 控件！
            } else {
                setChartMode('ai');     // 只有复杂的 iframe 气泡图/HTML才保持 AI 锁定
            }
            setChartVisible(true);
        }
        
        setPivotPanelOpen(true);
    };

    const [messages, setMessages] = useState<ChatMessage[]>([
        {
            id: 'welcome',
            role: 'assistant',
            content: '你好！我是 **GeoAI 空间智能助手**。\n\n请先在左侧文件树中勾选需要分析的数据图层，然后输入你的分析需求。\n\n例如："统计南京每个公园1km内的停车场数量"',
            timestamp: Date.now(),
        }
    ]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<any>(null);

    // 消息更新时自动滚到底部
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    // 面板打开时聚焦输入框
    useEffect(() => {
        if (isOpen) {
            setTimeout(() => inputRef.current?.focus(), 300);
        }
    }, [isOpen]);

    // ----------------------------------------------------------------
    // 发送消息
    // ----------------------------------------------------------------
    const handleSend = async () => {
        if (!inputValue.trim() || loading) return;

        const userMsg: ChatMessage = {
            id: `u-${Date.now()}`,
            role: 'user',
            content: inputValue,
            timestamp: Date.now(),
        };
        setMessages(prev => [...prev, userMsg]);
        const currentInput = inputValue;
        setInputValue('');
        setLoading(true);

        // 添加"思考中"占位消息
        const thinkingId = `thinking-${Date.now()}`;
        setMessages(prev => [...prev, {
            id: thinkingId,
            role: 'system',
            content: 'thinking',
            timestamp: Date.now(),
        }]);

        // 获取最后一次成功的AI回复中的 blueprint 和 pythonCode 作为上下文
        const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant' && m.blueprint && m.pythonCode);
        const context = lastAssistantMsg ? {
            lastBlueprint: lastAssistantMsg.blueprint,
            lastPythonCode: lastAssistantMsg.pythonCode
        } : undefined;

        try {
            const response = await geoService.generateModelByAI({
                userPrompt: currentInput,
                fileIds: selectedFileIds,
                context: context,
                agentMode: agentMode
            });
            
            //   修复后的拦截逻辑
            if (agentMode === 'pro_model' && response.newFileId) {
                message.success(response.message || "模型运算完成！");
                
                // 抛出全局事件，通知 FileTree 组件刷新
                window.dispatchEvent(new CustomEvent('REFRESH_FILE_TREE'));
                
                // 3.   使用 ChatMessage 类型，并使用 role 和 content 字段
                const aiMessage: ChatMessage = {
                    id: Date.now().toString(),
                    role: 'assistant', // 注意：这里是 role, 不是 sender
                    content: `我已经完成了模型运算。分析结果已自动为您保存为独立文件并放置在左侧资源树中。您可以在左侧双击预览或导出下载。`, // 注意：这里是 content, 不是 text
                    timestamp: Date.now(),
                    pythonCode: response.pythonCode
                };
                setMessages(prev => [...prev, aiMessage]);
                
                // 4.   使用 setLoading
                setLoading(false); 
                return; // 直接结束
            }

            // 如果后端返回状态为 failed（自愈彻底失败降级机制）
            if (response.status === 'failed') {
                setMessages(prev => {
                    const filtered = prev.filter(m => m.id !== thinkingId);
                    return [...filtered, {
                        id: `err-${Date.now()}`,
                        role: 'assistant',
                        content: response.error_message || 'AI 多次尝试修复代码失败，已切换至人工接管模式。',
                        timestamp: Date.now(),
                        status: 'failed',
                        traceback: response.traceback,
                        pythonCode: response.pythonCode,
                        blueprint: context?.lastBlueprint
                    }];
                });
                return; // 直接跳出，绝对不触发图表渲染
            }

            // 调用辅助函数，把透视结果和图表塞给主界面 (成功时)
            syncToGlobalStore(response);

            // 移除占位，添加正式回复
            setMessages(prev => {
                const filtered = prev.filter(m => m.id !== thinkingId);
                return [...filtered, {
                    id: `a-${Date.now()}`,
                    role: 'assistant',
                    content: response.blueprint?.explanation
                        || response.message
                        || ' 分析完成！请查看分析结果和生成的执行代码。',
                    timestamp: Date.now(),
                    engine: response.engine,
                    chartOption: response.chartOption,
                    chartHtml: response.chartHtml,
                    pythonCode: response.pythonCode,
                    blueprint: response.blueprint  // 保存蓝图，用于 rerun 时绘图
                }];
            });

        } catch (error: any) {
            const errData = error.response?.data;
            setMessages(prev => {
                const filtered = prev.filter(m => m.id !== thinkingId);
                return [...filtered, {
                    id: `err-${Date.now()}`,
                    role: 'assistant',
                    content: `  分析失败：${errData?.details || error.message || '未知错误'}`,
                    timestamp: Date.now(),
                    // 即使失败，也将中间产物传给渲染函数，以便用户审查代码
                    pythonCode: errData?.pythonCode,
                    chartHtml: 'error' // 标记为错误状态
                }];
            });
        } finally {
            setLoading(false);
        }
    };

    const handleClear = () => {
        setMessages([{
            id: 'cleared',
            role: 'assistant',
            content: '对话已清空。请选择数据图层后重新开始。',
            timestamp: Date.now(),
        }]);
    };

    // ----------------------------------------------------------------
    // 渲染单条消息
    // ----------------------------------------------------------------
    const renderMessage = (msg: ChatMessage) => {
        if (msg.role === 'system' && msg.content === 'thinking') {
            return (
                <div key={msg.id} className="flex items-start gap-2.5 my-3">
                    <Avatar
                        size={28}
                        icon={<RobotOutlined />}
                        className="shrink-0 bg-gradient-to-br from-blue-600 to-violet-600 shadow-md"
                    />
                    <div className="flex items-center gap-2 bg-geo-dark/80 border border-geo-border px-3 py-2 rounded-xl rounded-tl-none">
                        <Spin size="small" />
                        <span className="text-[11px] text-geo-text-secondary animate-pulse">正在思考分析方案...</span>
                    </div>
                </div>
            );
        }

        const isUser = msg.role === 'user';

        return (
            <div
                key={msg.id}
                className={`flex items-start gap-2.5 my-3 ${isUser ? 'flex-row-reverse' : ''}`}
            >
                <Avatar
                    size={28}
                    icon={isUser ? <UserOutlined /> : <RobotOutlined />}
                    className={`shrink-0 shadow-md ${
                        isUser
                            ? 'bg-geo-accent'
                            : 'bg-gradient-to-br from-blue-600 to-violet-600'
                    }`}
                />
                <div className="flex flex-col gap-2 max-w-[85%]">
                    <div
                        className={`px-3.5 py-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap rounded-xl shadow-sm ${
                            isUser
                                ? 'bg-geo-accent text-white rounded-tr-none'
                                : 'bg-geo-dark/80 border border-geo-border text-geo-text-secondary rounded-tl-none'
                        }`}
                    >
                        {msg.content}
                    </div>
                    
                    {/*       混合渲染容器       */}
                    {!isUser && (msg.pythonCode || msg.engine) && (
                        <div className="w-[320px] bg-geo-dark/95 border border-geo-border rounded-xl overflow-hidden shadow-lg animate-fade-in flex flex-col">
                            
                            {/* 图表渲染区 */}
                            {msg.engine === 'echarts' && msg.chartOption && (
                                <div className="w-full bg-slate-800/50 border-b border-geo-border p-1">
                                    <ReactECharts option={msg.chartOption} style={{ height: '240px', width: '100%' }} />
                                </div>
                            )}
                            {msg.engine === 'html_iframe' && msg.chartHtml && (
                                <div className="w-full h-[260px] bg-white border-b border-geo-border">
                                    <iframe srcDoc={msg.chartHtml} title="Spatial Chart" className="w-full h-full border-none" sandbox="allow-scripts"/>
                                </div>
                            )}

                            {/* 当状态为 failed 时的特殊回显：Traceback 栈和警示标签 */}
                            {msg.status === 'failed' && msg.traceback && (
                                <div className="p-3 bg-red-950/40 border-b border-red-900/50">
                                    <div className="flex items-center gap-1.5 text-red-400 font-bold text-xs mb-2">
                                        <CloseOutlined /> 
                                        沙盒崩溃 / 自动自愈逾期限界
                                    </div>
                                    <div className="bg-[#1e1e1e]/60 rounded p-2 overflow-x-auto text-[10px] text-red-300 font-mono select-text border border-red-900/30">
                                        {msg.traceback}
                                    </div>
                                </div>
                            )}

                            {/* 代码透视区 */}
                            {msg.pythonCode && (
                                <div className="p-2">
                                    <div className="flex items-center gap-2 mb-1.5 px-1 text-[10px] text-zinc-400 font-mono tracking-wider">
                                        <CodeOutlined className={msg.status === 'failed' ? "text-red-400" : "text-geo-accent"} /> 
                                        {msg.status === 'failed' ? '请审查并修正以下导致崩溃的算子代码：' : '沙盒算子代码 (Python) — 可直接修改后重新执行'}
                                    </div>
                                    <textarea
                                        className="w-full h-32 bg-[#1e1e1e] text-[#ce9178] font-mono text-[11px] p-2 rounded-lg border border-[#333] outline-none shadow-inner resize-y transition-colors focus:border-geo-accent"
                                        value={editedCodeMap[msg.id] ?? msg.pythonCode}
                                        onChange={e => setEditedCodeMap(prev => ({ ...prev, [msg.id]: e.target.value }))}
                                        spellCheck={false}
                                    />
                                    
                                    {/* 交互闭环控制 */}
                                    <div className="flex gap-2 mt-2 px-1">
                                        <Button 
                                            size="small" 
                                            type="primary" 
                                            loading={rerunLoadingMap[msg.id]}
                                            icon={<SettingOutlined />}
                                            className="flex-1 text-[11px] bg-geo-accent/90 hover:bg-geo-accent"
                                            onClick={async () => {
                                                const codeToRun = editedCodeMap[msg.id] ?? msg.pythonCode ?? '';
                                                if (!codeToRun || selectedFileIds.length === 0) return;

                                                setRerunLoadingMap(prev => ({ ...prev, [msg.id]: true }));
                                                try {
                                                    const res = await geoService.rerunCode({
                                                        pythonCode: codeToRun,
                                                        fileIds: selectedFileIds,
                                                        blueprint: msg.blueprint
                                                    });
                                                    
                                                    // 推送到主界面视图
                                                    syncToGlobalStore(res);

                                                    // 更新该条消息的图表和代码内容
                                                    setMessages(prev => prev.map(m => m.id !== msg.id ? m : {
                                                        ...m,
                                                        engine: res.engine,
                                                        chartOption: res.chartOption,
                                                        chartHtml: res.chartHtml,
                                                        pythonCode: codeToRun,
                                                        content: res.engine
                                                            ? ` 重跑成功！图表已更新。`
                                                            : m.content
                                                    }));
                                                } catch (err: any) {
                                                    const detail = err.response?.data?.details || err.message;
                                                    setMessages(prev => prev.map(m => m.id !== msg.id ? m : {
                                                        ...m,
                                                        content: `  重跑失败：${detail}`
                                                    }));
                                                } finally {
                                                    setRerunLoadingMap(prev => ({ ...prev, [msg.id]: false }));
                                                }
                                            }}
                                        >
                                            重新执行代码
                                        </Button>
                                        <Button 
                                            size="small" 
                                            icon={<CheckCircleOutlined />}
                                            className="flex-[0.8] text-[11px] border-geo-border text-geo-text-secondary hover:text-green-400 hover:border-green-400/50"
                                            onClick={() => { /* TODO: Hook up model registry */ }}
                                        >
                                            固化为服务
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

    // ----------------------------------------------------------------
    // 面板 UI
    // ----------------------------------------------------------------
    return (
        <div className="flex flex-col h-full w-full bg-geo-panel">
            {/* === 顶栏 === */}
            <div className="h-11 flex items-center justify-between px-4 border-b border-geo-border shrink-0 bg-geo-dark/60">
                <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.8)] animate-pulse" />
                    <span className="text-[11px] font-semibold text-geo-text-primary tracking-wider uppercase">GeoAI 助手</span>
                </div>
                <div className="flex items-center gap-1.5">
                    {selectedFileIds.length > 0 && (
                        <Badge count={selectedFileIds.length} size="small" color="#3b82f6">
                            <span className="text-[10px] text-geo-text-secondary">图层</span>
                        </Badge>
                    )}
                    <Button
                        type="text"
                        size="small"
                        icon={<ClearOutlined />}
                        onClick={handleClear}
                        className="text-geo-text-secondary hover:text-geo-text-primary hover:bg-white/5"
                        title="清空对话"
                    />
                    <Button
                        type="text"
                        size="small"
                        icon={<CloseOutlined />}
                        onClick={onClose}
                        className="text-geo-text-secondary hover:text-red-400 hover:bg-white/5"
                        title="关闭面板"
                    />
                </div>
            </div>

            {/* === 未选图层提示 === */}
            {selectedFileIds.length === 0 && (
                <div className="mx-3 mt-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-400/80 flex items-center gap-2">
                    <ThunderboltOutlined className="shrink-0" />
                    请先在左侧资源管理器中勾选数据图层
                </div>
            )}

            {/* === 消息区 === */}
            <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto px-3 py-2 space-y-0 scroll-smooth"
                style={{
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#334155 transparent',
                }}
            >
                {messages.map(renderMessage)}
            </div>

            {/* === 快捷问题 === */}
            {messages.length <= 2 && selectedFileIds.length > 0 && (
                <div className="px-3 pb-2">
                    <p className="text-[10px] text-geo-text-secondary mb-1.5 uppercase tracking-wider">快捷分析</p>
                    <div className="flex flex-wrap gap-1.5">
                        {QUICK_PROMPTS.map(prompt => (
                            <button
                                key={prompt}
                                onClick={() => setInputValue(prompt)}
                                className="text-[11px] px-2.5 py-1 rounded-full bg-geo-dark border border-geo-border text-geo-text-secondary hover:border-blue-500/60 hover:text-blue-400 transition-all duration-150"
                            >
                                {prompt}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* === 输入区 === */}
            <div className="shrink-0 px-3 pb-3 pt-2 border-t border-geo-border bg-geo-dark/40">
                {/*   新增：模式切换器   */}
                <Segmented
                    options={[
                        { label: '数据透视', value: 'pivot' },
                        { label: '特征计算', value: 'feature_calc' },
                        { label: '专业模型', value: 'pro_model' }
                    ]}
                    value={agentMode}
                    onChange={(val) => setAgentMode(val as 'pivot' | 'feature_calc')}
                    className="mb-2 bg-[#0f172a] text-gray-400 border border-geo-border"
                />
                <div className="flex gap-2 items-end">
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
                                ? '输入分析指令（Enter 发送，Shift+Enter 换行）...'
                                : '请先选择数据图层...'
                        }
                        disabled={loading}
                        autoSize={{ minRows: 2, maxRows: 5 }}
                        className="flex-1 text-[12px] resize-none"
                        style={{
                            background: '#0f172a',
                            border: '1px solid #334155',
                            borderRadius: '8px',
                            color: '#f1f5f9',
                        }}
                    />
                    <Button
                        type="primary"
                        icon={<SendOutlined />}
                        size="middle"
                        loading={loading}
                        onClick={handleSend}
                        disabled={!inputValue.trim() || loading}
                        className="mb-0.5 shrink-0 h-9 w-9 flex items-center justify-center rounded-lg bg-blue-600 border-blue-500 hover:bg-blue-500 shadow-[0_4px_12px_rgba(59,130,246,0.4)]"
                    />
                </div>
                <p className="text-[10px] text-geo-text-secondary/50 mt-1.5 text-center">
                    已关联 {selectedFileIds.length} 个图层 · Enter 发送 · Shift+Enter 换行
                </p>
            </div>
        </div>
    );
};

export default GeoAIAgent;