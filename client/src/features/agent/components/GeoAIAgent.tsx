import React, { useState, useRef, useEffect } from 'react';
import { 
    Bot, 
    Sparkles, 
    TerminalSquare, 
    X, 
    Send, 
    CheckCircle2, 
    Loader2, 
    Code2,
    Cpu
} from 'lucide-react';
import { geoService } from '../../../services/geoService';

interface ChatMessage {
    role: 'system' | 'user' | 'agent';
    content: string;
}

const GeoAIAgent: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generatedCode, setGeneratedCode] = useState<string | null>(null);
    const [prompt, setPrompt] = useState('');
    
    // 聊天记录状态
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([
        { role: 'system', content: '欢迎使用智能模型生成器。请直接用自然语言描述您的空间分析需求，我将自动推导模型参数并生成底层算子代码。' }
    ]);

    const chatScrollRef = useRef<HTMLDivElement>(null);

    // 每次聊天更新时，自动滚动到底部
    useEffect(() => {
        if (chatScrollRef.current) {
            chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
        }
    }, [chatHistory]);

    const handleAIGenerate = async () => {
        if (!prompt.trim() || isGenerating) return;

        const userText = prompt.trim();
        setPrompt(''); // 清空输入框
        setGeneratedCode(null);
        setIsGenerating(true);

        // 把用户输入加入聊天流
        setChatHistory(prev => [...prev, { role: 'user', content: userText }]);

        try {
            // 现在我们只需要传用户说的这句话给后端！
            const payload = {
                userDescription: userText
            };

            const response = await geoService.generateModelByAI(payload);
            
            // 后端把 AI 起好的真实名字返回来了！
            const realModelName = response.data.modelName;
            const realDisplayName = response.data.displayName;

            setGeneratedCode(response.previewCode);
            setChatHistory(prev => [...prev, { 
                role: 'agent', 
                content: `模型构建完成！已为您命名为【${realDisplayName}】(${realModelName}) 并挂载至系统。请在右侧终端查看底层逻辑。\n\n 调用语法: =${realModelName}()` 
            }]);
            
            // 发送全局事件，通知 AnalysisPanel 更新模型列表
            window.dispatchEvent(new CustomEvent('geoai-model-added', { detail: response.data }));
            
        } catch (error: any) {
            const errorMsg = error.response?.data?.error || '神经元连接失败，请重试';
            setChatHistory(prev => [...prev, { role: 'agent', content: `[Error]: ${errorMsg}` }]);
        } finally {
            setIsGenerating(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleAIGenerate();
        }
    };

    return (
        <div className="fixed bottom-6 left-6 z-9999 flex flex-col items-start font-sans pointer-events-none">
            {/* ========================================== */}
            {/*   弹出式左右分栏 UI (Split-Pane Dialog) */}
            {/* ========================================== */}
            <div 
                className={`mb-4 overflow-hidden transition-all duration-500 origin-bottom-left ${
                    isOpen ? 'scale-100 opacity-100 pointer-events-auto' : 'scale-0 opacity-0 pointer-events-none'
                }`}
                style={{ width: '850px', height: '520px' }} 
            >
                <div className="w-full h-full rounded-2xl bg-geo-dark/95 backdrop-blur-xl border border-blue-500/40 shadow-[0_20px_50px_rgba(0,0,0,0.8),0_0_30px_rgba(59,130,246,0.2)] flex flex-col overflow-hidden">
                    
                    {/* 顶部控制栏 */}
                    <div className="h-12 bg-linear-to-r from-geo-panel to-geo-dark border-b border-blue-500/20 px-5 flex justify-between items-center shrink-0">
                        <div className="flex items-center text-blue-400 font-mono text-xs tracking-widest font-bold drop-shadow-[0_0_8px_rgba(59,130,246,0.6)]">
                            <Sparkles className="w-4 h-4 mr-2" /> 
                            GEOAI
                        </div>
                        <button onClick={() => setIsOpen(false)} className="text-slate-400 hover:text-white transition-colors bg-slate-800/50 hover:bg-red-500/80 p-1.5 rounded-full">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {/* 主体分栏区 */}
                    <div className="flex-1 flex overflow-hidden">
                        
                        {/* 左侧：自然语言对话区 (Chat Panel) */}
                        <div className="w-[45%] flex flex-col border-r border-slate-700/60 bg-[#162032]/50 relative">
                            {/* 对话历史记录区 */}
                            <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                                {chatHistory.map((msg, idx) => (
                                    <div key={idx} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                                        <div className={`flex items-center gap-2 mb-1.5 px-1 opacity-80 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                                            {msg.role === 'user' ? <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-white"><Sparkles className="w-3 h-3"/></div> : 
                                             msg.role === 'system' ? <Cpu className="w-4 h-4 text-emerald-400"/> : 
                                             <Bot className="w-4 h-4 text-blue-400"/>}
                                            <span className="text-[10px] font-mono text-slate-400 tracking-wider">
                                                {msg.role.toUpperCase()}
                                            </span>
                                        </div>
                                        <div className={`px-4 py-2.5 rounded-2xl text-xs leading-relaxed max-w-[90%] shadow-md wrap-break-word ${
                                            msg.role === 'user' 
                                                ? 'bg-blue-600/90 text-white rounded-tr-sm' 
                                                : msg.role === 'system'
                                                ? 'bg-emerald-900/30 border border-emerald-500/30 text-emerald-200 rounded-tl-sm'
                                                : 'bg-slate-800 border border-slate-700 text-slate-200 rounded-tl-sm'
                                        }`}>
                                            {msg.content}
                                        </div>
                                    </div>
                                ))}
                                {isGenerating && (
                                    <div className="flex items-start">
                                        <div className="px-4 py-3 rounded-2xl bg-slate-800 border border-blue-500/30 text-blue-300 rounded-tl-sm flex items-center gap-3">
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            <span className="text-xs font-mono tracking-widest animate-pulse">解析语义并编写算子...</span>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* 模糊输入区 */}
                            <div className="p-4 bg-geo-dark border-t border-slate-800 shrink-0 relative">
                                <textarea 
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    placeholder="输入指令 (例: 帮我写一个综合风险评估模型，第一列权重0.3...)"
                                    className="w-full bg-slate-900/80 border border-slate-700 rounded-xl px-4 py-3 pr-12 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 resize-none h-20 custom-scrollbar transition-all"
                                />
                                <button 
                                    onClick={handleAIGenerate}
                                    disabled={!prompt.trim() || isGenerating}
                                    className={`absolute right-6 bottom-7 p-2 rounded-lg flex items-center justify-center transition-all ${
                                        prompt.trim() && !isGenerating 
                                        ? 'bg-blue-600 text-white hover:bg-blue-500 hover:shadow-[0_0_10px_rgba(37,99,235,0.6)]' 
                                        : 'bg-slate-800 text-slate-600 cursor-not-allowed'
                                    }`}
                                >
                                    <Send className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        {/* 右侧：代码终端区 (Terminal Panel) */}
                        <div className="w-[55%] bg-[#090e17] flex flex-col relative overflow-hidden">
                            {/* Mac风格终端头 */}
                            <div className="h-9 bg-[#161b22] border-b border-slate-800 flex items-center px-4 shrink-0">
                                <div className="flex gap-1.5">
                                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/80"></div>
                                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80"></div>
                                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/80"></div>
                                </div>
                                <div className="mx-auto flex items-center text-slate-500 text-[10px] font-mono tracking-widest">
                                    <TerminalSquare className="w-3 h-3 mr-1.5" />
                                    python_engine/models/auto_agent.py
                                </div>
                            </div>
                            
                            {/* 代码内容区 */}
                            <div className="flex-1 p-5 overflow-auto custom-scrollbar relative">
                                {!generatedCode && !isGenerating && (
                                    <div className="absolute inset-0 flex flex-col items-center justify-center opacity-20 pointer-events-none">
                                        <Code2 className="w-24 h-24 mb-4 text-blue-500" />
                                        <span className="font-mono text-blue-500 tracking-widest">AWAITING GENERATION</span>
                                    </div>
                                )}

                                {isGenerating && (
                                    <div className="h-full w-full flex flex-col items-center justify-center text-blue-500/60 font-mono text-sm">
                                        <div className="relative w-16 h-16 mb-4">
                                            <div className="absolute inset-0 border-t-2 border-blue-500 rounded-full animate-spin"></div>
                                            <div className="absolute inset-2 border-r-2 border-cyan-400 rounded-full animate-spin animation-delay-150"></div>
                                        </div>
                                        <span className="animate-pulse tracking-widest">BUILDING KERNEL...</span>
                                    </div>
                                )}

                                {generatedCode && !isGenerating && (
                                    <div className="animate-fade-in-up">
                                        <div className="flex items-center gap-2 mb-4 text-emerald-400 bg-emerald-950/30 border border-emerald-900/50 px-3 py-1.5 rounded font-mono text-xs">
                                            <CheckCircle2 className="w-4 h-4" /> COMPILATION SUCCESSFUL
                                        </div>
                                        <pre className="text-[12px] font-mono leading-relaxed text-emerald-300 m-0 filter drop-shadow-[0_0_2px_rgba(52,211,153,0.3)]">
                                            <code>{generatedCode}</code>
                                        </pre>
                                    </div>
                                )}
                            </div>
                        </div>

                    </div>
                </div>
            </div>

            {/* ========================================== */}
            {/*   左下角悬浮发光触发器 (FAB) */}
            {/* ========================================== */}
            <div className="relative group pointer-events-auto">
                <div className="absolute -inset-1.5 bg-linear-to-r from-blue-600 to-cyan-400 rounded-full blur opacity-40 group-hover:opacity-80 transition duration-500 animate-pulse"></div>
                <button 
                    onClick={() => setIsOpen(!isOpen)}
                    className="relative w-14 h-14 bg-linear-to-br from-slate-900 to-geo-dark border border-blue-500/50 rounded-full flex items-center justify-center shadow-[0_0_20px_rgba(0,0,0,0.8)] cursor-pointer hover:scale-110 transition-transform duration-300 z-50 overflow-hidden"
                >
                    {/* 内部极光扫过效果 */}
                    <div className="absolute inset-0 bg-linear-to-br from-transparent via-blue-400/10 to-transparent -translate-x-full group-hover:animate-shimmer"></div>
                    {isOpen ? <X className="text-2xl text-blue-300 transition-all duration-300 rotate-90" /> : <Bot className="text-2xl text-blue-400 transition-all duration-300" />}
                </button>
                
                {/* 提示气泡 */}
                {!isOpen && (
                    <div className="absolute left-16 top-1/2 -translate-y-1/2 px-4 py-2 bg-geo-dark/95 backdrop-blur border border-blue-900 rounded-lg text-xs text-blue-300 font-mono tracking-wider whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none shadow-[0_5px_15px_rgba(0,0,0,0.5)] flex items-center">
                        <Sparkles className="w-3 h-3 mr-2" />
                        INITIATE AI AGENT
                    </div>
                )}
            </div>
            
            <style>{`
                .custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; border: 1px solid #0f172a; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #3b82f6; }
                @keyframes shimmer {
                    100% { transform: translateX(100%); }
                }
                .animate-shimmer {
                    animation: shimmer 2s infinite;
                }
                .animation-delay-150 {
                    animation-delay: 150ms;
                }
            `}</style>
        </div>
    );
};

export default GeoAIAgent;