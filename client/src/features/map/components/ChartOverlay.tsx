import React, { useMemo, useState, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import { Button, Segmented, Switch, Select } from 'antd'; //   引入 Tooltip
import { 
    CloseOutlined, BarChartOutlined, RadarChartOutlined, 
    DotChartOutlined, EnvironmentOutlined,
    HeatMapOutlined,
    BoxPlotOutlined,
    DeploymentUnitOutlined //   [新增]
} from '@ant-design/icons';
//   引入类型定义
import { useAnalysisStore, type ChartType, type ColorThemeType } from '../../../stores/useAnalysisStore';
import * as echarts from 'echarts/core';

//   [ ] 升级主题配置接口
// type: 'single' (单色+透明度变化) | 'gradient' (双色/多色插值)
interface ThemeConfig {
    label: string;
    type: 'single' | 'gradient'; 
    primary: string; // UI主色 (按钮/高亮)
    gradient: [string, string]; // 柱状图用的填充渐变
    stops?: [string, string]; // 地图用的插值断点 [LowColor, HighColor]
}

//   [新增] 定义更丰富的色系
export const THEME_COLORS: Record<ColorThemeType, ThemeConfig> = {
    // === 原有单色系 (Opacity Mode) ===
    cyan:   { label: '青', type: 'single', primary: '#22d3ee', gradient: ['#22d3ee', 'rgba(34, 211, 238, 0.1)'] },
    purple: { label: '紫', type: 'single', primary: '#e879f9', gradient: ['#e879f9', 'rgba(232, 121, 249, 0.1)'] },
    blue:   { label: '蓝', type: 'single', primary: '#3b82f6', gradient: ['#3b82f6', 'rgba(59, 130, 246, 0.1)'] },
    green:  { label: '绿', type: 'single', primary: '#34d399', gradient: ['#34d399', 'rgba(52, 211, 153, 0.1)'] },
    yellow: { label: '金', type: 'single', primary: '#facc15', gradient: ['#facc15', 'rgba(250, 204, 21, 0.1)'] },
    red:    { label: '红', type: 'single', primary: '#f87171', gradient: ['#f87171', 'rgba(248, 113, 113, 0.1)'] },

    // ===   [新增] 炫酷渐变色带 (Interpolation Mode) ===
    // 蓝红
    fire_ice: { 
        label: '蓝红', 
        type: 'gradient', 
        primary: '#f87171', 
        gradient: ['#f87171', '#3b82f6'], // 柱状图上红下蓝
        stops: ['#3b82f6', '#f87171'] // 地图 Low=蓝, High=红
    },
    // 紫黄
    magma: { 
        label: '紫黄', 
        type: 'gradient', 
        primary: '#facc15', 
        gradient: ['#facc15', '#6b21a8'], 
        stops: ['#6b21a8', '#facc15'] 
    },
    // 蓝绿
    viridis: { 
        label: '蓝绿', 
        type: 'gradient', 
        primary: '#34d399', 
        gradient: ['#34d399', '#1e3a8a'], 
        stops: ['#1e3a8a', '#34d399'] 
    },
    // 蓝
    ocean: { 
        label: '蓝', 
        type: 'gradient', 
        primary: '#0ea5e9', 
        gradient: ['#0c4a6e', '#bae6fd'], 
        stops: ['#bae6fd', '#0c4a6e'] // Low=浅, High=深
    },
    // 蓝粉
    cyber: { 
        label: '蓝粉', 
        type: 'gradient', 
        primary: '#e879f9', 
        gradient: ['#e879f9', '#22d3ee'], 
        stops: ['#22d3ee', '#e879f9'] 
    }
};
//   [新增] 高对比度对立色盘 (Low -> High)
export const CONTRAST_PALETTES = [
    ['#3b82f6', '#ef4444'], // 蓝红
    ['#10b981', '#8b5cf6'], // 绿紫
    ['#06b6d4', '#db2777'], // 青粉
    ['#f59e0b', '#2563eb'], // 橙蓝
    ['#84cc16', '#f43f5e'], // 橙红
    ['#6366f1', '#fbbf24'], // 蓝黄
];
// 为了兼容之前的代码，如果有地方用了 NEON_PALETTE，我们可以映射一下或者保留
// 这里为了彻底的效果，把 NEON_PALETTE 指向新的色盘的主色，或者直接导出
export const NEON_PALETTE = CONTRAST_PALETTES;
//  热力图专配色方案
const HEATMAP_PALETTES: Record<string, string[]> = {
    // 黑黄
    magma: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'],
    // 蓝绿
    cyber: ['#0b1121', '#1e3a8a', '#0ea5e9', '#22d3ee', '#34d399', '#a7f3d0'],
    // 红白
    inferno: ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'],
    // 蓝
    ocean: ['#081d58', '#253494', '#225ea8', '#1d91c0', '#41b6c4', '#7fcdbb', '#c7e9b4', '#edf8b1'],
    // 黑绿
    matrix: ['#000000', '#0a2f0a', '#1a5e1a', '#2ea82e', '#45f045', '#aaffaa']
};


const ChartOverlay: React.FC = () => {
    const { 
        isChartVisible, setChartVisible, 
        pivotData, pivotConfig, generatedColumns, // 透视数据
        rawScatterData, scatterConfig, // 散点数据
        chartType, setChartType, // 全局图表类型
        //   引入联动状态
        isMapLinkageEnabled, setMapLinkageEnabled,
        highlightedCategory, //   必须解构出当前状态
        setHighlightedCategory,
        //   引入新状态
        mapColorTheme, setMapColorTheme,
        //   [新增] 引入 activeColumn 相关 action
        setActiveColumn
    } = useAnalysisStore();

    // 散点图数据源切换：'Pivoted'(透视结果) vs 'Raw'(原始数据)
    const [scatterSource, setScatterSource] = useState<'Pivoted' | 'Raw'>('Pivoted');

    // 监听：如果有了新的 raw 数据且当前是散点图模式，自动切到 Raw 视图
    useEffect(() => {
        if (chartType === 'Scatter' && rawScatterData && rawScatterData.length > 0) {
            setScatterSource('Raw');
        }
    }, [chartType, rawScatterData]);

    // 计算容器尺寸
    const { containerWidth, containerHeight } = useMemo(() => {
        if (!isChartVisible) return { containerWidth: 0, containerHeight: 0 };
        
        let w = 500;
        let h = 450; 
        const len = pivotData?.length || 0;
        
        if (chartType === 'Bar') {
            w = Math.min(650, Math.max(450, len * 70 + 100)); // 稍微加宽
        } else if (chartType === 'Scatter' || chartType === 'Heatmap') { //   热力图也用方形
            w = 550;
            h = 520;
        } else if (chartType === 'Radar') {
            w = 500;
            h = 520;
        }
        return { containerWidth: w, containerHeight: h };
    }, [pivotData, chartType, isChartVisible]);

    // =================柱状图配置 =================
    const getBarOption = () => {
        if (!pivotData) return {};
        const is2D = generatedColumns.length > 1 || (generatedColumns[0] !== 'value');
        const xAxisData = pivotData.map(item => item.rowKey);
        const dataLength = pivotData.length;
        const showScroll = dataLength > 8;
        
        //   [新增] 获取当前主题配置
        const theme = THEME_COLORS[mapColorTheme];

        let series: any[] = [];
        if (!is2D) {
            //   [ ] 一维模式：使用 mapColorTheme
            series.push({
                name: pivotConfig.valueField || '统计值',
                type: 'bar',
                data: pivotData.map(item => item.value),
                itemStyle: {
                    //   [ ] 使用主题色的渐变
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: theme.gradient[0] }, // 亮色
                        { offset: 1, color: theme.gradient[1] }  // 暗色/透明
                    ]),
                    borderRadius: [4, 4, 0, 0],
                    //   [新增] 增加一点发光质感
                    shadowBlur: 5,
                    shadowColor: theme.gradient[1]
                },
                //   [新增] 高亮样式：点击或 hover 时变亮
                emphasis: {
                     itemStyle: {
                        color: theme.primary,
                        shadowBlur: 15,
                        shadowColor: theme.primary
                     }
                },
                barMaxWidth: 50,
            });
        } else {
            //   [ ] 二维模式：使用 CONTRAST_PALETTES 进行双色渐变渲染
            series = generatedColumns.map((colKey, index) => {
                // 获取对应的对立色对 [Low, High]
                const palette = CONTRAST_PALETTES[index % CONTRAST_PALETTES.length];
                const [lowColor, highColor] = palette;

                return {
                    name: colKey,
                    type: 'bar',
                    data: pivotData.map(row => row[colKey] || 0),
                    barMaxWidth: 30,
                    emphasis: { 
                        focus: 'series', blurScope: 'coordinateSystem', 
                        itemStyle: { 
                            shadowBlur: 15, 
                            shadowColor: highColor, // 高亮用暖色
                            borderColor: '#fff', 
                            borderWidth: 1 
                        }
                    },
                    itemStyle: {
                        // 纵向渐变：底部冷色 -> 顶部暖色
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: highColor }, // Top
                            { offset: 1, color: lowColor }   // Bottom
                        ]),
                        borderRadius: [2, 2, 0, 0],
                        // 给个边框让渐变更明显
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1
                    }
                };
            });
        }
        return {
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(0,0,0,0.8)', textStyle: { color: '#fff' } },
            legend: { show: is2D, data: is2D ? generatedColumns : [], textStyle: { color: '#e5e7eb' }, bottom: showScroll ? 35 : 5, type: 'scroll' },
            grid: { top: '15%', left: '8%', right: '8%', bottom: showScroll ? '20%' : '12%', containLabel: true },
            dataZoom: showScroll ? [{ type: 'slider', show: true, bottom: 5, height: 12, borderColor: 'transparent', fillerColor: 'rgba(34, 211, 238, 0.3)', backgroundColor: 'rgba(255,255,255,0.05)', showDataShadow: false }] : [],
            xAxis: { type: 'category', data: xAxisData, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#e5e7eb', rotate: showScroll ? 0 : 30 } },
            yAxis: { type: 'value', axisLine: { show: false }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)', type: 'dashed' } }, axisLabel: { color: '#9ca3af' } },
            series: series
        };
    };

    // =================雷达图配置 =================
    const getRadarOption = () => {
        if (!pivotData) return {};
        const is2D = generatedColumns.length > 1 || (generatedColumns[0] !== 'value');
        let indicators: { name: string, max?: number }[] = [];
        let seriesData: any[] = [];
        
        //   [新增] 获取当前主题色
        const theme = THEME_COLORS[mapColorTheme];

        if (is2D) {
            indicators = generatedColumns.map(col => ({ name: col }));
            seriesData = pivotData!.slice(0, 10).map((row) => ({
                value: generatedColumns.map(col => row[col] || 0),
                name: row.rowKey
            }));
        } else {
            const values = pivotData!.map(item => Number(item.value || 0));
            const maxVal = Math.max(...values);
            const safeMax = maxVal > 0 ? Math.ceil(maxVal * 1.1) : 10;
            const displayData = pivotData!.slice(0, 12); 
            indicators = displayData.map(item => ({
                name: String(item.rowKey).substring(0, 8),
                max: safeMax
            }));
            seriesData = [{
                value: displayData.map(item => item.value),
                name: pivotConfig.valueField || '统计值'
            }];
        }

        return {
            backgroundColor: 'transparent',
            tooltip: { trigger: 'item', backgroundColor: 'rgba(0,0,0,0.8)', borderColor: 'rgba(255,255,255,0.2)', textStyle: { color: '#fff' } },
            legend: {
                show: true, type: 'scroll', bottom: 5, textStyle: { color: '#e5e7eb' },
                pageIconColor: theme.primary, //   使用主题色
                pageTextStyle: { color: '#9ca3af' }
            },
            radar: {
                indicator: indicators,
                shape: 'polygon',
                axisName: {
                    color: is2D ? '#22d3ee' : theme.primary, //   使用主题色
                    fontSize: 12, fontWeight: 'bold', textShadowColor: 'rgba(0,0,0,0.5)', textShadowBlur: 2
                },
                axisLabel: { show: false }, axisTick: { show: false },
                splitLine: {
                    lineStyle: {
                        color: [
                            'rgba(255, 255, 255, 0.05)', 
                            'rgba(255, 255, 255, 0.1)'
                        ].reverse()
                    }
                },
                splitArea: { show: true, areaStyle: { color: ['rgba(255, 255, 255, 0.02)', 'rgba(255, 255, 255, 0.05)'] } },
                axisLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.1)' } }
            },
            series: [{
                name: 'Data Analysis',
                type: 'radar',
                data: seriesData.map((item, index) => {
                    //   [ ] 一维模式使用主题色
                    const color = is2D ? NEON_PALETTE[index % NEON_PALETTE.length][0] : theme.primary;
                    return {
                        ...item,
                        itemStyle: { color: color },
                        areaStyle: { color: color, opacity: 0.2 },
                        lineStyle: { width: 2 }
                    };
                }),
                symbol: 'circle',
                symbolSize: 4
            }]
        };
    };

    // =================散点图配置=================
    const getScatterOption = () => {
        if (scatterSource === 'Raw') {
            if (!rawScatterData || !scatterConfig.xField || !scatterConfig.yField) return {};
            
            const xField = scatterConfig.xField;
            const yField = scatterConfig.yField;
            const data = rawScatterData.map(item => [item[xField], item[yField]]);

            return {
                backgroundColor: 'transparent',
                tooltip: {
                    trigger: 'item',
                    backgroundColor: 'rgba(0,0,0,0.8)',
                    borderColor: 'rgba(167, 139, 250, 0.3)',
                    textStyle: { color: '#fff' },
                    formatter: (params: any) => {
                        const val = params.value;
                        return `<div style="font-weight:bold;color:#a78bfa">● Raw Point</div><div>${xField}: ${val[0]}</div><div>${yField}: ${val[1]}</div>`;
                    }
                },
                grid: { top: '15%', left: '8%', right: '8%', bottom: '12%', containLabel: true },
                xAxis: { type: 'value', name: xField, nameTextStyle: { color: '#a78bfa' }, splitLine: { show: false }, axisLabel: { color: '#e5e7eb' } },
                yAxis: { type: 'value', name: yField, nameTextStyle: { color: '#a78bfa' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)', type: 'dashed' } }, axisLabel: { color: '#9ca3af' }, scale: true },
                series: [{
                    type: 'scatter', symbolSize: 6, large: true,
                    itemStyle: { color: '#a78bfa', shadowBlur: 5, shadowColor: 'rgba(167, 139, 250, 0.5)', opacity: 0.8 },
                    data: data
                }]
            };
        } else {
            if (!pivotData) return {};
            const is2D = generatedColumns.length > 1 || (generatedColumns[0] !== 'value');
            const xAxisData = pivotData.map(item => item.rowKey);
            
            let series: any[] = [];
            if (!is2D) {
                series.push({
                    name: pivotConfig.valueField || '统计值',
                    type: 'scatter',
                    data: pivotData.map(item => item.value),
                    symbolSize: 15,
                    itemStyle: { color: '#22d3ee', shadowBlur: 10, shadowColor: 'rgba(34, 211, 238, 0.5)' }
                });
            } else {
                series = generatedColumns.map((colKey, index) => {
                    const colorPair = NEON_PALETTE[index % NEON_PALETTE.length];
                    return {
                        name: colKey,
                        type: 'scatter',
                        data: pivotData.map(row => row[colKey] || null),
                        symbolSize: 15,
                        itemStyle: { color: colorPair[0], shadowBlur: 10, shadowColor: colorPair[1] }
                    };
                });
            }

            return {
                backgroundColor: 'transparent',
                tooltip: { trigger: 'item', backgroundColor: 'rgba(0,0,0,0.8)', textStyle: { color: '#fff' } },
                legend: { show: is2D, data: is2D ? generatedColumns : [], textStyle: { color: '#e5e7eb' }, bottom: 5 },
                grid: { top: '15%', left: '5%', right: '5%', bottom: '15%', containLabel: true },
                xAxis: { type: 'category', data: xAxisData, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#e5e7eb', rotate: 30 } },
                yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(255,255,255,0.08)', type: 'dashed' } }, axisLabel: { color: '#9ca3af' } },
                series: series
            };
        }
    };

    // =================热力图配置=================
    const getHeatmapOption = () => {
        if (!pivotData || generatedColumns.length === 0) return {};

        // 1. 准备 X 轴 (列) 和 Y 轴 (行) 数据
        let xAxisData = [...generatedColumns]; // 列头 (Columns)
        let yAxisData = pivotData.map(item => item.rowKey); // 行头 (Rows)

        // 2. 智能排序逻辑
        //   [ ] 使用 localeCompare 的 numeric: true 选项
        // 这是一种“自然排序”算法，能够正确处理：
        // - 纯数字：["1", "10", "2"] -> ["1", "2", "10"]
        // - 带字符数字：["第1周", "第10周", "第2周"] -> ["第1周", "第2周", "第10周"]
        const naturalSort = (a: any, b: any) => {
            return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
        };

        // 直接对轴数据进行排序，不再判断 isAllNumeric
        // 因为即便是纯字符，排序后也比乱序好；如果是数字，则会严格按大小排
        xAxisData.sort(naturalSort);
        yAxisData.sort(naturalSort);

        // 3. 构建 ECharts 需要的二维数组数据 [[xIndex, yIndex, value], ...]
        const seriesData: any[] = [];
        
        // 遍历所有可能的 (x, y) 组合
        // 注意：这里必须使用排序后的 xAxisData 和 yAxisData 进行双重遍历
        // 这样生成的 seriesData 中的 index 才能和坐标轴对应上
        xAxisData.forEach((colKey, xIndex) => {
            yAxisData.forEach((rowKey, yIndex) => {
                // 在 pivotData 中找到对应行
                const rowObj = pivotData.find(item => item.rowKey === rowKey);
                if (rowObj) {
                    const value = rowObj[colKey];
                    // ECharts 热力图数据格式: [x坐标索引, y坐标索引, 数值]
                    seriesData.push([xIndex, yIndex, value !== undefined && value !== null ? value : '-']);
                }
            });
        });

        // 4. 获取配色方案
        const paletteKey = HEATMAP_PALETTES[mapColorTheme] ? mapColorTheme : 'magma';
        const colors = HEATMAP_PALETTES[paletteKey];

        // 5. 计算最大值用于 VisualMap 范围
        const maxVal = Math.max(...seriesData.map(d => typeof d[2] === 'number' ? d[2] : 0));

        return {
            backgroundColor: 'transparent',
            tooltip: {
                position: 'top',
                backgroundColor: 'rgba(0,0,0,0.8)',
                borderColor: '#333',
                textStyle: { color: '#fff' },
                formatter: (params: any) => {
                    // params.data[0] 是 xIndex, params.data[1] 是 yIndex
                    const xLabel = xAxisData[params.data[0]];
                    const yLabel = yAxisData[params.data[1]];
                    return `<div style="text-align:center; font-weight:bold">${yLabel} - ${xLabel}</div>
                            <div>Value: <span style="color:${colors[colors.length-1]}">${params.data[2]}</span></div>`;
                }
            },
            grid: {
                top: '10%', bottom: '15%', left: '10%', right: '10%',
                containLabel: true
            },
            xAxis: {
                type: 'category',
                data: xAxisData, // 使用排序后的数据
                splitArea: { show: true },
                axisLabel: { color: '#e5e7eb', rotate: xAxisData.length > 5 ? 30 : 0 },
                axisLine: { show: false },
                axisTick: { show: false }
            },
            yAxis: {
                type: 'category',
                data: yAxisData, // 使用排序后的数据
                splitArea: { show: true },
                axisLabel: { color: '#e5e7eb' },
                axisLine: { show: false },
                axisTick: { show: false }
            },
            visualMap: {
                min: 0,
                max: maxVal || 10,
                calculable: true,
                orient: 'horizontal',
                left: 'center',
                bottom: '0%',
                textStyle: { color: '#fff' },
                inRange: {
                    color: colors
                },
                itemWidth: 15,
                itemHeight: 100
            },
            series: [{
                name: 'Distribution',
                type: 'heatmap',
                data: seriesData,
                label: { show: false },
                itemStyle: {
                    borderColor: '#1f2937',
                    borderWidth: 1,
                    borderRadius: 4
                },
                emphasis: {
                    itemStyle: {
                        shadowBlur: 10,
                        shadowColor: 'rgba(255, 255, 255, 0.5)',
                        borderColor: '#fff',
                        borderWidth: 2
                    }
                }
            }]
        };
    };

    // =================箱线图配置=================
    const getBoxplotOption = () => {
        if (!pivotData) return {};
        
        // 1. 数据预处理
        const validData = pivotData.filter(item => Array.isArray(item.value) && item.value.length > 0);
        
        // 注意：因为要横向显示，Y轴是分类，X轴是数值
        const categoryData = validData.map(item => item.rowKey); // Y轴分类
        const rawValuesArray = validData.map(item => item.value);

        // 2. 计算五数概括 (Min, Q1, Median, Q3, Max)
        const calculateStats = (arr: number[]) => {
            const sorted = arr.slice().sort((a, b) => a - b);
            const q1 = sorted[Math.floor(sorted.length * 0.25)];
            const median = sorted[Math.floor(sorted.length * 0.5)];
            const q3 = sorted[Math.floor(sorted.length * 0.75)];
            const min = sorted[0];
            const max = sorted[sorted.length - 1];
            return [min, q1, median, q3, max];
        };
        
        const boxPlotData = rawValuesArray.map(arr => calculateStats(arr));

        // 3. 生成 Jitter 散点数据 (坐标互换)
        // 旧(垂直): [index + jitter, value]
        //   [ ] 新(横向): [value, index + jitter] 
        const scatterSeriesData: number[][] = [];
        validData.forEach((item, index) => {
            item.value.forEach((val: number) => {
                // 抖动范围 -0.25 到 0.25 (稍微收窄一点更精致)
                const jitter = (Math.random() - 0.5) * 0.5; 
                scatterSeriesData.push([val, index + jitter]); 
            });
        });

        // 获取当前主题色
        const theme = THEME_COLORS[mapColorTheme] || THEME_COLORS.cyan;

        return {
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'item',
                axisPointer: { type: 'line' }, // 横向图表用 line 指针更好看
                backgroundColor: 'rgba(0,0,0,0.85)',
                borderColor: theme.primary,
                borderWidth: 1,
                textStyle: { color: '#fff' },
                // 格式化 Tooltip，适配横向数据
                formatter: (param: any) => {
                    if (param.seriesName === 'Box') {
                        return [
                            `<div style="font-weight:bold; color:${theme.primary}">${param.name}</div>`,
                            `Max: ${param.data[5]}`,
                            `Q3: ${param.data[4]}`,
                            `Median: ${param.data[3]}`,
                            `Q1: ${param.data[2]}`,
                            `Min: ${param.data[1]}`
                        ].join('<br/>');
                    } else {
                        // 散点 Tooltip
                        return `<div style="font-size:12px; color:#aaa">${param.name}</div>
                                <div style="font-weight:bold">${param.value[0]}</div>`;
                    }
                }
            },
            grid: { 
                top: '10%', 
                left: '3%', // 留白自适应
                right: '5%', 
                bottom: '10%',
                containLabel: true // 自动防止Y轴文字溢出
            },
            //   [ ] X 轴变成数值轴
            xAxis: {
                type: 'value',
                name: pivotConfig.valueField || 'Value',
                nameLocation: 'middle',
                nameGap: 30,
                nameTextStyle: { color: '#6b7280' },
                splitLine: { 
                    show: true,
                    lineStyle: { color: 'rgba(255,255,255,0.05)', type: 'dashed' } 
                },
                axisLabel: { color: '#9ca3af' },
                axisLine: { show: true, lineStyle: { color: 'rgba(255,255,255,0.1)' } }
            },
            //   [ ] Y 轴变成分类轴
            yAxis: {
                type: 'category',
                data: categoryData,
                inverse: true, //   [关键] 反转坐标轴，让第一个数据在最上面，符合阅读习惯
                axisLine: { show: false }, // 隐藏轴线，更简洁
                axisTick: { show: false },
                axisLabel: { 
                    color: '#e5e7eb',
                    fontWeight: 'bold',
                    width: 100, // 限制宽度
                    overflow: 'truncate' // 超长省略
                },
                splitLine: { show: false } // Y轴方向不要网格线
            },
            series: [
                {
                    name: 'Box',
                    type: 'boxplot',
                    data: boxPlotData,
                    //   [美化] 增加横向渐变和圆角
                    itemStyle: {
                        color: new echarts.graphic.LinearGradient(1, 0, 0, 0, [ // 从右向左渐变
                            { offset: 0, color: 'rgba(34, 211, 238, 0.4)' },
                            { offset: 1, color: 'rgba(34, 211, 238, 0.1)' }
                        ]),
                        borderColor: '#22d3ee',
                        borderWidth: 1.5
                    },
                    emphasis: {
                        itemStyle: {
                            borderColor: '#fff',
                            borderWidth: 2,
                            shadowBlur: 10,
                            shadowColor: '#22d3ee'
                        }
                    },
                    boxWidth: ['40%', '60%'] // 调整箱子粗细
                },
                {
                    name: 'Points',
                    type: 'scatter',
                    data: scatterSeriesData,
                    symbolSize: 5,
                    //   [美化] 散点使用互补色 (紫色/粉色) 并带发光
                    itemStyle: {
                        color: 'rgba(232, 121, 249, 0.7)', 
                        borderColor: 'rgba(232, 121, 249, 0.3)',
                        borderWidth: 1,
                        shadowBlur: 5,
                        shadowColor: 'rgba(232, 121, 249, 1)'
                    },
                    zlevel: 1 // 确保点在箱子上面
                }
            ]
        };
    };

    // =================山脊图配置=================
    const getRidgelineOption = () => {
        if (!pivotData || pivotData.length === 0) return {};
        
        const theme = THEME_COLORS[mapColorTheme] || THEME_COLORS.cyan;
        
        // 判断是模式 A (趋势) 还是 模式 B (分布)
        const isTrendMode = generatedColumns.length > 0 && !generatedColumns.includes('ridgeline_raw') && !generatedColumns.includes('boxplot_raw');
        
        let series: any[] = [];
        let xAxisConfig: any = {};
        let yAxisConfig: any = {};
        let tooltipConfig: any = {};
        //   [修复] 移除 visualMap，避免与 areaStyle 冲突
        const visualMapConfig = undefined; 

        if (!isTrendMode) {
            // === 模式 B: 分布/密度山脊图 (Density) ===
            
            // ... (保留 kernelDensityEstimator, kernelEpanechnikov, d3Mean 算法函数)
            const kernelDensityEstimator = (kernel: any, X: number[]) => {
                return (V: number[]) => {
                    return X.map(x => [x, d3Mean(V, (v: number) => kernel(x - v))]);
                };
            };
            const kernelEpanechnikov = (k: number) => {
                return (v: number) => {
                    return Math.abs(v /= k) <= 1 ? 0.75 * (1 - v * v) / k : 0;
                };
            };
            const d3Mean = (arr: any[], fn: any) => {
                let sum = 0;
                let count = 0;
                for (let i = 0; i < arr.length; i++) {
                    const v = fn ? fn(arr[i]) : arr[i];
                    if (v !== undefined && !isNaN(v)) {
                        sum += v;
                        count++;
                    }
                }
                //   [优化] 防止除以 0 返回 NaN
                return count ? sum / count : 0;
            };

            // 2. 计算全局范围
            let allValues: number[] = [];
            //   [优化] 过滤掉空数组或非数组，防止报错
            const validRows = pivotData.filter(row => Array.isArray(row.value) && row.value.length > 0);
            validRows.forEach(row => allValues.push(...row.value));
            
            if (allValues.length === 0) return {};
            
            const minVal = Math.min(...allValues);
            const maxVal = Math.max(...allValues);
            //   [优化] 防止 range 为 0 导致死循环
            const range = Math.max(maxVal - minVal, 0.0001);
            
            const xTicks = Array.from({ length: 100 }, (_, i) => minVal + (i * range) / 99);
            const categories = validRows.map(row => row.rowKey);
            
            // 3. 生成 Series
            series = validRows.map((row, index) => {
                const kde = kernelDensityEstimator(kernelEpanechnikov(range / 15), xTicks);
                const density = kde(row.value); 
                
                // 归一化密度高度
                const maxDensity = Math.max(...density.map((d: any) => d[1]));
                //   这里的 Y 值是 index + 0.xxx
                const scaledDensity = density.map((d: any) => [d[0], d[1] / (maxDensity || 1) * 0.8 + index]);

                return {
                    name: row.rowKey,
                    type: 'line',
                    smooth: true,
                    symbol: 'none',
                    data: scaledDensity,
                    lineStyle: { width: 1.5, color: '#fff' },
                    areaStyle: {
                        opacity: 0.7,
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: theme.primary }, 
                            { offset: 1, color: 'rgba(0,0,0,0)' }
                        ])
                    },
                    // 确保第一行在最下面/或最上面，取决于视觉偏好，这里保持顺序
                    z: validRows.length - index 
                };
            });

            xAxisConfig = {
                type: 'value',
                min: minVal,
                max: maxVal,
                axisLabel: { color: '#9ca3af' },
                splitLine: { show: false }
            };

            //   [修复关键点] Y 轴必须是 value 类型才能支持浮点数堆叠
            yAxisConfig = {
                type: 'value', 
                min: 0,
                max: categories.length, 
                axisLine: { show: false },
                axisTick: { show: false },
                splitLine: { show: true, lineStyle: { color: 'rgba(255,255,255,0.05)' } },
                axisLabel: { 
                    color: '#e5e7eb',
                    margin: 10,
                    //   [关键] 自定义 Formatter：把数值索引 (0, 1, 2) 变回 分类名
                    formatter: (val: number) => {
                        // 只有当 val 非常接近整数时才显示标签
                        if (Math.abs(val - Math.round(val)) < 0.01) {
                            return categories[Math.round(val)] || '';
                        }
                        return '';
                    }
                },
                // 增加一点内边距，让第一个和最后一个山峰不贴边
                boundaryGap: ['10%', '10%']
            };

            tooltipConfig = {
                trigger: 'axis',
                axisPointer: { type: 'line' },
                formatter: (params: any) => {
                    // 找到 hover 最近的那个点
                    if (!params.length) return '';
                    // 排序找到 Y 值最接近鼠标位置的 series（逻辑较复杂，这里简化显示）
                    // 直接显示当前 X 坐标对应的值
                    const xVal = params[0].value[0].toFixed(2);
                    let html = `<div style="font-weight:bold; margin-bottom:5px">Value: ${xVal}</div>`;
                    
                    // 只显示前 5 个有数据的系列，防止 tooltip 太长
                    params.slice(0, 8).forEach((p: any) => {
                        // 还原相对高度：(Y - index) / 0.8
                        const yVal = p.value[1]; 
                        const index = validRows.findIndex(r => r.rowKey === p.seriesName);
                        // 简单的视觉提示
                        html += `
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; font-size:12px">
                            <span style="color:${p.color}">● ${p.seriesName}</span>
                            <span style="color:#aaa">Density: ${(yVal - index).toFixed(2)}</span>
                        </div>`;
                    });
                    return html;
                }
            };

        } else {
            // === 模式 A: 时序/趋势山脊图 (Trend) ===
            // ... (这部分逻辑之前是对的，保持不变，或确保 Y 轴也是 value 类型)
            
            const categories = pivotData.map(d => d.rowKey);
            const xLabels = [...generatedColumns];
            const isNumeric = xLabels.every(l => !isNaN(Number(l)));
            if (isNumeric) xLabels.sort((a, b) => Number(a) - Number(b));

            let globalMax = 0;
            pivotData.forEach(row => {
                xLabels.forEach(col => {
                    const val = Number(row[col] || 0);
                    if (val > globalMax) globalMax = val;
                });
            });

            series = pivotData.map((row, index) => {
                const data = xLabels.map(col => {
                    const val = Number(row[col] || 0);
                    const normalizedVal = (val / (globalMax || 1)) * 1.5; 
                    return normalizedVal + index; 
                });

                return {
                    name: row.rowKey,
                    type: 'line',
                    smooth: true,
                    symbol: 'none',
                    data: data,
                    lineStyle: { width: 1, color: '#fff', opacity: 0.5 },
                    areaStyle: {
                        opacity: 0.8,
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: theme.gradient[0] },
                            { offset: 1, color: theme.gradient[1] } 
                        ])
                    },
                    z: pivotData.length - index
                };
            });

            xAxisConfig = {
                type: 'category',
                data: xLabels,
                boundaryGap: false,
                axisLabel: { color: '#9ca3af', rotate: 30 }
            };
            
            //   [统一] 趋势图也用 Value 轴 + Formatter，保持一致性
            yAxisConfig = {
                type: 'value',
                show: true,
                axisLabel: {
                    formatter: (val: number) => {
                        if (Math.abs(val - Math.round(val)) < 0.01) {
                             return categories[Math.round(val)] || '';
                        }
                        return '';
                    },
                    color: '#e5e7eb',
                    margin: 10
                },
                splitLine: { show: false },
                min: 0,
                max: categories.length + 1
            };
            tooltipConfig = { /* ... 保留之前的 tooltip ... */ };
        }

        return {
            backgroundColor: 'transparent',
            tooltip: tooltipConfig,
            grid: { top: '10%', left: '12%', right: '5%', bottom: '10%' },
            xAxis: xAxisConfig,
            yAxis: yAxisConfig,
            series: series,
            //   [修复] 移除 visualMap
            visualMap: visualMapConfig 
        };
    };

    const getOption = useMemo(() => {
        if ((!pivotData && !rawScatterData) || !isChartVisible) return {};
        switch (chartType) {
            case 'Ridgeline': return getRidgelineOption(); //   [新增]
            case 'Radar': return getRadarOption(); 
            case 'Scatter': return getScatterOption(); 
            case 'Heatmap': return getHeatmapOption(); //   [新增]
            case 'BoxPlot': return getBoxplotOption(); //   [新增]
            case 'Bar': default: return getBarOption();
        }
    }, [pivotData, rawScatterData, chartType, scatterSource, scatterConfig, generatedColumns, pivotConfig, isChartVisible, mapColorTheme]);

    //   [新增] 点击事件处理
    const onChartClick = (params: any) => {
        if (!isMapLinkageEnabled) return;
        
        console.log('Chart Click:', params);

        // 1. 处理行联动 (Category / Row)
        // params.name 对应 rowKey (X轴)
        if (params.name) {
            const nextCategory = highlightedCategory === params.name ? null : params.name;
            setHighlightedCategory(nextCategory);
        }

        // 2. 处理列联动 (Series / Column)
        // params.seriesName 对应列名 (Legend)
        // 只有在二维模式下 (generatedColumns > 0) 才处理
        if (params.seriesName && generatedColumns.includes(params.seriesName)) {
            // 设置当前激活的列，地图颜色将随之改变
            setActiveColumn(params.seriesName);
        }
    };
    
    //   点击空白处取消高亮 (可选，取决于 zrender 事件，这里先只处理数据点击)
    const onChartEvents = {
        'click': onChartClick
    };

    if (!isChartVisible) return null;
    //   [ ] 判断是否是 2D 分析模式 (有行也有列)

    const is2DAnalysis = pivotData && pivotConfig.groupByRow && pivotConfig.groupByCol;
    //   [新增]  判断：只有“收集”模式且“一维”时，才允许箱线图
    const isBoxPlotAvailable = pivotConfig.method === 'boxplot' && !pivotConfig.groupByCol;
    
    //   [新增] 判断山脊图是否可用: 
    // 1. 选择了 'ridgeline' 聚合 (分布模式)
    // 2. 或者 选择了 'sum/avg' 且是二维 (趋势模式)
    const isRidgelineAvailable = 
        (pivotConfig.method === 'ridgeline') || 
        (is2DAnalysis && pivotConfig.method !== 'boxplot');

    //   [新增] 专门针对 Heatmap 的配色选项
    const showHeatmapPalette = chartType === 'Heatmap';

    //   [新增] 判断是否显示色系选择器：开启联动 && 一维透视
    const showThemeSelect = isMapLinkageEnabled && pivotData && !pivotConfig.groupByCol && pivotConfig.groupByRow;

    return (
        <div 
            className="absolute bottom-8 right-8 z-1000 flex flex-col overflow-hidden
                       rounded-3xl transition-all duration-300 ease-out
                       bg-[#0b1121]/30 backdrop-blur-xl
                       border border-white/10 ring-1 ring-white/5
                       shadow-[0_8px_32px_0_rgba(0,0,0,0.36)]
                       group hover:bg-[#0b1121]/40 hover:border-cyan-500/30"
            style={{ width: containerWidth, height: containerHeight }}
        >
            {/* 1. Header */}
            <div className="h-14 shrink-0 flex items-center justify-between px-4 border-b border-white/5 bg-linear-to-r from-white/5 to-transparent">
                {/* 左侧：主图表切换 */}
                <div className="mr-2">
                    <Segmented<ChartType>
                        options={[
                            { label: '柱状图', value: 'Bar', icon: <BarChartOutlined /> },
                            { label: '雷达图', value: 'Radar', icon: <RadarChartOutlined /> },
                            { label: '散点图', value: 'Scatter', icon: <DotChartOutlined /> }, 
                            //   [新增] 热力图选项，仅在 2D 模式下可用
                            { 
                                label: '热力图', 
                                value: 'Heatmap', 
                                icon: <HeatMapOutlined />, 
                                disabled: !is2DAnalysis, // 如果没选列，禁用
                                className: !is2DAnalysis ? 'opacity-50 cursor-not-allowed' : ''
                            },
                            //   [新增] 箱线图按钮 (带条件限制)
                            {
                                label: '箱线',
                                value: 'BoxPlot',
                                icon: <BoxPlotOutlined />,
                                disabled: !isBoxPlotAvailable,
                                className: !isBoxPlotAvailable ? 'opacity-50 cursor-not-allowed' : ''
                            },
                            //   [新增] 山脊图按钮
                            {
                                label: '山脊图', value: 'Ridgeline', icon: <DeploymentUnitOutlined />,
                                disabled: !isRidgelineAvailable, className: !isRidgelineAvailable ? 'opacity-50 cursor-not-allowed' : ''
                            }
                        ]}
                        value={chartType}
                        onChange={setChartType}
                        className="custom-segmented-glass"
                    />
                    

                    {/*   [新增] 热力图配色选择器 */}
                    {showHeatmapPalette && (
                         <Select
                            size="small"
                            variant="borderless"
                            value={HEATMAP_PALETTES[mapColorTheme] ? mapColorTheme : 'magma'}
                            onChange={setMapColorTheme}
                            popupMatchSelectWidth={false}
                            className="w-32 ml-2"
                            options={[
                                { value: 'magma', label: '混合' },
                                { value: 'cyber', label: '青色' },
                                { value: 'inferno', label: '红色' },
                                { value: 'ocean', label: '蓝色' },
                                { value: 'matrix', label: '矩阵' },
                            ]}
                         />
                    )}

                    {/*   色系选择器 (UI 优化：显示渐变色条) */}
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
                                        {/* 显示色条预览 */}
                                        <div className="w-4 h-2 rounded-xs" style={{ 
                                            background: conf.type === 'gradient' 
                                                ? `linear-gradient(to right, ${conf.stops![0]}, ${conf.stops![1]})`
                                                : conf.primary 
                                        }}></div>
                                        <span className="text-gray-300 text-xs">{conf.label}</span>
                                    </div>
                                ),
                                value: key
                            }))}
                         />
                    )}

                </div>

                {/*   中间：散点图数据源切换 (仅在 Scatter 模式下显示) */}
                <div className="flex-1 flex justify-end mr-4">
                    {chartType === 'Scatter' && (
                        <Segmented<'Pivoted' | 'Raw'>
                            options={[
                                { label: '透视', value: 'Pivoted' },
                                { label: '原始', value: 'Raw' }
                            ]}
                            value={scatterSource}
                            onChange={setScatterSource}
                            className="custom-segmented-glass-sm"
                            size="small"
                        />
                    )}
                </div>
                
                <Button 
                    type="text" shape="circle" icon={<CloseOutlined className="text-gray-300 hover:text-white" />} 
                    onClick={() =>{
                        setChartVisible(false);
                        setHighlightedCategory(null); //   关闭图表时清除高亮
                    }} className="hover:bg-white/10"
                />
            </div>

            {/* 2. ECharts */}
            <div className="flex-1 w-full h-full p-2 relative">
                <ReactECharts 
                    option={getOption} 
                    style={{ height: '100%', width: '100%' }} 
                    theme="dark" 
                    autoResize 
                    notMerge
                    //   绑定事件
                    onEvents={onChartEvents} 
                />
            </div>

            {/* Footer */}
            <div className="h-10 shrink-0 flex items-center justify-between px-4 border-t border-white/5 bg-white/5 text-xs text-gray-300">
                <div className="flex items-center gap-2 font-medium">
                    {/*   [ ] 联动状态指示灯 */}
                    <EnvironmentOutlined className={isMapLinkageEnabled ? 'text-cyan-400' : 'text-gray-400'} />
                    <span>地图颜色映射联动</span>
                </div>
                {/*   [ ] 绑定 store 状态 */}
                <Switch 
                    size="small" 
                    checked={isMapLinkageEnabled} 
                    onChange={(checked) => {
                        setMapLinkageEnabled(checked);
                        if(!checked) setHighlightedCategory(null);
                    }} 
                    className="bg-gray-500/50" 
                />
            </div>

            <style>{`
                /* 主切换器样式 */
                .custom-segmented-glass.ant-segmented {
                    background-color: rgba(0,0,0,0.2); color: #9ca3af; padding: 4px;
                }
                .custom-segmented-glass .ant-segmented-item-selected {
                    background-color: rgba(34, 211, 238, 0.15) !important; 
                    color: #22d3ee !important;
                    border: 1px solid rgba(34, 211, 238, 0.3);
                    backdrop-filter: blur(4px);
                }
                .custom-segmented-glass .ant-segmented-item:hover:not(.ant-segmented-item-selected) {
                    color: #fff !important; background-color: rgba(255,255,255,0.1) !important;
                }
                
                /*   副切换器样式 (更小更精致，紫色系区分) */
                .custom-segmented-glass-sm.ant-segmented {
                    background-color: rgba(0,0,0,0.3); color: #a78bfa;
                }
                .custom-segmented-glass-sm .ant-segmented-item-selected {
                    background-color: rgba(167, 139, 250, 0.2) !important;
                    color: #fff !important;
                    border: 1px solid rgba(167, 139, 250, 0.4);
                }
                .ant-segmented-thumb { background-color: transparent !important; }
            `}</style>
        </div>
    );
};

export default ChartOverlay;