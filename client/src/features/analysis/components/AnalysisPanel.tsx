import React, { useState, useEffect } from 'react';
import { Select, Button, Form, ConfigProvider, theme, App, Segmented, Tooltip } from 'antd';
import { 
    PlayCircleOutlined, 
    DotChartOutlined, 
    BarChartOutlined, 
    FunctionOutlined,
    ExperimentOutlined,
    AreaChartOutlined,
    DeploymentUnitOutlined, // ✅ [新增] 用这个图标代表山脊图/分段
    ThunderboltOutlined,
    BoxPlotOutlined, // ✅ [新增] 引入图标
} from '@ant-design/icons';
import { useAnalysisStore } from '../../../stores/useAnalysisStore';
import apiClient from '../../../services/apiClient';

const { Option } = Select;

interface AnalysisPanelProps {
    fileId: string;
    fields: string[]; 
}

type StatMode = 'Pivot' | 'Scatter';

const AnalysisPanel: React.FC<AnalysisPanelProps> = ({ fileId, fields }) => {
    const { message } = App.useApp();
    const { 
        pivotConfig, setPivotConfig, 
        scatterConfig, setScatterConfig, 
        setRawScatterData, setChartType, 
        setLoading, 
        setPivotResult, 
        setPivotPanelOpen,
        setChartVisible
    } = useAnalysisStore();

    const [statMode, setStatMode] = useState<StatMode>('Pivot');

    // 🌟 1. 增加模型列表状态
    const [availableModels, setAvailableModels] = useState<any[]>([]);

    useEffect(() => {
        const fetchModels = async () => {
            try {
                const res = await apiClient.get('/analysis/models');
                if (res.data.code === 200) {
                    setAvailableModels(res.data.data);
                }
            } catch (error) {
                console.error('获取可用模型失败:', error);
            }
        };
        fetchModels();

        // 🌟 新增：监听左下角 GeoAIAgent 派发的模型生成成功事件
        const handleModelAdded = (e: any) => {
            if (e.detail) {
                setAvailableModels(prev => [...prev, e.detail]);
            }
        };
        window.addEventListener('geoai-model-added', handleModelAdded);
        
        return () => window.removeEventListener('geoai-model-added', handleModelAdded);
    }, []);

    // --- 1. 透视分析逻辑 ---
    const handlePivotAnalyze = async () => {
        if (!fileId) { message.warning('请先在工作空间选择一个文件'); return; }
        if (!pivotConfig.groupByRow) { message.warning('请至少选择行分组字段'); return; }
        // ✅ [修改] 箱线图模式下也需要 valueField
        if (pivotConfig.method !== 'count' && !pivotConfig.valueField) { message.warning('请选择统计字段 (Value)'); return; }
        setLoading(true);
        try {
            const res = await apiClient.post('/analysis/pivot', {
                fileId: fileId,
                groupByRow: pivotConfig.groupByRow,
                groupByCol: pivotConfig.groupByCol,
                valueField: pivotConfig.valueField,
                method: pivotConfig.method
            });

            if (res.data.success) {
                setPivotResult(res.data.data, res.data.columns);
                setPivotPanelOpen(true);
                
                // ✅ [新增] 自动切换图表类型
                if (pivotConfig.method === 'boxplot') {
                    setChartType('BoxPlot'); 
                } else if (pivotConfig.method === 'ridgeline') {
                    setChartType('Ridgeline'); // 自动切到山脊图
                } else {
                    setChartType('Bar'); 
                }
                
                setChartVisible(true);
                message.success('透视分析完成');
            }
        } catch (error) {
            console.error(error);
            message.error('分析失败，请检查网络');
        } finally {
            setLoading(false);
        }
    };

    // --- 2. 散点分析逻辑 ---
    const handleScatterAnalyze = async () => {
        if (!fileId) { message.warning('请先选择文件'); return; }
        if (!scatterConfig.xField || !scatterConfig.yField) { message.warning('请选择 X 轴和 Y 轴字段'); return; }

        setLoading(true);
        try {
            const res = await apiClient.get(`/files/${fileId}/data`, {
                params: { page: 1, pageSize: 5000 }
            });

            if (res.data.code === 200) {
                const features = res.data.data.features;
                const rawData = features.map((f: any) => f.properties);
                setRawScatterData(rawData);
                setChartType('Scatter'); 
                setChartVisible(true);
                message.success(`已加载 ${rawData.length} 个数据点`);
            } else {
                message.error(res.data.message || '获取数据失败');
            }
        } catch (error) {
            console.error(error);
            message.error('获取数据失败');
        } finally {
            setLoading(false);
        }
    };

    if (!fileId) return <div className="p-8 text-gray-500 text-sm text-center flex flex-col items-center justify-center h-full opacity-50"><ExperimentOutlined className="text-4xl mb-4"/>请先选择一个文件以激活工具箱</div>;

    return (
        <div className="p-4 flex flex-col h-full overflow-y-auto custom-scrollbar gap-8">
            <ConfigProvider 
                theme={{ 
                    algorithm: theme.darkAlgorithm,
                    token: { 
                        colorBgElevated: '#1f2937', 
                        colorBgContainer: '#111827', 
                        colorBorder: '#374151',
                        controlItemBgActive: 'rgba(34, 211, 238, 0.1)',
                        colorPrimary: '#22d3ee',
                        borderRadius: 6
                    },
                    components: {
                        Segmented: {
                            itemSelectedBg: '#1f2937', 
                            itemSelectedColor: '#22d3ee',
                            trackBg: '#0b1121',
                            itemColor: '#6b7280'
                        }
                    }
                }}
            >
                {/* =========== 区域 1: 数据洞察 (DATA INSIGHTS) =========== */}
                <div className="flex flex-col gap-3">
                    {/* 区域标题 */}
                    <div className="flex items-center gap-2 px-1">
                        <AreaChartOutlined className="text-cyan-500" />
                        <span className="text-xs font-bold text-cyan-500/80 tracking-widest uppercase font-mono">
                            Data Insights
                        </span>
                        <div className="h-px flex-1 bg-linear-to-r from-cyan-900/50 to-transparent"></div>
                    </div>

                    {/* 卡片：统计探索 */}
                    <div className="rounded-xl overflow-hidden border border-cyan-800/30 bg-[#0b1121] shadow-lg shadow-cyan-900/5 hover:border-cyan-500/30 transition-all duration-300">
                        {/* Header: 青色系 */}
                        <div className="px-4 py-3 bg-linear-to-r from-cyan-950/30 to-transparent border-b border-cyan-900/30 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="p-1.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                                    <BarChartOutlined />
                                </div>
                                <span className="text-sm font-bold text-gray-200">统计分析</span>
                            </div>
                        </div>

                        {/* Content */}
                        <div className="p-4 bg-gray-900/20">
                            <Segmented<StatMode>
                                options={[
                                    { label: '数据透视', value: 'Pivot', icon: <BarChartOutlined /> },
                                    { label: '散点分布', value: 'Scatter', icon: <DotChartOutlined /> },
                                ]}
                                block
                                value={statMode}
                                onChange={setStatMode}
                                className="mb-5 border border-gray-800"
                            />

                            {/* Pivot Form */}
                            {statMode === 'Pivot' && (
                                <div className="animate-slide-up space-y-4">
                                    <Form layout="vertical" size="middle">
                                        <Form.Item label={<span className="text-gray-400 text-xs">行分组 (Row)</span>} className="mb-0">
                                            <Select className="w-full" placeholder="选择字段" value={pivotConfig.groupByRow} onChange={(val) => setPivotConfig({ groupByRow: val })} showSearch optionFilterProp="children">
                                                {fields.map(f => <Option key={f} value={f}>{f}</Option>)}
                                            </Select>
                                        </Form.Item>
                                        <div className="grid grid-cols-2 gap-3 mt-3">
                                            <Form.Item label={<span className="text-gray-400 text-xs">列分组 (Col)</span>} className="mb-0">
                                                <Select 
                                                    className="w-full" placeholder="可选" allowClear 
                                                    value={pivotConfig.groupByCol} 
                                                    onChange={(val) => setPivotConfig({ groupByCol: val })} 
                                                    showSearch
                                                    // ✅ [修改] 分段模式下禁用列
                                                    disabled={pivotConfig.method === 'boxplot' || pivotConfig.method === 'ridgeline'}
                                                >
                                                    {fields.map(f => <Option key={f} value={f}>{f}</Option>)}
                                                </Select>   
                                            </Form.Item>
                                            <Form.Item label={<span className="text-gray-400 text-xs">聚合方式</span>} className="mb-0">
                                                <Select className="w-full" value={pivotConfig.method} onChange={(val) => {
                                                    setPivotConfig({ 
                                                        method: val,
                                                        // ✅ [修改] 选中 raw 模式时清空列
                                                        groupByCol: (val === 'boxplot' || val === 'ridgeline') ? null : pivotConfig.groupByCol
                                                    })
                                                }}>
                                                    <Option value="count">计数</Option>
                                                    <Option value="sum">求和</Option>
                                                    <Option value="avg">平均</Option>
                                                    <Option value="max">最大</Option>
                                                    <Option value="min">最小</Option>
                                                    <Option value="boxplot">
                                                        <span className="flex items-center gap-2">
                                                            <BoxPlotOutlined className="text-purple-400"/>
                                                            <span>箱线图(分布)</span>
                                                        </span>
                                                    </Option>
                                                    {/* ✅ [新增] 分段/山脊图选项 */}
                                                    <Option value="ridgeline">
                                                        <span className="flex items-center gap-2">
                                                            <DeploymentUnitOutlined className="text-emerald-400"/>
                                                            <span>山脊图(分布)</span>
                                                        </span>
                                                    </Option>
                                                </Select>
                                            </Form.Item>
                                        </div>
                                        <Form.Item label={<span className="text-gray-400 text-xs">统计值 (Value)</span>} className="mt-3 mb-5">
                                            <Select 
                                                className="w-full" 
                                                placeholder="选择字段" 
                                                value={pivotConfig.valueField} 
                                                onChange={(val) => setPivotConfig({ valueField: val })} 
                                                // ✅ [修改] boxplot 模式下也必须选字段
                                                disabled={pivotConfig.method === 'count'} 
                                                showSearch
                                            >
                                                {fields.map(f => <Option key={f} value={f}>{f}</Option>)}
                                            </Select>
                                        </Form.Item>
                                        <Button type="primary" block onClick={handlePivotAnalyze} icon={<PlayCircleOutlined />} className="h-9 bg-cyan-700 hover:bg-cyan-600 border-none shadow-lg shadow-cyan-900/30">
                                            执行透视分析
                                        </Button>
                                    </Form>
                                </div>
                            )}

                            {/* Scatter Form */}
                            {statMode === 'Scatter' && (
                                <div className="animate-slide-up space-y-4">
                                    <Form layout="vertical" size="middle">
                                        <Form.Item label={<span className="text-gray-400 text-xs">X 轴字段</span>} className="mb-0">
                                            <Select className="w-full" placeholder="选择字段" value={scatterConfig.xField} onChange={(val) => setScatterConfig({ xField: val })} showSearch>
                                                {fields.map(f => <Option key={f} value={f}>{f}</Option>)}
                                            </Select>
                                        </Form.Item>
                                        <Form.Item label={<span className="text-gray-400 text-xs">Y 轴字段</span>} className="mt-3 mb-5">
                                            <Select className="w-full" placeholder="选择字段" value={scatterConfig.yField} onChange={(val) => setScatterConfig({ yField: val })} showSearch>
                                                {fields.map(f => <Option key={f} value={f}>{f}</Option>)}
                                            </Select>
                                        </Form.Item>
                                        <Button type="primary" block onClick={handleScatterAnalyze} icon={<DotChartOutlined />} className="h-9 bg-purple-700 hover:bg-purple-600 border-none shadow-lg shadow-purple-900/30">
                                            生成散点图
                                        </Button>
                                    </Form>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* =========== 区域 2: 空间计算 (SPATIAL COMPUTE) =========== */}
                <div className="flex flex-col gap-3">
                    {/* 区域标题 - 使用不同的颜色 (Emerald/Green) */}
                    <div className="flex items-center gap-2 px-1">
                        <ThunderboltOutlined className="text-emerald-500" />
                        <span className="text-xs font-bold text-emerald-500/80 tracking-widest uppercase font-mono">
                            Spatial Compute
                        </span>
                        <div className="h-px flex-1 bg-linear-to-r from-emerald-900/50 to-transparent"></div>
                    </div>

                    {/* 卡片：模型函数 */}
                    <div className="rounded-xl overflow-hidden border border-emerald-800/30 bg-[#0b1121] shadow-lg shadow-emerald-900/5 hover:border-emerald-500/30 transition-all duration-300">
                        {/* Header: 绿色系 */}
                        <div className="px-4 py-3 bg-linear-to-r from-emerald-950/30 to-transparent border-b border-emerald-900/30 flex items-center">
                            <div className="flex items-center gap-3">
                                <div className="p-1.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                    <FunctionOutlined />
                                </div>
                                <span className="text-sm font-bold text-gray-200">模型函数</span>
                            </div>
                        </div>
                        
                        {/* Content - 工具箱风格 */}
                        <div className="p-4 bg-gray-900/20">
                            <div className="grid grid-cols-2 gap-3">
                                {availableModels.length > 0 ? (
                                    availableModels.map((model) => (
                                        <Tooltip 
                                            key={model.modelName}
                                            placement="top" 
                                            color="#022c22" // 深邃内敛的暗绿色背景，专业不刺眼
                                            mouseEnterDelay={0.3} 
                                            title={
                                                <div className="flex flex-col gap-2 p-1 max-w-70"> {/* 稍微加宽一点以容纳参数说明 */}
                                                    {/* 1. 模型标题 */}
                                                    <div className="text-base font-bold text-emerald-400 border-b border-emerald-800/50 pb-1">
                                                        {model.displayName || model.modelName}
                                                    </div>
                                                    
                                                    {/* 2. 模型核心描述 */}
                                                    <div className="text-sm text-gray-300 leading-relaxed">
                                                        {model.description}
                                                    </div>

                                                    {/* 🌟 3. 新增：参数元数据动态渲染区 */}
                                                    {model.parameters && model.parameters.length > 0 && (
                                                        <div className="flex flex-col gap-1 bg-emerald-950/40 p-2 rounded-md border border-emerald-900/60 mt-1">
                                                            <span className="text-[10px] text-emerald-500 font-bold uppercase tracking-widest mb-0.5">
                                                                参数规范 (Parameters)
                                                            </span>
                                                            {model.parameters.map((p: any, idx: number) => (
                                                                <div key={idx} className="text-xs text-gray-300 flex items-start leading-tight">
                                                                    <span className="text-emerald-400 font-mono mr-1.5 shrink-0">
                                                                        [{idx + 1}] {p.name}:
                                                                    </span>
                                                                    <span className="text-gray-400">{p.description}</span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}

                                                    {/* 🌟 4. 修改：动态拼接精准的调用语法 */}
                                                    <div className="mt-1 px-2 py-1.5 bg-black/60 rounded border border-emerald-800/80 font-mono text-xs text-emerald-400 break-all shadow-[0_0_8px_rgba(52,211,153,0.1)_inset]">
                                                        输入： <b className="text-white">={model.modelName}</b>(
                                                        {model.parameters && model.parameters.length > 0 
                                                            ? <span className="text-emerald-200">{model.parameters.map((p: any) => p.name).join(', ')}</span>
                                                            : ''
                                                        })
                                                    </div>
                                                </div>
                                            }
                                        >
                                            <div 
                                                className="relative cursor-pointer h-12 flex items-center justify-center bg-[#0b1121] border border-emerald-900/50 rounded-md overflow-hidden group hover:border-emerald-500/50 hover:bg-emerald-950/40 transition-all duration-300 hover:shadow-[0_0_12px_rgba(16,185,129,0.15)] hover:-translate-y-0.5"
                                            >
                                                {/* 左侧动态发光条 (默认极暗，悬浮瞬间亮起纯正祖母绿) */}
                                                <div className="absolute left-0 top-0 bottom-0 w-1 bg-emerald-950 group-hover:bg-emerald-400 transition-colors duration-300"></div>
                                                
                                                {/* 🌟 模型核心指令名称: text-sm(与标题同大), font-bold, tracking-wide(微调字间距显得精致) */}
                                                <span className="text-sm font-bold tracking-wide text-emerald-400 group-hover:text-emerald-300 transition-colors duration-300 drop-shadow-sm">
                                                    {model.modelName}
                                                </span>
                                                
                                                {/* 右上角赛博朋克装饰角标 */}
                                                <div className="absolute top-0 right-0 w-2 h-2 border-l border-b border-emerald-900/50 group-hover:border-emerald-400/60 transition-colors duration-300"></div>
                                                {/* 右下角装饰点 */}
                                                <div className="absolute bottom-1 right-1 w-0.5 h-0.5 bg-emerald-900/60 group-hover:bg-emerald-400/80 transition-colors duration-300 rounded-full"></div>
                                            </div>
                                        </Tooltip>
                                    ))
                                ) : (
                                    // 加载中或无模型时的占位
                                    <div className="col-span-2 text-center py-6 text-gray-500 text-xs">
                                        <ThunderboltOutlined className="animate-pulse text-lg mb-2 block text-emerald-700"/>
                                        正在同步云端模型库...
                                    </div>
                                )}
                            </div>
                            
                            {/* 底部提示
                            <div className="mt-4 text-center">
                                <span className="text-[12px] text-emerald-400 bg-emerald-950/20 px-3 py-1.5 rounded-full border border-emerald-900/30">
                                    在表格单元格输入   <b className="text-emerald-400">=模型名称(列名)</b>   即可调用
                                </span>
                            </div> */}

                        </div>
                    </div>
                </div>

            </ConfigProvider>

            <style>{`
                @keyframes slideUp {
                    from { opacity: 0; transform: translateY(5px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .animate-slide-up {
                    animation: slideUp 0.3s ease-out forwards;
                }
            `}</style>
        </div>
    );
};

export default AnalysisPanel;