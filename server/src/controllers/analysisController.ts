import { Request, Response } from 'express';
import * as Feature from '../models/Feature';
import * as ModelRegistry from '../models/ModelRegistry';
import { generateModelCodeFromAI, planWorkflow, generatePivotCode, generateChartCode, fixPivotCode, fixChartCode } from '../utils/llmService';
import * as turf from '@turf/turf';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// WSL2 中 FastAPI 运行的地址
const PYTHON_API_URL = 'http://127.0.0.1:8000/api';
// 更新后的 Python API 返回结构 (API 契约)
interface PythonApiResponse {
  status: string;
  result_col_names: string[];
  result_data: Array<any>; // 明确告诉 TS 这是一个包含 id 和 score 的对象数组
  execution_time_ms: number;
}

// [Phase 5] Python SDK 物理直注字符串
// 直接拼接在执行代码前方，彻底解决沙盒 import 找不到路径的问题
// ==========================================
const PYTHON_SDK_INJECTION = `
import geopandas as gpd
import pandas as pd
import numpy as np
import warnings
from shapely.errors import ShapelyDeprecationWarning
warnings.filterwarnings("ignore", category=ShapelyDeprecationWarning)

# ==========================================
# 模块一：空间基底与投影安全模块 (Spatial Foundation)
# ==========================================

def ensure_metric_crs(gdf):
    """
    【安全投影算子】
    确保 GeoDataFrame 处于投影坐标系 (以米为单位，通常为 EPSG:3857)。
    这是执行 Buffer 和 距离计算 的绝对前提，防止经纬度直接 Buffer 导致极度变形。
    """
    if gdf.empty or gdf.geometry.isnull().all():
        return gdf
    
    # 如果没有坐标系，假定为 WGS84 (EPSG:4326)
    if gdf.crs is None:
        gdf = gdf.set_crs(epsg=4326)
        
    # 如果是地理坐标系 (经纬度，度为单位)，强制转为 Web Mercator (米为单位)
    if gdf.crs.is_geographic:
        return gdf.to_crs(epsg=3857)
    return gdf

# ==========================================
# 模块二：空间拓扑连接算子 (Spatial Topology Layer - The "S")
# ==========================================

def safe_buffer_intersects(target_gdf, join_gdf, radius=0):
    """
    【缓冲相交算子】: 解决 点-线、点-点 无法精确相交的问题。
    包含活跃几何陷阱的彻底修复。
    """
    if target_gdf.empty or join_gdf.empty:
        return gpd.GeoDataFrame()
        
    target_gdf = ensure_metric_crs(target_gdf)
    join_gdf = join_gdf.to_crs(target_gdf.crs) if join_gdf.crs != target_gdf.crs else join_gdf
    
    radius = float(radius)
    if radius > 0:
        # 强制使用 set_geometry 更新活跃几何列，防止全 0 Bug
        buffer_geom = target_gdf.geometry.buffer(radius)
        safe_target = target_gdf.set_geometry(buffer_geom)
    else:
        safe_target = target_gdf.copy()
        
    return gpd.sjoin(safe_target, join_gdf, how='inner', predicate='intersects')

def safe_intersects(target_gdf, join_gdf):
    """
    【精准相交算子】: 适用于 面-面、线-面 等原生具有面积交叉的要素。
    """
    if target_gdf.empty or join_gdf.empty:
        return gpd.GeoDataFrame()
    
    join_gdf = join_gdf.to_crs(target_gdf.crs) if join_gdf.crs else join_gdf
    return gpd.sjoin(target_gdf, join_gdf, how='inner', predicate='intersects')

def safe_within_contains(target_gdf, join_gdf, relation='within'):
    """
    【包含关系算子】: 适用于 统计行政区内的 POI (contains) 或 POI 属于哪个区 (within)。
    relation 可选: 'within' (被包含), 'contains' (包含)
    """
    if target_gdf.empty or join_gdf.empty:
        return gpd.GeoDataFrame()
        
    join_gdf = join_gdf.to_crs(target_gdf.crs) if join_gdf.crs else join_gdf
    return gpd.sjoin(target_gdf, join_gdf, how='inner', predicate=relation)

def safe_nearest(target_gdf, join_gdf, max_distance=None):
    """
    【最近邻算子】: 适用于 寻找最近的地铁站、医院等。
    """
    if target_gdf.empty or join_gdf.empty:
        return gpd.GeoDataFrame()

    target_gdf = ensure_metric_crs(target_gdf)
    join_gdf = join_gdf.to_crs(target_gdf.crs) if join_gdf.crs != target_gdf.crs else join_gdf
    
    if max_distance:
        return gpd.sjoin_nearest(target_gdf, join_gdf, how='inner', max_distance=float(max_distance))
    return gpd.sjoin_nearest(target_gdf, join_gdf, how='inner')

def safe_get_centroid_coords(gdf, x_col='lon', y_col='lat'):
    """
    【坐标提取算子】: 专门用于为前端绘图提供精确的 X/Y 经纬度坐标。
    """
    # 不可硬编码判断 'geometry' 字符串，因为底层列名可能是 'geom'
    # 使用 getattr 和 isinstance 动态判断是否具备空间属性
    if gdf.empty or not isinstance(gdf, gpd.GeoDataFrame) or getattr(gdf, 'geometry', None) is None:
        return gdf
        
    # 1. 先用米制投影算质心，保证几何中心绝对准确且不报 Warning
    metric_gdf = ensure_metric_crs(gdf)
    
    # 2. 将质心转回 Web 通用的 WGS84 经纬度
    # metric_gdf.geometry.centroid 直接返回 GeoSeries，调用 to_crs 即可
    centroids_wgs84 = metric_gdf.geometry.centroid.to_crs(epsg=4326)
    
    # 3. 将坐标赋给原表
    result_gdf = gdf.copy()
    result_gdf[x_col] = centroids_wgs84.x
    result_gdf[y_col] = centroids_wgs84.y
    
    return result_gdf

# ==========================================
# 模块三：空间数据透视聚合算子 (OLAP Aggregation - The "M" & "V")
# ==========================================

def safe_aggregate(joined_gdf, agg_method='size', value_col=None, col_dim=None):
    if joined_gdf.empty: return pd.DataFrame() if col_dim else pd.Series(name='value', dtype=float)
    agg_method = str(agg_method).lower()
    
    # ==== 二维透视逻辑 ====
    if col_dim and col_dim in joined_gdf.columns:
        if agg_method in ['size', 'count']: return joined_gdf.groupby([joined_gdf.index, col_dim]).size().unstack(fill_value=0)
        joined_gdf[value_col] = pd.to_numeric(joined_gdf[value_col], errors='coerce')
        if agg_method == 'sum': return joined_gdf.groupby([joined_gdf.index, col_dim])[value_col].sum().unstack(fill_value=0)
        elif agg_method == 'mean': return joined_gdf.groupby([joined_gdf.index, col_dim])[value_col].mean().unstack(fill_value=0)
        return pd.DataFrame()
        
    # ==== 一维透视逻辑 (强制命名为 value，对接前端规范) ====
    else:
        grouped = joined_gdf.groupby(level=0)
        if agg_method in ['size', 'count']: return grouped.size().rename('value')
        if value_col:
            joined_gdf[value_col] = pd.to_numeric(joined_gdf[value_col], errors='coerce')
            if agg_method == 'sum': return grouped[value_col].sum().rename('value')
            if agg_method == 'mean': return grouped[value_col].mean().rename('value')
            if agg_method == 'max': return grouped[value_col].max().rename('value')
            if agg_method == 'min':  return grouped[value_col].min().rename('value')
        return grouped.size().rename('value')
`

// ==========================================
// [Phase 5] 绘图沙盒专属 SDK (Chart SDK)
// 包含所有制图相关的标准化辅助函数，统一暗黑科技主题 UI
// ==========================================
const CHART_SDK_INJECTION = `
import pandas as pd
import numpy as np
import json

# ==========================================
# 绘图标准化辅助模块 (Visualization Utilities)
# ==========================================

def apply_system_theme_plotly(fig, title=""):
    """
    【Plotly 统一样式算子】: 保证所有生成的 Plotly 图表符合系统极客深色 UI 规范。
    强行覆盖大模型可能生成的丑陋默认白底样式。
    """
    fig.update_layout(
        title=dict(text=title, font=dict(color='#22d3ee', size=16)),
        template="plotly_dark",
        paper_bgcolor='rgba(11, 17, 33, 0)',  # 完全透明，适配前端玻璃拟态
        plot_bgcolor='rgba(11, 17, 33, 0)',
        font=dict(color='#e5e7eb', family='sans-serif'),
        margin=dict(t=50, l=10, r=10, b=10),
        coloraxis_colorbar=dict(title=dict(font=dict(color='#9ca3af')), tickfont=dict(color='#9ca3af'))
    )
    return fig

def create_system_base_map(center_lat, center_lon, zoom=11):
    """
    【Folium 底图算子】: 统一生成极客风格的暗色态街道底图。
    """
    import folium
    # 使用 CartoDB dark_matter 作为默认赛博风底图
    m = folium.Map(location=[center_lat, center_lon], zoom_start=zoom, tiles='CartoDB dark_matter')
    return m

def safe_render_folium(m):
    """
    【Folium 渲染算子】: 安全提取 HTML 并注入响应式 CSS，确保地图充满前端 Iframe。
    """
    html_str = m.get_root().render()
    # 强制 iframe 内部地图 100% 充满容器，消除滚动条
    html_str = html_str.replace(
        '<style>html, body {width: 100%;height: 100%;margin: 0;padding: 0;}</style>', 
        '<style>html, body {width: 100vw;height: 100vh;margin: 0;padding: 0;overflow:hidden;}</style>'
    )
    return html_str
`;

// 简易空间索引
class SimpleGridIndex {
    private buckets: Map<string, any[]> = new Map();
    private cellSize: number;

    constructor(bbox: number[], resolution: number = 20) { // 稍微调大 resolution 提高精度
        const width = bbox[2] - bbox[0];
        const height = bbox[3] - bbox[1];
        this.cellSize = Math.max(width, height) / resolution;
    }

    insert(item: any) {
        const bbox = turf.bbox(item);
        const minX = Math.floor(bbox[0] / this.cellSize);
        const maxX = Math.floor(bbox[2] / this.cellSize);
        const minY = Math.floor(bbox[1] / this.cellSize);
        const maxY = Math.floor(bbox[3] / this.cellSize);

        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                const key = `${x},${y}`;
                if (!this.buckets.has(key)) this.buckets.set(key, []);
                this.buckets.get(key)!.push(item);
            }
        }
    }

    query(feature: any): any[] {
        const bbox = turf.bbox(feature);
        return this.queryByBbox(bbox);
    }

    //   [新增] 支持直接通过 bbox 查询，方便做邻域搜索
    queryByBbox(bbox: number[]): any[] {
        const candidates = new Set<any>();
        const minX = Math.floor(bbox[0] / this.cellSize);
        const maxX = Math.floor(bbox[2] / this.cellSize);
        const minY = Math.floor(bbox[1] / this.cellSize);
        const maxY = Math.floor(bbox[3] / this.cellSize);

        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                const key = `${x},${y}`;
                const items = this.buckets.get(key);
                if (items) items.forEach(item => candidates.add(item));
            }
        }
        return Array.from(candidates);
    }
}

function safeIntersect(poly1: any, poly2: any): any {
    try {
        // @ts-ignore
        let intersection = turf.intersect(poly1, poly2);
        if (!intersection) {
             // @ts-ignore
             intersection = turf.intersect(turf.featureCollection([poly1, poly2]));
        }
        return intersection;
    } catch (e) {
        try {
            // @ts-ignore
            return turf.intersect(turf.featureCollection([poly1, poly2]));
        } catch (e2) {
            return null;
        }
    }
}

export const pivotAnalysis = async (req: Request, res: Response) => {
    try {
        const { 
            fileId, 
            groupByRow,   // 行分组 (必填) e.g. "properties.District"
            groupByCol,   // 列分组 (选填) e.g. "properties.Year"
            valueField,   // 统计值 (必填) e.g. "properties.Rainfall"
            method        // "sum", "avg", "max", "min", "count"
        } = req.body;

        if (!fileId || !groupByRow) {
            return res.status(400).json({ message:'缺少参数' });
        }

        const pool = require('../config/db').default;
        
        let aggSql = '';
        const rField = groupByRow.replace('properties.', '');
        const cField = groupByCol ? groupByCol.replace('properties.', '') : null;

        if (method === 'count') {
            aggSql = `COUNT(*) as value`;
        } else {
            const vKey = valueField.replace('properties.', '');
            // null 处理：如果字段不存在需要怎么处理？PostgreSQL在聚合时会忽略null。
            const safeField = `(properties->>'${vKey}')::numeric`;
            switch (method) {
                case 'sum': aggSql = `SUM(${safeField}) as value`; break;
                case 'avg': aggSql = `AVG(${safeField}) as value`; break;
                case 'max': aggSql = `MAX(${safeField}) as value`; break;
                case 'min': aggSql = `MIN(${safeField}) as value`; break;
                case 'boxplot': 
                case 'ridgeline': 
                    // jsonb_agg 等同于 mongodb 的 $push (去除为null的元素)
                    aggSql = `jsonb_agg(${safeField}) as value`; 
                    break;
                default: aggSql = `SUM(${safeField}) as value`;
            }
        }

        let rawResults: any[] = [];
        if (!cField) {
            // 一维分组
            const sql = `
                SELECT 
                    properties->>'${rField}' as "_id",
                    ${aggSql}
                FROM spatial_features
                WHERE file_id = $1
                GROUP BY properties->>'${rField}'
                ORDER BY value DESC NULLS LAST
            `;
            const result = await pool.query(sql, [fileId]);
            rawResults = result.rows.map((r: any) => ({
                _id: r._id,
                value: method === 'boxplot' || method === 'ridgeline' 
                         ? (Array.isArray(r.value) ? r.value.filter((v: any) => v !== null) : [])
                         : Number(r.value)
            }));
        } else {
            // 二维透视
            if (method === 'boxplot' || method === 'ridgeline') {
                return res.status(400).json({ message: '二维模式不支持 raw array 聚合' });
            }
            
            const sql = `
                SELECT 
                    properties->>'${rField}' as "row",
                    properties->>'${cField}' as "col",
                    ${aggSql}
                FROM spatial_features
                WHERE file_id = $1
                GROUP BY properties->>'${rField}', properties->>'${cField}'
            `;
            const result = await pool.query(sql, [fileId]);
            rawResults = result.rows.map((r: any) => ({
                _id: { row: r.row, col: r.col },
                val: Number(r.value)
            }));
        }

        // 数据格式化（转成echarts格式）
        let finalData: any[] = [];
        let dynamicColumns: string[] = [];

        if (!cField) {
            // 一维格式化
            finalData = rawResults.map((item, idx) => ({
                key: idx,
                rowKey: (item._id === null || item._id === undefined || item._id === '') ? '未分类' : item._id,
                // 要是是boxplot和ridgeline，则返回数组
                value: (method === 'boxplot' || method === 'ridgeline')
                    ? item.value 
                    : (typeof item.value === 'number' ? parseFloat(item.value.toFixed(2)) : item.value)
            }));
            // 标记列类型
            if (method === 'boxplot') dynamicColumns = ['boxplot_raw'];
            else if (method === 'ridgeline') dynamicColumns = ['ridgeline_raw'];
            else dynamicColumns = ['value'];
        } else {
            // 二维格式化(Matrix转置)
            const map = new Map<string, any>();
            const colSet = new Set<string>();

            rawResults.forEach(item => {
                const rKey = (item._id.row === null || item._id.row === undefined || item._id.row === '') ? '未分类' : item._id.row;
                const cKey = String(item._id.col || '未分类'); // 列名必须是字符串
                const val = typeof item.val === 'number' ? parseFloat(item.val.toFixed(2)) : item.val;

                // 把所有列名自动去重，做表头
                colSet.add(cKey);

                // 行列交叉值的存储
                if (!map.has(rKey)) {
                    map.set(rKey, { key: rKey, rowKey: rKey });
                }
                const rowObj = map.get(rKey);
                rowObj[cKey] = val; // { rowKey: '南京', '2020': 100, '2021': 200 }
            });

            dynamicColumns = Array.from(colSet).sort(); // 列排序

            // 最终数据格式 [ { rowKey: '南京', '2020': 100, '2021': 200 }, { rowKey: '苏州', '2020': 150, '2021': 120 } ]
            finalData = Array.from(map.values());
        }

        res.json({
            success: true,
            data: finalData,
            columns: dynamicColumns,
            meta: { groupByRow, groupByCol, valueField, method }
        });

    } catch (error) {
        console.error('Pivot error:', error);
        res.status(500).json({ message: 'Analysis failed' });
    }
};

export const generateGrid = async (req: Request, res: Response): Promise<void> => {
    try {
        const { fileId, shape, size, method, targetField } = req.body;

        if (!fileId || !shape || !size) {
            res.status(400).json({ error: 'Missing required parameters' });
            return;
        }
        
        //   [配置] 定义缓冲区圈数 n (可在此处 ，或从前端传入)
        const BUFFER_RINGS = 2; // 显示周围 2 圈网格

        console.log(`[Grid] Generating ${shape} grid (${size}km) for file ${fileId}`);
        
        const rawFeatures = await Feature.findFeaturesByFileId(fileId);
        if (!rawFeatures || rawFeatures.length === 0) {
                res.status(404).json({ error: 'No features found' });
                return;
        }

        const features = rawFeatures.map((f: any) => turf.feature(f.geometry, f.properties));
        
        //   [新增] 预判数据类型，用于覆盖率计算
        const firstGeom = features[0]?.geometry.type;
        const isPolygonLayer = firstGeom?.includes('Polygon');
        const isLineLayer = firstGeom?.includes('Line');
        
        const featureCollection = turf.featureCollection(features);
        const bbox = turf.bbox(featureCollection);
        
        // 2. 生成网格
        const options: any = { units: 'kilometers' };
        let grid: any;
        try {
            if (shape === 'hex') {
                grid = turf.hexGrid(bbox, size, options);
            } else {
                grid = turf.squareGrid(bbox, size, options);
            }
        } catch (e) {
            res.status(500).json({ error: 'Grid generation error' });
            return;
        }

        // 初始化属性，并给每个网格打上唯一 ID 方便索引
        grid.features.forEach((cell: any, index: number) => {
            cell.properties = { 
                value: 0, 
                count: 0,
                _id: index // 内部临时 ID
            };
        });

        // 3. 建立索引
        const gridIndex = new SimpleGridIndex(bbox, 25);
        grid.features.forEach((cell: any) => gridIndex.insert(cell));

        // 4. 聚合计算
        // 记录所有“活跃”网格的 ID (即与数据相交的网格)
        const activeCellIds = new Set<number>();

        let processedCount = 0;
        let intersectCount = 0;

        features.forEach((feature: any) => {
            const geometryType = feature.geometry.type;
            let rawValue = 1;
            
            //   [ ] 确定 rawValue (根据模式)
            if (method === 'coverage') {
                // 覆盖率模式：计算几何体自身的绝对量（面积或长度）
                if (isPolygonLayer) {
                    // 面：使用平方米
                    rawValue = turf.area(feature); 
                } else if (isLineLayer) {
                    // 线：使用千米
                    rawValue = turf.length(feature, { units: 'kilometers' });
                } else {
                    // 点数据不支持覆盖率，忽略
                    return; 
                }
            } else if (method !== 'count' && targetField) {
                // 属性聚合模式
                const val = Number(feature.properties[targetField]);
                if (isNaN(val)) return;
                rawValue = val;
            }
            // 计数模式 rawValue 默认为 1

            const candidateCells = gridIndex.query(feature);
            
            candidateCells.forEach((cell: any) => {
                let ratio = 0;
                try {
                    // A. 点数据
                    if (geometryType === 'Point') {
                        if (turf.booleanPointInPolygon(feature, cell)) ratio = 1;
                    } 
                    // B. 线数据
                    else if (geometryType === 'LineString' || geometryType === 'MultiLineString') {
                        if (!turf.booleanIntersects(cell, feature)) return;
                        const totalLen = turf.length(feature);
                        if (totalLen === 0) return;

                        if (turf.booleanContains(cell, feature)) {
                            ratio = 1;
                        } else {
                            const cellBoundary = turf.polygonToLine(cell);
                            // @ts-ignore
                            const splitLines = turf.lineSplit(feature, cellBoundary);
                            let insideLen = 0;
                            splitLines.features.forEach((seg: any) => {
                                const len = turf.length(seg);
                                if (len > 0) {
                                    const mid = turf.along(seg, len / 2);
                                    if (turf.booleanPointInPolygon(mid, cell)) insideLen += len;
                                }
                            });
                            if (splitLines.features.length === 0) {
                                    const mid = turf.along(feature, totalLen / 2);
                                    if (turf.booleanPointInPolygon(mid, cell)) ratio = 1;
                            } else {
                                    ratio = insideLen / totalLen;
                            }
                        }
                    } 
                    // C. 面数据
                    else if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') {
                        if (!turf.booleanIntersects(cell, feature)) return;
                        if (turf.booleanContains(cell, feature)) {
                            ratio = 1; 
                        } else if (turf.booleanContains(feature, cell)) {
                            const cellArea = turf.area(cell);
                            const featArea = turf.area(feature);
                            if (featArea > 0) ratio = cellArea / featArea;
                        } else {
                            const intersection = safeIntersect(cell, feature);
                            if (intersection) {
                                const totalArea = turf.area(feature);
                                const partArea = turf.area(intersection);
                                if (totalArea > 0) ratio = partArea / totalArea;
                            }
                        }
                    }

                    if (ratio > 0) {
                        cell.properties.value += rawValue * ratio;
                        cell.properties.count += 1;
                        intersectCount++;
                        //   [标记] 该网格是活跃的
                        activeCellIds.add(cell.properties._id);
                    }
                } catch (err) {}
            });
            processedCount++;
        });

        console.log(`[Grid] Processed ${processedCount} features. Active cells: ${activeCellIds.size}`);

        //   [新增] 覆盖率模式的后处理：除以网格面积
        if (method === 'coverage') {
            grid.features.forEach((cell: any) => {
                if (activeCellIds.has(cell.properties._id)) {
                    const cellAreaSqM = turf.area(cell); // 网格面积 (m²)
                    
                    if (isPolygonLayer) {
                        // 面覆盖率 = (网格内建筑总面积 m²) / (网格面积 m²)
                        // 结果范围 0.0 - 1.0
                        cell.properties.value = cell.properties.value / cellAreaSqM;
                        // 修正可能的浮点误差，最大不超过 1
                        if (cell.properties.value > 1) cell.properties.value = 1;
                    } else if (isLineLayer) {
                        // 线密度 = (网格内道路总长 km) / (网格面积 km²)
                        // 结果单位：km/km²
                        const cellAreaSqKm = cellAreaSqM / 1_000_000;
                        if (cellAreaSqKm > 0) {
                            cell.properties.value = cell.properties.value / cellAreaSqKm;
                        }
                    }
                }
            });
        }

        // 5. 修约数值
        grid.features.forEach((cell: any) => {
            // 覆盖率通常保留更多小数位
            const decimals = method === 'coverage' ? 4 : 2;
            cell.properties.value = Number(cell.properties.value.toFixed(decimals));
        });

        //   [新增] 缓冲区过滤逻辑
        // 无论点、线、面，都执行这个通用的视觉优化
        if (activeCellIds.size > 0) {
            const cellsToKeep = new Set<number>(activeCellIds);
            
            // 将所有活跃网格对象找出来
            const activeCells = grid.features.filter((f: any) => activeCellIds.has(f.properties._id));
            
            // 计算缓冲区半径 (km)
            // 假设 size 是半径或边长，我们向外扩展 n * size * 2 (确保覆盖够宽)
            // 这里用一个近似值：size * 1.5 * n
            const bufferDist = size * 1.5 * BUFFER_RINGS;

            // 对每个活跃网格，寻找其周边的邻居
            activeCells.forEach((cell: any) => {
                const cellBbox = turf.bbox(cell);
                // 扩大 BBox
                const expandedBbox = [
                    cellBbox[0] - 0.02 * size * BUFFER_RINGS, // 经度简易换算
                    cellBbox[1] - 0.02 * size * BUFFER_RINGS, // 纬度简易换算
                    cellBbox[2] + 0.02 * size * BUFFER_RINGS,
                    cellBbox[3] + 0.02 * size * BUFFER_RINGS
                ];
                
                // 利用 turf.buffer 更精确 (但这比较慢)，或者直接用 GridIndex 查邻居 (极快)
                // 这里我们用 GridIndex + 几何中心距离判断
                const center = turf.centroid(cell);
                // 搜索范围略大于缓冲区
                const neighbors = gridIndex.queryByBbox(expandedBbox);
                
                neighbors.forEach((neighbor: any) => {
                    if (cellsToKeep.has(neighbor.properties._id)) return;
                    
                    // 计算距离，判断是否在 n 圈内
                    const dist = turf.distance(center, turf.centroid(neighbor), { units: 'kilometers' });
                    // 两个相邻六边形中心距离约为 size * 1.732
                    // n 圈大约是 n * 2 * size
                    if (dist <= size * 2.0 * BUFFER_RINGS) {
                        cellsToKeep.add(neighbor.properties._id);
                    }
                });
            });

            console.log(`[Grid Filter] Buffer expansion (${BUFFER_RINGS} rings): ${activeCellIds.size} -> ${cellsToKeep.size} cells`);
            
            // 执行过滤
            grid.features = grid.features.filter((f: any) => cellsToKeep.has(f.properties._id));
        } else {
            // 如果没有任何相交，返回空
            grid.features = [];
        }

        // 清理临时 ID
        grid.features.forEach((f: any) => delete f.properties._id);

        res.json({ success: true, data: grid });

    } catch (error) {
        console.error('Grid generation failed:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// 辅助函数：确保 Key 生成逻辑在“初始化阶段”和“聚合阶段”完全一致
const getSafeKey = (field: string, val: any) => {
    const strVal = String(val); // 强制转字符串
    const safeVal = strVal.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_');
    return `${field}_${safeVal}`;
};

export const exportGrid = async (req: Request, res: Response): Promise<void> => {
    try {
        const { fileId, shape, size, method, categoryFields } = req.body;

        if (!fileId || !shape || !size) {
            res.status(400).json({ error: 'Missing required parameters' });
            return;
        }

        const selectedCategories: string[] = Array.isArray(categoryFields) 
            ? categoryFields 
            : (categoryFields ? [categoryFields] : []);

        console.log(`[Export] Exporting ${shape} grid (${size}km) for file ${fileId}. Method: ${method}`);

        const getSafeKey = (field: string, val: any) => {
            const strVal = String(val);
            const safeVal = strVal.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_');
            return `${field}_${safeVal}`;
        };

        // 1. 获取原始数据
        const rawFeatures = await Feature.findFeaturesByFileId(fileId);
        if (!rawFeatures || rawFeatures.length === 0) {
                res.status(404).json({ error: 'No features found' });
                return;
        }

        //   [Fix: 移动定义到这里] 统一在最前面将原始数据转为 Turf Feature，供后续所有步骤使用
        const features = rawFeatures.map((f: any) => turf.feature(f.geometry, f.properties));
        
        //   [新增] 预判数据类型 (用于覆盖率计算)
        const firstGeom = features[0]?.geometry.type;
        const isPolygonLayer = firstGeom?.includes('Polygon');
        const isLineLayer = firstGeom?.includes('Line');

        // 2. 识别字段 & 收集分类值
        const numericFields = new Set<string>();
        const categoryValueMap = new Map<string, Set<string>>();

        selectedCategories.forEach(field => categoryValueMap.set(field, new Set()));

        rawFeatures.forEach((f: any) => {
            if (f.properties) {
                Object.keys(f.properties).forEach(key => {
                    if (typeof f.properties[key] === 'number') {
                        numericFields.add(key);
                    }
                });
                selectedCategories.forEach(field => {
                    const val = f.properties[field];
                    if (val !== undefined && val !== null) {
                        categoryValueMap.get(field)?.add(String(val));
                    }
                });
            }
        });

        const fieldsToAggregate = Array.from(numericFields);
        const allCategoryColumns: string[] = [];
        categoryValueMap.forEach((values, field) => {
            Array.from(values).sort().forEach(val => {
                allCategoryColumns.push(getSafeKey(field, val));
            });
        });

        // 3. 准备网格
        // ❌ [删除] 原来的 const features = ... 删掉，防止重复声明错误
        const featureCollection = turf.featureCollection(features);
        const bbox = turf.bbox(featureCollection);
        
        const options: any = { units: 'kilometers' };
        let grid: any;
        try {
            if (shape === 'hex') {
                grid = turf.hexGrid(bbox, size, options);
            } else {
                grid = turf.squareGrid(bbox, size, options);
            }
        } catch (e) {
            res.status(500).json({ error: 'Grid generation error' });
            return;
        }

        // 初始化网格属性
        grid.features.forEach((cell: any) => {
            const props: any = { 
                count: 0, 
                value: 0, //   [新增] 显式初始化 value 字段
                _weight: 0 
            };
            
            // A. 常规数值
            fieldsToAggregate.forEach(field => {
                props[field] = (method === 'max' || method === 'min') 
                    ? (method === 'max' ? -Infinity : Infinity) 
                    : 0;
            });

            // B. 分类列
            allCategoryColumns.forEach(key => {
                props[key] = 0;
            });

            cell.properties = props;
        });

        // 4. 建立索引 & 聚合
        const gridIndex = new SimpleGridIndex(bbox, 25);
        grid.features.forEach((cell: any) => gridIndex.insert(cell));

        features.forEach((feature: any) => {
            const geometryType = feature.geometry.type;
            const candidateCells = gridIndex.query(feature);

            //   [新增] 计算 rawValue ( 指标)
            let rawValue = 1; // 默认为计数 (count)
            if (method === 'coverage') {
                if (isPolygonLayer) {
                    rawValue = turf.area(feature); // m²
                } else if (isLineLayer) {
                    rawValue = turf.length(feature, { units: 'kilometers' }); // km
                }
            } else if (method !== 'count' && method !== 'coverage') {
                 // 其他模式下 value 默认记为 1 (类似 count)，主要看具体属性字段
                 rawValue = 1; 
            }

            const activeCategoryKeys: string[] = [];
            selectedCategories.forEach(field => {
                const rawCat = feature.properties[field];
                if (rawCat !== undefined && rawCat !== null) {
                    activeCategoryKeys.push(getSafeKey(field, rawCat));
                }
            });

            candidateCells.forEach((cell: any) => {
                let ratio = 0;
                try {
                    // --- 几何计算 ---
                    if (geometryType === 'Point') {
                        if (turf.booleanPointInPolygon(feature, cell)) ratio = 1;
                    } 
                    else if (geometryType.includes('Line')) {
                        if (turf.booleanIntersects(cell, feature)) {
                            // 简化处理，若需要更高精度可换回 lineSplit
                            if (turf.booleanContains(cell, feature)) ratio = 1;
                            else ratio = 0.5; 
                        }
                    }
                    else if (geometryType.includes('Polygon')) {
                        if (turf.booleanIntersects(cell, feature)) {
                            const intersect = safeIntersect(cell, feature);
                            if (intersect) ratio = turf.area(intersect) / turf.area(feature);
                        }
                    }
                    // ------------------------------

                    if (ratio > 0) {
                        cell.properties.count += 1;
                        cell.properties._weight += ratio;
                        
                        //   [新增] 累加  Value
                        // Count模式: 1 * ratio
                        // Coverage模式: Area * ratio (即网格内的实际面积)
                        cell.properties.value += rawValue * ratio;

                        // 1. 常规聚合
                        if (method !== 'count' && method !== 'coverage') {
                            fieldsToAggregate.forEach(field => {
                                const val = Number(feature.properties[field]);
                                if (!isNaN(val)) {
                                    if (method === 'sum' || method === 'avg') cell.properties[field] += val * ratio;
                                    else if (method === 'max') cell.properties[field] = Math.max(cell.properties[field], val);
                                    else if (method === 'min') cell.properties[field] = Math.min(cell.properties[field], val);
                                }
                            });
                        }

                        // 2. 多分类拆分聚合
                        activeCategoryKeys.forEach(key => {
                            if (typeof cell.properties[key] === 'undefined') cell.properties[key] = 0;
                            cell.properties[key] += ratio;
                        });
                    }
                } catch (e) {}
            });
        });

        // 5. 后处理
        const resultFeatures = grid.features.filter((f: any) => f.properties.count > 0);
        
        resultFeatures.forEach((cell: any) => {
            //   [新增] 覆盖率模式归一化处理
            if (method === 'coverage') {
                const cellAreaSqM = turf.area(cell);
                
                if (isPolygonLayer) {
                    // 面覆盖率 = 网格内总面积 / 网格面积
                    cell.properties.value = cell.properties.value / cellAreaSqM;
                    if (cell.properties.value > 1) cell.properties.value = 1;
                } else if (isLineLayer) {
                    // 线密度 = 网格内总长度(km) / 网格面积(km²)
                    const cellAreaSqKm = cellAreaSqM / 1_000_000;
                    if (cellAreaSqKm > 0) {
                        cell.properties.value = cell.properties.value / cellAreaSqKm;
                    }
                }
                cell.properties.value = Number(cell.properties.value.toFixed(4));
            } else {
                // 其他模式保留两位小数
                cell.properties.value = Number(cell.properties.value.toFixed(2));
            }

            // 常规字段修约
            fieldsToAggregate.forEach(field => {
                if (method === 'avg' && cell.properties._weight > 0) {
                    cell.properties[field] = Number((cell.properties[field] / cell.properties._weight).toFixed(2));
                } else if (method !== 'count' && method !== 'coverage') {
                    if (cell.properties[field] !== Infinity && cell.properties[field] !== -Infinity) {
                            cell.properties[field] = Number(cell.properties[field].toFixed(2));
                    } else {
                            cell.properties[field] = 0;
                    }
                }
            });
            
            // 分类字段修约
            allCategoryColumns.forEach(key => {
                if (typeof cell.properties[key] !== 'undefined') {
                    cell.properties[key] = Number(cell.properties[key].toFixed(3));
                }
            });
            
            delete cell.properties._weight;
        });

        const finalGeoJSON = turf.featureCollection(resultFeatures);
        const fileName = `grid_export_${fileId}_${method}_${Date.now()}.geojson`;
        res.setHeader('Content-Type', 'application/geo+json');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.send(JSON.stringify(finalGeoJSON));

    } catch (error) {
        console.error('Export failed:', error);
        res.status(500).json({ error: 'Export failed' });
    }
}

// 获取所有已注册的活跃模型
export const getRegisteredModels = async (req: Request, res: Response) => {
  try {
    const allModels = await ModelRegistry.getAllModels();
    // 过滤 active 状态并在返回时展平 JSONB
    const models = allModels
        .filter(m => m.parameters_schema?.status !== 'inactive')
        .map(m => ({
            modelName: m.model_name,
            displayName: m.parameters_schema?.displayName || m.model_name,
            description: m.description,
            parameters: m.parameters_schema?.parameters || [],
            status: m.parameters_schema?.status || 'active'
        }));
    res.json({ code: 200, data: models });
  } catch (error) {
    console.error("获取模型列表失败:", error);
    res.status(500).json({ error: '获取模型列表失败' });
  }
};

// ==========================================
// LLM 智能体代理注册接口 (API 机械臂)
// ==========================================
export const registerModelByAI = async (req: Request, res: Response) => {
  try {
    // 接收 LLM 生成的模型名称、描述、参数规范，以及最关键的：Python 源代码字符串
    const { modelName, displayName, description, parameters, pythonCode } = req.body;

    if (!pythonCode) {
      return res.status(400).json({ error: '智能体未能提供有效的 Python 代码' });
    }

    // 步骤 A：物理隔离写入（绝对不碰 main.py，只向 models 文件夹注入“零件”）
    // 解析出 python_engine/models 的绝对路径 (根据你的目录结构可能需要微调 ../ 的数量)
    const modelsDir = path.join(process.cwd(), '../python_engine/models');
    
    // 确保 models 文件夹存在
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true });
    }

    // 将 AI 写的代码保存为 .py 文件（例如 lsi_ahp.py）
    const fileName = `${modelName.toLowerCase()}.py`;
    const filePath = path.join(modelsDir, fileName);
    fs.writeFileSync(filePath, pythonCode, 'utf8');

    // 步骤 B：元数据落库（记录在案，供前端动态读取公式列表）
    const newModelData = {
      model_name: modelName.toUpperCase(),
      description: description,
      parameters_schema: {
        displayName,
        parameters,
        status: 'active'
      }
    };
    const newModel = await ModelRegistry.registerOrUpdateModel(newModelData);

    res.json({ 
      code: 200, 
      message: `智能体已成功将模型 ${modelName} 注入系统并注册完毕！`, 
      data: newModel 
    });
  } catch (error: any) {
    res.status(500).json({ error: '模型代理注册失败: ' + error.message });
  }
};

// ==========================================
// 2.  模型函数计算 (高速调度网关 BFF)
// ==========================================
export const executeTableFormula = async (req: Request, res: Response) => {
  try {
    const { fileId, modelName, rawArgs } = req.body;
    
    // 兼容老代码接口
    let reqColumns: string[] = req.body.columns || [];
    let reqParams: Record<string, any> = req.body.params || {};

    let modelDefRaw = await ModelRegistry.findModelByName(modelName.toUpperCase());
    let modelDef: any;
    if (!modelDefRaw) {
        console.warn(`[BFF 警告] DB 未找到模型元数据: ${modelName}，将尝试直接穿透调度到底层引擎...`);
        // 构造一个虚拟的 modelDef，防止后面映射参数时报错
        modelDef = { parameters: [] } as any; 
    } else {
        modelDef = {
            parameters: modelDefRaw.parameters_schema?.parameters || [],
            requiredColumns: modelDefRaw.parameters_schema?.requiredColumns || []
        };
    }

    //    ：动态参数分类与路由 (保持原有优秀逻辑)
    if (rawArgs && Array.isArray(rawArgs)) {
        reqColumns = [];
        reqParams = {};
        
        rawArgs.forEach((arg: string, index: number) => {
            const numVal = Number(arg);
            const paramName = modelDef?.parameters?.[index]?.name || `param_${index}`;

            if (!isNaN(numVal) && arg.trim() !== '') {
                reqParams[paramName] = numVal;
            } else if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
                reqParams[paramName] = arg.slice(1, -1);
            } else {
                reqColumns.push(arg);
                reqParams[paramName] = arg;       //   2. 【新增这一行】：绑定参数键值对！
            }
        });
    }

    console.log(`[BFF调度层] 向底层空间引擎下发计算指令... 文件: ${fileId}, 模型: ${modelName}`);

    // ==========================================
    //   终极瘦身：彻底斩断 Node.js 的数据搬运！
    // ==========================================

    //   新增：合并前端传来的列（reqColumns）与模型注册时 AI 提取的必填列（requiredColumns）
    // 用 Set 去重，防止同一个列名传两遍
    const finalColumns = Array.from(new Set([
        ...reqColumns, 
        ...(modelDef?.requiredColumns || []) // 👈 从 MongoDB 里读出 AI 存下的列名
    ]));

    // 发送给 Python
    const response = await axios.post<PythonApiResponse>(`${PYTHON_API_URL}/models/execute`, {
      model_name: modelName,
      file_id: fileId,         
      columns: finalColumns,   //   将合并后的终极列名数组发给 Python 引擎
      parameters: reqParams    
    });

    // ==========================================
    //   接收轻量级结果与协同渲染
    // ==========================================
    // 此时 Python 已经在底层完成了“拉取 -> 计算 -> MongoDB 回写”的闭环！
    // Node.js 只需要拿到轻量级的绘图数据返回给前端即可。
    const { result_col_names, result_data, execution_time_ms } = response.data;

    console.log(`[BFF调度层] 底层引擎计算并落盘完毕，新增 ${result_col_names.length} 列，总耗时 ${execution_time_ms.toFixed(2)}ms`);

    // 直接返回给前端更新 UI
    res.json({ 
        code: 200, 
        resultColName: result_col_names, 
        resultData: result_data 
    });

  } catch (error: any) {
    console.error("模型执行错误:", error.response?.data || error.message);
    res.status(500).json({ error: '模型执行异常', details: error.response?.data?.detail || error.message });
  }
};


// 模型智能生成与元数据提取
export const createModelViaNaturalLanguage = async (req: Request, res: Response) => {
    try {
        const { userDescription } = req.body;

        if (!userDescription) {
            return res.status(400).json({ error: "需求描述不能为空" });
        }

        console.log(`[GeoAI Agent] 收到用户指令: ${userDescription}`);
        console.log(`[GeoAI Agent] 正在思考并提取模型特征...`);

        // 1. 唤醒大模型，返回结构化的 JSON 数据（包含名字、描述、参数、代码）
        const aiResult = await generateModelCodeFromAI(userDescription);
        
        //   关键 ：在这里解构出 parameters
        const { modelName, displayName, description, parameters, requiredColumns, pythonCode } = aiResult;

        console.log(`[GeoAI Agent] 思考完成！模型名: ${modelName}，提取到 ${parameters?.length || 0} 个参数。准备注入系统。`);

        // 2. 物理隔离写入 (存入 python_engine/models)
        const modelsDir = path.join(process.cwd(), '../python_engine/models');
        if (!fs.existsSync(modelsDir)) {
            fs.mkdirSync(modelsDir, { recursive: true });
        }
        
        const fileName = `${modelName.toLowerCase()}.py`;
        const filePath = path.join(modelsDir, fileName);
        fs.writeFileSync(filePath, pythonCode, 'utf8');

        const newModelData = {
            model_name: modelName.toUpperCase(),
            description: description,
            parameters_schema: {
                displayName,
                parameters: parameters || [],
                requiredColumns: requiredColumns || [],
                status: 'active'
            }
        };
        const newModel = await ModelRegistry.registerOrUpdateModel(newModelData);

        res.json({ 
            code: 200, 
            message: `🎉 成功！GeoAI 为您构建了 ${displayName} (${modelName})。`, 
            data: newModel,
            previewCode: pythonCode 
        });

    } catch (error: any) {
        console.error("大模型 Agent 执行失败:", error);
        res.status(500).json({ error: error.message || '系统内部异常' });
    }
};


// 数据透视API期望的返回类型
interface PivotApiResponse {
    status: string;
    data: any[]; // 一个包含字典的数组
}

// 绘图API期望的返回类型
interface ChartApiResponse {
    status: string;
    engine?: 'echarts' | 'html_iframe';
    html_string?: string;
    chart_option?: any;
}

// ==========================================
// 沙盒重跑：用户编辑代码后跳过 LLM 直接执行
// ==========================================
export const rerunPivotCode = async (req: Request, res: Response): Promise<void> => {
    try {
        const { pythonCode, fileIds, blueprint } = req.body;

        if (!pythonCode || !fileIds || fileIds.length === 0) {
            res.status(400).json({ error: "缺少 pythonCode 或 fileIds" });
            return;
        }

        console.log(`\n[Rerun] 收到用户手动修改后的代码，文件数: ${fileIds.length}，跳过 LLM 直接执行...`);

        // 直接调用 Python 执行透视（沙盒重跑）
        const pivotResponse = await axios.post<PivotApiResponse>(`${PYTHON_API_URL}/models/pivot_only`, {
            python_code: pythonCode,
            file_ids: fileIds
        });

        const aggregatedData = pivotResponse.data.data;
        if (!aggregatedData || aggregatedData.length === 0) {
            throw new Error("透视结果为空，请检查代码逻辑或数据是否匹配");
        }
        console.log(`[Rerun] 透视成功！共 ${aggregatedData.length} 条记录，正在生成图表...`);

        // 如果传入了 blueprint，继续走绘图流程；否则只返回数据
        let engine: string | undefined;
        let html_string: string | undefined;
        let chart_option: any;

        if (blueprint) {
            const chartCode = await generateChartCode(blueprint, aggregatedData.slice(0, 3));
            const chartResponse = await axios.post<ChartApiResponse>(`${PYTHON_API_URL}/models/chart_only`, {
                python_code: chartCode,
                data: aggregatedData
            });
            engine = chartResponse.data.engine;
            html_string = chartResponse.data.html_string;
            chart_option = chartResponse.data.chart_option;
            console.log(`[Rerun] 图表渲染完成，引擎: ${engine}`);
        }

        res.json({
            code: 200,
            tableData: aggregatedData,
            engine,
            chartHtml: html_string,
            chartOption: chart_option,
            pythonCode // 回穿修改后的代码
        });

    } catch (error: any) {
        const details = error.response?.data?.detail || error.response?.data?.details || error.message;
        console.error("[Rerun错误]", details);
        res.status(500).json({ error: '重跑失败', details });
    }
};

// 多节点进行可扩展的透视和绘图
export const executeDynamicPipeline = async (req: Request, res: Response): Promise<void> => {
    // ⚠️ 关键：将 blueprint / pivotCode 提升到 try/catch 之外，使 catch 块可以访问
    let blueprint: any = null;
    let pivotCode: string = "";

    try {
        const { userPrompt, fileIds, context } = req.body;

        if (!userPrompt || !fileIds || fileIds.length === 0) {
            res.status(400).json({ error: "缺少用户需求或未选择任何文件" });
            return;
        }

        console.log(`\n======================================================`);
        console.log(`[Pipeline] 分析文件数: ${fileIds.length}`);
        console.log(`[Pipeline] 用户意图: "${userPrompt}"`);

        // 提取工作区文件元数据 (给 Planner 当上下文)
        const availableFiles = [];
        for (const fId of fileIds) {
            const schema = await Feature.getFileSchemaSummary(fId);
            availableFiles.push(schema);
        }

        // 1 意图拆解节点
        console.log(`[Pipeline] 节点1正在拆解意图...`);
        blueprint = await planWorkflow(userPrompt, availableFiles, context);
        console.log(`[Pipeline] 拆解意图完成:`, blueprint.explanation);

        // 2 数据透视代码生成节点 / 或复用历史代码
        let rawPivotCode = "";
        let pivotCode = "";
        if (blueprint.reuse_code && context?.lastPythonCode) {
            console.log(`[Pipeline] 检测到意图为图表切换/追问，直接复用上一轮数据抽取代码。`);
            rawPivotCode = context.lastPythonCode;
            pivotCode = PYTHON_SDK_INJECTION + "\n\n" + rawPivotCode;
        } else {
            console.log(`[Pipeline] 节点2正在编写透视代码...`);
            rawPivotCode = await generatePivotCode(blueprint);
            pivotCode = PYTHON_SDK_INJECTION + "\n\n" + rawPivotCode;
        }

        // 3 Python执行透视 (带自愈修复环)
        let aggregatedData: any = null;
        let lastErrorDetails = "";
        const MAX_RETRIES = 2;
        let retries = 0;

        console.log(`\n======================python代码================================`);
        console.log(pivotCode);
        console.log(`\n======================python代码================================`);

        while (retries <= MAX_RETRIES) {
            try {
                console.log(`[Pipeline] 节点3正在执行空间透视... (尝试 ${retries + 1}/${MAX_RETRIES + 1})`);
                const pivotResponse = await axios.post<any>(`${PYTHON_API_URL}/models/pivot_only`, {
                    python_code: pivotCode, // 发送带 SDK 的完整代码
                    file_ids: fileIds
                });
                
                aggregatedData = pivotResponse.data.data; 
                if (!aggregatedData || aggregatedData.length === 0) {
                    throw new Error("透视结果为空，请检查需求或数据是否匹配");
                }
                console.log(`[Pipeline] 透视计算成功，共有 ${aggregatedData.length} 条统计记录`);
                break; 
            } catch (err: any) {
                lastErrorDetails = err.response?.data?.detail || err.message;
                console.error(`\n[Pipeline 容错捕捉] 沙盒执行引发异常: ${lastErrorDetails}`);

                if (retries >= MAX_RETRIES) break;
                
                retries++;
                console.log(`[Pipeline] 节点发觉错误，启动自愈修复环 (第 ${retries} 次重试)...`);
                try {
                    // 核心修复：只把业务代码给 AI 修，修完后再次拼上 SDK！
                    rawPivotCode = await fixPivotCode(blueprint, rawPivotCode, lastErrorDetails);
                    pivotCode = PYTHON_SDK_INJECTION + "\n\n" + rawPivotCode;
                    console.log(`[Pipeline] FixerAgent 自愈重写完成，准备再次向沙盒投入代码...`);
                } catch (fixErr) { break; }
            }
        }
        


        // 终局判定：如果重试已耗尽且依旧没有数据，走优雅降级方案，提前返回 200 让前端处理重入
        if (!aggregatedData) {
            console.log(`======================================================\n`);
            res.status(200).json({
                status: "failed",
                error_message: "AI 多次尝试修复代码失败，已切换至人工接管模式。",
                traceback: lastErrorDetails,
                pythonCode: pivotCode // 携带最后挣扎生成的代码
            });
            return;
        }

        // 4 绘图代码/元数据生成节点
        console.log(`[Pipeline] 节点4正在构建图表配置/代码...`);
        let chartCodeOrMetadata = "";

        // 5 渲染流分发：这是 Phase 5 的灵魂！
        let chartResponseData: any = null;
        let chartErrorDetails = "";

        if (blueprint.visualization_spec.engine === 'echarts') {
            console.log(`[Pipeline] 命中 ECharts 路由，【跳过】绘图代码生成，直接触发前端 TS 引擎接管渲染...`);
            try {
                // 提取大模型建议的图表类型（默认 bar）
                const aiChartType = blueprint.visualization_spec.chart_type?.toLowerCase() || 'bar';
                
                chartResponseData = {
                    engine: 'echarts',
                    ai_chart_type: aiChartType, // 将图表类型传给前端！
                    chart_option: null,         // 绝对不传配置，强制前端使用原生组件！
                    html_string: ""
                };
                console.log(`[Pipeline] TS 模板引擎渲染 ECharts 成功！`);
            } catch (err: any) {
                console.error("[Pipeline] ECharts 元数据解析失败，可能是 AI 输出了非 JSON 格式:", err.message);
                chartErrorDetails = "AI 未能生成正确的图表配置元数据 (JSON 解析失败)。";
            }
        } 
        else {
            // 原有的 html_iframe 复杂渲染流，依然走 Python 沙盒
            console.log(`[Pipeline] 命中 html_iframe 路由，进入 Node 4 呼叫 AI 编写 Plotly/Folium 制图代码...`);
            // 只有走 Python 制图时，才消耗 Token 去生成代码
            chartCodeOrMetadata = await generateChartCode(blueprint, aggregatedData.slice(0, 5));
            // 在这里把绘图专属 SDK 拼接上去！
            const finalChartCode = CHART_SDK_INJECTION + "\n\n" + chartCodeOrMetadata;

            const MAX_RETRIES = 2;
            let chartRetries = 0;

            while (chartRetries <= MAX_RETRIES) {
                try {
                    const chartResponse = await axios.post(`${PYTHON_API_URL}/models/chart_only`, {
                        python_code: finalChartCode,
                        data: aggregatedData
                    });
                    chartResponseData = chartResponse.data;
                    console.log(`[Pipeline] 图表渲染成功，渲染引擎: ${chartResponseData.engine}。`);
                    break;
                } catch (err: any) {
                    chartErrorDetails = err.response?.data?.detail || err.response?.data?.details || err.message;
                    chartRetries++;
                    if (chartRetries > MAX_RETRIES) break;
                    
                    try {
                        console.log(`[Pipeline] 呼叫 FixerAgent 进行图表代码自愈 (第 ${chartRetries} 次重试)...`);
                        chartCodeOrMetadata = await fixChartCode(blueprint, chartCodeOrMetadata, chartErrorDetails);
                    } catch (fixErr) { break; }
                }
            }
        }

        // 终局判定
        if (!chartResponseData) {
            console.log(`======================================================\n`);
            res.status(200).json({
                status: "failed",
                error_message: "图表渲染模块崩溃，已降级至人工接管模式。",
                traceback: chartErrorDetails,
                pythonCode: chartCodeOrMetadata
            });
            return;
        }

        // 解构并返回给前端
        const { engine, html_string, chart_option } = chartResponseData;
        console.log(`[Pipeline] 全部执行成功，最终渲染引擎: ${engine}。`);
        console.log(`======================================================\n`);

        res.json({
            code: 200,
            blueprint: blueprint,
            tableData: aggregatedData,
            engine: engine,
            aiChartType: chartResponseData?.ai_chart_type,
            chartHtml: html_string,
            chartOption: chart_option,
            pythonCode: pivotCode // 依然返回 pivot 代码供用户检查修改
        });

    } catch (error: any) {
        // 提取执行上下文，方便前端展示错误原因及出错的代码
        const details = error.response?.data?.detail || error.response?.data?.details || error.message;
        console.error("\n[Pipeline错误]", details);
        
        res.status(500).json({ 
            error: '执行失败', 
            details: details,
            // blueprint / pivotCode 已提升到外层作用域，可直接安全访问
            blueprint: blueprint,
            pythonCode: pivotCode || null
        });
    }
};