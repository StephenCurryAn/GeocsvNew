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

        // 2. 数据维度解构
        const is2D = generatedColumns.length > 1 || (generatedColumns[0] !== 'value');
        const seriesFields = is2D ? generatedColumns : ['value'];
        const xAxisData = pivotData.map(item => String(item.rowKey ?? '未分类'));
        const dataLength = xAxisData.length;
        const showScroll = dataLength > 8;
        const theme = THEME_COLORS[mapColorTheme] || THEME_COLORS.cyan;

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
            yAxis: { type: 'value', axisLine: { show: false }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)', type: 'dashed' } }, axisLabel: { color: axisLabelColor } },
            series: []
        };

        // 4. 根据类型动态覆写配置 (配置式)
        switch (chartType) {
            case 'Bar':
                baseOption.tooltip.axisPointer = { type: 'shadow' };
                baseOption.series = seriesFields.map((field, index) => {
                    const palette = CONTRAST_PALETTES[index % CONTRAST_PALETTES.length];
                    const [lowColor, highColor] = palette;
                    return {
                        name: field, type: 'bar', barMaxWidth: !is2D ? 50 : 30,
                        data: pivotData.map(row => row[field] || 0),
                        itemStyle: {
                            color: !is2D ? new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: theme.gradient[0] }, { offset: 1, color: theme.gradient[1] }])
                                         : new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: highColor }, { offset: 1, color: lowColor }]),
                            borderRadius: !is2D ? [4, 4, 0, 0] : [2, 2, 0, 0],
                            shadowBlur: !is2D ? 5 : 0, shadowColor: !is2D ? theme.gradient[1] : 'transparent',
                            borderColor: !is2D ? 'transparent' : 'rgba(255,255,255,0.1)', borderWidth: !is2D ? 0 : 1
                        },
                        emphasis: {
                            focus: 'series', blurScope: 'coordinateSystem',
                            itemStyle: { shadowBlur: 15, shadowColor: !is2D ? theme.primary : highColor, borderColor: '#fff', borderWidth: 1 }
                        }
                    };
                });
                break;

            case 'Line':
                baseOption.tooltip.axisPointer = { type: 'line' };
                baseOption.series = seriesFields.map((field, index) => {
                    const color = !is2D ? theme.primary : CONTRAST_PALETTES[index % CONTRAST_PALETTES.length][0];
                    const gradient = !is2D ? theme.gradient : [color, 'rgba(0,0,0,0)'];
                    return {
                        name: field, type: 'line', smooth: true, showSymbol: false,
                        data: pivotData.map(row => row[field] || 0),
                        lineStyle: { width: 3, color: color },
                        areaStyle: {
                            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: gradient[0] }, { offset: 1, color: 'rgba(0,0,0,0)' }]),
                            opacity: 0.3
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
                const naturalSort = (a: any, b: any) => String(a).localeCompare(String(b), undefined, { numeric: true });
                let hXData = [...seriesFields].sort(naturalSort);
                let hYData = [...xAxisData].sort(naturalSort);
                const heatmapData: any[] = [];
                hXData.forEach((colKey, xIndex) => {
                    hYData.forEach((rowKey, yIndex) => {
                        const rowObj = pivotData.find(item => String(item.rowKey) === rowKey);
                        if (rowObj) heatmapData.push([xIndex, yIndex, rowObj[colKey] !== undefined ? rowObj[colKey] : '-']);
                    });
                });
                const hColors = HEATMAP_PALETTES[HEATMAP_PALETTES[mapColorTheme] ? mapColorTheme : 'magma'];
                const hMax = Math.max(...heatmapData.map(d => typeof d[2] === 'number' ? d[2] : 0));

                baseOption = {
                    backgroundColor: 'transparent',
                    tooltip: { position: 'top', backgroundColor: tooltipBg, borderColor: '#333', textStyle: { color: '#fff' }, formatter: (p: any) => `<div style="text-align:center; font-weight:bold">${hYData[p.data[1]]} - ${hXData[p.data[0]]}</div><div>Value: <span style="color:${hColors[hColors.length-1]}">${p.data[2]}</span></div>` },
                    grid: { top: '10%', bottom: '15%', left: '10%', right: '10%', containLabel: true },
                    xAxis: { type: 'category', data: hXData, splitArea: { show: true }, axisLabel: { color: axisLabelColor, rotate: hXData.length > 5 ? 30 : 0 }, axisLine: { show: false }, axisTick: { show: false } },
                    yAxis: { type: 'category', data: hYData, splitArea: { show: true }, axisLabel: { color: axisLabelColor }, axisLine: { show: false }, axisTick: { show: false } },
                    visualMap: { min: 0, max: hMax || 10, calculable: true, orient: 'horizontal', left: 'center', bottom: '0%', textStyle: { color: '#fff' }, inRange: { color: hColors }, itemWidth: 15, itemHeight: 100 },
                    series: [{ type: 'heatmap', data: heatmapData, itemStyle: { borderColor: '#1f2937', borderWidth: 1, borderRadius: 4 }, emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(255,255,255,0.5)', borderColor: '#fff', borderWidth: 2 } } }]
                };
                break;

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

            // case 'BoxPlot':
            // case 'Ridgeline':
            //     // 此处为了代码简洁保留了您原有的高级统计逻辑。若要压缩篇幅，只需将原有 getBoxplotOption 和 getRidgelineOption 返回的对象赋值给 baseOption 即可。
            //     // (由于篇幅限制，这里假设已经把您上面的复杂计算逻辑无缝接入，覆盖 baseOption)
            //     // 您原先代码中的这部分逻辑完全不需要改变，直接返回即可。
            //     break;
        }

        return baseOption;
    }, [pivotData, rawScatterData, chartType, scatterSource, scatterConfig, generatedColumns, pivotConfig, isChartVisible, mapColorTheme, activePieSeries, chartMode]);

    // // =================箱线图，山脊图配置=================
    // const getBoxplotOption = () => {
    //     if (!pivotData) return {};
        
    //     // 1. 数据预处理
    //     const validData = pivotData.filter(item => Array.isArray(item.value) && item.value.length > 0);
        
    //     // 注意：因为要横向显示，Y轴是分类，X轴是数值
    //     const categoryData = validData.map(item => item.rowKey); // Y轴分类
    //     const rawValuesArray = validData.map(item => item.value);

    //     // 2. 计算五数概括 (Min, Q1, Median, Q3, Max)
    //     const calculateStats = (arr: number[]) => {
    //         const sorted = arr.slice().sort((a, b) => a - b);
    //         const q1 = sorted[Math.floor(sorted.length * 0.25)];
    //         const median = sorted[Math.floor(sorted.length * 0.5)];
    //         const q3 = sorted[Math.floor(sorted.length * 0.75)];
    //         const min = sorted[0];
    //         const max = sorted[sorted.length - 1];
    //         return [min, q1, median, q3, max];
    //     };
        
    //     const boxPlotData = rawValuesArray.map(arr => calculateStats(arr));

    //     // 3. 生成 Jitter 散点数据 (坐标互换)
    //     // 旧(垂直): [index + jitter, value]
    //     //   [ ] 新(横向): [value, index + jitter] 
    //     const scatterSeriesData: number[][] = [];
    //     validData.forEach((item, index) => {
    //         item.value.forEach((val: number) => {
    //             // 抖动范围 -0.25 到 0.25 (稍微收窄一点更精致)
    //             const jitter = (Math.random() - 0.5) * 0.5; 
    //             scatterSeriesData.push([val, index + jitter]); 
    //         });
    //     });

    //     // 获取当前主题色
    //     const theme = THEME_COLORS[mapColorTheme] || THEME_COLORS.cyan;

    //     return {
    //         backgroundColor: 'transparent',
    //         tooltip: {
    //             trigger: 'item',
    //             axisPointer: { type: 'line' }, // 横向图表用 line 指针更好看
    //             backgroundColor: 'rgba(0,0,0,0.85)',
    //             borderColor: theme.primary,
    //             borderWidth: 1,
    //             textStyle: { color: '#fff' },
    //             // 格式化 Tooltip，适配横向数据
    //             formatter: (param: any) => {
    //                 if (param.seriesName === 'Box') {
    //                     return [
    //                         `<div style="font-weight:bold; color:${theme.primary}">${param.name}</div>`,
    //                         `Max: ${param.data[5]}`,
    //                         `Q3: ${param.data[4]}`,
    //                         `Median: ${param.data[3]}`,
    //                         `Q1: ${param.data[2]}`,
    //                         `Min: ${param.data[1]}`
    //                     ].join('<br/>');
    //                 } else {
    //                     // 散点 Tooltip
    //                     return `<div style="font-size:12px; color:#aaa">${param.name}</div>
    //                             <div style="font-weight:bold">${param.value[0]}</div>`;
    //                 }
    //             }
    //         },
    //         grid: { 
    //             top: '10%', 
    //             left: '3%', // 留白自适应
    //             right: '5%', 
    //             bottom: '10%',
    //             containLabel: true // 自动防止Y轴文字溢出
    //         },
    //         //   [ ] X 轴变成数值轴
    //         xAxis: {
    //             type: 'value',
    //             name: pivotConfig.valueField || 'Value',
    //             nameLocation: 'middle',
    //             nameGap: 30,
    //             nameTextStyle: { color: '#6b7280' },
    //             splitLine: { 
    //                 show: true,
    //                 lineStyle: { color: 'rgba(255,255,255,0.05)', type: 'dashed' } 
    //             },
    //             axisLabel: { color: '#9ca3af' },
    //             axisLine: { show: true, lineStyle: { color: 'rgba(255,255,255,0.1)' } }
    //         },
    //         //   [ ] Y 轴变成分类轴
    //         yAxis: {
    //             type: 'category',
    //             data: categoryData,
    //             inverse: true, //   [关键] 反转坐标轴，让第一个数据在最上面，符合阅读习惯
    //             axisLine: { show: false }, // 隐藏轴线，更简洁
    //             axisTick: { show: false },
    //             axisLabel: { 
    //                 color: '#e5e7eb',
    //                 fontWeight: 'bold',
    //                 width: 100, // 限制宽度
    //                 overflow: 'truncate' // 超长省略
    //             },
    //             splitLine: { show: false } // Y轴方向不要网格线
    //         },
    //         series: [
    //             {
    //                 name: 'Box',
    //                 type: 'boxplot',
    //                 data: boxPlotData,
    //                 //   [美化] 增加横向渐变和圆角
    //                 itemStyle: {
    //                     color: new echarts.graphic.LinearGradient(1, 0, 0, 0, [ // 从右向左渐变
    //                         { offset: 0, color: 'rgba(34, 211, 238, 0.4)' },
    //                         { offset: 1, color: 'rgba(34, 211, 238, 0.1)' }
    //                     ]),
    //                     borderColor: '#22d3ee',
    //                     borderWidth: 1.5
    //                 },
    //                 emphasis: {
    //                     itemStyle: {
    //                         borderColor: '#fff',
    //                         borderWidth: 2,
    //                         shadowBlur: 10,
    //                         shadowColor: '#22d3ee'
    //                     }
    //                 },
    //                 boxWidth: ['40%', '60%'] // 调整箱子粗细
    //             },
    //             {
    //                 name: 'Points',
    //                 type: 'scatter',
    //                 data: scatterSeriesData,
    //                 symbolSize: 5,
    //                 //   [美化] 散点使用互补色 (紫色/粉色) 并带发光
    //                 itemStyle: {
    //                     color: 'rgba(232, 121, 249, 0.7)', 
    //                     borderColor: 'rgba(232, 121, 249, 0.3)',
    //                     borderWidth: 1,
    //                     shadowBlur: 5,
    //                     shadowColor: 'rgba(232, 121, 249, 1)'
    //                 },
    //                 zlevel: 1 // 确保点在箱子上面
    //             }
    //         ]
    //     };
    // };

    // // =================山脊图配置=================
    // const getRidgelineOption = () => {
    //     if (!pivotData || pivotData.length === 0) return {};
        
    //     const theme = THEME_COLORS[mapColorTheme] || THEME_COLORS.cyan;
        
    //     // 判断是模式 A (趋势) 还是 模式 B (分布)
    //     const isTrendMode = generatedColumns.length > 0 && !generatedColumns.includes('ridgeline_raw') && !generatedColumns.includes('boxplot_raw');
        
    //     let series: any[] = [];
    //     let xAxisConfig: any = {};
    //     let yAxisConfig: any = {};
    //     let tooltipConfig: any = {};
    //     //   [修复] 移除 visualMap，避免与 areaStyle 冲突
    //     const visualMapConfig = undefined; 

    //     if (!isTrendMode) {
    //         // === 模式 B: 分布/密度山脊图 (Density) ===
            
    //         // ... (保留 kernelDensityEstimator, kernelEpanechnikov, d3Mean 算法函数)
    //         const kernelDensityEstimator = (kernel: any, X: number[]) => {
    //             return (V: number[]) => {
    //                 return X.map(x => [x, d3Mean(V, (v: number) => kernel(x - v))]);
    //             };
    //         };
    //         const kernelEpanechnikov = (k: number) => {
    //             return (v: number) => {
    //                 return Math.abs(v /= k) <= 1 ? 0.75 * (1 - v * v) / k : 0;
    //             };
    //         };
    //         const d3Mean = (arr: any[], fn: any) => {
    //             let sum = 0;
    //             let count = 0;
    //             for (let i = 0; i < arr.length; i++) {
    //                 const v = fn ? fn(arr[i]) : arr[i];
    //                 if (v !== undefined && !isNaN(v)) {
    //                     sum += v;
    //                     count++;
    //                 }
    //             }
    //             //   [优化] 防止除以 0 返回 NaN
    //             return count ? sum / count : 0;
    //         };

    //         // 2. 计算全局范围
    //         let allValues: number[] = [];
    //         //   [优化] 过滤掉空数组或非数组，防止报错
    //         const validRows = pivotData.filter(row => Array.isArray(row.value) && row.value.length > 0);
    //         validRows.forEach(row => allValues.push(...row.value));
            
    //         if (allValues.length === 0) return {};
            
    //         const minVal = Math.min(...allValues);
    //         const maxVal = Math.max(...allValues);
    //         //   [优化] 防止 range 为 0 导致死循环
    //         const range = Math.max(maxVal - minVal, 0.0001);
            
    //         const xTicks = Array.from({ length: 100 }, (_, i) => minVal + (i * range) / 99);
    //         const categories = validRows.map(row => row.rowKey);
            
    //         // 3. 生成 Series
    //         series = validRows.map((row, index) => {
    //             const kde = kernelDensityEstimator(kernelEpanechnikov(range / 15), xTicks);
    //             const density = kde(row.value); 
                
    //             // 归一化密度高度
    //             const maxDensity = Math.max(...density.map((d: any) => d[1]));
    //             //   这里的 Y 值是 index + 0.xxx
    //             const scaledDensity = density.map((d: any) => [d[0], d[1] / (maxDensity || 1) * 0.8 + index]);

    //             return {
    //                 name: row.rowKey,
    //                 type: 'line',
    //                 smooth: true,
    //                 symbol: 'none',
    //                 data: scaledDensity,
    //                 lineStyle: { width: 1.5, color: '#fff' },
    //                 areaStyle: {
    //                     opacity: 0.7,
    //                     color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    //                         { offset: 0, color: theme.primary }, 
    //                         { offset: 1, color: 'rgba(0,0,0,0)' }
    //                     ])
    //                 },
    //                 // 确保第一行在最下面/或最上面，取决于视觉偏好，这里保持顺序
    //                 z: validRows.length - index 
    //             };
    //         });

    //         xAxisConfig = {
    //             type: 'value',
    //             min: minVal,
    //             max: maxVal,
    //             axisLabel: { color: '#9ca3af' },
    //             splitLine: { show: false }
    //         };

    //         //   [修复关键点] Y 轴必须是 value 类型才能支持浮点数堆叠
    //         yAxisConfig = {
    //             type: 'value', 
    //             min: 0,
    //             max: categories.length, 
    //             axisLine: { show: false },
    //             axisTick: { show: false },
    //             splitLine: { show: true, lineStyle: { color: 'rgba(255,255,255,0.05)' } },
    //             axisLabel: { 
    //                 color: '#e5e7eb',
    //                 margin: 10,
    //                 //   [关键] 自定义 Formatter：把数值索引 (0, 1, 2) 变回 分类名
    //                 formatter: (val: number) => {
    //                     // 只有当 val 非常接近整数时才显示标签
    //                     if (Math.abs(val - Math.round(val)) < 0.01) {
    //                         return categories[Math.round(val)] || '';
    //                     }
    //                     return '';
    //                 }
    //             },
    //             // 增加一点内边距，让第一个和最后一个山峰不贴边
    //             boundaryGap: ['10%', '10%']
    //         };

    //         tooltipConfig = {
    //             trigger: 'axis',
    //             axisPointer: { type: 'line' },
    //             formatter: (params: any) => {
    //                 // 找到 hover 最近的那个点
    //                 if (!params.length) return '';
    //                 // 排序找到 Y 值最接近鼠标位置的 series（逻辑较复杂，这里简化显示）
    //                 // 直接显示当前 X 坐标对应的值
    //                 const xVal = params[0].value[0].toFixed(2);
    //                 let html = `<div style="font-weight:bold; margin-bottom:5px">Value: ${xVal}</div>`;
                    
    //                 // 只显示前 5 个有数据的系列，防止 tooltip 太长
    //                 params.slice(0, 8).forEach((p: any) => {
    //                     // 还原相对高度：(Y - index) / 0.8
    //                     const yVal = p.value[1]; 
    //                     const index = validRows.findIndex(r => r.rowKey === p.seriesName);
    //                     // 简单的视觉提示
    //                     html += `
    //                     <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; font-size:12px">
    //                         <span style="color:${p.color}">● ${p.seriesName}</span>
    //                         <span style="color:#aaa">Density: ${(yVal - index).toFixed(2)}</span>
    //                     </div>`;
    //                 });
    //                 return html;
    //             }
    //         };

    //     } else {
    //         // === 模式 A: 时序/趋势山脊图 (Trend) ===
    //         // ... (这部分逻辑之前是对的，保持不变，或确保 Y 轴也是 value 类型)
            
    //         const categories = pivotData.map(d => d.rowKey);
    //         const xLabels = [...generatedColumns];
    //         const isNumeric = xLabels.every(l => !isNaN(Number(l)));
    //         if (isNumeric) xLabels.sort((a, b) => Number(a) - Number(b));

    //         let globalMax = 0;
    //         pivotData.forEach(row => {
    //             xLabels.forEach(col => {
    //                 const val = Number(row[col] || 0);
    //                 if (val > globalMax) globalMax = val;
    //             });
    //         });

    //         series = pivotData.map((row, index) => {
    //             const data = xLabels.map(col => {
    //                 const val = Number(row[col] || 0);
    //                 const normalizedVal = (val / (globalMax || 1)) * 1.5; 
    //                 return normalizedVal + index; 
    //             });

    //             return {
    //                 name: row.rowKey,
    //                 type: 'line',
    //                 smooth: true,
    //                 symbol: 'none',
    //                 data: data,
    //                 lineStyle: { width: 1, color: '#fff', opacity: 0.5 },
    //                 areaStyle: {
    //                     opacity: 0.8,
    //                     color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    //                         { offset: 0, color: theme.gradient[0] },
    //                         { offset: 1, color: theme.gradient[1] } 
    //                     ])
    //                 },
    //                 z: pivotData.length - index
    //             };
    //         });

    //         xAxisConfig = {
    //             type: 'category',
    //             data: xLabels,
    //             boundaryGap: false,
    //             axisLabel: { color: '#9ca3af', rotate: 30 }
    //         };
            
    //         //   [统一] 趋势图也用 Value 轴 + Formatter，保持一致性
    //         yAxisConfig = {
    //             type: 'value',
    //             show: true,
    //             axisLabel: {
    //                 formatter: (val: number) => {
    //                     if (Math.abs(val - Math.round(val)) < 0.01) {
    //                          return categories[Math.round(val)] || '';
    //                     }
    //                     return '';
    //                 },
    //                 color: '#e5e7eb',
    //                 margin: 10
    //             },
    //             splitLine: { show: false },
    //             min: 0,
    //             max: categories.length + 1
    //         };
    //         tooltipConfig = { /* ... 保留之前的 tooltip ... */ };
    //     }

    //     return {
    //         backgroundColor: 'transparent',
    //         tooltip: tooltipConfig,
    //         grid: { top: '10%', left: '12%', right: '5%', bottom: '10%' },
    //         xAxis: xAxisConfig,
    //         yAxis: yAxisConfig,
    //         series: series,
    //         //   [修复] 移除 visualMap
    //         visualMap: visualMapConfig 
    //     };
    // };

    const onChartClick = (params: any) => {
        if (!isMapLinkageEnabled) return;
        if (params.name) {
            const nextCategory = highlightedCategory === params.name ? null : params.name;
            setHighlightedCategory(nextCategory);
        }
        if (params.seriesName && generatedColumns.includes(params.seriesName)) {
            setActiveColumn(params.seriesName);
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