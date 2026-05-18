import React, { useMemo, useState, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import { Button, Segmented, Switch, Select } from 'antd';
import { 
    CloseOutlined, BarChartOutlined, RadarChartOutlined, 
    DotChartOutlined, EnvironmentOutlined, HeatMapOutlined,
    BoxPlotOutlined, DeploymentUnitOutlined,
    PieChartOutlined, LineChartOutlined // [新增] 折线图与饼图图标
} from '@ant-design/icons';
import { useAnalysisStore, type ChartType, type ColorThemeType } from '../../../stores/useAnalysisStore';
import * as echarts from 'echarts/core';

// [保持原有主题配置]
interface ThemeConfig {
    label: string;
    type: 'single' | 'gradient'; 
    primary: string; 
    gradient: [string, string]; 
    stops?: [string, string]; 
}

export const THEME_COLORS: Record<ColorThemeType, ThemeConfig> = {
    cyan:   { label: '青', type: 'single', primary: '#22d3ee', gradient: ['#22d3ee', 'rgba(34, 211, 238, 0.1)'] },
    purple: { label: '紫', type: 'single', primary: '#e879f9', gradient: ['#e879f9', 'rgba(232, 121, 249, 0.1)'] },
    blue:   { label: '蓝', type: 'single', primary: '#3b82f6', gradient: ['#3b82f6', 'rgba(59, 130, 246, 0.1)'] },
    green:  { label: '绿', type: 'single', primary: '#34d399', gradient: ['#34d399', 'rgba(52, 211, 153, 0.1)'] },
    yellow: { label: '金', type: 'single', primary: '#facc15', gradient: ['#facc15', 'rgba(250, 204, 21, 0.1)'] },
    red:    { label: '红', type: 'single', primary: '#f87171', gradient: ['#f87171', 'rgba(248, 113, 113, 0.1)'] },
    fire_ice: { label: '蓝红', type: 'gradient', primary: '#f87171', gradient: ['#f87171', '#3b82f6'], stops: ['#3b82f6', '#f87171'] },
    magma:    { label: '紫黄', type: 'gradient', primary: '#facc15', gradient: ['#facc15', '#6b21a8'], stops: ['#6b21a8', '#facc15'] },
    viridis:  { label: '蓝绿', type: 'gradient', primary: '#34d399', gradient: ['#34d399', '#1e3a8a'], stops: ['#1e3a8a', '#34d399'] },
    ocean:    { label: '蓝',   type: 'gradient', primary: '#0ea5e9', gradient: ['#0c4a6e', '#bae6fd'], stops: ['#bae6fd', '#0c4a6e'] },
    cyber:    { label: '蓝粉', type: 'gradient', primary: '#e879f9', gradient: ['#e879f9', '#22d3ee'], stops: ['#22d3ee', '#e879f9'] }
};

export const CONTRAST_PALETTES = [
    ['#3b82f6', '#ef4444'], ['#10b981', '#8b5cf6'], ['#06b6d4', '#db2777'],
    ['#f59e0b', '#2563eb'], ['#84cc16', '#f43f5e'], ['#6366f1', '#fbbf24'],
];
export const NEON_PALETTE = CONTRAST_PALETTES;

const HEATMAP_PALETTES: Record<string, string[]> = {
    magma: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'],
    cyber: ['#0b1121', '#1e3a8a', '#0ea5e9', '#22d3ee', '#34d399', '#a7f3d0'],
    inferno: ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'],
    ocean: ['#081d58', '#253494', '#225ea8', '#1d91c0', '#41b6c4', '#7fcdbb', '#c7e9b4', '#edf8b1'],
    matrix: ['#000000', '#0a2f0a', '#1a5e1a', '#2ea82e', '#45f045', '#aaffaa']
};

const ChartOverlay: React.FC = () => {
    const { 
        isChartVisible, setChartVisible, 
        pivotData, pivotConfig, generatedColumns,
        rawScatterData, scatterConfig,
        chartType, setChartType,
        isMapLinkageEnabled, setMapLinkageEnabled,
        highlightedCategory, setHighlightedCategory,
        mapColorTheme, setMapColorTheme, setActiveColumn,
        chartMode, aiChartOption, aiChartHtml
    } = useAnalysisStore();

    const [scatterSource, setScatterSource] = useState<'Pivoted' | 'Raw'>('Pivoted');
    // [新增] 用于饼图多维度切换的状态
    const [activePieSeries, setActivePieSeries] = useState<string>("");

    useEffect(() => {
        if (chartType === 'Scatter' && rawScatterData && rawScatterData.length > 0) {
            setScatterSource('Raw');
        }
    }, [chartType, rawScatterData]);

    // 监听列变化，自动选取第一列作为饼图默认维度
    useEffect(() => {
        const is2D = generatedColumns.length > 1 || (generatedColumns[0] !== 'value');
        const seriesFields = is2D ? generatedColumns : ['value'];
        if (seriesFields.length > 0 && (!activePieSeries || !seriesFields.includes(activePieSeries))) {
            setActivePieSeries(seriesFields[0]);
        }
    }, [generatedColumns, activePieSeries]);

    const { containerWidth, containerHeight } = useMemo(() => {
        if (!isChartVisible) return { containerWidth: 0, containerHeight: 0 };
        let w = 500, h = 450; 
        const len = pivotData?.length || 0;

        if (chartMode === 'ai') { w = 550; h = 420; } 
        else if (chartType === 'Bar' || chartType === 'Line') { w = Math.min(650, Math.max(450, len * 70 + 100)); } 
        else if (['Scatter', 'Heatmap', 'Pie'].includes(chartType)) { w = 550; h = 520; } 
        else if (chartType === 'Radar') { w = 500; h = 520; }
        return { containerWidth: w, containerHeight: h };
    }, [pivotData, chartType, isChartVisible, chartMode]);

    // ================= 核心：配置式 Option 渲染引擎 =================
    const getOption = useMemo(() => {
        if (!isChartVisible) return {};

        // 1. 处理无需 PivotData 的原生散点图
        if (chartType === 'Scatter' && scatterSource === 'Raw') {
            if (!rawScatterData || !scatterConfig.xField || !scatterConfig.yField) return {};
            
            // 【核心修复】：将它们提取为明确的 string 类型的局部变量，消除 TS 警告
            const xField = scatterConfig.xField as string;
            const yField = scatterConfig.yField as string;

            return {
                backgroundColor: 'transparent',
                tooltip: {
                    trigger: 'item', backgroundColor: 'rgba(15, 23, 42, 0.95)', borderColor: '#8b5cf6', textStyle: { color: '#fff' },
                    formatter: (p: any) => `<div style="color:#a78bfa">● Raw Point</div><div>X: ${p.value[0]}</div><div>Y: ${p.value[1]}</div>`
                },
                grid: { top: '15%', left: '8%', right: '8%', bottom: '12%', containLabel: true },
                // 下面直接使用局部变量 xField 和 yField
                xAxis: { type: 'value', name: xField, nameTextStyle: { color: '#a78bfa' }, splitLine: { show: false }, axisLabel: { color: '#e5e7eb' } },
                yAxis: { type: 'value', name: yField, nameTextStyle: { color: '#a78bfa' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)', type: 'dashed' } }, axisLabel: { color: '#9ca3af' }, scale: true },
                series: [{
                    type: 'scatter', symbolSize: 6, 
                    // 这里也直接使用局部变量，TypeScript 就能完美识别了
                    data: rawScatterData.map(i => [i[xField], i[yField]]),
                    itemStyle: { color: '#a78bfa', shadowBlur: 5, shadowColor: 'rgba(167, 139, 250, 0.5)', opacity: 0.8 }
                }]
            };
        }

        if (!pivotData || pivotData.length === 0) return {};

        // 2. 数据维度解构与智能语义探测
        const is2D = generatedColumns.length > 1 || (generatedColumns[0] !== 'value');
        const seriesFields = is2D ? generatedColumns : ['value'];
        const xAxisData = pivotData.map(item => String(item.rowKey ?? '未分类'));
        const dataLength = xAxisData.length;
        const showScroll = dataLength > 8;
        const theme = THEME_COLORS[mapColorTheme] || THEME_COLORS.cyan;

        // 🌟 【核心逻辑】：判断是“2D 交叉分组”还是“1D 多指标聚合”
        // 如果用户设置了“列维度”(groupByCol)，说明是交叉分组 -> 采用分组柱状图 (Single Axis)
        // 如果没有列维度，但有多个指标 (seriesFields.length >= 2) -> 采用双 Y 轴混合图 (Dual Axis)
        const isPivot2D = !!pivotConfig.groupByCol; 
        const useDualYAxis = !isPivot2D && seriesFields.length >= 2 && (chartType === 'Bar' || chartType === 'Line');

        // 3. 构建 BaseOption (公共UI配置)
        const tooltipBg = 'rgba(15, 23, 42, 0.95)';
        const tooltipBorder = '#334155';
        const axisLabelColor = '#9ca3af';

        let baseOption: any = {
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis', backgroundColor: tooltipBg, borderColor: tooltipBorder, textStyle: { color: '#e2e8f0' } },
            legend: { show: is2D, data: is2D ? seriesFields : [], textStyle: { color: '#e5e7eb' }, bottom: showScroll ? 35 : 5, type: 'scroll' },
            grid: { top: '15%', left: '8%', right: '8%', bottom: showScroll ? '20%' : '12%', containLabel: true },
            dataZoom: showScroll ? [{ type: 'slider', show: true, bottom: 5, height: 12, borderColor: 'transparent', fillerColor: 'rgba(34, 211, 238, 0.3)', backgroundColor: 'rgba(255,255,255,0.05)' }] : [],
            xAxis: { type: 'category', data: xAxisData, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: axisLabelColor, rotate: showScroll ? 0 : 30 } },
            
            // 🌟 【语义化 Y 轴】：双轴模式 vs 单轴模式
            yAxis: useDualYAxis ? [
                { 
                    type: 'value', name: seriesFields[0], alignTicks: true,
                    axisLine: { show: false }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)', type: 'dashed' } }, 
                    axisLabel: { color: axisLabelColor }, nameTextStyle: { color: axisLabelColor }
                },
                { 
                    type: 'value', name: seriesFields.length > 2 ? '指标均值/比例' : seriesFields[1], alignTicks: true,
                    axisLine: { show: false }, splitLine: { show: false }, 
                    axisLabel: { color: '#fbbf24' }, nameTextStyle: { color: '#fbbf24' }
                }
            ] : { 
                type: 'value', axisLine: { show: false }, 
                splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)', type: 'dashed' } }, 
                axisLabel: { color: axisLabelColor } 
            },
            series: []
        };

        // 4. 根据类型动态覆写配置 (配置式)
        switch (chartType) {
            case 'Bar':
                baseOption.tooltip.axisPointer = { type: 'shadow' };
                baseOption.series = seriesFields.map((field, index) => {
                    const palette = CONTRAST_PALETTES[index % CONTRAST_PALETTES.length];
                    const [lowColor, highColor] = palette;
                    
                    // 【混合渲染决策】：
                    // 如果是 2D 交叉分组 (isPivot2D) -> 全部强制为 'bar' 实现震撼的分组并列效果
                    // 如果是 1D 多指标 (useDualYAxis) -> 第一个为柱，后面全为折线挂右轴
                    const isLineInDual = useDualYAxis && index > 0;
                    const lineColors = ['#fbbf24', '#34d399', '#f472b6', '#22d3ee'];
                    const lineColor = lineColors[(index - 1) % lineColors.length];

                    return {
                        name: field, 
                        type: isLineInDual ? 'line' : 'bar',   // 智能切换类型
                        yAxisIndex: isLineInDual ? 1 : 0,      // 智能挂载 Y 轴
                        smooth: isLineInDual ? true : undefined,
                        barMaxWidth: !is2D ? 50 : 30,
                        barGap: '10%', // 柱子间的间距，让分组更紧凑震撼
                        data: pivotData.map(row => row[field] || 0),
                        
                        itemStyle: isLineInDual ? { color: lineColor } : {
                            color: !is2D ? new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: theme.gradient[0] }, { offset: 1, color: theme.gradient[1] }])
                                         : new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: highColor }, { offset: 1, color: lowColor }]),
                            borderRadius: (isLineInDual) ? 0 : [2, 2, 0, 0],
                            shadowBlur: (is2D || isLineInDual) ? 0 : 5, 
                            shadowColor: (is2D || isLineInDual) ? 'transparent' : theme.gradient[1]
                        },
                        lineStyle: isLineInDual ? { width: 3, color: lineColor } : undefined,
                        emphasis: { focus: 'series', blurScope: 'coordinateSystem' }
                    };
                });
                break;

            case 'Line':
                baseOption.tooltip.axisPointer = { type: 'line' };
                baseOption.series = seriesFields.map((field, index) => {
                    const color = !is2D ? theme.primary : CONTRAST_PALETTES[index % CONTRAST_PALETTES.length][0];
                    const isSecondary = useDualYAxis && index > 0;
                    const finalColor = isSecondary ? '#fbbf24' : color;

                    return {
                        name: field, type: 'line', smooth: true, showSymbol: false,
                        yAxisIndex: isSecondary ? 1 : 0,
                        data: pivotData.map(row => row[field] || 0),
                        lineStyle: { width: 3, color: finalColor },
                        areaStyle: {
                            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: isSecondary ? '#fcd34d' : (is2D ? finalColor : theme.gradient[0]) }, { offset: 1, color: 'rgba(0,0,0,0)' }]),
                            opacity: is2D ? 0.1 : 0.3
                        },
                        emphasis: { focus: 'series' }
                    };
                });
                break;

            case 'Pie':
                const targetField = activePieSeries || seriesFields[0]; 
                let pieData = pivotData.map(item => ({
                    name: String(item.rowKey ?? '未分类'),
                    value: Number(item[targetField]) || 0
                })).sort((a, b) => b.value - a.value);

                if (pieData.length > 14) {
                    const top13 = pieData.slice(0, 13);
                    const othersValue = pieData.slice(13).reduce((sum, curr) => sum + curr.value, 0);
                    top13.push({ name: '其他', value: othersValue });
                    pieData = top13;
                }
                
                // 覆写基础配置
                baseOption = {
                    backgroundColor: 'transparent',
                    tooltip: { trigger: 'item', backgroundColor: tooltipBg, borderColor: tooltipBorder, textStyle: { color: '#e2e8f0' } },
                    color: CONTRAST_PALETTES.map(p => p[0]), // 赋予缤纷色彩
                    series: [{
                        name: targetField, type: 'pie', radius: ['25%', '50%'], center: ['50%', '55%'], roseType: 'area',
                        itemStyle: { borderRadius: 4, borderColor: '#0f172a', borderWidth: 2 },
                        label: { color: axisLabelColor, formatter: '{b}\n{d}%', fontSize: 11 },
                        labelLine: { smooth: true },
                        data: pieData
                    }]
                };
                break;

            case 'Radar':
                const radarSorted = [...pivotData].map(item => {
                    const total = seriesFields.reduce((sum, f) => sum + (Number(item[f]) || 0), 0);
                    return { ...item, _total: total };
                }).sort((a, b) => b._total - a._total).slice(0, 12);

                const indicators = radarSorted.map(item => String(item.rowKey)).map(name => {
                    let maxVal = 0;
                    seriesFields.forEach(f => {
                        const matched = radarSorted.find(d => String(d.rowKey) === name);
                        if (matched && Number(matched[f]) > maxVal) maxVal = Number(matched[f]);
                    });
                    return { name, max: maxVal * 1.2 || 100 };
                });

                baseOption = {
                    backgroundColor: 'transparent',
                    tooltip: { trigger: 'item', backgroundColor: tooltipBg, borderColor: tooltipBorder, textStyle: { color: '#fff' } },
                    legend: { show: true, type: 'scroll', bottom: 5, textStyle: { color: '#e5e7eb' }, pageIconColor: theme.primary },
                    radar: {
                        indicator: indicators, shape: 'polygon', center: ['50%', '55%'], radius: '60%', splitNumber: 4,
                        axisName: { color: !is2D ? theme.primary : '#22d3ee', fontSize: 11, fontWeight: 'bold' },
                        splitLine: { lineStyle: { color: ['rgba(255,255,255,0.1)', 'rgba(255,255,255,0.05)'] } },
                        splitArea: { show: true, areaStyle: { color: ['rgba(255,255,255,0.02)', 'rgba(255,255,255,0.05)'] } },
                        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } }
                    },
                    series: [{
                        type: 'radar', symbol: 'circle', symbolSize: 4,
                        data: seriesFields.map((field, idx) => {
                            const color = !is2D ? theme.primary : NEON_PALETTE[idx % NEON_PALETTE.length][0];
                            return {
                                name: field, value: radarSorted.map(item => Number(item[field]) || 0),
                                itemStyle: { color: color }, areaStyle: { color: color, opacity: 0.2 }, lineStyle: { width: 2 }
                            };
                        })
                    }]
                };
                break;

                case 'Heatmap':
                    let hXData: string[] = [];
                    let hYData: string[] = [];
                    const heatmapData: any[] = [];
                    
                    // 🌟 【核心修复 1】：新增动态最小值变量
                    let hMax = 10;
                    let hMin = 0; 
                    let isGeodetector = false;
    
                    // 智能探测是否为“地理探测器交互矩阵”数据格式
                    if (pivotData[0] && ('因子A' in pivotData[0]) && ('因子B' in pivotData[0])) {
                        isGeodetector = true;
                        const factors = Array.from(new Set(pivotData.map(d => String(d['因子A']))));
                        hXData = factors;
                        hYData = factors;
    
                        pivotData.forEach(item => {
                            const xIndex = factors.indexOf(String(item['因子B'])); 
                            const yIndex = factors.indexOf(String(item['因子A'])); 
                            const val = item['交互q值'] !== undefined ? Number(item['交互q值']) : '-';
                            heatmapData.push([xIndex, yIndex, val, item['交互类型']]); 
                        });
                        
                        // 🌟 【核心修复 2】：动态提取实际数据的最小值和最大值！
                        const validValues = heatmapData.map(d => d[2]).filter(v => typeof v === 'number');
                        if (validValues.length > 0) {
                            hMax = Math.max(...validValues);
                            hMin = Math.min(...validValues);
                            // 防呆：如果所有值完全一样，强行给一点区间防止 ECharts 报错
                            if (hMax === hMin) {
                                hMax = hMax + 0.01;
                                hMin = Math.max(0, hMin - 0.01);
                            }
                        } else {
                            hMax = 1.0;
                            hMin = 0.0;
                        }
                    } 
                    // 保留原有：传统数据透视表的热力图解析逻辑
                    else {
                        const naturalSort = (a: any, b: any) => String(a).localeCompare(String(b), undefined, { numeric: true });
                        hXData = [...seriesFields].sort(naturalSort);
                        hYData = [...xAxisData].sort(naturalSort);
                        
                        hXData.forEach((colKey, xIndex) => {
                            hYData.forEach((rowKey, yIndex) => {
                                const rowObj = pivotData.find(item => String(item.rowKey) === rowKey);
                                if (rowObj) heatmapData.push([xIndex, yIndex, rowObj[colKey] !== undefined ? rowObj[colKey] : '-']);
                            });
                        });
                        
                        // 普通热力图也支持动态极值提取
                        const validValues = heatmapData.map(d => d[2]).filter(v => typeof v === 'number');
                        if(validValues.length > 0) {
                            hMax = Math.max(...validValues);
                            hMin = Math.min(...validValues);
                        }
                    }
    
                    const hColors = HEATMAP_PALETTES[HEATMAP_PALETTES[mapColorTheme] ? mapColorTheme : 'magma'];
    
                    baseOption = {
                        backgroundColor: 'transparent',
                        tooltip: { 
                            position: 'top', 
                            backgroundColor: tooltipBg, 
                            borderColor: '#333', 
                            textStyle: { color: '#fff' }, 
                            formatter: (p: any) => {
                                if (isGeodetector) {
                                    const intType = p.data[3] ? `<div style="margin-top:4px; font-size:12px; color:#9ca3af">交互类型: <span style="color:#22d3ee">${p.data[3]}</span></div>` : '';
                                    return `<div style="text-align:center; font-weight:bold; margin-bottom:4px">${hYData[p.data[1]]} ∩ ${hXData[p.data[0]]}</div>
                                            <div>交互 q 值: <span style="color:${hColors[hColors.length-1]}; font-weight:bold">${p.data[2]}</span></div>
                                            ${intType}`;
                                } else {
                                    return `<div style="text-align:center; font-weight:bold">${hYData[p.data[1]]} - ${hXData[p.data[0]]}</div>
                                            <div>Value: <span style="color:${hColors[hColors.length-1]}">${p.data[2]}</span></div>`;
                                }
                            }
                        },
                        grid: { top: '10%', bottom: '20%', left: '15%', right: '10%', containLabel: true },
                        xAxis: { 
                            type: 'category', data: hXData, splitArea: { show: true }, 
                            axisLabel: { color: axisLabelColor, rotate: hXData.length > 3 ? 45 : 0 },
                            axisLine: { show: false }, axisTick: { show: false } 
                        },
                        yAxis: { 
                            type: 'category', data: hYData, splitArea: { show: true }, 
                            axisLabel: { color: axisLabelColor }, axisLine: { show: false }, axisTick: { show: false } 
                        },
                        visualMap: { 
                            // 🌟 【核心修复 3】：应用动态的下限和上限！
                            min: hMin, 
                            max: hMax, 
                            calculable: true, orient: 'horizontal', 
                            left: 'center', bottom: '0%', textStyle: { color: '#fff' }, 
                            inRange: { color: hColors }, itemWidth: 15, itemHeight: 120,
                            dimension: 2
                        },
                        series: [{ 
                            type: 'heatmap', 
                            data: heatmapData, 
                            label: {
                                show: isGeodetector, 
                                color: '#fff',
                                fontSize: 11
                            },
                            itemStyle: { borderColor: '#1f2937', borderWidth: 1, borderRadius: 4 }, 
                            emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(255,255,255,0.5)', borderColor: '#fff', borderWidth: 2 } } 
                        }]
                    };
                    break
                    
            case 'Scatter':
                // 透视数据的 Scatter
                baseOption.tooltip.trigger = 'item';
                baseOption.series = seriesFields.map((field, index) => {
                    const colorPair = !is2D ? [theme.primary, theme.gradient[1]] : NEON_PALETTE[index % NEON_PALETTE.length];
                    return {
                        name: field, type: 'scatter', symbolSize: 15,
                        data: pivotData.map(row => row[field] || null),
                        itemStyle: { color: colorPair[0], shadowBlur: 10, shadowColor: colorPair[1] }
                    };
                });
                break;

        }

        return baseOption;
    }, [pivotData, rawScatterData, chartType, scatterSource, scatterConfig, generatedColumns, pivotConfig, isChartVisible, mapColorTheme, activePieSeries, chartMode]);

    const onChartClick = (params: any) => {
        if (!isMapLinkageEnabled) return;

        let rowCategory: string | null = null;
        let colCategory: string | null = null;

        // 1. 兼容热力矩阵（Heatmap）的特殊点击事件
        if (chartType === 'Heatmap' && params.data) {
            // 热力图的 data 格式为 [xIndex, yIndex, value]
            const xIndex = params.data[0];
            const yIndex = params.data[1];

            // 动态还原我们在 getOption 中排序过的 X 轴和 Y 轴名称
            const is2D = generatedColumns.length > 1 || (generatedColumns[0] !== 'value');
            const seriesFields = is2D ? generatedColumns : ['value'];
            const xAxisData = (pivotData || []).map(item => String(item.rowKey ?? '未分类'));

            const naturalSort = (a: any, b: any) => String(a).localeCompare(String(b), undefined, { numeric: true });
            const hXData = [...seriesFields].sort(naturalSort);
            const hYData = [...xAxisData].sort(naturalSort);

            colCategory = hXData[xIndex];
            rowCategory = hYData[yIndex];
        } 
        // 2. 兼容基础一维/二维图表（柱状图、折线图、饼图、散点图）
        else {
            rowCategory = params.name;       // X轴的类目名（如: "10°-20°"）
            colCategory = params.seriesName; // 图例的系列名（如: "低植被覆盖"）
        }

        // --- 触发状态更新，向地图组件发送联动信号 ---

        if (rowCategory) {
            // 切换高亮行分类 (比如高亮特定的坡度等级)
            const nextCategory = highlightedCategory === rowCategory ? null : rowCategory;
            setHighlightedCategory(nextCategory);
        }
        
        if (colCategory && generatedColumns.includes(colCategory)) {
            // 切换高亮列维度 (比如切换到特定的植被覆盖等级的颜色映射)
            setActiveColumn(colCategory);
        }
    };

    if (!isChartVisible) return null;

    const is2DAnalysis = pivotData && pivotConfig.groupByRow && pivotConfig.groupByCol;
    const isBoxPlotAvailable = pivotConfig.method === 'boxplot' && !pivotConfig.groupByCol;
    const isRidgelineAvailable = (pivotConfig.method === 'ridgeline') || (is2DAnalysis && pivotConfig.method !== 'boxplot');
    const showHeatmapPalette = chartType === 'Heatmap';
    const showThemeSelect = isMapLinkageEnabled && pivotData && !pivotConfig.groupByCol && pivotConfig.groupByRow;
    
    return (
        <div 
            className="absolute bottom-8 right-8 z-[1000] flex flex-col overflow-hidden
                       rounded-3xl transition-all duration-300 ease-out
                       bg-[#0b1121]/30 backdrop-blur-xl
                       border border-white/10 ring-1 ring-white/5
                       shadow-[0_8px_32px_0_rgba(0,0,0,0.36)]
                       group hover:bg-[#0b1121]/40 hover:border-cyan-500/30"
            style={{ width: containerWidth, height: containerHeight }}
        >
            {/* Header */}
            <div className="h-14 shrink-0 flex items-center justify-between px-4 border-b border-white/5 bg-gradient-to-r from-white/5 to-transparent">
                <div className="mr-2 flex items-center">
                    {chartMode === 'ai' ? (
                        <span className="text-cyan-400 font-bold ml-2">AI 智能分析视图</span>
                    ) : (
                    <>
                        <Segmented<ChartType>
                            options={[
                                { label: '柱状图', value: 'Bar', icon: <BarChartOutlined /> },
                                { label: '折线图', value: 'Line', icon: <LineChartOutlined /> }, // [新增]
                                { label: '饼状图', value: 'Pie', icon: <PieChartOutlined /> },   // [新增]
                                { label: '雷达图', value: 'Radar', icon: <RadarChartOutlined /> },
                                { label: '散点图', value: 'Scatter', icon: <DotChartOutlined /> }, 
                                { label: '热力图', value: 'Heatmap', icon: <HeatMapOutlined /> },
                                // { label: '箱线图', value: 'BoxPlot', icon: <BoxPlotOutlined />, disabled: !isBoxPlotAvailable, className: !isBoxPlotAvailable ? 'opacity-50' : '' },
                                // { label: '山脊图', value: 'Ridgeline', icon: <DeploymentUnitOutlined />, disabled: !isRidgelineAvailable, className: !isRidgelineAvailable ? 'opacity-50' : '' }
                            ]}
                            value={chartType}
                            onChange={setChartType}
                            className="custom-segmented-glass"
                        />
                        {/* [新增] 热力图专属配色选择器 */}
                        {showHeatmapPalette && (
                            <Select
                                size="small"
                                variant="borderless"
                                value={HEATMAP_PALETTES[mapColorTheme] ? mapColorTheme : 'magma'}
                                onChange={setMapColorTheme}
                                popupMatchSelectWidth={false}
                                className="w-32 ml-2"
                                options={[
                                    { value: 'magma', label: '混合 (Magma)' },
                                    { value: 'cyber', label: '青蓝 (Cyber)' },
                                    { value: 'inferno', label: '炽热 (Inferno)' },
                                    { value: 'ocean', label: '深海 (Ocean)' },
                                    { value: 'matrix', label: '矩阵 (Matrix)' },
                                ]}
                            />
                        )}

                        {/* [新增] 全局色系选择器 (带渐变色条 UI 预览) */}
                        {showThemeSelect && (
                            <Select
                                size="small"
                                variant="borderless"
                                value={mapColorTheme}
                                onChange={setMapColorTheme}
                                popupMatchSelectWidth={false}
                                className="w-28 ml-2"
                                options={Object.entries(THEME_COLORS).map(([key, conf]) => ({
                                    label: (
                                        <div className="flex items-center gap-2">
                                            {/* 显示精致的色条预览 */}
                                            <div className="w-4 h-2 rounded-[2px]" style={{ 
                                                background: conf.type === 'gradient' && conf.stops
                                                    ? `linear-gradient(to right, ${conf.stops[0]}, ${conf.stops[1]})`
                                                    : conf.primary 
                                            }}></div>
                                            <span className="text-gray-300 text-xs">{conf.label}</span>
                                        </div>
                                    ),
                                    value: key
                                }))}
                            />
                        )}
                    </>
                    )}
                </div>
                <Button type="text" shape="circle" icon={<CloseOutlined className="text-gray-300" />} onClick={() => { setChartVisible(false); setHighlightedCategory(null); }} />
            </div>

            {/* 主区 */}
            <div className="flex-1 w-full h-full p-2 relative">
                {/* [新增] 饼图维度选择器：如果图表是 Pie 且是多维数据，悬浮显示 Select */}
                {chartMode !== 'ai' && chartType === 'Pie' && generatedColumns.length > 1 && (
                    <div className="absolute top-2 right-4 z-10 bg-[#1e293b]/80 backdrop-blur-md rounded-lg border border-[#334155] p-1.5 flex items-center shadow-lg">
                        <span className="text-[11px] text-gray-400 font-bold mr-2">透视维度:</span>
                        <Select 
                            size="small" variant="borderless" className="w-28 text-cyan-400"
                            value={activePieSeries} onChange={setActivePieSeries}
                            options={generatedColumns.map(f => ({ label: f, value: f }))}
                        />
                    </div>
                )}

                {chartMode === 'ai' && aiChartHtml ? (
                    <iframe srcDoc={aiChartHtml} className="w-full h-full bg-white rounded" sandbox="allow-scripts"/>
                ) : chartMode === 'ai' && aiChartOption ? (
                    <ReactECharts option={aiChartOption} style={{ height: '100%', width: '100%' }} theme="dark" notMerge autoResize />
                ) : (
                    <ReactECharts option={getOption} style={{ height: '100%', width: '100%' }} theme="dark" notMerge autoResize onEvents={{ 'click': onChartClick }} />
                )}
            </div>

            {/* Footer 保持不变 */}
            <div className="h-10 shrink-0 flex items-center justify-between px-4 border-t border-white/5 bg-white/5 text-xs text-gray-300">
                <div className="flex items-center gap-2 font-medium">
                    <EnvironmentOutlined className={isMapLinkageEnabled ? 'text-cyan-400' : 'text-gray-400'} />
                    <span>地图颜色映射联动</span>
                </div>
                <Switch size="small" checked={isMapLinkageEnabled} onChange={(c) => { setMapLinkageEnabled(c); if(!c) setHighlightedCategory(null); }} disabled={chartMode === 'ai'} />
            </div>
        </div>
    );
};

export default ChartOverlay;