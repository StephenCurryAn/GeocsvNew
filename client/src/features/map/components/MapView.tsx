import React, { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { bbox } from '@turf/turf';
//   [ ] 引入所需的 Ant Design 组件
import { 
    Button, Tooltip, App, Checkbox, Spin, Select, ConfigProvider, 
    theme, Popover, Segmented, Slider, Badge 
} from 'antd';
import ChartOverlay, { THEME_COLORS, CONTRAST_PALETTES } from './ChartOverlay';
import { geoService } from '../../../services/geoService';
//   [ ] 引入图标
import { 
    BarChartOutlined, 
    GlobalOutlined,      
    BgColorsOutlined,    
    GatewayOutlined,     
    CloudServerOutlined, 
    DeploymentUnitOutlined, // 网格入口图标
    AppstoreOutlined,       // Hex 图标
    BorderOutlined,         // Square 图标
    ThunderboltOutlined,    // 执行图标
    UndoOutlined,            // 重置图标
    SaveOutlined,
    FilterOutlined
} from '@ant-design/icons';
import { useAnalysisStore } from '../../../stores/useAnalysisStore'

const { Option, OptGroup } = Select;

interface MapViewProps {
    data: any;        // GeoJSON 数据
    fileName: string; // 当前文件名
    fileId?: string; // 当前选中的文件ID (必须要有这个才能去后台拉全量数据)
    selectedFeature?: any;
    onFeatureClick?: (feature: any) => void;
}

//   [ ] 扩展 GridConfig 接口，增加 coverage
interface GridConfig {
    shape: 'hex' | 'square';
    size: number;
    // 添加 'coverage'
    method: 'count' | 'sum' | 'avg' | 'max' | 'min' | 'coverage'; 
    targetField: string | null;
    categoryFields: string[];
}

// --- 配置常量 ---
//   [ ] 1. 升级配色方案库：提供高区分度的色阶 (High Distinction Palettes)
const COLOR_SCHEMES = {
    // A. 经典红黄蓝 (适合展示差异，对比极强)
    rdylbu: { 
        name: '红黄蓝 (RdYlBu)', 
        colors: ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#fee090', '#fdae61', '#f46d43', '#d73027', '#a50026'] 
    },
    // B. 科学可视化 (Viridis) - 深色底图最佳拍档，亮度变化均匀
    viridis: { 
        name: '极光绿 (Viridis)', 
        colors: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'] 
    },
    // C. 烈焰红 (Magma) - 暖色系，高对比度
    magma: { 
        name: '烈焰红 (Magma)', 
        colors: ['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f1705b', '#fe9f6d', '#fcfdbf'] 
    },
    // D. 深海蓝 (Ocean) - 清新单色系，分层明显
    blues: { 
        name: '深海蓝 (Blues)', 
        colors: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'] 
    },
    // E. 默认青色 (保留一个简单的)
    default: { 
        name: '科技青 (Default)', 
        colors: ['#e0f7fa', '#b2ebf2', '#80deea', '#4dd0e1', '#26c6da', '#00bcd4', '#00acc1', '#0097a7', '#00838f', '#006064'] 
    },
    categorical: {
        name: '离散型',
        // 经典的 D3/Tableau 风格高对比度颜色，色相差异极大，绝不混淆
        colors: ['#e6194B', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4']
    },
    pastel: {
        name: '离散型（低饱和）',
        // 柔和、低饱和度的多色彩系，非常适合做大面积多边形(Polygon)填充，不会刺眼
        colors: ['#ffb3ba', '#ffdfba', '#ffffba', '#baffc9', '#bae1ff', '#e0bbe4', '#957dad', '#d291bc', '#fec8d8', '#ffdfd3']
    },
    cyberpunk: {
        name: '离散型（高饱和）',
        // 配合你的暗色底图，极高饱和度、发光质感的霓虹色
        colors: ['#ff00ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000', '#0000ff', '#ff8800', '#ff0088', '#88ff00', '#8800ff']
    }
};

//   [新增] 颜色插值辅助函数 (Hex -> RGB -> Interpolate -> Hex)
// 简单的线性插值，用于在JS端计算颜色
function hexToRgb(hex: string) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
}

function componentToHex(c: number) {
    const hex = Math.round(c).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
}

function rgbToHex(r: number, g: number, b: number) {
    return "#" + componentToHex(r) + componentToHex(g) + componentToHex(b);
}

function interpolateColor(color1: string, color2: string, factor: number) {
    const c1 = hexToRgb(color1);
    const c2 = hexToRgb(color2);
    const r = c1.r + (c2.r - c1.r) * factor;
    const g = c1.g + (c2.g - c1.g) * factor;
    const b = c1.b + (c2.b - c1.b) * factor;
    return rgbToHex(r, g, b);
}

// 2. 预设底图样式 (Basemaps)
const BASEMAPS = [
    {
        key: 'dark',
        name: 'Dark',
        style: {
            version: 8,
            sources: {
                'carto-dark': {
                    type: 'raster',
                    tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'],
                    tileSize: 256,
                    attribution: '&copy; CARTO'
                }
            },
            layers: [{ id: 'carto-dark-layer', type: 'raster', source: 'carto-dark' }]
        }
    },
    {
        key: 'light',
        name: 'Light',
        style: {
            version: 8,
            sources: {
                'carto-light': {
                    type: 'raster',
                    tiles: ['https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'],
                    tileSize: 256,
                    attribution: '&copy; CARTO'
                }
            },
            layers: [{ id: 'carto-light-layer', type: 'raster', source: 'carto-light' }]
        }
    },
    {
        key: 'satellite',
        name: '卫星图',
        style: {
            version: 8,
            sources: {
                'tianditu-sat': {
                    type: 'raster',
                    tiles: [
                        'http://t0.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=2f10b6f61571dbb1f5c8199c813fea4d'
                    ], 
                    tileSize: 256,
                    attribution: '&copy; 天地图'
                }
            },
            layers: [{ id: 'tianditu-sat-layer', type: 'raster', source: 'tianditu-sat' }]
        }
    }
];

const MapView: React.FC<MapViewProps> = ({ data, fileName, fileId, selectedFeature, onFeatureClick }) => {
    //     2: 获取上下文感知的 message 实例
    // 注意：MapView 必须被包裹在 <App> 组件中（通常在 main.tsx 或 App.tsx 已经包了）
    const { message } = App.useApp();
    const mapContainer = useRef<HTMLDivElement>(null);
    const mapInstance = useRef<maplibregl.Map | null>(null);
    const popupRef = useRef<maplibregl.Popup | null>(null);
    // 缓存上一次的文件名，防止重复 fitBounds
    const lastFileNameRef = useRef<string>('');

    const [isMapLoaded, setIsMapLoaded] = useState(false);
    const [numericFields, setNumericFields] = useState<string[]>([]); // 可用于映射的数值字段
    //   [新增] 存储文本型字段，用于分类拆分
    const [stringFields, setStringFields] = useState<string[]>([]);

    const [activeField, setActiveField] = useState<string | null>(null); // 当前选中的映射字段
    const [activeScheme, setActiveScheme] = useState<string>('viridis'); // 当前颜色方案
    const [activeBasemap, setActiveBasemap] = useState<string>('dark'); // 当前底图
    
    const [uniqueFieldValues, setUniqueFieldValues] = useState<(string | number)[]>([]); // 存放当前字段所有的唯一值
    const [activeFilterValues, setActiveFilterValues] = useState<(string | number)[]>([]); // 存放当前勾选的值

    //  状态管理 - 全量数据相关
    const [showAll, setShowAll] = useState(false);
    const [allData, setAllData] = useState<any>(null);
    const [loading, setLoading] = useState(false);

    //   [新增] 空间网格相关状态
    const [isGridMode, setIsGridMode] = useState(false);
    const [gridData, setGridData] = useState<any>(null); // 存储后端返回的 GeoJSON
    const [gridLoading, setGridLoading] = useState(false);

    //   [ ] 状态初始化
    const [gridConfig, setGridConfig] = useState<GridConfig>({
        shape: 'hex',
        size: 5,
        method: 'count',
        targetField: null,
        categoryFields: [] // 默认为空数组
    });

    //   [ ] 决定当前显示数据的逻辑
    // 优先级：网格模式(gridData) > 全量模式(allData) > 分页模式(data)
    const displayData = (isGridMode && gridData) 
        ? gridData 
        : ((showAll && allData) ? allData : data);

    //  使用 Ref 来始终追踪最新的 displayData
    // Ref 可以穿透闭包，确保在事件监听器（如切换底图）中拿到的是这一刻应该显示的数据（全量），而不是旧数据
    const displayDataRef = useRef(displayData);
    //  每次组件渲染时，都更新 ref 的值为最新的 displayData
    displayDataRef.current = displayData;

    //   [新增] 获取 Store 状态
    const { isChartVisible, setChartVisible, generatedColumns,
        pivotData, pivotConfig, // 数据
        isMapLinkageEnabled, highlightedCategory, mapColorTheme,// 联动状态
        //   [新增] 获取 activeColumn
        activeColumn 
    } = useAnalysisStore();

    //  切换文件时的自动清理逻辑
    useEffect(() => {
        // 只要 fileId 变了，或者 fileName 变了，说明切文件了
        // 立即重置勾选框，并清空内存中的 allData
        if (showAll || allData) {
            console.log('切换文件，自动释放旧文件的全量数据内存...');
            setShowAll(false);
            setAllData(null); // 立即释放内存
        }
    }, [fileId, fileName]); // 依赖项加上 fileName 双重保险

    //  处理复选框点击事件
    const handleShowAllChange = async (e: any) => {
        const isChecked = e.target.checked;
        
        if (isChecked) {
            // 勾选：去加载数据
            if (!fileId) {
                message.warning("无法获取文件ID，无法加载全量数据");
                return;
            }

            // 如果已经有缓存，直接切状态，不请求
            if (allData) {
                setShowAll(true);
                return;
            }

            setLoading(true);
            try {
                // 调用后端接口 (需要在 geoService 中实现 getAllFileData)
                const resdata = await geoService.getAllFileData(fileId);
                if (resdata) {
                    setAllData(resdata); // 存入缓存
                    setShowAll(true);     // 切换状态
                    message.success(`全量数据加载完成: 共 ${resdata.pagination.total} 个要素`);
                }
            } catch (error) {
                console.error(error);
                message.error('加载全量数据失败');
                setShowAll(false); 
            } finally {
                setLoading(false);
            }
        } else {
            // 🚫 取消勾选：立即释放内存！
            console.log('用户取消勾选，释放全量数据内存...');
            setShowAll(false);
            setAllData(null); // 设置为 null，垃圾回收会介入
        }
    };

    // 初始化地图
    useEffect(() => {
        if (mapInstance.current) return;

        // mapContainer.current的初始值是<div ref={mapContainer} className="w-full h-full" />给的
        // （初始值是这个div）
        if (mapContainer.current) {
            // 默认使用第一个底图配置
            const defaultStyle = BASEMAPS.find(b => b.key === 'dark')?.style || BASEMAPS[0].style;

            mapInstance.current = new maplibregl.Map({
                container: mapContainer.current,
                style: defaultStyle as any, // 类型强转，只要符合 Mapbox Style Spec 即可
                center: [118.7969, 32.0603],
                zoom: 7
            });

            mapInstance.current.on('load', () => {
                console.log('  地图加载完成');
                setIsMapLoaded(true);
                // 确保地图撑满屏幕，防止显示bug
                mapInstance.current?.resize();
            });
        }
        // 清理函数
        // 当这个地图组件被销毁（例如用户切到别的页面，或者组件被隐藏）时，
        // 彻底清除地图占用的资源，防止内存泄漏
        return () => {
            setIsMapLoaded(false);
            if (mapInstance.current) {
                mapInstance.current.remove();
                mapInstance.current = null;
            }
        };
    }, []);

    //   [ ] 字段提取逻辑分离：
    // 1. numericFields (数值): 从 displayData 提取，用于当前地图的颜色渲染（支持网格的 value 字段）
    // 2. stringFields (文本): 始终从 原始数据(data/allData) 提取，用于导出时的分类拆分
    useEffect(() => {
        // --- A. 处理渲染字段 (随视图变化) ---
        if (displayData && displayData.features && displayData.features.length > 0) {
            const firstProps = displayData.features[0].properties;
            const numFields = Object.keys(firstProps).filter(key => {
                const val = firstProps[key];
                return typeof val === 'number';
            });
            setNumericFields(numFields);
            
            // 如果切回了网格模式，且有 value 字段，自动选上
            if (isGridMode && numFields.includes('value') && activeField !== 'value') {
                // setActiveField('value'); // 可选：自动选中
            }
        } else {
            setNumericFields([]);
        }

        // --- B. 处理原始字段 (始终锁定原始数据) ---
        // 确定当前持有的原始数据源
        const sourceData = (showAll && allData) ? allData : data;
        
        if (sourceData && sourceData.features && sourceData.features.length > 0) {
            const rawProps = sourceData.features[0].properties;
            
            //   [ 修复] 从原始数据中提取分类字段
            const strFields = Object.keys(rawProps).filter(key => {
                const val = rawProps[key];
                // 排除系统字段和非字符串字段
                return typeof val === 'string' && !['_id', 'id', 'fid', 'ObjectId'].includes(key);
            });
            setStringFields(strFields);
        } else {
            setStringFields([]);
        }
        
    }, [displayData, data, allData, showAll, isGridMode]); // 依赖项加上 data 等

    //   [新增] Effect 3: 提取当前渲染字段的唯一值，作为下拉列表的选项
    useEffect(() => {
        // 如果没选字段、或者处于网格模式、或者没数据，清空过滤选项
        if (!activeField || activeField === 'none' || isGridMode || !displayData) {
            setUniqueFieldValues([]);
            setActiveFilterValues([]);
            return;
        }

        const valSet = new Set<string | number>();
        displayData.features.forEach((f: any) => {
            const val = f.properties[activeField];
            // 排除 null 和 undefined，但放行 0 和 空字符串
            if (val !== undefined && val !== null) {
                valSet.add(val);
            }
        });

        // 排序：如果是数字就按大小排，如果是文字就按字母排
        const uniqueVals = Array.from(valSet).sort((a, b) => {
            if (typeof a === 'number' && typeof b === 'number') return a - b;
            return String(a).localeCompare(String(b));
        });

        setUniqueFieldValues(uniqueVals);
        setActiveFilterValues(uniqueVals); // 默认全部勾选
    }, [activeField, displayData, isGridMode]);

    //   [新增] Effect 4: 将用户的过滤选项应用到地图图层 (Filter 属性)
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;

        const applyFilter = () => {
            // 当没有开启过滤或处于网格模式时，恢复默认显示所有
            if (isGridMode || !activeField || activeField === 'none') {
                if (map.getLayer('geo-fill-layer')) map.setFilter('geo-fill-layer', ['==', '$type', 'Polygon']);
                if (map.getLayer('geo-polygon-border')) map.setFilter('geo-polygon-border', ['==', '$type', 'Polygon']);
                if (map.getLayer('geo-linestring-main')) map.setFilter('geo-linestring-main', ['==', '$type', 'LineString']);
                if (map.getLayer('geo-point-layer')) map.setFilter('geo-point-layer', ['==', '$type', 'Point']);
                return;
            }

            // 如果用户取消了所有的勾选，什么都不渲染
            if (activeFilterValues.length === 0) {
                const hideExp: any = ['==', 'id', 'nothing_selected'];
                if (map.getLayer('geo-fill-layer')) map.setFilter('geo-fill-layer', hideExp);
                if (map.getLayer('geo-polygon-border')) map.setFilter('geo-polygon-border', hideExp);
                if (map.getLayer('geo-linestring-main')) map.setFilter('geo-linestring-main', hideExp);
                if (map.getLayer('geo-point-layer')) map.setFilter('geo-point-layer', hideExp);
                return;
            }

            // 👇  修复：构建传统过滤语法 ['in', '字段名', '值1', '值2', ...]
            const filterExp: any = ['in', activeField, ...activeFilterValues];

            // 应用到所有图层，同时保留原有基础的 Geometry 类型过滤
            if (map.getLayer('geo-fill-layer')) {
                map.setFilter('geo-fill-layer', ['all', ['==', '$type', 'Polygon'], filterExp] as any);
            }
            if (map.getLayer('geo-polygon-border')) {
                map.setFilter('geo-polygon-border', ['all', ['==', '$type', 'Polygon'], filterExp] as any);
            }
            if (map.getLayer('geo-linestring-main')) {
                map.setFilter('geo-linestring-main', ['all', ['==', '$type', 'LineString'], filterExp] as any);
            }
            if (map.getLayer('geo-point-layer')) {
                map.setFilter('geo-point-layer', ['all', ['==', '$type', 'Point'], filterExp] as any);
            }
        };

        applyFilter();
    }, [activeFilterValues, activeField, isGridMode, isMapLoaded]);


    //   [新增] 全选/清空处理函数
    const handleSelectAllCategories = () => {
        if (gridConfig.categoryFields.length === stringFields.length) {
            // 如果已全选，则清空
            setGridConfig(prev => ({ ...prev, categoryFields: [] }));
        } else {
            // 否则全选
            setGridConfig(prev => ({ ...prev, categoryFields: [...stringFields] }));
        }
    };

    //   [新增] 生成网格处理函数
    const handleGenerateGrid = async () => {
        if (!fileId) {
            message.error("无法获取文件ID，请先保存文件");
            return;
        }
        //   修正逻辑：计数(count) 和 覆盖率(coverage) 都不需要选择数值字段
        if (gridConfig.method !== 'count' && gridConfig.method !== 'coverage' && !gridConfig.targetField) {
            message.warning("非计数/覆盖率模式下，请选择一个数值字段");
            return;
        }

        setGridLoading(true);
        try {
            // 1. 调用后端接口
            const res = await geoService.generateGridAggregation(fileId, gridConfig);
            
            if (res.success && res.data) {
                setGridData(res.data); // 保存网格 GeoJSON
                setIsGridMode(true);   // 进入网格模式
                
                // 2. 自动设置渲染字段为聚合结果 'value'
                setActiveField('value'); 
                
                message.success(`生成成功: ${res.data.features.length} 个网格单元`);
            } else {
                message.error("生成失败: 后端返回异常");
            }

        } catch (err) {
            console.error(err);
            message.error("网格生成请求失败，请检查后端服务");
        } finally {
            setGridLoading(false);
        }
    };

    //   [新增] 重置网格，切回原始数据
    const handleResetGrid = () => {
        setIsGridMode(false);
        setGridData(null);
        setActiveField(null); // 清空字段，让用户重新选
        message.info("已切换回原始图层");
    };

    /**
     *   [ ]  渲染逻辑：只负责 Geometry 和基础图层架构
     * (移除了底部的 map.on 事件绑定，防止重复)
     */
    const renderGeoJSON = (geoJSON: any) => {
        const map = mapInstance.current;
        if (!map || !map.getStyle()) return;

        const sourceId = 'uploaded-geo-data';

        // 清理旧图层 (注意名字变了)
        const layersToRemove = [
            'geo-fill-layer', 
            'geo-polygon-border', //   新图层名
            'geo-linestring-main', //   新图层名
            'geo-line-layer', // 旧图层名(兼容清理)
            'geo-point-layer', 
            'geo-highlight-fill', 'geo-highlight-line', 'geo-highlight-point'
        ];
        layersToRemove.forEach(layer => {
            if (map.getLayer(layer)) map.removeLayer(layer);
        });
        if (map.getSource(sourceId)) map.removeSource(sourceId);

        // 添加数据源
        map.addSource(sourceId, { type: 'geojson', data: geoJSON });

        // 1. 填充层
        map.addLayer({
            id: 'geo-fill-layer', type: 'fill', source: sourceId,
            paint: { 
                'fill-color': '#00e5ff', 
                'fill-opacity': 0.6,
                //   [ ] 智能边框：网格模式透明，普通模式保留淡淡的轮廓
                'fill-outline-color': isGridMode ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0.1)' 
            },
            filter: ['==', '$type', 'Polygon']
        });
        // 2.   面边框图层 (Polygon Border) - 只渲染 Polygon 的轮廓
        // 它的任务是：高亮时变白，不参与颜色映射
        map.addLayer({
            id: 'geo-polygon-border', type: 'line', source: sourceId,
            paint: { 
                // 使用极低透明度的白色或黑色，取决于你的底图，这里用通用淡白
                'line-color': 'rgba(255, 255, 255, 0.08)', 
                //   [ ] 智能线宽：网格模式隐藏(0)，普通模式显示(1)
                'line-width': isGridMode ? 0 : 1,
                'line-opacity': 0.5
            },
            filter: ['==', '$type', 'Polygon']
        });

        // 3.   线实体图层 (LineString Main) - 只渲染 LineString
        // 它的任务是：像面一样展示炫酷的渐变色
        map.addLayer({
            id: 'geo-linestring-main', type: 'line', source: sourceId,
            paint: { 
                'line-color': '#00e5ff', 
                'line-width': 3, // 默认粗一点，更有质感
                'line-opacity': 0.8,
                'line-blur': 1   // 加一点模糊，做出霓虹灯管效果
            },
            filter: ['==', '$type', 'LineString']
        });

        // 3. 点图层
        map.addLayer({
            id: 'geo-point-layer', type: 'circle', source: sourceId,
            paint: { 'circle-radius': 6, 'circle-color': '#00e5ff', 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' },
            filter: ['==', '$type', 'Point']
        });
        // 高亮层 (略，保持原样)
        map.addLayer({ id: 'geo-highlight-fill', type: 'fill', source: sourceId, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.2 }, filter: ['==', 'id', 'nothing-selected'] });
        map.addLayer({ id: 'geo-highlight-line', type: 'line', source: sourceId, paint: { 'line-color': '#ffffff', 'line-width': 3 }, filter: ['==', 'id', 'nothing-selected'] });
        map.addLayer({ id: 'geo-highlight-point', type: 'circle', source: sourceId, paint: { 'circle-radius': 8, 'circle-color': '#ffffff', 'circle-stroke-width': 2, 'circle-stroke-color': '#ff0000' }, filter: ['==', 'id', 'nothing-selected'] });

        if (fileName !== lastFileNameRef.current) {
            try {
                const bounds = bbox(geoJSON) as [number, number, number, number];
                map.fitBounds(bounds, { padding: 50, maxZoom: 14, duration: 1500 });
                lastFileNameRef.current = fileName; 
            } catch(e) { console.warn('BBox calc failed', e) }
        }
    };

/**
     *   [新增] 专门的 Effect 处理事件绑定 (只运行一次或当 isMapLoaded 变时)
     * 解决了重复绑定导致的性能问题
     */
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;

        // 监听列表更新
        const interactiveLayers = [
            'geo-fill-layer', 
            'geo-polygon-border', 
            'geo-linestring-main', //  
            'geo-point-layer'
        ];

        const handleClick = (e: any) => {
            if (e.features && e.features.length > 0) {
                const feature = e.features[0];
                const props = feature.properties;
                // ... (props.cp 处理逻辑保持不变)
                if (typeof props.cp === 'string') { try { props.cp = JSON.parse(props.cp); } catch (err) {} }
                if (!props.cp || !Array.isArray(props.cp)) {
                    if (feature.geometry.type === 'Point') {
                         // @ts-ignore
                        props.cp = feature.geometry.coordinates;
                    } else { props.cp = [e.lngLat.lng, e.lngLat.lat]; }
                }
                if (onFeatureClick) onFeatureClick(props);
            }
        };

        const handleMouseEnter = () => map.getCanvas().style.cursor = 'pointer';
        const handleMouseLeave = () => map.getCanvas().style.cursor = '';

        // 绑定
        interactiveLayers.forEach(layerId => {
            map.on('click', layerId, handleClick);
            map.on('mouseenter', layerId, handleMouseEnter);
            map.on('mouseleave', layerId, handleMouseLeave);
        });

        // 清理
        return () => {
            interactiveLayers.forEach(layerId => {
                map.off('click', layerId, handleClick);
                map.off('mouseenter', layerId, handleMouseEnter);
                map.off('mouseleave', layerId, handleMouseLeave);
            });
        };
    }, [isMapLoaded]); // 只依赖 isMapLoaded


    //   [ ]  联动着色逻辑：增强高亮对比度
    const updateLinkageColors = () => {
        const map = mapInstance.current;
        // 卫兵：只要没有 图层就退出
        if (!map || (!map.getLayer('geo-fill-layer') && !map.getLayer('geo-linestring-main'))) return;
        
        const isPivotMode = isMapLinkageEnabled && pivotData && pivotData.length > 0;
        const isScenario1 = isPivotMode && !pivotConfig.groupByCol && pivotConfig.groupByRow; 
        const isScenario2 = isPivotMode && pivotConfig.groupByCol && pivotConfig.groupByRow; 

        if (isScenario1 || isScenario2) {
            const rowField = pivotConfig.groupByRow!;
            let targetValues: number[] = [];
            
            let useGradient = false;
            let gradStart = '#000';
            let gradEnd = '#fff';
            let singleColor = '#00e5ff';
            
            const themeConfig = THEME_COLORS[mapColorTheme];

            if (isScenario1) {
                targetValues = pivotData!.map(d => Number(d.value));
                if (themeConfig.type === 'gradient' && themeConfig.stops) {
                    useGradient = true;
                    gradStart = themeConfig.stops[0];
                    gradEnd = themeConfig.stops[1];
                } else {
                    useGradient = false;
                    singleColor = themeConfig.primary;
                }
            } else if (isScenario2) {
                const targetCol = (activeColumn && generatedColumns.includes(activeColumn)) 
                    ? activeColumn 
                    : generatedColumns[0];
                const colIndex = generatedColumns.indexOf(targetCol);
                const safeIndex = colIndex >= 0 ? colIndex : 0;
                const palette = CONTRAST_PALETTES[safeIndex % CONTRAST_PALETTES.length];
                
                useGradient = true;
                gradStart = palette[0];
                gradEnd = palette[1];
                targetValues = pivotData!.map(d => Number(d[targetCol] || 0));
                
                console.log(`🔗 联动渲染: Col=${targetCol}, Mode=${useGradient ? 'Gradient' : 'Single'}`);
            }

            const minVal = Math.min(...targetValues);
            const maxVal = Math.max(...targetValues);
            const range = maxVal - minVal;

            //   [   1] 使用 'to-string' 强制转字符串，规避浮点数分支报错
            // 原来: ['match', ['get', rowField]]
            // 现在: ['match', ['to-string', ['get', rowField]]]
            const colorMatch: any[] = ['match', ['to-string', ['get', rowField]]];
            const opacityMatch: any[] = ['match', ['to-string', ['get', rowField]]];
            
            // 2. 边框逻辑 (适用于 PolygonBorder)
            const borderStrokeWidthMatch: any[] = ['match', ['to-string', ['get', rowField]]];
            const borderStrokeColorMatch: any[] = ['match', ['to-string', ['get', rowField]]];

            // 3. 线宽逻辑 (适用于 LineMain)
            const mainLineWidthMatch: any[] = ['match', ['to-string', ['get', rowField]]];

            // 3. 点描边属性 (Point Stroke)
            const pointStrokeWidthMatch: any[] = ['match', ['to-string', ['get', rowField]]];
            const pointStrokeColorMatch: any[] = ['match', ['to-string', ['get', rowField]]];
            const pointRadiusMatch: any[] = ['match', ['to-string', ['get', rowField]]];

            pivotData!.forEach((item, index) => {
                const val = targetValues[index]; 
                let normalized = 0.5;
                if (range > 0) normalized = (val - minVal) / range;

                let calculatedColor: string;
                let calculatedOpacity: number;

                if (useGradient) {
                    calculatedColor = interpolateColor(gradStart, gradEnd, normalized);
                    calculatedOpacity = 0.8; 
                } else {
                    calculatedColor = singleColor;
                    calculatedOpacity = 0.2 + (normalized * 0.7); 
                }

                //   修复后：统统转成字符串进行比对，无视 String 和 Number 的类型差异
                const isSelected = highlightedCategory != null && String(highlightedCategory) === String(item.rowKey);
                const hasActiveSelection = !!highlightedCategory;

                let finalColor = calculatedColor;
                let finalOpacity = calculatedOpacity;
                
                // Polygon Border Params
                let finalBorderWidth = 1;
                let finalBorderColor = 'rgba(255,255,255,0.3)';
                
                //   Line Main Params
                let finalLineWidth = 3; // 默认线宽

                //   Point Params (默认值)
                let finalPointRadius = 4;
                let finalPointStrokeWidth = 1;
                let finalPointStrokeColor = 'rgba(255,255,255,0.2)';

                if (hasActiveSelection) {
                    if (isSelected) {
                        // 选中: 颜色最亮，完全不透明
                        finalColor = calculatedColor;
                        finalOpacity = 1.0;
                        
                        // Polygon: 白边框加粗
                        finalBorderWidth = 4;
                        finalBorderColor = '#ffffff';

                        //   Line: 线条加粗
                        finalLineWidth = 6; 

                        //   Point: 变大，白边框加粗
                        finalPointRadius = 6;
                        finalPointStrokeWidth = 2;
                        finalPointStrokeColor = '#ffffff';
                    } else {
                        // 未选中: 颜色不变(保留上下文)，但变暗
                        finalColor = calculatedColor;
                        finalOpacity = 0.3; 
                        
                        // Polygon: 边框隐去
                        finalBorderWidth = 1;
                        finalBorderColor = 'rgba(255,255,255,0.1)';

                        //   Line: 线条变细
                        finalLineWidth = 2;

                        //   Point: 变小，边框几乎隐形
                        finalPointRadius = 1; // 稍微变小一点，退居次要位置
                        finalPointStrokeWidth = 1;
                        finalPointStrokeColor = 'rgba(255,255,255,0.1)'; // 关键：把边框也变暗！
                    }
                }

                //   [   2] 将匹配值也转为字符串 String(item.rowKey)
                const matchKey = String(item.rowKey);

                colorMatch.push(matchKey, finalColor);
                opacityMatch.push(matchKey, finalOpacity);
                
                borderStrokeWidthMatch.push(matchKey, finalBorderWidth);
                borderStrokeColorMatch.push(matchKey, finalBorderColor);
                
                mainLineWidthMatch.push(matchKey, finalLineWidth);

                // Push Point Params
                pointRadiusMatch.push(matchKey, finalPointRadius);
                pointStrokeWidthMatch.push(matchKey, finalPointStrokeWidth);
                pointStrokeColorMatch.push(matchKey, finalPointStrokeColor);
            });

            // 👇 👇 👇   ：让未参与透视的脏点彻底隐形 👇 👇 👇
            // Defaults (回退默认值)
            // 无论有没有选中柱子，未参与分析的数据一律透明、尺寸为0，保持地图绝对干净
            
            // 基础颜色和透明度
            colorMatch.push('transparent'); 
            opacityMatch.push(0.0); //   永远为0，彻底透明
            
            // Polygon (面) 边框
            borderStrokeWidthMatch.push(0);
            borderStrokeColorMatch.push('rgba(0,0,0,0)');
            
            // Line (线) 宽度
            mainLineWidthMatch.push(0);
            
            // Point (点) 属性
            pointRadiusMatch.push(0);               //   半径改为 0，直接消失！
            pointStrokeWidthMatch.push(0);          // 无描边
            pointStrokeColorMatch.push('rgba(0,0,0,0)');
            
            // ============ 应用属性 ============

            try { //   [新增] 加上 try-catch 保护
                // 1. Polygon Fill (面填充)
                if (map.getLayer('geo-fill-layer')) {
                    map.setPaintProperty('geo-fill-layer', 'fill-color', colorMatch);
                    map.setPaintProperty('geo-fill-layer', 'fill-opacity', opacityMatch);
                }

                // 2. Polygon Border (面边框)
                if (map.getLayer('geo-polygon-border')) {
                    map.setPaintProperty('geo-polygon-border', 'line-width', borderStrokeWidthMatch);
                    map.setPaintProperty('geo-polygon-border', 'line-color', borderStrokeColorMatch);
                }

                // 3. LineString Main (线实体)
                if (map.getLayer('geo-linestring-main')) {
                    map.setPaintProperty('geo-linestring-main', 'line-color', colorMatch);
                    map.setPaintProperty('geo-linestring-main', 'line-opacity', opacityMatch);
                    map.setPaintProperty('geo-linestring-main', 'line-width', mainLineWidthMatch);
                }

                // 4. Point (点)
                if (map.getLayer('geo-point-layer')) {
                     map.setPaintProperty('geo-point-layer', 'circle-color', colorMatch);
                     map.setPaintProperty('geo-point-layer', 'circle-opacity', opacityMatch);
                     map.setPaintProperty('geo-point-layer', 'circle-radius', pointRadiusMatch);
                     map.setPaintProperty('geo-point-layer', 'circle-stroke-width', pointStrokeWidthMatch);
                     map.setPaintProperty('geo-point-layer', 'circle-stroke-color', pointStrokeColorMatch);
                 }
            } catch (e) {
                console.error("Linkage Apply Error:", e);
            }

        } else {
            //   [修复] 回退逻辑 (保持不变)
            // 1. 先尝试执行普通分级渲染 (如果用户选了字段)
            updateChoroplethColors();
            
            // 2. 恢复默认状态
            // 面图层
            if (map.getLayer('geo-fill-layer')) {
                map.setPaintProperty('geo-fill-layer', 'fill-opacity', 0.6);
                //   [ ] 恢复时也看模式
                map.setPaintProperty('geo-fill-layer', 'fill-outline-color', isGridMode ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0)');
            }
            
            // 面边框 (Polygon Border)
            if (map.getLayer('geo-polygon-border')) {
                //   [ ] 恢复时也看模式
                map.setPaintProperty('geo-polygon-border', 'line-width', isGridMode ? 0 : 1);
                map.setPaintProperty('geo-polygon-border', 'line-color', activeBasemap === 'light' ? '#666' : '#a5f3fc');
            }

            // 线实体 (LineString Main)
            if (map.getLayer('geo-linestring-main')) {
                map.setPaintProperty('geo-linestring-main', 'line-width', 2);
                map.setPaintProperty('geo-linestring-main', 'line-color', '#00e5ff');
                map.setPaintProperty('geo-linestring-main', 'line-opacity', 0.8);
            }
            // 点图层
            if (map.getLayer('geo-point-layer')) {
                map.setPaintProperty('geo-point-layer', 'circle-color', '#00e5ff');
                map.setPaintProperty('geo-point-layer', 'circle-opacity', 1);
                map.setPaintProperty('geo-point-layer', 'circle-radius', 6);
                map.setPaintProperty('geo-point-layer', 'circle-stroke-width', 1);
                map.setPaintProperty('geo-point-layer', 'circle-stroke-color', '#ffffff');
            }
        }
    };

    /**
     *   [ ] 更新颜色映射 (Choropleth) - 采用“分段阶梯”渲染以增强区分度，支持值过滤变暗
     */
    const updateChoroplethColors = () => {
        // 卫兵：如果开启了联动模式且符合条件，直接退出
        const isScenario1 = isMapLinkageEnabled && pivotData && pivotData.length > 0 && !pivotConfig.groupByCol && pivotConfig.groupByRow;
        if (isScenario1) return;

        const map = mapInstance.current;
        const currentDisplayData = displayDataRef.current;
        
        if (!map || !map.getLayer('geo-fill-layer') || !currentDisplayData) return;

        // 1. 如果没有选字段，恢复默认颜色 (全部全亮显示)
        if (!activeField || activeField === 'none') {
            if (map.getLayer('geo-fill-layer')) {
                map.setPaintProperty('geo-fill-layer', 'fill-color', '#00e5ff');
                map.setPaintProperty('geo-fill-layer', 'fill-outline-color', 'rgba(0,0,0,0)'); 
                map.setPaintProperty('geo-fill-layer', 'fill-opacity', 0.6);
            }
            if (map.getLayer('geo-linestring-main')) {
                map.setPaintProperty('geo-linestring-main', 'line-color', '#00e5ff');
                map.setPaintProperty('geo-linestring-main', 'line-opacity', 0.8);
                map.setPaintProperty('geo-linestring-main', 'line-width', 3);
            }
            if (map.getLayer('geo-point-layer')) {
                map.setPaintProperty('geo-point-layer', 'circle-color', '#00e5ff');
                map.setPaintProperty('geo-point-layer', 'circle-opacity', 1);
                map.setPaintProperty('geo-point-layer', 'circle-radius', 6);
                map.setPaintProperty('geo-point-layer', 'circle-stroke-width', 1);
                map.setPaintProperty('geo-point-layer', 'circle-stroke-color', '#ffffff');
            }
            return;
        }

        // 2. 获取配色方案
        // @ts-ignore
        const scheme = COLOR_SCHEMES[activeScheme] || COLOR_SCHEMES.default;
        const colors = scheme.colors;

        let baseColorExpression: any;

        // 判断当前选中的是文本字段还是数值字段
        const isStringField = stringFields.includes(activeField);

        if (isStringField) {
            // ==========================================
            //   文本字段：分类唯一值渲染 (Categorical Match)
            // ==========================================
            baseColorExpression = ['match', ['get', activeField]];
            
            // uniqueFieldValues 在前面的 useEffect 中已经提取好了（去重+排序过的数据）
            if (uniqueFieldValues.length > 0) {
                uniqueFieldValues.forEach((val, index) => {
                    // 循环利用调色板中的颜色，保证同一类型颜色固定
                    const colorIndex = index % colors.length;
                    baseColorExpression.push(val);
                    baseColorExpression.push(colors[colorIndex]);
                });
            } else {
                baseColorExpression.push('__dummy__', colors[0]); // 防呆兜底
            }
            
            // Mapbox 要求 match 必须有一个默认 Fallback 颜色
            baseColorExpression.push('#808080'); 

        } else {
                // 3. 计算极值 (Min/Max)
                let min = Infinity;
                let max = -Infinity;
                currentDisplayData.features.forEach((f: any) => {
                    const val = f.properties[activeField];
                    if (typeof val === 'number') {
                        if (val < min) min = val;
                        if (val > max) max = val;
                    }
                });

                if (min === Infinity || max === -Infinity) return; // 没数据
                
                // 4. 构建基础颜色表达式 (Base Expression)
                if (min === max) {
                    baseColorExpression = colors[Math.floor(colors.length / 2)];
                } else {
                    const stepCount = colors.length;
                    const stepSize = (max - min) / stepCount;
                    baseColorExpression = ['step', ['get', activeField]];
                    baseColorExpression.push(colors[0]);
                    for (let i = 1; i < stepCount; i++) {
                        const stopValue = min + (stepSize * i);
                        baseColorExpression.push(stopValue);
                        baseColorExpression.push(colors[i]);
                    }
                }
        }
        //    5. [  ] 构建“是否勾选”的判断逻辑   
        // 如果用户把下拉框清空了，为了防止底层引擎报错，给一个绝对匹配不到的值
        const safeFilterValues = activeFilterValues.length > 0 ? activeFilterValues : ['__NOTHING_SELECTED__'];
        
        // isMatched 是一个布尔运算：当前要素的值，是否在安全数组内
        const isMatched: any = ['in', ['get', activeField], ['literal', safeFilterValues]];

        // 利用 ['case', 条件, 满足时的值, 不满足时的值] 动态分配属性
        
        // 🚀  点：Color 统一直接使用 baseColorExpression，保留原色
        
        // 面 (Polygon) 属性
        const finalFillColor = baseColorExpression;                                 // 无论是否勾选，都保留原色
        const finalFillOpacity = ['case', isMatched, 0.85, 0.15];                   // 未勾选透明度降到 15%
        const outlineColor = isGridMode ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0.05)';
        const finalFillOutline = ['case', isMatched, outlineColor, 'rgba(0,0,0,0)'];// 未勾选去边框

        // 线 (LineString) 属性
        const finalLineColor = baseColorExpression;                                 // 保留原色
        const finalLineOpacity = ['case', isMatched, 0.8, 0.15];                    // 未勾选变透明
        const finalLineWidth = ['case', isMatched, 3, 1];                           // 未勾选变极细

        // 点 (Point) 属性
        const finalPointColor = baseColorExpression;                                // 保留原色
        const finalPointOpacity = ['case', isMatched, 1.0, 0.2];                    //   给 20% 的透明度，确保能看清原本的颜色，但又很暗淡
        const finalPointRadius = ['case', isMatched, 6, 2];                         //   未勾选缩小到 2px
        const finalPointStrokeWidth = ['case', isMatched, 1, 0];                    // 未勾选无描边
        const finalPointStrokeColor = ['case', isMatched, 'rgba(255,255,255,0.3)', 'rgba(0,0,0,0)'];

        // 6. 应用到地图
        if (map.getLayer('geo-fill-layer')) {
            map.setPaintProperty('geo-fill-layer', 'fill-color', finalFillColor);
            map.setPaintProperty('geo-fill-layer', 'fill-opacity', finalFillOpacity); 
            map.setPaintProperty('geo-fill-layer', 'fill-outline-color', finalFillOutline);
        }
        
        if (map.getLayer('geo-linestring-main')) {
            map.setPaintProperty('geo-linestring-main', 'line-color', finalLineColor);
            map.setPaintProperty('geo-linestring-main', 'line-opacity', finalLineOpacity);
            map.setPaintProperty('geo-linestring-main', 'line-width', finalLineWidth);
        }
        
        if (map.getLayer('geo-point-layer')) {
            map.setPaintProperty('geo-point-layer', 'circle-color', finalPointColor);
            map.setPaintProperty('geo-point-layer', 'circle-opacity', finalPointOpacity);
            map.setPaintProperty('geo-point-layer', 'circle-radius', finalPointRadius);
            map.setPaintProperty('geo-point-layer', 'circle-stroke-width', finalPointStrokeWidth);
            map.setPaintProperty('geo-point-layer', 'circle-stroke-color', finalPointStrokeColor);
        }
    };

//   [ ] Effect 1: 仅处理“数据几何渲染” (Geometry)
    // 只有当文件数据变化时，重绘
    useEffect(() => {
        if (isMapLoaded && displayData) {
            renderGeoJSON(displayData);
            updateLinkageColors(); // 初始绘制后立即上色
        }
    }, [displayData, isMapLoaded]); 


    //   [ ] Effect 2: 仅处理“样式/颜色更新” (Paint)
    // 当联动开关、高亮状态、透视数据、或主题色变化时，只更新颜色
    useEffect(() => {
        if (isMapLoaded && displayData) {
            updateLinkageColors();
        }
    }, [
        isMapLinkageEnabled, pivotData, pivotConfig, 
        highlightedCategory, mapColorTheme, //   依赖新状态
        activeField, activeScheme
    ]);
    
    // 监听可视化配置变化（字段、配色），只更新 Paint Property，不重绘 Geometry
    useEffect(() => {
        if (isMapLoaded && data) {
            updateChoroplethColors();
        }
    }, [activeField, activeScheme, activeFilterValues, isMapLoaded]);
    
    // 用来记录上一次的底图，初始化为当前的 activeBasemap
    const prevBasemapRef = useRef(activeBasemap);
    // 监听样式数据加载，确保图层在切换底图后不丢失
    useEffect(() => {
        const map = mapInstance.current;
        if (!map) return;

        const onStyleData = () => {
            if (activeBasemap !== prevBasemapRef.current) {
                console.log(`底图改变触发: ${prevBasemapRef.current} -> ${activeBasemap}`);
                // 立即更新 Ref，防止后续的 styledata 事件重复打印
                prevBasemapRef.current = activeBasemap;
            }
            //  这里全部改成使用 displayDataRef.current
            const currentData = displayDataRef.current;
            // 只有当地图样式完全加载，且我们需要的数据存在时才执行
            if (map.getStyle() && currentData) {
                // console.log('地图样式完全加载，重新渲染');
                
                //  判断：如果数据源不见了（说明刚切换了底图），则重新渲染
                if (!map.getSource('uploaded-geo-data')) {
                    console.log('检测到底图切换，正在恢复 GeoJSON 图层...');
                    
                    // 加上 try-catch 防止极少数情况下的竞态错误
                    try {
                        renderGeoJSON(currentData);
                        // 稍微延迟一点点应用颜色，确保图层已经注册到 map 中
                        setTimeout(() => {
                            updateChoroplethColors();
                        }, 10);
                    } catch (err) {
                        console.warn('恢复图层失败，等待下一次事件:', err);
                    }
                }
            }
        };

        map.on('styledata', onStyleData);

        return () => {
            map.off('styledata', onStyleData);
        };
    // 这里加入 activeBasemap 依赖，是为了确保 renderGeoJSON 内部取到的边框颜色是基于新底图的
    }, [activeBasemap, activeField, activeScheme]);

    // handleBasemapChange只需要负责两件事：更新 React 状态、告诉地图切换样式
    // basemapKey 是从 UI 界面上的下拉菜单（Select 组件）传过来的
    const handleBasemapChange = (basemapKey: string) => {
        const map = mapInstance.current;
        if (!map) return;

        const targetStyle = BASEMAPS.find(b => b.key === basemapKey)?.style;
        if (targetStyle) {
            // 更新 React 状态 (用于 UI 显示)
            setActiveBasemap(basemapKey);
            
            // 切换地图样式 (这会触发 styledata 事件，进而触发上面的 useEffect)
            map.setStyle(targetStyle as any);
        }
    };
    
    // 监听 selectedFeature 高亮 (保持原有逻辑)
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;
        if (!selectedFeature) {
            if (map.getLayer('geo-highlight-fill')) map.setFilter('geo-highlight-fill', ['==', 'id', 'nothing']);
            if (map.getLayer('geo-highlight-line')) map.setFilter('geo-highlight-line', ['==', 'id', 'nothing']);
            popupRef.current?.remove();
            return;
        }
        const uniqueKey = selectedFeature.id ? 'id' : 'name';
        const uniqueVal = selectedFeature.id || selectedFeature.name;
        if (uniqueVal) {
            // 防止 ID 类型不匹配 (String vs Number)
            // 如果是 ID，我们让它同时匹配 字符串形式 和 数字形式
            if (uniqueKey === 'id') {
                map.setFilter('geo-highlight-fill', [
                    // 'any' 相当于 JavaScript 中的 ||（逻辑或）
                    'any', 
                    ['==', ['to-string', ['get', 'id']], String(uniqueVal)], // 把地图里的ID转字符串对比
                    ['==', ['get', 'id'], uniqueVal] // 或者直接对比
                ]);
                map.setFilter('geo-highlight-line', [
                    'any', 
                    ['==', ['to-string', ['get', 'id']], String(uniqueVal)],
                    ['==', ['get', 'id'], uniqueVal]
                ]);
            } else {
                // 只有 name 的情况 (旧逻辑)
                map.setFilter('geo-highlight-fill', ['==', uniqueKey, uniqueVal]);
                map.setFilter('geo-highlight-line', ['==', uniqueKey, uniqueVal]);
            }
        }
        // Popup 逻辑
        // 这里的 cp 现在肯定是数组了，因为我们在 click 事件里修复了它
        let centerCoord: [number, number] | null = null;
        // 使用数据自带的 cp (center point) 字段
        if (selectedFeature.cp && Array.isArray(selectedFeature.cp)) {
            centerCoord = selectedFeature.cp as [number, number];
        }

        if (centerCoord) {
            // 移除旧弹窗
            popupRef.current?.remove();

            // 显式提取 ID，确保它不被 ignoreKeys 过滤掉，或者单独显示
            const displayId = selectedFeature.id || 'N/A';

            // 生成弹窗内容 HTML (过滤掉不想显示的内部字段)
            // const ignoreKeys = ['_geometry', '_geometry_type'];
            const rowsHtml = Object.entries(selectedFeature)
                // 过滤掉 id (因为我们在标题栏或置顶显示它)，过滤掉 geometry 相关
                .filter(([key]) => {
                    // 1. 不显示 id (因为标题栏有了)
                    if (key === 'id') return false;
                    // 2.  不显示任何以 _ 开头的临时字段
                    if (key.startsWith('_')) return false;
                    // 3. 不显示 cp (中心点坐标)
                    if (key === 'cp') return false;
                    
                    return typeof key === 'string';
                })
                .map(([key, val]) => `
                    <div class="flex justify-between py-1 border-b border-gray-700 last:border-0">
                        <span class="text-gray-400 font-mono text-xs uppercase">${key}</span>
                        <span class="text-cyan-400 font-bold text-xs ml-4 text-right">${val}</span>
                    </div>
                `).join('');

            const popupContent = `
                <div class="min-w-50">
                    <div class="text-sm font-bold text-white mb-1 flex items-center justify-between">
                        <div class="flex items-center">
                            <span class="w-2 h-2 rounded-full bg-cyan-400 mr-2 shadow-[0_0_8px_#00e5ff]"></span>
                            ${selectedFeature.name || 'Feature'}
                        </div>
                        <span class="text-xs font-mono text-gray-500">ID: ${displayId}</span>
                    </div>
                    <div class="w-full h-px bg-cyan-500/50 mb-2"></div>
                    <div>${rowsHtml}</div>
                </div>
            `;

            // 创建自定义样式的弹窗
            popupRef.current = new maplibregl.Popup({
                closeButton: true,
                closeOnClick: false,
                className: 'dark-cool-popup', // 对应下面的 CSS 类名
                maxWidth: '300px',
                offset: 15
            })
            .setLngLat(centerCoord)
            .setHTML(popupContent)
            .addTo(map);

            // 飞到该位置
            map.flyTo({ center: centerCoord, zoom: 16, speed: 1.5 });
        }
    }, [selectedFeature, isMapLoaded]);

    //   [新增] 导出处理函数
    const handleExport = async () => {
        if (!fileId) return;
        message.loading({ content: '正在生成并导出全量数据...', key: 'exporting' });
        const success = await geoService.exportGridAggregation(fileId, gridConfig);
        if (success) {
            message.success({ content: '导出成功！已开始下载', key: 'exporting' });
        } else {
            message.error({ content: '导出失败，请重试', key: 'exporting' });
        }
    };

    //   [新增] 网格配置面板的 UI 内容
    const gridConfigContent = (
        //   [ ] 移除 Space 组件，改用 div + flex 布局，彻底解决 direction 警告
        <div className="w-64 p-1 flex flex-col gap-2">
            
            {/* 1. 形状选择 */}
            <div className="flex justify-between items-center">
                <span className="text-gray-400 text-xs">网格形状</span>
                <Segmented
                    value={gridConfig.shape}
                    onChange={(val: any) => setGridConfig(prev => ({ ...prev, shape: val }))}
                    options={[
                        { label: '六边形', value: 'hex', icon: <AppstoreOutlined /> },
                        { label: '正方形', value: 'square', icon: <BorderOutlined /> }
                    ]}
                    size="small"
                    className="bg-gray-700 text-gray-200"
                />
            </div>

            {/* 2. 大小滑块 */}
            <div>
                <div className="flex justify-between text-xs text-gray-400 mb-1">
                    <span>网格大小 (Radius)</span>
                    {/*   [ ] 优化显示逻辑，小于1km显示米 */}
                    <span className="text-cyan-400 font-mono">
                        {gridConfig.size < 1 
                            ? `${Math.round(gridConfig.size * 1000)} m` 
                            : `${gridConfig.size} km`}
                    </span>
                </div>
                {/*   [ ] 调整 Slider 参数：min=0.1 (100m), step=0.1 */}
                <Slider
                    min={0.1} 
                    max={50}
                    step={0.1} // 允许 0.1km 的微调
                    value={gridConfig.size}
                    onChange={(val) => setGridConfig(prev => ({ ...prev, size: val }))}
                    tooltip={{ open: false }}
                    styles={{ track: { background: '#00e5ff' }, handle: { borderColor: '#00e5ff' } }}
                />
            </div>

            {/* 3. 聚合方式 */}
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <span className="text-gray-400 text-xs block mb-1">聚合模式</span>
                    <Select
                        size="small"
                        className="w-full"
                        value={gridConfig.method}
                        onChange={(val) => setGridConfig(prev => ({ ...prev, method: val as any }))}
                        options={[
                            { label: '计数 (Count)', value: 'count' },
                            //   [新增] 覆盖率选项
                            { label: '覆盖率/密度 (Coverage)', value: 'coverage' }, 
                            { label: '求和 (Sum)', value: 'sum' },
                            { label: '平均 (Avg)', value: 'avg' },
                            { label: '最大 (Max)', value: 'max' },
                            { label: '最小 (Min)', value: 'min' },
                        ]}
                        //   [修复] 使用 styles.popup.root 替代 dropdownStyle
                        styles={{ popup: { root: { border: '1px solid #334155' } } }}
                    />
                </div>
                {/* 级联显示字段选择 */}
                <div>
                    <span className="text-gray-400 text-xs block mb-1">聚合字段</span>
                    <Select
                        size="small"
                        className="w-full"
                        placeholder="选择字段"
                        //   [ ] 当选择 coverage 时也禁用字段选择
                        disabled={gridConfig.method === 'count' || gridConfig.method === 'coverage'}
                        value={gridConfig.targetField}
                        onChange={(val) => setGridConfig(prev => ({ ...prev, targetField: val }))}
                        options={numericFields.filter(f => f !== 'value').map(f => ({ label: f, value: f }))} 
                        styles={{ popup: { root: { border: '1px solid #334155' } } }}
                    />
                </div>
            </div>

            <div className="w-full h-px bg-gray-700 my-1"></div>


            {/*   [ ] 导出选项：支持多选 + 全选 */}
            {isGridMode && (
                <div className="mb-2 bg-gray-800/50 p-2 rounded border border-gray-700">
                    <div className="flex justify-between items-center mb-1">
                        <span className="text-gray-400 text-xs">
                            分类拆分 (可多选)
                        </span>
                        {/* 全选按钮 */}
                        <a 
                            className="text-xs text-cyan-500 hover:text-cyan-400 cursor-pointer select-none"
                            onClick={handleSelectAllCategories}
                        >
                            {gridConfig.categoryFields.length === stringFields.length && stringFields.length > 0 ? '清空' : '全选'}
                        </a>
                    </div>
                    
                    <Select
                        mode="multiple"
                        size="small"
                        //   [ ] 添加自定义类名
                        className="w-full custom-multi-select" 
                        placeholder="选择分类字段..."
                        allowClear
                        maxTagCount="responsive"
                        value={gridConfig.categoryFields}
                        onChange={(val) => setGridConfig(prev => ({ ...prev, categoryFields: val }))}
                        options={stringFields.map(f => ({ label: f, value: f }))}
                        //   [ ] 移除报错的 selector 属性
                        styles={{ 
                            popup: { root: { border: '1px solid #334155' } } 
                        }}
                    />
                </div>
            )}

            {/* 4. 执行按钮区 */}
            {isGridMode ? (
                //   [ ] 网格模式下：显示 重置 和 保存 两个按钮
                <div className="flex gap-2">
                    <Button 
                        danger 
                        size="small" 
                        icon={<UndoOutlined />}
                        onClick={handleResetGrid}
                        className="flex-1"
                    >
                        重置
                    </Button>
                    <Button 
                        type="primary" 
                        size="small" 
                        icon={<SaveOutlined />}
                        onClick={handleExport}
                        className="flex-1 bg-green-600 hover:bg-green-500 border-none shadow-lg shadow-green-900/50"
                    >
                        保存结果
                    </Button>
                </div>
            ) : (
                <Button 
                    type="primary" block size="small" icon={<ThunderboltOutlined />}
                    className="bg-linear-to-r from-cyan-600 to-blue-600 border-none shadow-lg shadow-blue-900/50 hover:shadow-cyan-500/50 transition-all"
                    onClick={handleGenerateGrid}
                    loading={gridLoading}
                >
                    生成网格 (Generate)
                </Button>
            )}
        </div>
    );

    return (
        <div className="w-full h-full relative">
            
            {/*   [新增] 顶部进度条 (全局状态反馈) */}
            {gridLoading && (
                <div className="absolute top-0 left-0 w-full h-1 bg-gray-800 z-50">
                    <div className="h-full bg-cyan-400 animate-progress-indeterminate shadow-[0_0_10px_#00e5ff]"></div>
                </div>
            )}
            {/*  加载遮罩层 - 当请求全量数据时显示 */}
            {loading && (
                <div className="absolute inset-0 bg-black/60 z-50 flex flex-col items-center justify-center backdrop-blur-sm">
                    <Spin size="large" />
                    <span className="text-cyan-400 mt-3 font-mono">正在加载全量数据...</span>
                </div>
            )}

            {/* 地图容器 */}
            <div ref={mapContainer} className="w-full h-full" />

            {/*   [ ] 文件名提示 (调整位置和样式，使其与下方工具条对齐) */}
            {fileName && (
                <div className="absolute top-4 left-4 z-10 animate-fade-in-down">
                     <div className="bg-gray-900/80 backdrop-blur-md text-cyan-400 px-4 py-1.5 rounded-full border border-cyan-500/30 text-xs font-mono shadow-[0_0_10px_rgba(0,229,255,0.2)] flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
                        VISUALIZING: <span className="text-white font-bold">{fileName}</span>
                     </div>
                </div>
            )}

            {/*   [ ] HUD Toolbar: 包含网格聚合模块 */}
            <div className="absolute top-16 left-4 z-10 transition-all duration-300 ease-in-out">
                <ConfigProvider
                    theme={{
                        algorithm: theme.darkAlgorithm,
                        token: {
                            colorBgContainer: 'transparent',
                            colorBorder: 'transparent',
                            colorPrimary: '#00e5ff',
                            colorTextPlaceholder: 'rgba(255,255,255,0.4)',
                            controlHeight: 32,
                        },
                        components: {
                            Select: {
                                selectorBg: 'transparent',
                                colorBgElevated: 'rgba(17, 24, 39, 0.95)',
                                optionSelectedBg: 'rgba(6, 182, 212, 0.2)',
                            },
                            Segmented: {
                                itemSelectedBg: '#00e5ff',
                                itemSelectedColor: '#000',
                            }
                        }
                    }}
                >
                    <div className="bg-gray-900/80 backdrop-blur-xl border border-cyan-500/30 px-2 py-1.5 rounded-full shadow-[0_4px_20px_rgba(0,0,0,0.5)] flex items-center gap-1 hover:border-cyan-400/60 transition-colors">
                        
                        {/* 1. 底图切换 */}
                        <Tooltip title="切换底图风格">
                            <div className="flex items-center px-2">
                                <GlobalOutlined className="text-cyan-500 mr-2 text-lg" />
                                <Select
                                    variant="borderless"
                                    popupMatchSelectWidth={false}
                                    value={activeBasemap}
                                    onChange={handleBasemapChange}
                                    className="w-24 font-bold text-gray-200"
                                    suffixIcon={null}
                                    styles={{ popup: { root: { border: '1px solid #334155', borderRadius: '8px' } } }}
                                >
                                    {BASEMAPS.map(b => (
                                        <Option key={b.key} value={b.key}>{b.name}</Option>
                                    ))}
                                </Select>
                            </div>
                        </Tooltip>

                        <div className="w-px h-5 bg-gray-600 mx-1" />

                        {/*   [新增] 2. 空间网格聚合模块 */}
                        <Popover 
                            content={gridConfigContent} 
                            trigger="hover" 
                            placement="bottom"
                            // ❌ [删除] styles={{ body: ... }} 或 overlayInnerStyle
                            //   [新增] 使用 CSS 类名
                            overlayClassName="grid-config-popover"
                            arrow={false}
                        >
                            <div className={`flex items-center px-3 cursor-pointer rounded-full transition-all ${isGridMode ? 'bg-cyan-500/20 text-cyan-300' : 'hover:bg-white/10 text-gray-300'}`}>
                                <Badge dot={isGridMode} color="#00e5ff" offset={[-2, 2]}>
                                    <DeploymentUnitOutlined className={`text-lg mr-2 ${isGridMode ? 'animate-pulse' : 'text-yellow-500'}`} />
                                </Badge>
                                <span className="text-xs font-bold whitespace-nowrap">
                                    {isGridMode ? '网格视图' : '网格聚合'}
                                </span>
                            </div>
                        </Popover>

                        <div className="w-px h-5 bg-gray-600 mx-1" />

                        {/* 3. 普通渲染 (互斥逻辑) */}
                        <Tooltip title={isGridMode ? "网格模式下不可用 (已自动映射)" : "选择字段进行着色"}>
                            <div className={`flex items-center px-2 transition-opacity ${isGridMode ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                <GatewayOutlined className="text-purple-400 mr-2 text-lg" />
                                <Select
                                    variant="borderless"
                                    popupMatchSelectWidth={false}
                                    //   [ ] 提示文案变化
                                    placeholder={isGridMode ? "聚合值" : "普通渲染"}
                                    value={activeField}
                                    onChange={setActiveField}
                                    allowClear={!isGridMode}
                                    //   [ ] 禁用逻辑
                                    disabled={isGridMode || (numericFields.length === 0 && stringFields.length === 0)} 
                                    className="min-w-25 max-w-35 text-gray-200"
                                    styles={{ popup: { root: { border: '1px solid #334155', borderRadius: '8px' } } }}
                                >
                                    <Option value="none">-- 默认纯色 --</Option>

                                    {/*   [  2] 分组渲染数值字段 */}
                                    {numericFields.length > 0 && (
                                        <OptGroup label="数值字段 (渐变映射)">
                                            {numericFields.map(field => (
                                                <Option key={field} value={field}>{field}</Option>
                                            ))}
                                        </OptGroup>
                                    )}
                                    
                                    {/*   [  3] 分组渲染文本字段 */}
                                    {stringFields.length > 0 && (
                                        <OptGroup label="文本字段 (分类映射)">
                                            {stringFields.map(field => (
                                                <Option key={field} value={field}>{field}</Option>
                                            ))}
                                        </OptGroup>
                                    )}

                                    {/* 网格模式下可能包含 value 字段 */}
                                    {isGridMode && <Option value="value">聚合值 (Value)</Option>}
                                </Select>
                            </div>
                        </Tooltip>

                        {/* 4. 颜色方案 */}
                        {activeField && activeField !== 'none' && (
                            <>
                                <div className="w-px h-5 bg-gray-600 mx-1" />
                                <Tooltip title="颜色方案">
                                    <div className="flex items-center px-2 animate-slide-in-left">
                                        <BgColorsOutlined className="text-pink-400 mr-2 text-lg" />
                                        <Select
                                            variant="borderless"
                                            popupMatchSelectWidth={200}
                                            value={activeScheme}
                                            onChange={setActiveScheme}
                                            className="w-28 text-gray-200"
                                            styles={{ popup: { root: { border: '1px solid #334155', borderRadius: '8px' } } }}
                                            optionLabelProp="label"
                                        >
                                            {Object.entries(COLOR_SCHEMES).map(([key, scheme]) => (
                                                <Option key={key} value={key} label={scheme.name}>
                                                    <div className="flex items-center justify-between py-1">
                                                        <span className="text-xs">{scheme.name}</span>
                                                        <div className="flex h-2 w-10 ml-2 rounded overflow-hidden">
                                                            {scheme.colors.map((c, i) => (
                                                                <div key={i} style={{ backgroundColor: c, flex: 1 }} />
                                                            ))}
                                                        </div>
                                                    </div>
                                                </Option>
                                            ))}
                                        </Select>
                                    </div>
                                </Tooltip>
                            </>
                        )}

                        {/* 👇 👇 👇 [新增] 值过滤模块 👇 👇 👇 */}
                        {activeField && activeField !== 'none' && !isGridMode && (
                            <>
                                <div className="w-px h-5 bg-gray-600 mx-1" />
                                <Tooltip title="值过滤 (取消勾选可隐藏对应数据)">
                                    <div className="flex items-center px-2 animate-slide-in-left">
                                        <FilterOutlined className="text-orange-400 mr-2 text-lg" />
                                        <Select
                                            mode="multiple"
                                            variant="borderless"
                                            placeholder="筛选数据..."
                                            value={activeFilterValues}
                                            onChange={(val) => setActiveFilterValues(val)}
                                            allowClear
                                            maxTagCount={1} // 限制标签显示数量，防止选项过多撑爆工具栏
                                            className="min-w-28 max-w-44 text-gray-200 custom-multi-select"
                                            options={uniqueFieldValues.map(v => ({ label: String(v), value: v }))}
                                            styles={{ popup: { root: { border: '1px solid #334155', borderRadius: '8px' } } }}
                                        />
                                    </div>
                                </Tooltip>
                            </>
                        )}

                        <div className="w-px h-5 bg-gray-600 mx-1" />

                        {/* 5. 全量数据 (网格模式下禁用) */}
                        <Tooltip title={isGridMode ? "网格模式下已锁定" : (fileId ? "加载该文件所有分页数据" : "需保存文件后可用")}>
                            <div className="flex items-center px-2 cursor-pointer hover:bg-white/5 rounded transition-colors" onClick={(e) => e.stopPropagation()}>
                                <CloudServerOutlined className={`mr-2 text-lg ${showAll ? 'text-green-400' : 'text-gray-500'}`} />
                                <Checkbox 
                                    checked={showAll}
                                    onChange={handleShowAllChange}
                                    disabled={!fileId || loading || isGridMode} 
                                    className="text-gray-300 text-xs whitespace-nowrap"
                                >
                                    <span className={`${showAll ? 'text-green-400 font-bold' : 'text-gray-400'}`}>
                                        全量
                                    </span>
                                </Checkbox>
                            </div>
                        </Tooltip>

                    </div>
                </ConfigProvider>
            </div>
            
            {/*   3. 放置 HUD 图表组件 (绝对定位在地图层之上) */}
            <ChartOverlay />

            {/*   4. (可选) 增加一个悬浮按钮，用于在关闭图表后重新打开 */}
            {!isChartVisible && pivotData && pivotData.length > 0 && (
                <div className="absolute top-4 right-4 z-900">
                    <Tooltip title="显示透视分析图表" placement="left">
                        <Button 
                            type="primary" 
                            shape="circle" 
                            size="large"
                            icon={<BarChartOutlined />} 
                            onClick={() => setChartVisible(true)}
                            className="bg-cyan-600 border-cyan-500 shadow-lg shadow-cyan-900/50"
                        />
                    </Tooltip>
                </div>
            )}

            {/* 样式 (保持原有的 Popup 样式，并添加动画) */}
            <style>{`
                .dark-cool-popup .maplibregl-popup-content {
                    background: rgba(17, 24, 39, 0.95) !important;
                    border: 1px solid #06b6d4;
                    border-radius: 8px;
                    padding: 12px;
                    box-shadow: 0 0 15px rgba(6, 182, 212, 0.4);
                    backdrop-filter: blur(4px);
                }
                .dark-cool-popup .maplibregl-popup-tip {
                    border-top-color: #06b6d4 !important;
                    border-bottom-color: #06b6d4 !important;
                }
                .dark-cool-popup .maplibregl-popup-close-button {
                    color: #22d3ee;
                }
                .animate-slide-in-left {
                    animation: slideIn 0.3s ease-out forwards;
                }
                @keyframes progress-indeterminate {
                    0% { width: 0%; margin-left: 0%; }
                    50% { width: 70%; margin-left: 30%; }
                    100% { width: 0%; margin-left: 100%; }
                }
                .animate-progress-indeterminate {
                    animation: progress-indeterminate 1.5s infinite ease-in-out;
                }
                
                /*   [新增] Popover 样式覆盖 (解决 TS 报错和警告) */
                .grid-config-popover .ant-popover-inner {
                    background-color: rgba(17, 24, 39, 0.95) !important;
                    backdrop-filter: blur(10px) !important;
                    border: 1px solid #06b6d4 !important;
                    border-radius: 8px !important;
                    padding: 12px !important;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5) !important;
                }

                /*   [新增] 强制覆盖多选框的背景色 */
                .custom-multi-select .ant-select-selector {
                    background-color: transparent !important;
                    border-color: rgba(255, 255, 255, 0.2) !important; /* 可选：让边框也淡一点 */
                }
                
                /* 选中项标签的样式优化 (可选) */
                .custom-multi-select .ant-select-selection-item {
                    background-color: rgba(6, 182, 212, 0.2) !important;
                    border: 1px solid rgba(6, 182, 212, 0.5) !important;
                    color: #22d3ee !important;
                }
                
                /* 清除图标颜色 */
                .custom-multi-select .ant-select-clear {
                    background: transparent !important;
                    color: rgba(255,255,255,0.5) !important;
                }
            `}</style>
        </div>
    );
};

export default MapView;