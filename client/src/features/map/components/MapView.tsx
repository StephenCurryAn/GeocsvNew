import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { bbox, pointOnFeature } from '@turf/turf';
//   [ ] 引入所需的 Ant Design 组件
import { 
    Button, Tooltip, App, Checkbox, Spin, Select, Popover, Segmented, Slider
} from 'antd';
import ChartOverlay, { THEME_COLORS, CONTRAST_PALETTES } from './ChartOverlay';
import { geoService, type LayerBounds } from '../../../services/geoService';
//   [ ] 引入图标
import { 
    BarChartOutlined, 
    DeploymentUnitOutlined, // 网格入口图标
    AppstoreOutlined,       // Hex 图标
    BorderOutlined,         // Square 图标
    CheckSquareOutlined,
    ThunderboltOutlined,    // 执行图标
    UndoOutlined,            // 重置图标
    SaveOutlined,
} from '@ant-design/icons';
import { useAnalysisStore } from '../../../stores/useAnalysisStore'
import { API_BASE_URL, getApiUrl } from '../../../services/apiConfig';
import { BASEMAP_OPTIONS, BasemapController, DEFAULT_BASEMAP, initialMapStyle, loadBasemap } from '../basemaps';
import type { SelectedFeature } from '../featureSelection';
import { useDeckPointLayer } from '../useDeckPointLayer';
import { readDeckPointLayer, saveDeckPointLayer } from '../../workspace/scenePreferences';
import {
    addFileLayers, addSelectionLayers, defaultLayerColor, drawingLayers, EMPTY_SELECTION, geometryLayers, highlightLayers,
    highlightGeometryFilter, layerIds, LAYER_PALETTE, paintFileLayers, paintSelectionStyle, removeFileLayers, setFileVisibility,
    updateGridGeometry, updateVectorTiles, type SelectionStyle,
} from '../fileLayers';

const PROTOMAPS_KEY = (import.meta.env.VITE_PROTOMAPS_API_KEY || '').trim();

const { Option, OptGroup } = Select;

// 多图层信息类型
export interface FileLayerInfo {
    fileId: string;
    fileName: string;
    totalFeatures?: number;
    geometryTypes?: string[];
    loadFailed?: boolean;
    tileVersion?: number;
}

export type DrawStatus = 'ready' | 'error';
const fileLayers = (fileId: string) => layerIds('file-' + fileId);
const gridLayers = layerIds('grid');
const featureSelectionLayers = layerIds('feature-selection');
const DENSE_LAYER_SIZE = 5000;
const isPointLayer = (file?: FileLayerInfo) => Boolean(file?.totalFeatures && file.geometryTypes?.length
    && file.geometryTypes.every(type => type === 'ST_Point' || type === 'ST_MultiPoint'));

function tileUrls(fileId: string, version: number) {
    return [toMapLibreTileUrl('/tiles/' + fileId + '/{z}/{x}/{y}?v=' + version)];
}

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

const toMapLibreTileUrl = (path: string): string => {
    const apiUrl = getApiUrl(path);
    // Keep {z}/{x}/{y} intact while resolving relative URLs against this app's origin.
    return /^https?:\/\//i.test(apiUrl) ? apiUrl : `${window.location.origin}${apiUrl.startsWith('/') ? '' : '/'}${apiUrl}`;
};
const FEATURE_ID_FIELDS = ['id', 'Id', 'ID', 'fid', 'FID', '_id', 'ObjectId', 'OBJECTID', 'objectid'];
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

interface MapViewProps {
    data: any;        // GeoJSON 数据（当前激活文件）
    fileId?: string;  // 当前选中的文件ID
    sceneId: string;
    selectedFeatures: SelectedFeature[];
    focusedFeature?: SelectedFeature;
    featureFocus: SelectedFeature[] | null;
    selectionStyle: SelectionStyle;
    onFeatureClick: (feature: SelectedFeature | null, additive: boolean) => void;
    layerFocus: { fileId: string } | null;
    hiddenFileIds: string[];
    onDrawStatusChange: (fileId: string, status?: DrawStatus) => void;
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

const MapView: React.FC<MapViewProps> = ({
    data, fileId, sceneId, selectedFeatures, focusedFeature, featureFocus, selectionStyle, onFeatureClick,
    layerFocus, hiddenFileIds, onDrawStatusChange, selectedFilesInfo = [],
}) => {
    //     2: 获取上下文感知的 message 实例
    // 注意：MapView 必须被包裹在 <App> 组件中（通常在 main.tsx 或 App.tsx 已经包了）
    const { message } = App.useApp();
    const mapContainer = useRef<HTMLDivElement>(null);
    const mapInstance = useRef<maplibregl.Map | null>(null);
    const basemapController = useRef<BasemapController | null>(null);
    const basemapRequest = useRef(0);
    const [basemapLoading, setBasemapLoading] = useState(false);
    const [tiandituStatus, setTiandituStatus] = useState<'checking' | 'available' | 'unconfigured' | 'unavailable'>('checking');
    const openFiles = useRef(new Map<string, { version: number; stop: () => void }>());
    const initialTileVersion = useRef(Date.now());
    const mapSelection = useRef(onFeatureClick);
    mapSelection.current = onFeatureClick;
    const [batchMode, setBatchMode] = useState(false);
    const activeFileRef = useRef(fileId);
    activeFileRef.current = fileId;
    const fullDataRequest = useRef(0);
    const [gridSelection, setGridSelection] = useState<Record<string, unknown> | null>(null);
    const activeHidden = Boolean(fileId && hiddenFileIds.includes(fileId));

    const [isMapLoaded, setIsMapLoaded] = useState(false);
    const [mapStartupFailed, setMapStartupFailed] = useState(false);
    const [numericFields, setNumericFields] = useState<string[]>([]); // 可用于映射的数值字段
    //   [新增] 存储文本型字段，用于分类拆分
    const [stringFields, setStringFields] = useState<string[]>([]);

    const [fieldSelection, setFieldSelection] = useState<{ fileId?: string; field: string | null }>();
    const activeField = fieldSelection?.fileId === fileId ? fieldSelection?.field ?? null : null;
    const setActiveField = (field: string | null) => setFieldSelection({ fileId, field });
    const [activeScheme, setActiveScheme] = useState<string>('viridis'); // 当前颜色方案
    const [activeBasemap, setActiveBasemap] = useState<string>();
    
    const [uniqueFieldValues, setUniqueFieldValues] = useState<(string | number)[]>([]); // 存放当前字段所有的唯一值
    const [activeFilterValues, setActiveFilterValues] = useState<(string | number)[]>([]); // 存放当前勾选的值

    //  状态管理 - 全量数据相关
    const [fullLayer, setFullLayer] = useState<{ fileId: string; data: Awaited<ReturnType<typeof geoService.getAllFileData>> } | null>(null);
    const allData = fullLayer?.fileId === fileId ? fullLayer?.data : null;
    const showAll = Boolean(allData);
    const [loading, setLoading] = useState(false);

    //   [新增] 空间网格相关状态
    const [gridResult, setGridResult] = useState<{ fileId: string; data: any } | null>(null);
    const isGridMode = Boolean(fileId && gridResult?.fileId === fileId);
    const gridData = isGridMode ? gridResult?.data : null;
    const primary = isGridMode ? gridLayers : fileLayers(fileId || '');
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
        layerColors, assignLayerColors,
        validIds // 新增：获取 validIds 用于地图过滤
    } = useAnalysisStore();

    useEffect(() => {
        ++fullDataRequest.current;
        setFullLayer(null);
        setLoading(false);
        setGridSelection(null);
    }, [fileId]);

    useEffect(() => {
        assignLayerColors(selectedFilesInfo.map(file => file.fileId));
    }, [selectedFilesInfo, assignLayerColors]);

    const colorForFile = (id?: string) => {
        if (!id) return LAYER_PALETTE[0];
        return layerColors[id] || defaultLayerColor(id);
    };

    const [preferredDeckFile, setPreferredDeckFile] = useState(readDeckPointLayer);
    const chooseDeckFile = useCallback((id?: string) => {
        saveDeckPointLayer(id);
        setPreferredDeckFile(id);
    }, []);
    const canUseDeck = !isGridMode && !validIds.length && !(isMapLinkageEnabled && (pivotData?.length || highlightedCategory));
    const hasCustomStyle = Boolean(activeField && activeField !== 'none');
    const preferredLayer = selectedFilesInfo.find(file => file.fileId === preferredDeckFile);
    const deckFile = canUseDeck && preferredLayer && isPointLayer(preferredLayer)
        && !hiddenFileIds.includes(preferredLayer.fileId) && !(fileId === preferredLayer.fileId && hasCustomStyle)
        ? preferredLayer : undefined;
    const deckFileId = deckFile?.fileId;
    const deckVersion = deckFile?.tileVersion ?? initialTileVersion.current;
    const deckColor = colorForFile(deckFileId);
    const deckDense = (deckFile?.totalFeatures ?? 0) > DENSE_LAYER_SIZE;
    const deckOptions = useMemo(() => deckFileId ? {
        fileId: deckFileId, tileUrl: tileUrls(deckFileId, deckVersion)[0], beforeId: fileLayers(deckFileId).point,
        color: deckColor, dense: deckDense,
    } : undefined, [deckFileId, deckVersion, deckColor, deckDense]);
    const activeDeckFile = useRef(deckFileId);
    activeDeckFile.current = deckFileId;
    const onDeckReady = useCallback((id: string) => onDrawStatusChange(id, 'ready'), [onDrawStatusChange]);
    const onDeckError = useCallback((id: string) => {
        chooseDeckFile();
        onDrawStatusChange(id);
        message.warning('deck.gl 无法绘制此图层，已切回原生 MVT');
    }, [chooseDeckFile, message, onDrawStatusChange]);
    const { layer: deckLayer, ready: deckReady } = useDeckPointLayer(
        isMapLoaded ? mapInstance.current : null, deckOptions, onDeckReady, onDeckError,
    );

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
            for (const { stop } of openFiles.current.values()) stop();
            openFiles.current.clear();
            if (mapInstance.current) {
                mapInstance.current.remove();
                mapInstance.current = null;
            }
        };
    }, []);

    // File sources belong to the selected files, independently of the active attribute tab.
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;
        const visibleFiles = selectedFilesInfo.filter(file => (file.totalFeatures ?? 0) > 0);
        const selected = new Set(visibleFiles.map(file => file.fileId));
        for (const [id, { stop }] of openFiles.current) {
            if (selected.has(id)) continue;
            stop();
            removeFileLayers(map, fileLayers(id));
            openFiles.current.delete(id);
            onDrawStatusChange(id);
        }

        for (const file of visibleFiles) {
            const ids = fileLayers(file.fileId);
            const version = file.tileVersion ?? initialTileVersion.current;
            const current = openFiles.current.get(file.fileId);
            if (current) {
                if (version !== current.version) {
                    updateVectorTiles(map, ids, tileUrls(file.fileId, version));
                    current.version = version;
                }
                continue;
            }
            const stop = watchLayerSource(map, ids.source, status => {
                if (activeDeckFile.current !== file.fileId) onDrawStatusChange(file.fileId, status);
            });
            addFileLayers(map, ids, tileUrls(file.fileId, version));
            paintFileLayers(map, ids, colorForFile(file.fileId), { dense: (file.totalFeatures ?? 0) > DENSE_LAYER_SIZE });
            openFiles.current.set(file.fileId, { version, stop });
        }
        for (const file of [...visibleFiles].reverse()) {
            for (const id of drawingLayers(fileLayers(file.fileId))) map.moveLayer(id);
        }
        deckLayer.current?.align();
        if (map.getSource(gridLayers.source)) {
            for (const id of drawingLayers(gridLayers)) map.moveLayer(id);
        }
    }, [selectedFilesInfo, isMapLoaded, onDrawStatusChange, deckLayer]);

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
        setGridSelection(null);
        setActiveField(null); // 清空字段，让用户重新选
        message.info("已切换回原始图层");
    };

    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;

        const findFeature = (event: maplibregl.MapMouseEvent) => {
            const layerOwners = new Map<string, string | null>();
            for (const id of openFiles.current.keys()) {
                for (const layer of geometryLayers(fileLayers(id))) {
                    if (map.getLayoutProperty(layer.id, 'visibility') !== 'none') layerOwners.set(layer.id, id);
                }
            }
            for (const layer of geometryLayers(gridLayers)) {
                if (map.getLayer(layer.id) && map.getLayoutProperty(layer.id, 'visibility') !== 'none') layerOwners.set(layer.id, null);
            }
            const [feature] = layerOwners.size ? map.queryRenderedFeatures(event.point, { layers: [...layerOwners.keys()] }) : [];
            const owner = feature && layerOwners.get(feature.layer.id);
            if (deckFileId && deckReady && owner !== null && (owner === undefined
                || selectedFilesInfo.findIndex(file => file.fileId === deckFileId) < selectedFilesInfo.findIndex(file => file.fileId === owner))) {
                const hit = deckLayer.current?.pick(event.point.x, event.point.y);
                if (hit) return { feature: hit, owner: deckFileId };
            }
            return owner !== undefined ? { feature, owner } : undefined;
        };
        const handleClick = (event: maplibregl.MapMouseEvent) => {
            const hit = findFeature(event);
            const { shiftKey, ctrlKey, metaKey } = event.originalEvent;
            const additive = batchMode || shiftKey || ctrlKey || metaKey;
            map.stop();
            if (hit?.owner === null) {
                setGridSelection({ ...hit.feature.properties, id: hit.feature.id ?? hit.feature.properties.id,
                    cp: [event.lngLat.lng, event.lngLat.lat] });
                return;
            }
            setGridSelection(null);
            if (!hit) {
                mapSelection.current(null, additive);
                return;
            }
            const { feature, owner } = hit;
            const id = feature.id;
            if (id == null) return;
            mapSelection.current({
                fileId: owner, id: String(id), properties: feature.properties, geometry: null,
                anchor: [event.lngLat.lng, event.lngLat.lat],
            }, additive);
        };
        const handleMove = (event: maplibregl.MapMouseEvent) => {
            if (deckFileId && map.isMoving()) return;
            map.getCanvas().style.cursor = findFeature(event) ? 'pointer' : '';
        };
        map.on('click', handleClick);
        map.on('mousemove', handleMove);
        return () => {
            map.off('click', handleClick);
            map.off('mousemove', handleMove);
        };
    }, [isMapLoaded, batchMode, deckFileId, deckLayer, deckReady, selectedFilesInfo]);

    //   [ ]  联动着色逻辑：增强高亮对比度
    const updateLinkageColors = () => {
        const map = mapInstance.current;
        // 卫兵：只要没有 图层就退出
        if (!map || (!map.getLayer(primary.fill) && !map.getLayer(primary.line))) return;
        
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
                const otherLayers = [...openFiles.current.keys()].filter(id => id !== fileId).map(fileLayers);
                const fillLayers = [primary.fill, ...otherLayers.map(ids => ids.fill)];
                const borderLayers = [primary.border];
                const lineLayers = [primary.line, ...otherLayers.map(ids => ids.line)];
                const pointLayers = [primary.point, ...otherLayers.map(ids => ids.point)];

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
            updateChoroplethColors();
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
        
        if (!map || !map.getLayer(primary.fill) || !currentDisplayData) return;

        if (!activeField || activeField === 'none') return;

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
        if (map.getLayer(primary.fill)) {
            map.setPaintProperty(primary.fill, 'fill-color', finalFillColor);
            map.setPaintProperty(primary.fill, 'fill-opacity', finalFillOpacity);
            map.setPaintProperty(primary.fill, 'fill-outline-color', finalFillOutline);
        }
        
        if (map.getLayer(primary.line)) {
            map.setPaintProperty(primary.line, 'line-color', finalLineColor);
            map.setPaintProperty(primary.line, 'line-opacity', finalLineOpacity);
            map.setPaintProperty(primary.line, 'line-width', finalLineWidth);
        }
        
        if (map.getLayer(primary.point)) {
            map.setPaintProperty(primary.point, 'circle-color', finalPointColor);
            map.setPaintProperty(primary.point, 'circle-opacity', finalPointOpacity);
            map.setPaintProperty(primary.point, 'circle-radius', finalPointRadius);
            map.setPaintProperty(primary.point, 'circle-stroke-width', finalPointStrokeWidth);
            map.setPaintProperty(primary.point, 'circle-stroke-color', finalPointStrokeColor);
        }
    };

    const activeTotal = selectedFilesInfo.find(file => file.fileId === fileId)?.totalFeatures;

    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;
        if (!gridData) {
            removeFileLayers(map, gridLayers);
            return;
        }
        if (!map.getSource(gridLayers.source)) addFileLayers(map, gridLayers);
        updateGridGeometry(map, gridLayers, gridData);
    }, [gridData, isMapLoaded]);

    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;
        for (const id of openFiles.current.keys()) {
            setFileVisibility(map, fileLayers(id), id !== deckFileId && !hiddenFileIds.includes(id) && !(isGridMode && id === fileId));
        }
        if (isGridMode) setFileVisibility(map, gridLayers, !activeHidden);
    }, [isMapLoaded, fileId, gridData, isGridMode, selectedFilesInfo, hiddenFileIds, activeHidden, deckFileId]);

    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded || !sceneId || !layerFocus || layerFocus.fileId !== fileId) return;

        const controller = new AbortController();
        map.stop();
        void geoService.getFileExtent(layerFocus.fileId, sceneId, controller.signal).then(bounds => {
            if (controller.signal.aborted) return;
            if (!bounds?.every(Number.isFinite)) {
                message.info('该图层没有可定位的空间要素');
                return;
            }
            const canvas = map.getContainer();
            if (!canvas.clientWidth || !canvas.clientHeight) return;
            map.fitBounds(bounds, {
                padding: Math.min(48, canvas.clientWidth / 8, canvas.clientHeight / 8),
                maxZoom: 15, duration: 540,
            });
        }).catch(() => {
            if (!controller.signal.aborted) message.warning('暂时无法定位图层，请重新点击图层名称');
        });
        return () => { controller.abort(); };
    }, [fileId, layerFocus, isMapLoaded, sceneId, message]);

    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded || isGridMode || !featureFocus) return;
        const geometries = featureFocus.flatMap(item => item.geometry ? [item.geometry] : []);
        if (!geometries.length) return;
        const bounds = bbox({ type: 'GeometryCollection', geometries }, { recompute: true }) as LayerBounds;
        if (!bounds.every(Number.isFinite)) return;
        const canvas = map.getContainer();
        if (!canvas.clientWidth || !canvas.clientHeight) return;
        const camera = map.cameraForBounds(bounds, {
            padding: Math.min(56, canvas.clientWidth / 6, canvas.clientHeight / 6),
            maxZoom: geometries.length > 1 ? map.getZoom() : Math.max(15, map.getZoom()),
        });
        if (camera?.center && camera.zoom !== undefined) {
            map.easeTo({ center: camera.center, zoom: Math.min(camera.zoom, map.getZoom() + 2.5), duration: 360 });
        }
    }, [featureFocus, isMapLoaded, isGridMode]);

// =========================================================================
    // 🌟 核心修复一：全图层覆盖 + 语义化智能遮罩 (不误伤背景边界图层)
    // =========================================================================
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;

        const syncAllFilters = () => {
            const allLayers = [...openFiles.current.keys()].flatMap(id =>
                geometryLayers(fileLayers(id)).map(layer => ({ ...layer, active: id === fileId && !isGridMode })));
            if (isGridMode) allLayers.push(...geometryLayers(gridLayers).map(layer => ({ ...layer, active: true })));

            // 2. 构建智能的基础条件数组
            const baseFilterConditions: any[] = [];
            const fieldConditions: any[] = [];

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
                    fieldConditions.push(['==', '$id', -1]);
                } else {
                    fieldConditions.push((['in', activeField] as any[]).concat(activeFilterValues));
                }
            }

        // 3. 循环遍历所有图层并应用过滤
        allLayers.forEach(layerInfo => {
            if (map.getLayer(layerInfo.id)) {
                // 拼接基础的图层几何类型判断 + 我们上面的动态条件
                const finalFilter = ['all', ['==', '$type', layerInfo.geometry], ...baseFilterConditions, ...(layerInfo.active ? fieldConditions : [])];

                // 🌟 【核心修复】：直接使用 as any，彻底强制闭嘴！
                map.setFilter(layerInfo.id, finalFilter as any);
            }
        });
        };

        syncAllFilters();
    }, [
        validIds, highlightedCategory, isMapLinkageEnabled, pivotConfig.groupByRow, pivotConfig.groupByCol,
        activeFilterValues, activeField, stringFields, isGridMode, isMapLoaded,
        gridData, fileId, selectedFilesInfo
    ]);

    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;
        for (const file of selectedFilesInfo) {
            if (file.fileId !== fileId || isGridMode) paintFileLayers(map, fileLayers(file.fileId), colorForFile(file.fileId),
                { dense: (file.totalFeatures ?? 0) > DENSE_LAYER_SIZE });
        }
        if (!map.getSource(primary.source)) return;
        paintFileLayers(map, primary, colorForFile(fileId), { grid: isGridMode, dense: (activeTotal ?? 0) > DENSE_LAYER_SIZE });
        updateLinkageColors();
    }, [isMapLoaded, fileId, isGridMode, selectedFilesInfo, displayData, layerColors,
        isMapLinkageEnabled, pivotData, pivotConfig, highlightedCategory, mapColorTheme,
        activeField, activeScheme, activeFilterValues, uniqueFieldValues]);

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
        if (isMapLoaded && PROTOMAPS_KEY) void handleBasemapChange(DEFAULT_BASEMAP);
    }, [isMapLoaded]);

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

    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;
        for (const file of openFiles.current.keys()) {
            const pending = isGridMode ? [] : selectedFeatures.filter(item => item.fileId === file && !item.geometry)
                .map(item => Number(item.id)).filter(Number.isSafeInteger);
            const ids = fileLayers(file);
            const filter: boolean | maplibregl.ExpressionSpecification = pending.length ? ['in', ['id'], ['literal', pending]] : EMPTY_SELECTION;
            for (const layer of highlightLayers(ids)) map.setFilter(layer, highlightGeometryFilter(ids, layer, filter));
        }
        if (isGridMode) {
            const id = gridSelection?.id;
            const filter: boolean | maplibregl.ExpressionSpecification = id == null ? EMPTY_SELECTION : ['any',
                ['==', ['to-string', ['id']], String(id)], ['==', ['to-string', ['get', 'id']], String(id)]];
            for (const layer of highlightLayers(gridLayers)) {
                if (map.getLayer(layer)) map.setFilter(layer, highlightGeometryFilter(gridLayers, layer, filter));
            }
        }
    }, [selectedFeatures, isMapLoaded, selectedFilesInfo, isGridMode, gridData, gridSelection]);

    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;
        const features: GeoJSON.Feature[] = isGridMode ? [] : selectedFeatures.flatMap(item =>
            item.geometry && !hiddenFileIds.includes(item.fileId)
                ? [{ type: 'Feature', geometry: item.geometry, properties: null }] : []);
        if (!map.getSource(featureSelectionLayers.source)) {
            addSelectionLayers(map, featureSelectionLayers);
        }
        updateGridGeometry(map, featureSelectionLayers, { type: 'FeatureCollection', features });
        for (const id of highlightLayers(featureSelectionLayers)) map.moveLayer(id);
    }, [selectedFeatures, hiddenFileIds, isGridMode, isMapLoaded, selectedFilesInfo]);

    useEffect(() => {
        const map = mapInstance.current;
        if (!map || !isMapLoaded) return;
        paintSelectionStyle(map, featureSelectionLayers, selectionStyle);
        for (const file of openFiles.current.keys()) paintSelectionStyle(map, fileLayers(file), selectionStyle);
    }, [selectionStyle, isMapLoaded, selectedFilesInfo]);

    useEffect(() => {
        const map = mapInstance.current;
        const detail = !isGridMode && focusedFeature && !hiddenFileIds.includes(focusedFeature.fileId) ? focusedFeature : null;
        const feature = isGridMode && !activeHidden ? gridSelection : detail?.properties;
        const cp = isGridMode ? gridSelection?.cp : detail?.anchor ?? (detail?.geometry
            ? pointOnFeature(detail.geometry).geometry.coordinates : undefined);
        if (!map || !isMapLoaded || !feature || !Array.isArray(cp) || cp.length < 2
            || !cp.slice(0, 2).every(Number.isFinite)) return;
        const center: [number, number] = [cp[0], cp[1]];
        const content = document.createElement('div');
        content.className = 'map-feature-details';
        content.setAttribute('role', 'region');
        content.setAttribute('aria-label', '要素属性');
        content.tabIndex = 0;
        const heading = document.createElement('strong');
        const id = detail?.id ?? feature.id;
        heading.textContent = String(feature.name ?? feature.community ?? (isGridMode ? '网格' : '要素'))
            + (id == null ? '' : ' · #' + id);
        content.append(heading);
        const attributes = document.createElement('dl');
        for (const [key, value] of Object.entries(feature)) {
            if (['cp', '_geometry', '_geom_coords'].includes(key)) continue;
            const name = document.createElement('dt');
            name.textContent = key;
            const definition = document.createElement('dd');
            definition.textContent = value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—');
            attributes.append(name, definition);
        }
        content.append(attributes);
        const popup = new maplibregl.Popup({
            closeOnClick: false, focusAfterOpen: false, className: 'workbench-map-popup', maxWidth: '260px', offset: 12,
        }).setLngLat(center).setDOMContent(content).addTo(map);
        return () => { popup.remove(); };
    }, [isMapLoaded, activeHidden, hiddenFileIds, isGridMode, gridSelection, focusedFeature]);

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
                    placeholder={basemapLoading ? '底图加载中…' : '选择底图'}
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
                {isPointLayer(selectedFilesInfo.find(file => file.fileId === fileId)) && (
                    <Tooltip title={canUseDeck && !hasCustomStyle
                        ? '两种渲染器使用相同的点瓦片与地图视角'
                        : 'deck.gl 试点适用于默认纯色点图层，当前样式使用原生 MVT'}>
                        <Select
                            aria-label="点图层渲染器"
                            popupMatchSelectWidth={false}
                            size="small"
                            className="map-point-renderer-select"
                            disabled={!isMapLoaded || activeHidden || !canUseDeck || hasCustomStyle}
                            loading={fileId === deckFileId && !deckReady}
                            value={fileId === deckFileId ? 'deck' : 'native'}
                            onChange={value => chooseDeckFile(value === 'deck' ? fileId : undefined)}
                            options={[
                                { value: 'native', label: '原生 MVT' },
                                { value: 'deck', label: 'deck.gl 试点' },
                            ]}
                        />
                    </Tooltip>
                )}
                <Tooltip title="开启后，点击地图可逐个添加或取消选择。也可以按住 Shift 点击。">
                    <Button size="small" icon={<CheckSquareOutlined />} aria-pressed={batchMode}
                        type={batchMode ? 'primary' : 'default'} disabled={!isMapLoaded || isGridMode || !selectedFilesInfo.length}
                        onClick={() => setBatchMode(value => !value)}>
                        {batchMode && selectedFeatures.length > 0 ? `多选 (${selectedFeatures.length})` : '多选'}
                    </Button>
                </Tooltip>
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
                    全量属性
                </Checkbox>
                {!isChartVisible && pivotData && pivotData.length > 0 && (
                    <Tooltip title="显示透视分析图表">
                        <Button size="small" icon={<BarChartOutlined />} aria-label="显示透视分析图表" onClick={() => setChartVisible(true)} />
                    </Tooltip>
                )}
            </div>

            <div className="map-stage">
                <div ref={mapContainer} className="map-surface" />
                {!isMapLoaded && (
                    <div className="map-notice" role="status">
                        {mapStartupFailed ? '地图初始化失败，请检查浏览器的 WebGL 支持' : <><Spin size="small" /> 地图初始化中…</>}
                    </div>
                )}
                {loading && <div className="map-notice" role="status"><Spin size="small" /> 正在加载全量数据…</div>}
                {deckFileId && !deckReady && <div className="map-notice" role="status"><Spin size="small" /> 正在加载 deck.gl 点图层…</div>}
                <ChartOverlay />
            </div>
        </div>
    );
};

export default MapView;
