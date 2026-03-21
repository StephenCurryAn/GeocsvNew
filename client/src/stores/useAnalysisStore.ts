import { create } from 'zustand';

// 透视配置接口
export interface PivotConfig {
    groupByRow: string | null;
    groupByCol: string | null;
    valueField: string | null;
    method: 'sum' | 'avg' | 'count' | 'max' | 'min' | 'boxplot' | 'ridgeline';
}

// ✅ 新增：散点图配置接口
export interface ScatterConfig {
    xField: string | null;
    yField: string | null;
}
// ✅ [修改] 添加 'Ridgeline' 到图表类型
export type ChartType = 'Bar' | 'Radar' | 'Scatter' | 'Pie' | 'Heatmap' | 'BoxPlot' | 'Ridgeline';

// ✅ [修改] 扩展支持的色系 Key，增加渐变色系
export type ColorThemeType = 
    // 单色系 (Opacity Mode)
    | 'cyan' | 'purple' | 'blue' | 'green' | 'yellow' | 'red' 
    // 渐变色系 (Gradient Mode)
    | 'fire_ice' | 'magma' | 'viridis' | 'ocean' | 'cyber';

interface AnalysisState {
    // --- 透视相关 ---
    pivotConfig: PivotConfig;
    setPivotConfig: (config: Partial<PivotConfig>) => void;
    pivotData: any[] | null;
    generatedColumns: string[]; 
    setPivotResult: (data: any[], cols: string[]) => void;

    // --- ✅ 新增：散点图相关 ---
    scatterConfig: ScatterConfig;
    setScatterConfig: (config: Partial<ScatterConfig>) => void;
    rawScatterData: any[] | null; // 存储未聚合的原始数据
    setRawScatterData: (data: any[]) => void;

    // --- ✅ 新增：全局图表状态 ---
    chartType: ChartType;
    setChartType: (type: ChartType) => void;

    // --- 通用状态 ---
    isLoading: boolean;
    setLoading: (loading: boolean) => void;
    isPivotPanelOpen: boolean;
    setPivotPanelOpen: (isOpen: boolean) => void;
    isChartVisible: boolean;
    setChartVisible: (visible: boolean) => void;

    // ✅ 新增：地图联动相关状态
    isMapLinkageEnabled: boolean;
    setMapLinkageEnabled: (enabled: boolean) => void;
    
    // ✅ 新增：当前高亮的分类（对应 pivotData 的 rowKey）
    highlightedCategory: string | null;
    setHighlightedCategory: (category: string | null) => void;

    // ✅ 新增：地图/图表的主题色系
    mapColorTheme: ColorThemeType;
    setMapColorTheme: (theme: ColorThemeType) => void;

    // ✅ [新增] 当前激活的列（用于二维透视联动）
    // 比如用户点击了 "2021" 年的柱子，这里就存 "2021"
    activeColumn: string | null;
    setActiveColumn: (col: string | null) => void;
}

export const useAnalysisStore = create<AnalysisState>((set) => ({
    // Pivot Defaults
    pivotConfig: {
        groupByRow: null,
        groupByCol: null,
        valueField: null,
        method: 'count',
    },
    setPivotConfig: (config) => set((state) => ({ 
        pivotConfig: { ...state.pivotConfig, ...config } 
    })),
    pivotData: null,
    generatedColumns: [],
    setPivotResult: (data, cols) => set({ pivotData: data, generatedColumns: cols }),

    // Scatter Defaults
    scatterConfig: {
        xField: null,
        yField: null,
    },
    setScatterConfig: (config) => set((state) => ({ 
        scatterConfig: { ...state.scatterConfig, ...config } 
    })),
    rawScatterData: null,
    setRawScatterData: (data) => set({ rawScatterData: data }),

    // Global Chart State
    chartType: 'Bar',
    setChartType: (type) => set({ chartType: type }),

    isLoading: false,
    setLoading: (loading) => set({ isLoading: loading }),
    isPivotPanelOpen: false,
    setPivotPanelOpen: (isOpen) => set({ isPivotPanelOpen: isOpen }),
    isChartVisible: false, 
    setChartVisible: (visible) => set({ isChartVisible: visible }),

    // ✅ 新增状态初始化
    isMapLinkageEnabled: false,
    setMapLinkageEnabled: (enabled) => set({ isMapLinkageEnabled: enabled }),
    
    highlightedCategory: null,
    setHighlightedCategory: (category) => set({ highlightedCategory: category }),

    // ✅ 初始化默认为青色
    mapColorTheme: 'cyan',
    setMapColorTheme: (theme) => set({ mapColorTheme: theme }),

    // ✅ [新增] 初始化
    activeColumn: null,
    setActiveColumn: (col) => set({ activeColumn: col }),

}));