import React, { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { bbox } from '@turf/turf';
//   [ ] 引入所需的 Ant Design 组件
import { 
    Button, Tooltip, App, Checkbox, Spin, Select, Popover, Segmented, Slider, ColorPicker
} from 'antd';
import ChartOverlay, { THEME_COLORS, CONTRAST_PALETTES } from './ChartOverlay';
import { geoService } from '../../../services/geoService';
//   [ ] 引入图标
import { 
    BarChartOutlined, 
    UnorderedListOutlined,
    DeploymentUnitOutlined, // 网格入口图标
    AppstoreOutlined,       // Hex 图标
    BorderOutlined,         // Square 图标
    ThunderboltOutlined,    // 执行图标
    UndoOutlined,            // 重置图标
    SaveOutlined,
} from '@ant-design/icons';
import { useAnalysisStore } from '../../../stores/useAnalysisStore'
import { API_BASE_URL, getApiUrl } from '../../../services/apiConfig';
import { BASEMAP_OPTIONS, BasemapController, initialMapStyle, loadBasemap } from '../basemaps';

const PROTOMAPS_KEY = (import.meta.env.VITE_PROTOMAPS_API_KEY || '').trim();

const { Option, OptGroup } = Select;

// 多图层信息类型
export interface FileLayerInfo {
    fileId: string;
    fileName: string;
    totalFeatures?: number;
    loadFailed?: boolean;
}

type DrawStatus = 'loading' | 'ready' | 'empty' | 'error';
const PRIMARY_SOURCE = 'uploaded-geo-data';
const EXTRA_SUFFIXES = ['fill', 'line', 'point'];
const EMPTY_SELECTION: maplibregl.FilterSpecification = ['==', 1, 0];

function watchLayerSource(map: maplibregl.Map, sourceId: string, update: (status: DrawStatus) => void) {
    const onData = (event: maplibregl.MapSourceDataEvent) => {
        if (event.sourceId === sourceId && event.sourceDataType !== 'metadata' && event.isSourceLoaded) update('ready');
    };
    const onError = (event: { sourceId?: string; error: Error }) => {
        if (event.sourceId === sourceId) update('error');
    };
    map.on('sourcedata', onData);
    map.on('error', onError);
    return () => {
        map.off('sourcedata', onData);
        map.off('error', onError);
    };
}

function removePrimaryLayers(map: maplibregl.Map) {
    PRIMARY_MAP_LAYERS.forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
    if (map.getSource(PRIMARY_SOURCE)) map.removeSource(PRIMARY_SOURCE);
}


// 多图层颜色调色板（每个图层分配一个主题色）
const LAYER_PALETTE = [
    '#00e5ff', // 科技青 (主文件)
    '#ff6b35', // 暖橙
    '#7c3aed', // 深紫
    '#10b981', // 翠绿
    '#f59e0b', // 琥珀
    '#ec4899', // 玫瑰粉
    '#06b6d4', // 天蓝
    '#84cc16', // 荧光绿
];

const SYSTEM_FIELD_NAMES = new Set(['_id', 'id', 'fid', 'ObjectId', 'geometry', 'geom', 'cp']);

const isNumericLike = (value: any) => {
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'string') return false;
    const normalized = value.trim().replace(/,/g, '');
    if (!normalized || ['null', 'undefined', 'nan'].includes(normalized.toLowerCase())) return false;
    return Number.isFinite(Number(normalized));
};

const toMapNumberExpression = (field: string) => ([
    'to-number',
    ['coalesce', ['get', field], 0],
    0
] as any);

// MVT 大数据阈值：超过此数量自动启用 MVT 瓦片模式
const MVT_THRESHOLD = 5000;
const toMapLibreTileUrl = (path: string): string => {
    const apiUrl = getApiUrl(path);
    // Keep {z}/{x}/{y} intact while resolving relative URLs against this app's origin.
    return /^https?:\/\//i.test(apiUrl) ? apiUrl : `${window.location.origin}${apiUrl.startsWith('/') ? '' : '/'}${apiUrl}`;
};
const FEATURE_ID_FIELDS = ['id', 'Id', 'ID', 'fid', 'FID', '_id', 'ObjectId', 'OBJECTID', 'objectid'];
const PRIMARY_MAP_LAYERS = [
    'geo-fill-layer',
    'geo-polygon-border',
    'geo-linestring-main',
    'geo-point-layer',
    'geo-highlight-fill',
    'geo-highlight-line',
    'geo-highlight-point'
];

const buildFeatureIdFilter = (ids: Array<string | number>) => {
    const rawIds = ids.filter((id) => id !== undefined && id !== null && id !== '');
    const stringIds = rawIds.map(String);
    const checks: any[] = [];

    FEATURE_ID_FIELDS.forEach((field) => {
        checks.push((['in', field] as any[]).concat(rawIds));
        checks.push((['in', field] as any[]).concat(stringIds));
    });
    checks.push((['in', '$id'] as any[]).concat(rawIds));
    checks.push((['in', '$id'] as any[]).concat(stringIds));

    return ['any', ...checks];
};

const bringPrimaryLayersToFront = (map: maplibregl.Map) => {
    PRIMARY_MAP_LAYERS.forEach((layerId) => {
        if (map.getLayer(layerId)) {
            map.moveLayer(layerId);
        }
    });
};

interface MapViewProps {
    data: any;        // GeoJSON 数据（当前激活文件）
    fileName: string; // 当前文件名
    fileId?: string;  // 当前选中的文件ID
    selectedFeature?: any;
    onFeatureClick?: (feature: any) => void;
    // 多图层支持
    selectedFilesInfo?: FileLayerInfo[];
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
    },
    viridi: {
        name: '翠绿-明黄',
        // 配合你的暗色底图，极高饱和度、发光质感的霓虹色
        colors: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725']
    },
    magm: {
        name: '黑紫-亮橘',
        // 配合你的暗色底图，极高饱和度、发光质感的霓虹色
        colors: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf']
    },
    morandi_earth: {
        name: '大地色',
        // 配合你的暗色底图，极高饱和度、发光质感的霓虹色
        colors: ['#f4f1e1', '#e2d3b6', '#c6b497', '#9e8d71', '#72634d', '#493d2c']
    },
    morandi_aqua: {
        name: '青水色',
        // 配合你的暗色底图，极高饱和度、发光质感的霓虹色
        colors: ['#f1f6f7', '#d4e0e5', '#aebec5', '#829aa3', '#5a7681', '#38525d']
    },
    Spectral: {
        name: '冷暖双向渐变',
        // 配合你的暗色底图，极高饱和度、发光质感的霓虹色
        colors: ['#5e4fa2', '#3288bd', '#66c2a5', '#abdda4', '#e6f598', '#fee08b', '#fdae61', '#f46d43', '#d53e4f', '#9e0142']
    },    // 新增：专业离散型配色方案（5类）
    discrete_warm: {
        name: '离散-暖色系',
        // 参考"大地色"和"黑紫-亮橘"，暖色调高区分度
        colors: ['#d73027', '#fc8d59', '#fee08b', '#d9ef8b', '#91cf60']
    },
    discrete_cool: {
        name: '离散-冷色系',
        // 参考"深海蓝"和"青水色"，冷色调专业配色
        colors: ['#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7']
    },
    discrete_contrast: {
        name: '离散-高对比',
        // 参考"冷暖双向渐变"，冷暖色对比强烈
        colors: ['#4575b4', '#d53e4f', '#91bfdb', '#fc8d59', '#fee08b']
    },
    discrete_contrast4: {
        name: '离散-高对比4色',
        // 参考"冷暖双向渐变"，冷暖色对比强烈
        colors: ['#4575b4', '#fc8d59','#d53e4f', '#91bfdb']
    },
    discrete_contrast3: {
        name: '离散-高对比3色',
        // 参考"冷暖双向渐变"，冷暖色对比强烈
        colors: ['#91bfdb','#d53e4f','#fee08b']
        
    },
    discrete_nature: {
        name: '离散-自然系',
        // 参考"翠绿-明黄"，自然界色彩
        colors: ['#1a9850', '#91cf60', '#d9ef8b', '#fee08b', '#d73027']
    },
    discrete_elegant: {
        name: '离散-雅致系',
        // 参考"大地色"和"青水色"，低饱和度优雅配色
        colors: ['#8c510a', '#d8b365', '#f6e8c3', '#c7eae5', '#5ab4ac']
    },
    discrete_vibrant: {
        name: '离散-活力系',
        // 参考"烈焰红"和"极光绿"，高饱和度活力配色
        colors: ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00']
    },
    discrete_pastel: {
        name: '离散-马卡龙',
        // 柔和马卡龙色系，适合大面积填充
        colors: ['#fbb4ae', '#b3cde3', '#ccebc5', '#decbe4', '#fed9a6']
    },
    discrete_dark: {
        name: '离散-深色系',
        // 深色调配色，适合暗色底图
        colors: ['#7fc97f', '#beaed4', '#fdc086', '#ffff99', '#386cb0']
    },
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

const MapView: React.FC<MapViewProps> = ({ data, fileName, fileId, selectedFeature, onFeatureClick, selectedFilesInfo = [] }) => {
    //     2: 获取上下文感知的 message 实例
    // 注意：MapView 必须被包裹在 <App> 组件中（通常在 main.tsx 或 App.tsx 已经包了）
    const { message } = App.useApp();
    const mapContainer = useRef<HTMLDivElement>(null);
    const mapInstance = useRef<maplibregl.Map | null>(null);
    const basemapController = useRef<BasemapController | null>(null);
    const basemapRequest = useRef(0);
    const [basemapLoading, setBasemapLoading] = useState(false);
    const [tiandituStatus, setTiandituStatus] = useState<'checking' | 'available' | 'unconfigured' | 'unavailable'>('checking');
    const lastFramedFile = useRef('');
    const activeFileRef = useRef(fileId);
    activeFileRef.current = fileId;
    const fullDataRequest = useRef(0);
    const [hiddenFileIds, setHiddenFileIds] = useState<string[]>([]);
    const [legendOpen, setLegendOpen] = useState(true);
    const [primaryStatus, setPrimaryStatus] = useState<{ fileId?: string; status: DrawStatus }>();
    const [extraStatuses, setExtraStatuses] = useState<Record<string, DrawStatus>>({});
    const activeHidden = Boolean(fileId && hiddenFileIds.includes(fileId));

    const [isMapLoaded, setIsMapLoaded] = useState(false);
    const [mapStartupFailed, setMapStartupFailed] = useState(false);
    const [numericFields, setNumericFields] = useState<string[]>([]); // 可用于映射的数值字段
    //   [新增] 存储文本型字段，用于分类拆分
    const [stringFields, setStringFields] = useState<string[]>([]);

    const [activeField, setActiveField] = useState<string | null>(null); // 当前选中的映射字段
    const [activeScheme, setActiveScheme] = useState<string>('viridis'); // 当前颜色方案
    const [activeBasemap, setActiveBasemap] = useState<string>('dark'); // 当前底图
    
    const [uniqueFieldValues, setUniqueFieldValues] = useState<(string | number)[]>([]); // 存放当前字段所有的唯一值
    const [activeFilterValues, setActiveFilterValues] = useState<(string | number)[]>([]); // 存放当前勾选的值

    //  状态管理 - 全量数据相关
    const [fullLayer, setFullLayer] = useState<{ fileId: string; data: Awaited<ReturnType<typeof geoService.getAllFileData>> } | null>(null);
    const allData = fullLayer?.fileId === fileId ? fullLayer?.data : null;
    const showAll = Boolean(allData);
    const [loading, setLoading] = useState(false);

    // 多图层：当前激活的操作目标文件 ID（普通渲染/网格聚合的操作对象）
    // 多图层使用的 ref（记录当前已渲染的图层 IDs，用于清理）
    const renderedExtraLayersRef = useRef<string[]>([]);


    //   [新增] 空间网格相关状态
    const [gridResult, setGridResult] = useState<{ fileId: string; data: any } | null>(null);
    const isGridMode = Boolean(fileId && gridResult?.fileId === fileId);
    const gridData = isGridMode ? gridResult?.data : null;
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
        activeColumn , 
        layerColors, setLayerColor,
        validIds // 新增：获取 validIds 用于地图过滤
    } = useAnalysisStore();

    useEffect(() => {
        ++fullDataRequest.current;
        setFullLayer(null);
        setLoading(false);
        setActiveField(gridResult?.fileId === fileId ? 'value' : null);
    }, [fileId]);

    useEffect(() => {
        setHiddenFileIds(prev => {
            const remaining = prev.filter(id => selectedFilesInfo.some(file => file.fileId === id));
            return remaining.length === prev.length ? prev : remaining;
        });
    }, [selectedFilesInfo]);

    const colorForFile = (id?: string) => {
        if (!id) return LAYER_PALETTE[0];
        const index = selectedFilesInfo.findIndex(file => file.fileId === id);
        return layerColors[id] || LAYER_PALETTE[Math.max(index, 0) % LAYER_PALETTE.length];
    };

    const handleShowAllChange = async (e: { target: { checked: boolean } }) => {
        const request = ++fullDataRequest.current;
        if (!e.target.checked) {
            setFullLayer(null);
            return;
        }
        if (!fileId) return;

        setLoading(true);
        try {
            const result = await geoService.getAllFileData(fileId);
            if (request !== fullDataRequest.current || activeFileRef.current !== fileId) return;
            setFullLayer({ fileId, data: result });
            message.success('全量数据加载完成，共 ' + result.pagination.total + ' 个要素');
        } catch (error) {
            if (request !== fullDataRequest.current || activeFileRef.current !== fileId) return;
            console.error(error);
            message.error('加载全量数据失败');
        } finally {
            if (request === fullDataRequest.current) setLoading(false);
        }
    };

    // 初始化地图
    useEffect(() => {
        if (mapInstance.current || !mapContainer.current) return;
        let map: maplibregl.Map;
        try {
            map = new maplibregl.Map({
                container: mapContainer.current,
                style: initialMapStyle(),
                center: [118.7969, 32.0603],
                zoom: 7,
            });
        } catch (error) {
            console.error(error);
            setMapStartupFailed(true);
            return;
        }

        setMapStartupFailed(false);
        mapInstance.current = map;
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
        map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
        map.on('load', () => {
            basemapController.current = new BasemapController(map, (key, signal) =>
                loadBasemap(key, { protomapsKey: PROTOMAPS_KEY, apiBase: API_BASE_URL }, signal));
            setIsMapLoaded(true);
            map.resize();
        });

        // 清理函数
        // 当这个地图组件被销毁（例如用户切到别的页面，或者组件被隐藏）时，
        // 彻底清除地图占用的资源，防止内存泄漏
        return () => {
            setIsMapLoaded(false);
            ++basemapRequest.current;
            basemapController.current?.dispose();
            basemapController.current = null;
            if (mapInstance.current) {
                mapInstance.current.remove();
                mapInstance.current = null;
            }
        };
    }, []);

    // 每次切换主文件时，其他已选文件继续作为独立图层显示。
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;

        let disposed = false;
        const stopWatching: (() => void)[] = [];
        const extraFiles = selectedFilesInfo.filter(file => file.fileId !== fileId && (file.totalFeatures ?? 0) > 0);
        renderedExtraLayersRef.current = extraFiles.map(file => file.fileId);
        setExtraStatuses({});

        for (const file of extraFiles) {
            const source = 'extra-src-' + file.fileId;
            const color = colorForFile(file.fileId);
            const useMVT = (file.totalFeatures ?? 0) > MVT_THRESHOLD;
            const update = (status: DrawStatus) => {
                if (disposed) return;
                setExtraStatuses(prev => {
                    const current = prev[file.fileId];
                    if (current === status || (current === 'error' && status === 'ready')) return prev;
                    return { ...prev, [file.fileId]: status };
                });
            };

            if (useMVT) stopWatching.push(watchLayerSource(map, source, update));
            map.addSource(source, useMVT ? {
                type: 'vector',
                tiles: [toMapLibreTileUrl('/files/' + file.fileId + '/tiles/{z}/{x}/{y}')],
                minzoom: 0,
                maxzoom: 14,
            } : {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [] },
            });

            const vectorLayer = useMVT ? { 'source-layer': 'features' } : {};
            map.addLayer({
                id: 'extra-' + file.fileId + '-fill', type: 'fill', source, ...vectorLayer,
                paint: { 'fill-color': color, 'fill-opacity': 0.5 },
                filter: ['==', '$type', 'Polygon'],
            });
            map.addLayer({
                id: 'extra-' + file.fileId + '-line', type: 'line', source, ...vectorLayer,
                paint: { 'line-color': color, 'line-width': 2.5, 'line-opacity': 0.9 },
                filter: ['==', '$type', 'LineString'],
            });
            map.addLayer({
                id: 'extra-' + file.fileId + '-point', type: 'circle', source, ...vectorLayer,
                paint: { 'circle-radius': 5, 'circle-color': color, 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' },
                filter: ['==', '$type', 'Point'],
            });

            if (!useMVT) {
                geoService.getAllFileData(file.fileId).then(result => {
                    if (disposed) return;
                    const features = result.features;
                    (map.getSource(source) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features });
                    update(features.length ? 'ready' : 'empty');
                }).catch(() => update('error'));
            }
        }

        bringPrimaryLayersToFront(map);
        return () => {
            disposed = true;
            stopWatching.forEach(stop => stop());
            if (mapInstance.current !== map) return;
            for (const file of extraFiles) {
                for (const suffix of EXTRA_SUFFIXES) map.removeLayer('extra-' + file.fileId + '-' + suffix);
                map.removeSource('extra-src-' + file.fileId);
            }
        };
    }, [selectedFilesInfo, isMapLoaded, fileId, layerColors]);

    //   [ ] 字段提取逻辑分离：
    // 1. numericFields (数值): 从 displayData 提取，用于当前地图的颜色渲染（支持网格的 value 字段）
    // 2. stringFields (文本): 始终从 原始数据(data/allData) 提取，用于导出时的分类拆分
    useEffect(() => {
        let renderNumericFields: string[] = [];

        // --- A. 处理渲染字段 (随视图变化) ---
        if (displayData && displayData.features && displayData.features.length > 0) {
            const fieldStats = new Map<string, { numeric: number; string: number; total: number }>();
            displayData.features.slice(0, 1000).forEach((feature: any) => {
                Object.entries(feature.properties || {}).forEach(([key, value]) => {
                    if (SYSTEM_FIELD_NAMES.has(key) || key.startsWith('_')) return;
                    if (value === undefined || value === null || value === '') return;

                    const stats = fieldStats.get(key) || { numeric: 0, string: 0, total: 0 };
                    stats.total += 1;
                    if (isNumericLike(value)) stats.numeric += 1;
                    else if (typeof value === 'string') stats.string += 1;
                    fieldStats.set(key, stats);
                });
            });

            const numFields = Array.from(fieldStats.entries())
                .filter(([, stats]) => stats.numeric > 0 && stats.numeric >= stats.string)
                .map(([key]) => key);
            renderNumericFields = numFields;
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
            const fieldStats = new Map<string, { numeric: number; string: number; total: number }>();
            sourceData.features.slice(0, 1000).forEach((feature: any) => {
                Object.entries(feature.properties || {}).forEach(([key, value]) => {
                    if (SYSTEM_FIELD_NAMES.has(key) || key.startsWith('_')) return;
                    if (value === undefined || value === null || value === '') return;

                    const stats = fieldStats.get(key) || { numeric: 0, string: 0, total: 0 };
                    stats.total += 1;
                    if (isNumericLike(value)) stats.numeric += 1;
                    else if (typeof value === 'string') stats.string += 1;
                    fieldStats.set(key, stats);
                });
            });

            const strFields = Array.from(fieldStats.entries())
                .filter(([key, stats]) => stats.string > 0 && stats.string > stats.numeric && !renderNumericFields.includes(key))
                .map(([key]) => key);
            setStringFields(strFields);
        } else {
            setStringFields([]);
        }
        
    }, [displayData, data, allData, showAll, isGridMode]); // 依赖项加上 data 等

    //   [修改] Effect 3: 提取当前渲染字段的唯一值，作为下拉列表的选项
    useEffect(() => {
        //   判断是否为文本字段
        const isStringField = activeField ? stringFields.includes(activeField) : false;

        // 如果没选字段、处于网格模式、没数据，或者【当前选中是数值字段】，清空过滤选项！
        if (!activeField || activeField === 'none' || isGridMode || !displayData || !isStringField) {
            setUniqueFieldValues([]);
            setActiveFilterValues([]);
            return;
        }

        const valSet = new Set<string | number>();
        displayData.features.forEach((f: any) => {
            const val = f.properties[activeField];
            if (val !== undefined && val !== null) {
                valSet.add(val);
            }
        });

        const uniqueVals = Array.from(valSet).sort((a, b) => String(a).localeCompare(String(b)));
        setUniqueFieldValues(uniqueVals);
        setActiveFilterValues(uniqueVals); 
    }, [activeField, displayData, isGridMode, stringFields]);

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
                setGridResult({ fileId, data: res.data });
                if (activeFileRef.current === fileId) setActiveField('value');
                
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
        setGridResult(null);
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

        const sourceId = PRIMARY_SOURCE;

        // 判断是否应该使用 MVT 矢量瓦片模式
        const useMVT = fileId && !isGridMode;
        const mainLayerColor = colorForFile(fileId);
        if (useMVT) {
            console.log(`[MapView] 启用 MVT 极速矢量瓦片渲染模式: ${fileId}`);
            map.addSource(sourceId, {
                type: 'vector',
                //     核心修复：在 URL 尾部加上 ?t=${Date.now()} 作为缓存爆破器    
                tiles: [toMapLibreTileUrl(`/tiles/${fileId}/{z}/{x}/{y}?t=${Date.now()}`)],
                //     修复结束    
                minzoom: 0,
                maxzoom: 22
            });
            // 当使用 MVT 瓦片源时，必须在每一个图层配置中指定 'source-layer' (对应 ST_AsMVT 中设定的图层名 'default_layer')
            map.addLayer({
                id: 'geo-fill-layer', type: 'fill', source: sourceId, 'source-layer': 'default_layer',
                paint: { 
                    'fill-color': mainLayerColor, 
                    'fill-opacity': 0.6,
                    'fill-outline-color': isGridMode ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0.1)' 
                },
                filter: ['==', '$type', 'Polygon']
            });
            map.addLayer({
                id: 'geo-polygon-border', type: 'line', source: sourceId, 'source-layer': 'default_layer',
                paint: { 
                    'line-color': activeBasemap === 'light' ? '#666' : '#a5f3fc',
                    'line-width': isGridMode ? 0 : 1,
                    'line-opacity': 0.5
                },
                filter: ['==', '$type', 'Polygon']
            });
            map.addLayer({
                id: 'geo-linestring-main', type: 'line', source: sourceId, 'source-layer': 'default_layer',
                paint: { 
                    'line-color': mainLayerColor, 
                    'line-width': 3, 
                    'line-opacity': 0.8,
                    'line-blur': 1   
                },
                filter: ['==', '$type', 'LineString']
            });
            map.addLayer({
                id: 'geo-point-layer', type: 'circle', source: sourceId, 'source-layer': 'default_layer',
                paint: { 'circle-radius': 6, 'circle-color': '#00e5ff', 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' },
                filter: ['==', '$type', 'Point']
            });
            map.addLayer({ id: 'geo-highlight-fill', type: 'fill', source: sourceId, 'source-layer': 'default_layer', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.2 }, filter: ['==', 'id', 'nothing-selected'] });
            map.addLayer({ id: 'geo-highlight-line', type: 'line', source: sourceId, 'source-layer': 'default_layer', paint: { 'line-color': '#ffffff', 'line-width': 3 }, filter: ['==', 'id', 'nothing-selected'] });
            map.addLayer({ id: 'geo-highlight-point', type: 'circle', source: sourceId, 'source-layer': 'default_layer', paint: { 'circle-radius': 8, 'circle-color': '#ffffff', 'circle-stroke-width': 2, 'circle-stroke-color': '#ff0000' }, filter: ['==', 'id', 'nothing-selected'] });

        } else {
            console.log(`[MapView] 启用普通 GeoJSON 渲染模式: ${fileName}`);
            map.addSource(sourceId, { type: 'geojson', data: geoJSON });

            map.addLayer({
                id: 'geo-fill-layer', type: 'fill', source: sourceId,
                paint: { 
                    'fill-color': '#00e5ff', 
                    'fill-opacity': 0.6,
                    'fill-outline-color': isGridMode ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0.1)' 
                },
                filter: ['==', '$type', 'Polygon']
            });
            map.addLayer({
                id: 'geo-polygon-border', type: 'line', source: sourceId,
                paint: { 
                    'line-color': activeBasemap === 'light' ? '#666' : '#a5f3fc',
                    'line-width': isGridMode ? 0 : 1,
                    'line-opacity': 0.5
                },
                filter: ['==', '$type', 'Polygon']
            });
            map.addLayer({
                id: 'geo-linestring-main', type: 'line', source: sourceId,
                paint: { 
                    'line-color': '#00e5ff', 
                    'line-width': 3, 
                    'line-opacity': 0.8,
                    'line-blur': 1   
                },
                filter: ['==', '$type', 'LineString']
            });
            map.addLayer({
                id: 'geo-point-layer', type: 'circle', source: sourceId,
                paint: { 'circle-radius': 6, 'circle-color': '#00e5ff', 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' },
                filter: ['==', '$type', 'Point']
            });
            map.addLayer({ id: 'geo-highlight-fill', type: 'fill', source: sourceId, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.2 }, filter: ['==', 'id', 'nothing-selected'] });
            map.addLayer({ id: 'geo-highlight-line', type: 'line', source: sourceId, paint: { 'line-color': '#ffffff', 'line-width': 3 }, filter: ['==', 'id', 'nothing-selected'] });
            map.addLayer({ id: 'geo-highlight-point', type: 'circle', source: sourceId, paint: { 'circle-radius': 8, 'circle-color': '#ffffff', 'circle-stroke-width': 2, 'circle-stroke-color': '#ff0000' }, filter: ['==', 'id', 'nothing-selected'] });
        }

        bringPrimaryLayersToFront(map);

        if (fileId && fileId !== lastFramedFile.current && geoJSON.features.some((feature: any) => feature.geometry)) {
            lastFramedFile.current = fileId;
            const bounds = bbox(geoJSON) as [number, number, number, number];
            if (bounds.every(Number.isFinite)) {
                map.fitBounds(bounds, { padding: 42, maxZoom: 14, duration: 600 });
            }
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
                const props = { ...feature.properties, id: feature.properties.id ?? feature.id };
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
            
            const themeConfig = THEME_COLORS[mapColorTheme] || THEME_COLORS.cyan;

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

            const rowValueMap = new Map<string, { rowKey: any; value: number }>();
            pivotData!.forEach((item, index) => {
                const matchKey = String(item.rowKey);
                const currentValue = Number(targetValues[index]) || 0;
                const existing = rowValueMap.get(matchKey);
                if (existing) {
                    existing.value += currentValue;
                } else {
                    rowValueMap.set(matchKey, { rowKey: item.rowKey, value: currentValue });
                }
            });
            const linkageRows = Array.from(rowValueMap.values());
            targetValues = linkageRows.map(item => item.value);

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

            linkageRows.forEach((item) => {
                const val = item.value;
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

            // 面图层未命中的行政单元仍要作为空间上下文保留；点/线未命中则退隐。
            const areaColorMatch = [...colorMatch, 'rgba(100, 116, 139, 0.34)'];
            const areaOpacityMatch = [...opacityMatch, 0.48];
            const areaBorderStrokeWidthMatch = [...borderStrokeWidthMatch, 1];
            const areaBorderStrokeColorMatch = [...borderStrokeColorMatch, 'rgba(148, 163, 184, 0.38)'];

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
            
            // ============ 应用属性 (增强版：全图层智能着色) ============
            try { 
                // 提取所有可能的图层ID
                const fillLayers = ['geo-fill-layer', ...renderedExtraLayersRef.current.map(id => `extra-${id}-fill`)];
                const borderLayers = ['geo-polygon-border'];
                const lineLayers = ['geo-linestring-main', ...renderedExtraLayersRef.current.map(id => `extra-${id}-line`)];
                const pointLayers = ['geo-point-layer', ...renderedExtraLayersRef.current.map(id => `extra-${id}-point`)];

                // 【绝杀逻辑】：用 case 语句保护背景图层。如果没有分析字段，使用备用颜色(如偏暗的背景色)
                const safeAreaColorMatch = ['case', ['has', rowField], areaColorMatch, 'rgba(100, 116, 139, 0.3)'];
                const safeAreaOpacityMatch = ['case', ['has', rowField], areaOpacityMatch, 0.5];
                const safeColorMatch = ['case', ['has', rowField], colorMatch, 'rgba(100, 116, 139, 0.3)'];
                const safeOpacityMatch = ['case', ['has', rowField], opacityMatch, 0.5];
                const safeBorderColor = ['case', ['has', rowField], areaBorderStrokeColorMatch, 'rgba(148, 163, 184, 0.3)'];
                const safeBorderWidth = ['case', ['has', rowField], areaBorderStrokeWidthMatch, 1];

                fillLayers.forEach(l => {
                    if (map.getLayer(l)) {
                        map.setPaintProperty(l, 'fill-color', safeAreaColorMatch as any);
                        map.setPaintProperty(l, 'fill-opacity', safeAreaOpacityMatch as any);
                    }
                });

                borderLayers.forEach(l => {
                    if (map.getLayer(l)) {
                        map.setPaintProperty(l, 'line-color', safeBorderColor as any);
                        map.setPaintProperty(l, 'line-width', safeBorderWidth as any);
                    }
                });

                lineLayers.forEach(l => {
                    if (map.getLayer(l)) {
                        map.setPaintProperty(l, 'line-color', safeColorMatch as any);
                        map.setPaintProperty(l, 'line-opacity', safeOpacityMatch as any);
                        map.setPaintProperty(l, 'line-width', ['case', ['has', rowField], mainLineWidthMatch, 1] as any);
                    }
                });

                pointLayers.forEach(l => {
                    if (map.getLayer(l)) {
                        map.setPaintProperty(l, 'circle-color', safeColorMatch as any);
                        map.setPaintProperty(l, 'circle-opacity', safeOpacityMatch as any);
                        map.setPaintProperty(l, 'circle-radius', ['case', ['has', rowField], pointRadiusMatch, 2] as any);
                        map.setPaintProperty(l, 'circle-stroke-width', ['case', ['has', rowField], pointStrokeWidthMatch, 0] as any);
                        map.setPaintProperty(l, 'circle-stroke-color', ['case', ['has', rowField], pointStrokeColorMatch, 'transparent'] as any);
                    }
                });
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
        // =========================================================================
        // 🌟 核心修复二：只要是图表联动模式（无论是1D柱状图还是2D热力图），
        // 颜色全权交给 updateLinkageColors 处理，此处立刻退出，防止覆写！
        // =========================================================================
        const isPivotMode = isMapLinkageEnabled && pivotData && pivotData.length > 0;
        if (isPivotMode) return;

        const map = mapInstance.current;
        const currentDisplayData = displayDataRef.current;
        
        if (!map || !map.getLayer('geo-fill-layer') || !currentDisplayData) return;

        // 1. 如果没有选字段，恢复默认颜色 (全部全亮显示)
        if (!activeField || activeField === 'none') {
            const mainLayerColor = colorForFile(fileId);
            if (map.getLayer('geo-fill-layer')) {
                map.setPaintProperty('geo-fill-layer', 'fill-color', mainLayerColor);
                map.setPaintProperty('geo-fill-layer', 'fill-outline-color', 'rgba(0,0,0,0)'); 
                map.setPaintProperty('geo-fill-layer', 'fill-opacity', 0.6);
            }
            if (map.getLayer('geo-linestring-main')) {
                map.setPaintProperty('geo-linestring-main', 'line-color', mainLayerColor);
                map.setPaintProperty('geo-linestring-main', 'line-opacity', 0.8);
                map.setPaintProperty('geo-linestring-main', 'line-width', 3);
            }
            if (map.getLayer('geo-point-layer')) {
                map.setPaintProperty('geo-point-layer', 'circle-color', mainLayerColor);
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
                    if (isNumericLike(val)) {
                        const numericVal = typeof val === 'number' ? val : Number(String(val).trim().replace(/,/g, ''));
                        if (numericVal < min) min = numericVal;
                        if (numericVal > max) max = numericVal;
                    }
                });

                if (min === Infinity || max === -Infinity) return; // 没数据
                
                // 4. 构建基础颜色表达式 (Base Expression)
                if (min === max) {
                    baseColorExpression = colors[Math.floor(colors.length / 2)];
                } else {
                    const stepCount = colors.length;
                    const stepSize = (max - min) / stepCount;
                    baseColorExpression = ['step', toMapNumberExpression(activeField)];
                    baseColorExpression.push(colors[0]);
                    for (let i = 1; i < stepCount; i++) {
                        const stopValue = min + (stepSize * i);
                        baseColorExpression.push(stopValue);
                        baseColorExpression.push(colors[i]);
                    }
                }
        }
        //    5. [  ] 构建“是否勾选”的判断逻辑   
        // isMatched 是一个布尔运算：当前要素的值，是否在安全数组内
        //   [修改] 5. 构建“是否勾选”的判断逻辑   
        let isMatched: any;
        if (isStringField) {
            // 文本字段：走离散值比对
            const safeFilterValues = activeFilterValues.length > 0 ? activeFilterValues : ['__NOTHING_SELECTED__'];
            isMatched = ['in', ['get', activeField], ['literal', safeFilterValues]];
        } else {
            //   数值字段：构造一个永远为 True 的表达式（只要值不为空），彻底抛弃庞大的 In 数组判断！
            isMatched = ['has', activeField];
        }

        // 利用 ['case', 条件, 满足时的值, 不满足时的值] 动态分配属性
        const finalFillColor = baseColorExpression;                                 
        const finalFillOpacity = ['case', isMatched, 0.85, 0.15];

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
    const activeTotal = selectedFilesInfo.find(file => file.fileId === fileId)?.totalFeatures;
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;
        removePrimaryLayers(map);
        if (!displayData || (!isGridMode && activeTotal === 0)) {
            lastFramedFile.current = '';
            return;
        }

        setPrimaryStatus({ fileId, status: isGridMode && !displayData.features.length ? 'empty' : 'loading' });
        const stopWatching = watchLayerSource(map, PRIMARY_SOURCE, status => {
            setPrimaryStatus(prev => {
                if (prev?.fileId === fileId && (prev?.status === 'empty' || prev?.status === status || (prev?.status === 'error' && status === 'ready'))) return prev;
                return { fileId, status };
            });
        });
        renderGeoJSON(displayData);
        updateLinkageColors();
        updateChoroplethColors();
        return stopWatching;
    }, [displayData, fileId, activeTotal, isGridMode, isMapLoaded]);

    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;
        const setVisibility = (id: string, hidden: boolean) => {
            if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', hidden ? 'none' : 'visible');
        };
        PRIMARY_MAP_LAYERS.forEach(id => setVisibility(id, activeHidden));
        for (const id of renderedExtraLayersRef.current) {
            EXTRA_SUFFIXES.forEach(suffix => setVisibility('extra-' + id + '-' + suffix, hiddenFileIds.includes(id)));
        }
    }, [isMapLoaded, fileId, displayData, activeTotal, isGridMode, selectedFilesInfo, layerColors, hiddenFileIds, activeHidden]);

// =========================================================================
    // 🌟 核心修复一：全图层覆盖 + 语义化智能遮罩 (不误伤背景边界图层)
    // =========================================================================
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;

        const syncAllFilters = () => {
            // 1. 获取当前地图上所有的图层 ID（主图层 + 所有的副图层）
            const allLayers: { id: string, type: 'Polygon' | 'LineString' | 'Point' }[] = [
                { id: 'geo-fill-layer', type: 'Polygon' },
                { id: 'geo-polygon-border', type: 'Polygon' },
                { id: 'geo-linestring-main', type: 'LineString' },
                { id: 'geo-point-layer', type: 'Point' }
            ];

            renderedExtraLayersRef.current.forEach(baseId => {
                allLayers.push({ id: `extra-${baseId}-fill`, type: 'Polygon' });
                allLayers.push({ id: `extra-${baseId}-line`, type: 'LineString' });
                allLayers.push({ id: `extra-${baseId}-point`, type: 'Point' });
            });

            // 2. 构建智能的基础条件数组
            let baseFilterConditions: any[] = [];

            // A. 巴中市 validIds 过滤
            const shouldApplyValidIdMask = validIds && validIds.length > 0 && !(isMapLinkageEnabled && pivotConfig.groupByCol);
            if (shouldApplyValidIdMask) {
                const idExp = buildFeatureIdFilter(validIds);

                // 【绝杀逻辑】：只对带有分析字段(如Slope_C)的图层应用遮罩！其他图层直接放行(true)
                if (pivotConfig?.groupByRow) {
                    baseFilterConditions.push(['any', ['!has', pivotConfig.groupByRow], idExp]);
                } else {
                    baseFilterConditions.push(idExp);
                }
            }

            // B. 图表高亮联动过滤
            if (isMapLinkageEnabled && highlightedCategory && pivotConfig.groupByRow) {
                const highlightExp = [
                    'any',
                    ['==', pivotConfig.groupByRow, highlightedCategory],
                    ['==', pivotConfig.groupByRow, String(highlightedCategory)],
                    ['==', pivotConfig.groupByRow, Number(highlightedCategory)]
                ];
                // 同样，只针对包含该分析字段的图层生效
                baseFilterConditions.push(['any', ['!has', pivotConfig.groupByRow], highlightExp]);
            }

            // C. 侧边栏基础属性过滤
            const isStringField = activeField ? stringFields.includes(activeField) : false;
            if (!isGridMode && activeField && activeField !== 'none' && isStringField) {
                if (activeFilterValues.length === 0) {
                    baseFilterConditions.push(['==', 'id', 'nothing_selected']);
                } else {
                    baseFilterConditions.push((['in', activeField] as any[]).concat(activeFilterValues));
                }
            }

        // 3. 循环遍历所有图层并应用过滤
        allLayers.forEach(layerInfo => {
            if (map.getLayer(layerInfo.id)) {
                // 拼接基础的图层几何类型判断 + 我们上面的动态条件
                const finalFilter = ['all', ['==', '$type', layerInfo.type], ...baseFilterConditions];

                // 🌟 【核心修复】：直接使用 as any，彻底强制闭嘴！
                map.setFilter(layerInfo.id, finalFilter as any);
            }
        });
        };

        syncAllFilters();
    }, [
        validIds, highlightedCategory, isMapLinkageEnabled, pivotConfig.groupByRow, pivotConfig.groupByCol,
        activeFilterValues, activeField, stringFields, isGridMode, isMapLoaded,
        displayData, fileId, selectedFilesInfo, layerColors
    ]);

    //   [ ] Effect 2: 仅处理“样式/颜色更新” (Paint)
    // 当联动开关、高亮状态、透视数据、或主题色变化时，只更新颜色
    useEffect(() => {
        if (isMapLoaded && displayData) {
            updateLinkageColors();
        }
    }, [
        isMapLinkageEnabled, pivotData, pivotConfig, 
        highlightedCategory, mapColorTheme, //   依赖新状态
        activeField, activeScheme, layerColors
    ]);
    
    // 监听可视化配置变化（字段、配色），只更新 Paint Property，不重绘 Geometry
    useEffect(() => {
        if (isMapLoaded && data) {
            updateChoroplethColors();
        }
    }, [activeField, activeScheme, activeFilterValues, isMapLoaded, layerColors, selectedFilesInfo]);
    
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;

        if (map.getLayer('geo-polygon-border')) {
            map.setPaintProperty(
                'geo-polygon-border',
                'line-color',
                activeBasemap === 'light' ? '#666' : '#a5f3fc'
            );
        }
    }, [activeBasemap, isMapLoaded]);

    const handleBasemapChange = async (basemapKey: string) => {
        const controller = basemapController.current;
        if (!controller) return;
        const request = ++basemapRequest.current;
        setBasemapLoading(true);
        try {
            if (await controller.switchTo(basemapKey)) setActiveBasemap(basemapKey);
        } catch (error) {
            if (request === basemapRequest.current) message.error(error instanceof Error ? error.message : '底图加载失败');
        } finally {
            if (request === basemapRequest.current) setBasemapLoading(false);
        }
    };

    useEffect(() => {
        const abort = new AbortController();
        let disposed = false;
        const timeout = setTimeout(() => abort.abort(), 8000);
        fetch(getApiUrl('/basemaps'), { signal: abort.signal })
            .then(async response => {
                if (!response.ok) throw new Error('catalog unavailable');
                const body = await response.json();
                if (typeof body.data?.tianditu?.configured !== 'boolean') throw new Error('invalid catalog');
                if (!abort.signal.aborted) setTiandituStatus(body.data.tianditu.configured ? 'available' : 'unconfigured');
            })
            .catch(() => { if (!disposed) setTiandituStatus('unavailable'); })
            .finally(() => clearTimeout(timeout));
        return () => { disposed = true; clearTimeout(timeout); abort.abort(); };
    }, []);

    // 重建主图层（如分页或切换网格）后也要恢复当前选中的描边。
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;
        let filter: maplibregl.FilterSpecification = EMPTY_SELECTION;
        if (selectedFeature?.id != null) {
            const id = String(selectedFeature.id);
            filter = ['any',
                ['==', ['to-string', ['id']], id],
                ...FEATURE_ID_FIELDS.map<maplibregl.ExpressionSpecification>(field => ['==', ['to-string', ['get', field]], id]),
            ];
        } else if (selectedFeature?.name) {
            filter = ['==', 'name', selectedFeature.name];
        }
        for (const id of ['geo-highlight-fill', 'geo-highlight-line', 'geo-highlight-point']) {
            if (map.getLayer(id)) map.setFilter(id, filter);
        }
    }, [selectedFeature, isMapLoaded, displayData, fileId, activeTotal, isGridMode]);

    useEffect(() => {
        const map = mapInstance.current;
        const cp = selectedFeature?.cp;
        if (!map || !isMapLoaded || activeHidden || !Array.isArray(cp) || !cp.slice(0, 2).every(Number.isFinite) || cp.length < 2) return;
        const center: [number, number] = [cp[0], cp[1]];
        const content = document.createElement('div');
        content.className = 'map-feature-details';
        const heading = document.createElement('strong');
        heading.textContent = String(selectedFeature.name ?? '要素') + (selectedFeature.id == null ? '' : ' · #' + selectedFeature.id);
        content.append(heading);
        const attributes = document.createElement('dl');
        for (const [key, value] of Object.entries(selectedFeature)) {
            if (key === 'id' || key === 'cp' || key.startsWith('_')) continue;
            const name = document.createElement('dt');
            name.textContent = key;
            const definition = document.createElement('dd');
            definition.textContent = String(value ?? '—');
            attributes.append(name, definition);
        }
        content.append(attributes);

        const popup = new maplibregl.Popup({
            closeOnClick: false, className: 'workbench-map-popup', maxWidth: '260px', offset: 12,
        }).setLngLat(center).setDOMContent(content).addTo(map);
        map.easeTo({ center, zoom: Math.max(14, map.getZoom()), duration: 380 });
        return () => { popup.remove(); };
    }, [selectedFeature, isMapLoaded, activeHidden]);

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
                <span className="text-geo-text-secondary text-xs">网格形状</span>
                <Segmented
                    value={gridConfig.shape}
                    onChange={(val: any) => setGridConfig(prev => ({ ...prev, shape: val }))}
                    options={[
                        { label: '六边形', value: 'hex', icon: <AppstoreOutlined /> },
                        { label: '正方形', value: 'square', icon: <BorderOutlined /> }
                    ]}
                    size="small"
                />
            </div>

            {/* 2. 大小滑块 */}
            <div>
                <div className="flex justify-between text-xs text-geo-text-secondary mb-1">
                    <span>网格大小 (Radius)</span>
                    {/*   [ ] 优化显示逻辑，小于1km显示米 */}
                    <span className="text-geo-accent font-mono">
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
                />
            </div>

            {/* 3. 聚合方式 */}
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <span className="text-geo-text-secondary text-xs block mb-1">聚合模式</span>
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
                    />
                </div>
                {/* 级联显示字段选择 */}
                <div>
                    <span className="text-geo-text-secondary text-xs block mb-1">聚合字段</span>
                    <Select
                        size="small"
                        className="w-full"
                        placeholder="选择字段"
                        //   [ ] 当选择 coverage 时也禁用字段选择
                        disabled={gridConfig.method === 'count' || gridConfig.method === 'coverage'}
                        value={gridConfig.targetField}
                        onChange={(val) => setGridConfig(prev => ({ ...prev, targetField: val }))}
                        options={numericFields.filter(f => f !== 'value').map(f => ({ label: f, value: f }))} 
                    />
                </div>
            </div>

            <div className="w-full h-px bg-geo-border my-1"></div>


            {/*   [ ] 导出选项：支持多选 + 全选 */}
            {isGridMode && (
                <div className="mb-2 bg-geo-dark p-2 rounded border border-geo-border">
                    <div className="flex justify-between items-center mb-1">
                        <span className="text-geo-text-secondary text-xs">
                            分类拆分 (可多选)
                        </span>
                        {/* 全选按钮 */}
                        <a 
                            className="text-xs text-geo-accent cursor-pointer select-none"
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
                        className="flex-1"
                    >
                        保存结果
                    </Button>
                </div>
            ) : (
                <Button 
                    type="primary" block size="small" icon={<ThunderboltOutlined />}
                    onClick={handleGenerateGrid}
                    loading={gridLoading}
                >
                    生成网格
                </Button>
            )}
        </div>
    );

    return (
        <div className="map-workbench">
            <div className="map-toolbar" aria-label="地图工具">
                <Select
                    aria-label="底图"
                    size="small"
                    popupMatchSelectWidth={false}
                    value={activeBasemap}
                    onChange={handleBasemapChange}
                    className="map-basemap-select"
                    loading={basemapLoading}
                    disabled={!isMapLoaded}
                >
                    {BASEMAP_OPTIONS.map(option => {
                        const reason = option.key.startsWith('protomaps-') && !PROTOMAPS_KEY ? '未配置'
                            : option.key.startsWith('tianditu-') && tiandituStatus !== 'available'
                                ? ({ checking: '检查中', unconfigured: '未配置', unavailable: '服务不可用' } as const)[tiandituStatus]
                                : '';
                        return (
                            <Option key={option.key} value={option.key} disabled={Boolean(reason)}>
                                {option.name}{reason ? '（' + reason + '）' : ''}
                            </Option>
                        );
                    })}
                </Select>
                <Popover content={gridConfigContent} trigger="click" placement="bottom">
                    <Button
                        size="small"
                        icon={<DeploymentUnitOutlined />}
                        type={isGridMode ? 'primary' : 'default'}
                        disabled={!fileId || !activeTotal}
                        loading={gridLoading}
                    >
                        {isGridMode ? '网格视图' : '网格聚合'}
                    </Button>
                </Popover>
                <Select
                    aria-label="渲染字段"
                    size="small"
                    popupMatchSelectWidth={false}
                    placeholder="渲染字段"
                    value={activeField}
                    onChange={setActiveField}
                    allowClear={!isGridMode}
                    disabled={isGridMode || (!numericFields.length && !stringFields.length)}
                    className="map-field-select"
                >
                    <Option value="none">默认纯色</Option>
                    {numericFields.length > 0 && (
                        <OptGroup label="数值字段">
                            {numericFields.map(field => <Option key={field} value={field}>{field}</Option>)}
                        </OptGroup>
                    )}
                    {stringFields.length > 0 && (
                        <OptGroup label="文本字段">
                            {stringFields.map(field => <Option key={field} value={field}>{field}</Option>)}
                        </OptGroup>
                    )}
                </Select>
                {activeField && activeField !== 'none' && (
                    <Select
                        aria-label="配色"
                        size="small"
                        popupMatchSelectWidth={180}
                        value={activeScheme}
                        onChange={setActiveScheme}
                        className="map-field-select"
                        optionLabelProp="label"
                    >
                        {Object.entries(COLOR_SCHEMES).map(([key, scheme]) => (
                            <Option key={key} value={key} label={scheme.name}>
                                <div className="flex items-center justify-between gap-2">
                                    <span>{scheme.name}</span>
                                    <div className="flex h-2 w-10 overflow-hidden rounded">
                                        {scheme.colors.map((color, i) => <span key={i} style={{ backgroundColor: color, flex: 1 }} />)}
                                    </div>
                                </div>
                            </Option>
                        ))}
                    </Select>
                )}
                {activeField && !isGridMode && stringFields.includes(activeField) && (
                    <Select
                        aria-label="筛选属性值"
                        size="small"
                        mode="multiple"
                        placeholder="筛选"
                        value={activeFilterValues}
                        onChange={setActiveFilterValues}
                        allowClear
                        maxTagCount={0}
                        className="map-filter-select"
                        options={uniqueFieldValues.map(value => ({ label: String(value), value }))}
                    />
                )}
                <Checkbox checked={showAll} onChange={handleShowAllChange} disabled={!activeTotal || loading || isGridMode}>
                    全量
                </Checkbox>
                {!isChartVisible && pivotData && pivotData.length > 0 && (
                    <Tooltip title="显示透视分析图表">
                        <Button size="small" icon={<BarChartOutlined />} aria-label="显示透视分析图表" onClick={() => setChartVisible(true)} />
                    </Tooltip>
                )}
                <Button
                    size="small" className="map-layer-button" icon={<UnorderedListOutlined />}
                    aria-controls="map-layer-list" aria-expanded={legendOpen}
                    onClick={() => setLegendOpen(open => !open)}
                >
                    图层
                </Button>
            </div>

            <div className="map-stage">
                <div ref={mapContainer} className="map-surface" />
                {!isMapLoaded && (
                    <div className="map-notice" role="status">
                        {mapStartupFailed ? '地图初始化失败，请检查浏览器的 WebGL 支持' : <><Spin size="small" /> 地图初始化中…</>}
                    </div>
                )}
                {loading && <div className="map-notice" role="status"><Spin size="small" /> 正在加载全量数据…</div>}
                <ChartOverlay />
                <div id="map-layer-list" className="map-layer-list" aria-label="图层图例" role="region" hidden={!legendOpen}>
                    {!selectedFilesInfo.length && <p className="map-layer-empty">未选择图层</p>}
                    {selectedFilesInfo.map(file => {
                        const primary = file.fileId === fileId;
                        const vector = primary ? !isGridMode : (file.totalFeatures ?? 0) > MVT_THRESHOLD;
                        const hidden = hiddenFileIds.includes(file.fileId);
                        const drawStatus = primary
                            ? (primaryStatus?.fileId === file.fileId ? primaryStatus.status : undefined)
                            : extraStatuses[file.fileId];
                        let status = '加载中…';
                        if (file.loadFailed) status = '数据加载失败';
                        else if (file.totalFeatures === undefined) status = '加载中…';
                        else if (file.totalFeatures === 0 || drawStatus === 'empty') status = '无要素';
                        else if (drawStatus === 'error') status = vector ? '瓦片加载失败' : '图层加载失败';
                        else if (hidden) status = '已隐藏';
                        else if (drawStatus === 'ready') status = '可见';

                        return (
                            <div key={file.fileId} className="map-layer-row">
                                <Checkbox
                                    aria-label={'显示 ' + file.fileName}
                                    checked={!hidden}
                                    disabled={file.loadFailed || file.totalFeatures === 0}
                                    onChange={event => setHiddenFileIds(prev => event.target.checked
                                        ? prev.filter(id => id !== file.fileId)
                                        : [...prev, file.fileId])}
                                />
                                <ColorPicker
                                    size="small"
                                    value={colorForFile(file.fileId)}
                                    disabled={file.loadFailed || !file.totalFeatures}
                                    onChangeComplete={color => setLayerColor(file.fileId, color.toHexString())}
                                    aria-label={'图层颜色 ' + file.fileName}
                                />
                                <div className="map-layer-caption">
                                    <div className="map-layer-name" title={file.fileName} aria-current={primary || undefined}>{file.fileName}</div>
                                    <div className="map-layer-status" role="status" data-error={status.endsWith('失败') || undefined}>
                                        {status}
                                        {status === '可见' && vector && ' · MVT'}
                                        {primary && ' · 当前'}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export default MapView;
