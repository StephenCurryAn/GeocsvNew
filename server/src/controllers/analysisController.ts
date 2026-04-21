import { Request, Response } from 'express';
import * as Feature from '../models/Feature';
import * as ModelRegistry from '../models/ModelRegistry';
import { generateModelCodeFromAI, planWorkflow, generatePivotCode, 
        generateChartCode, fixPivotCode, fixChartCode,
        generateFeatureCalcCode, fixFeatureCalcCode,
        generateProModelCode, fixProModelCode
         /* ... */  } from '../utils/llmService';
import * as turf from '@turf/turf';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import * as FileNode from '../models/FileNode'; // 用于写库

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

// 2. 注入特征计算专属的 Python SDK 字符串
const FEATURE_CALC_SDK_INJECTION = `
import geopandas as gpd
import pandas as pd
import numpy as np
import warnings
from shapely.errors import ShapelyDeprecationWarning
warnings.filterwarnings("ignore")
from rasterstats import zonal_stats
import rasterio
import mapclassify as mc

def ensure_metric_crs(gdf):
    if gdf.crs is None: gdf = gdf.set_crs(epsg=4326)
    if gdf.crs.is_geographic: return gdf.to_crs(epsg=3857)
    return gdf

def safe_zonal_stats(vector_gdf, raster_file_path, stat='mean', col_name='raster_val'):
    if vector_gdf.empty: return vector_gdf
    
    # 修复 1：读取栅格物理文件的真实 CRS，并强制将矢量对齐过去，杜绝空间错位
    try:
        with rasterio.open(raster_file_path) as src:
            raster_crs = src.crs
            if raster_crs and vector_gdf.crs != raster_crs:
                vector_gdf = vector_gdf.to_crs(raster_crs)
    except Exception as e:
        pass # 如果读取失败，降级依赖 rasterstats 的默认行为

    # 修复 2：加入 all_touched=True，只要多边形触碰到像素边缘就纳入统计，彻底消灭规律性 0 值空洞！
    stats = zonal_stats(vector_gdf, raster_file_path, stats=[stat], all_touched=True, geojson_out=False)
    vector_gdf[col_name] = [s[stat] if s[stat] is not None else 0 for s in stats]
    return vector_gdf

def safe_shortest_distance(target_gdf, ref_gdf, col_name='min_dist'):
    if target_gdf.empty or ref_gdf.empty: 
        target_gdf[col_name] = np.nan
        return target_gdf
    t_gdf = ensure_metric_crs(target_gdf)
    r_gdf = ensure_metric_crs(ref_gdf).to_crs(t_gdf.crs)
    joined = gpd.sjoin_nearest(t_gdf, r_gdf, how='left', distance_col=col_name)
    joined = joined[~joined.index.duplicated(keep='first')]
    target_gdf[col_name] = joined[col_name]
    return target_gdf

def safe_intersects_count(target_gdf, join_gdf, col_name='count_val'):
    t_gdf = ensure_metric_crs(target_gdf)
    j_gdf = ensure_metric_crs(join_gdf).to_crs(t_gdf.crs)
    joined = gpd.sjoin(t_gdf, j_gdf, how='inner', predicate='intersects')
    counts = joined.groupby(level=0).size()
    target_gdf[col_name] = counts
    target_gdf[col_name] = target_gdf[col_name].fillna(0)
    return target_gdf

def safe_calc_geometry(gdf, calc_type='area', col_name='geom_val'):
    if gdf.empty: 
        gdf[col_name] = np.nan
        return gdf
    t_gdf = ensure_metric_crs(gdf)
    if calc_type == 'area':
        gdf[col_name] = t_gdf.geometry.area
    elif calc_type == 'length':
        gdf[col_name] = t_gdf.geometry.length
    return gdf

def safe_spatial_join_attribute(target_gdf, ref_gdf, extract_col, join_type='nearest', col_name='ref_val'):
    if target_gdf.empty or ref_gdf.empty or extract_col not in ref_gdf.columns:
        target_gdf[col_name] = np.nan
        return target_gdf
    t_gdf = ensure_metric_crs(target_gdf)
    r_gdf = ensure_metric_crs(ref_gdf).to_crs(t_gdf.crs)
    r_gdf_sub = r_gdf[['geometry', extract_col]]
    if join_type == 'nearest':
        joined = gpd.sjoin_nearest(t_gdf, r_gdf_sub, how='left')
    else:
        joined = gpd.sjoin(t_gdf, r_gdf_sub, how='left', predicate='intersects')
    joined = joined[~joined.index.duplicated(keep='first')]
    target_gdf[col_name] = joined[extract_col]
    return target_gdf

def safe_buffer_count(target_gdf, join_gdf, buffer_dist=500, col_name='buf_count'):
    if target_gdf.empty or join_gdf.empty:
        target_gdf[col_name] = 0
        return target_gdf
    t_gdf = ensure_metric_crs(target_gdf)
    j_gdf = ensure_metric_crs(join_gdf).to_crs(t_gdf.crs)
    t_buffered = t_gdf.copy()
    t_buffered['geometry'] = t_buffered.geometry.buffer(buffer_dist)
    joined = gpd.sjoin(t_buffered, j_gdf, how='inner', predicate='intersects')
    counts = joined.groupby(level=0).size()
    target_gdf[col_name] = counts
    target_gdf[col_name] = target_gdf[col_name].fillna(0)
    return target_gdf

def safe_categorical_zonal_stats(vector_gdf, raster_file_path, col_name='majority_class'):
    if vector_gdf.empty: return vector_gdf
    
    try:
        with rasterio.open(raster_file_path) as src:
            raster_crs = src.crs
            if raster_crs and vector_gdf.crs != raster_crs:
                vector_gdf = vector_gdf.to_crs(raster_crs)
    except:
        pass

    # 同样开启 all_touched=True 防止分类栅格提取遗漏
    stats = zonal_stats(vector_gdf, raster_file_path, stats=['majority'], all_touched=True, categorical=False, geojson_out=False)
    vector_gdf[col_name] = [s['majority'] if s['majority'] is not None else np.nan for s in stats]
    return vector_gdf

def safe_natural_breaks(gdf, target_col, k=5, col_name='jenks_class'):
    """
    Jenks 自然断点法分级 (Feature Binning)
    """
    if gdf.empty or target_col not in gdf.columns:
        gdf[col_name] = np.nan
        return gdf
    
    # 过滤掉空值参与计算
    valid_data = gdf[target_col].dropna()
    if len(valid_data) < k:
        gdf[col_name] = 0 # 数据量太少无法分级
        return gdf
        
    try:
        # 使用 mapclassify 计算断点
        classifier = mc.NaturalBreaks(valid_data, k=k)
        # 将分类结果映射回原数据 (类别通常为 0, 1, 2... k-1)
        # 我们让类别从 1 开始，即 1, 2, 3...
        mapping = dict(zip(valid_data.index, classifier.yb + 1))
        gdf[col_name] = gdf.index.map(mapping)
    except Exception as e:
        print(f"Jenks分级失败: {e}")
        gdf[col_name] = np.nan
        
    return gdf

def safe_rule_reclassify(gdf, target_col, bins, labels, col_name='reclass_val', default_val='其他'):
    """
    规则重分类 (支持同名标签和兜底值)
    """
    if gdf.empty or target_col not in gdf.columns:
        print(f"[Warning] 未找到目标列: {target_col}")
        gdf[col_name] = None
        return gdf
    
    # 核心修复：设置 labels=False，让 pd.cut 只返回数字索引 (0, 1, 2...)
    # 这样就完美绕过了 Pandas 严禁 labels 出现重复名称（如两个'北'）的底层限制！
    codes = pd.cut(gdf[target_col], bins=bins, labels=False, right=False)
    
    # 手动建立索引到真实标签的映射字典
    label_map = {i: lbl for i, lbl in enumerate(labels)}
    gdf[col_name] = codes.map(label_map)
    
    # 把不包含在区间内的值（比如 <0 或 >360 的值），统一填充为用户要求的 default_val（如“平面”）
    if default_val:
        gdf[col_name] = gdf[col_name].fillna(default_val)
        
    # 转为字符串防止前端 JSON 解析问题
    gdf[col_name] = gdf[col_name].astype(str)
    return gdf
`;


// 3. 注入专业模型专属的 Python SDK 字符串
const PRO_MODEL_SDK_INJECTION = `
import geopandas as gpd
import pandas as pd
import numpy as np
import warnings
warnings.filterwarnings("ignore")

def safe_geodetector_factor(gdf, y_col, x_cols):
    """
    地理探测器 - 因子探测 (Factor Detector)
    计算自变量 X 们对 因变量 Y 的空间分异解释力 q 值。
    """
    if gdf.empty or y_col not in gdf.columns:
        return [{"Error": "数据为空或因变量不存在"}]
        
    results = []
    # 确保因变量是纯数字
    gdf[y_col] = pd.to_numeric(gdf[y_col], errors='coerce')
    
    # 循环计算每个 X 的解释力 q
    for x_col in x_cols:
        if x_col not in gdf.columns: continue
        
        # 提取有效数据（剔除缺失值）
        valid_df = gdf[[y_col, x_col]].dropna()
        if valid_df.empty: continue
        
        N = len(valid_df)
        if N < 2: continue
        
        # 全局总方差 (SST)
        sst = valid_df[y_col].var(ddof=0) * N
        if sst == 0:
            results.append({'因变量 (Y)': y_col, '自变量 (X)': x_col, 'q值 (解释力)': 0.0})
            continue
            
        # 层内方差之和 (SSW)
        ssw = 0
        grouped = valid_df.groupby(x_col)[y_col]
        for name, group in grouped:
            nh = len(group)
            if nh > 1:
                ssw += group.var(ddof=0) * nh
                
        # 计算 q 值
        q = 1 - (ssw / sst)
        results.append({
            '因变量 (Y)': y_col, 
            '自变量 (X)': x_col, 
            'q值 (解释力)': round(max(0.0, q), 4) # 限制最低为0，保留4位小数
        })
        
    # 按解释力大小降序排列
    results.sort(key=lambda item: item.get('q值 (解释力)', 0), reverse=True)
    return results

def safe_geodetector_interaction(gdf, y_col, x_cols):
    """
    地理探测器 - 交互探测 (Interaction Detector)
    计算两两因子叠加后的解释力 q(A∩B)，并判断交互类型。
    为完美适配前端二维热力图，输出对称矩阵格式的 List of Dict。
    """
    import itertools
    if gdf.empty or y_col not in gdf.columns or len(x_cols) < 2:
        return [{"Error": "数据为空，或因变量不存在，或自变量不足2个"}]
        
    results = []
    gdf[y_col] = pd.to_numeric(gdf[y_col], errors='coerce')
    
    # 闭包辅助函数：计算单因子的 q 值
    def calc_q(df, x_c, y_c):
        valid = df[[y_c, x_c]].dropna()
        N = len(valid)
        if N < 2: return 0.0
        sst = valid[y_c].var(ddof=0) * N
        if sst == 0: return 0.0
        ssw = sum(g.var(ddof=0) * len(g) for _, g in valid.groupby(x_c)[y_c] if len(g) > 1)
        return max(0.0, 1 - (ssw / sst))

    # 1. 计算对角线（自身 q 值）
    for x in x_cols:
        if x not in gdf.columns: continue
        q_self = calc_q(gdf, x, y_col)
        results.append({'因子A': x, '因子B': x, '交互q值': round(q_self, 4), '交互类型': '单因子自身'})

    # 2. 计算两两交互
    for x1, x2 in itertools.combinations(x_cols, 2):
        if x1 not in gdf.columns or x2 not in gdf.columns: continue
        
        temp_df = gdf[[y_col, x1, x2]].dropna().copy()
        if temp_df.empty: continue
        
        # 生成叠加后的大类
        temp_df['interact'] = temp_df[x1].astype(str) + "_" + temp_df[x2].astype(str)
        
        q1 = calc_q(temp_df, x1, y_col)
        q2 = calc_q(temp_df, x2, y_col)
        q12 = calc_q(temp_df, 'interact', y_col)
        
        # 判断交互类型
        if q12 < min(q1, q2): int_type = "非线性减弱"
        elif min(q1, q2) <= q12 <= max(q1, q2): int_type = "单因子非线性减弱"
        elif q12 > max(q1, q2) and q12 < (q1 + q2): int_type = "双因子增强"
        elif q12 == (q1 + q2): int_type = "独立"
        else: int_type = "非线性增强"
            
        q12_round = round(q12, 4)
        # 补齐对称面（A-B 和 B-A 都压入，热力图才能形成正方形）
        results.append({'因子A': x1, '因子B': x2, '交互q值': q12_round, '交互类型': int_type})
        results.append({'因子A': x2, '因子B': x1, '交互q值': q12_round, '交互类型': int_type})
        
    return results
`
;

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
// 多节点进行可扩展的透视和绘图
export const executeDynamicPipeline = async (req: Request, res: Response): Promise<void> => {
    // ⚠️ 关键：将 blueprint / pythonCode 提升到 try/catch 之外，使 catch 块可以访问
    let blueprint: any = null;
    // 👇👇👇 修改：将 pivotCode 改为通用的 pythonCode，以适应双管线 👇👇👇
    let pythonCode: string = ""; 
    // 👆👆👆 修改结束 👆👆👆

    try {
        const { userPrompt, fileIds, context, agentMode = 'pivot' } = req.body;

        if (!userPrompt || !fileIds || fileIds.length === 0) {
            res.status(400).json({ error: "缺少用户需求或未选择任何文件" });
            return;
        }

        console.log(`\n======================================================`);
        console.log(`[Pipeline] 分析文件数: ${fileIds.length}`);
        console.log(`[Pipeline] 用户意图: "${userPrompt}"`);
        console.log(`[Pipeline] 当前工作模式: [${agentMode}]`); // 补充打印一下模式

        // 提取工作区文件元数据 (给 Planner 当上下文)
        const availableFiles = [];
        for (const fId of fileIds) {
            const schema = await Feature.getFileSchemaSummary(fId);
            availableFiles.push(schema);
        }

        // 1 意图拆解节点
        console.log(`[Pipeline] 节点1正在拆解意图...`);
        blueprint = await planWorkflow(userPrompt, availableFiles, context, agentMode);
        console.log(`[Pipeline] 拆解意图完成:`, blueprint.explanation);

        // 👇👇👇 新增/修改：节点2 引入双管线代码生成逻辑 👇👇👇
        let rawCode = "";
        let endpointUrl = "";

        if (agentMode === 'feature_calc') {
            console.log(`[Pipeline] 命中【特征计算】专属管线，节点2正在编写特征计算代码...`);
            rawCode = await generateFeatureCalcCode(blueprint);
            // 拼接特征计算专属的 SDK
            pythonCode = FEATURE_CALC_SDK_INJECTION + "\n\n" + rawCode;
            endpointUrl = `${PYTHON_API_URL}/models/feature_calc_only`;
        }
        else if (agentMode === 'pro_model') {
            console.log(`[Pipeline] 命中【专业模型】专属管线，正在构建底层模型调用代码...`);
            rawCode = await generateProModelCode(blueprint);
            pythonCode = PRO_MODEL_SDK_INJECTION + "\n\n" + rawCode;
            endpointUrl = `${PYTHON_API_URL}/models/feature_calc_only`; // 引擎端可以复用这个万能沙盒入口
        } 
        else {
            console.log(`[Pipeline] 命中【数据透视】原有管线...`);
            // 🚨 原封不动保留你的追问与图表切换逻辑 🚨
            if (blueprint.reuse_code && context?.lastPythonCode) {
                console.log(`[Pipeline] 检测到意图为图表切换/追问，直接复用上一轮数据抽取代码。`);
                rawCode = context.lastPythonCode;
                pythonCode = PYTHON_SDK_INJECTION + "\n\n" + rawCode;
            } else {
                console.log(`[Pipeline] 节点2正在编写透视代码...`);
                rawCode = await generatePivotCode(blueprint);
                pythonCode = PYTHON_SDK_INJECTION + "\n\n" + rawCode;
            }
            endpointUrl = `${PYTHON_API_URL}/models/pivot_only`;
        }
        // 👆👆👆 新增/修改结束 👆👆👆

        // 3 Python执行 (带自愈修复环)
        let aggregatedData: any = null;
        let lastErrorDetails = "";
        const MAX_RETRIES = 2;
        let retries = 0;

        console.log(`\n======================python代码================================`);
        console.log(pythonCode);
        console.log(`\n======================python代码================================`);

        while (retries <= MAX_RETRIES) {
            try {
                console.log(`[Pipeline] 节点3正在执行沙盒运算... (尝试 ${retries + 1}/${MAX_RETRIES + 1})`);
                // 👇👇👇 修改：动态请求 endpointUrl 👇👇👇
                const sandboxResponse = await axios.post<any>(endpointUrl, {
                    python_code: pythonCode, // 发送带 SDK 的完整代码
                    file_ids: fileIds
                });
                
                aggregatedData = sandboxResponse.data.data; 
                // 👆👆👆 修改结束 👆👆👆

                if (!aggregatedData || aggregatedData.length === 0) {
                    throw new Error("计算结果为空，请检查需求或数据是否匹配");
                }
                console.log(`[Pipeline] 沙盒计算成功，返回 ${aggregatedData.length} 条记录`);
                break; 
            } catch (err: any) {
                lastErrorDetails = err.response?.data?.detail || err.message;
                console.error(`\n[Pipeline 容错捕捉] 沙盒执行引发异常: ${lastErrorDetails}`);

                if (retries >= MAX_RETRIES) break;
                
                retries++;
                console.log(`[Pipeline] 节点发觉错误，启动自愈修复环 (第 ${retries} 次重试)...`);
                try {
                    // 👇👇👇 新增/修改：双管线各自调用对应的自愈 Agent 👇👇👇
                    if (agentMode === 'feature_calc') {
                        rawCode = await fixFeatureCalcCode(blueprint, rawCode, lastErrorDetails);
                        pythonCode = FEATURE_CALC_SDK_INJECTION + "\n\n" + rawCode;
                    } else if (agentMode === 'pro_model') {
                        rawCode = await fixProModelCode(blueprint, rawCode, lastErrorDetails);
                        pythonCode = PRO_MODEL_SDK_INJECTION + "\n\n" + rawCode;
                    }
                    else {
                        // 原有数据透视自愈逻辑
                        rawCode = await fixPivotCode(blueprint, rawCode, lastErrorDetails);
                        pythonCode = PYTHON_SDK_INJECTION + "\n\n" + rawCode;
                    }
                    // 👆👆👆 新增/修改结束 👆👆👆
                    console.log(`[Pipeline] FixerAgent 自愈重写完成，准备再次向沙盒投入代码...`);
                } catch (fixErr) { break; }
            }
        }

        // 终局判定：如果重试已耗尽且依旧没有数据，走优雅降级方案
        if (!aggregatedData) {
            console.log(`======================================================\n`);
            res.status(200).json({
                status: "failed",
                error_message: "AI 多次尝试修复代码失败，已切换至人工接管模式。",
                traceback: lastErrorDetails,
                pythonCode: pythonCode // 携带最后挣扎生成的代码
            });
            return;
        }

        // 👇👇👇 新增：特征计算的「回写数据库」与「提前返回」逻辑 👇👇👇
        if (agentMode === 'feature_calc') {
            console.log(`[Pipeline] 特征计算完成，正在将结果同步更新回原始数据层...`);
            const targetFileId = blueprint.data_dependencies?.find((d: any) => d.role.includes('Target'))?.file_id || fileIds[0];
            
            // 提取第一行中的所有新列名（排除固定字段 id）
            const newCols = Object.keys(aggregatedData[0] || {}).filter(k => k !== 'id' && k !== 'rowKey');

            // 🌟 核心修改：将串行更新改为“分批并发更新” 🌟
            console.log(`[Pipeline] 准备同步 ${aggregatedData.length} 条记录，采用分批并发策略...`);
            
            // 设置并发块大小（推荐 50-100，兼顾速度且不会撑爆 DB 连接池）
            const CHUNK_SIZE = 100; 
            
            for (let i = 0; i < aggregatedData.length; i += CHUNK_SIZE) {
                const chunk = aggregatedData.slice(i, i + CHUNK_SIZE);
                
                // 使用 Promise.all 让这一批次的 100 条数据并发更新
                await Promise.all(chunk.map(async (row: any) => {
                    if (row.id) {
                        const { id, rowKey, ...newProps } = row; 
                        await Feature.updateFeatureProperty(targetFileId, id, newProps);
                    }
                }));

                // 每处理完一定数量打印一下进度，让你在后端能看到在动
                if ((i + CHUNK_SIZE) % 5000 === 0 || (i + CHUNK_SIZE) >= aggregatedData.length) {
                    console.log(`[Pipeline] 数据库同步进度: ${Math.min(i + CHUNK_SIZE, aggregatedData.length)} / ${aggregatedData.length}`);
                }
            }
            
            console.log(`======================================================\n`);
            // 特征计算无需渲染图表，直接返回属性表数据并结束！
            res.json({
                code: 200,
                blueprint: blueprint,
                tableData: aggregatedData, 
                engine: null, // 无引擎
                message: `✅ 计算成功！已将新特征 [${newCols.join(', ')}] 同步至要素。`,
                pythonCode: pythonCode // 返回代码方便用户在前端人工修正
            });
            return; 
        }
        // 👆👆👆 新增结束：特征计算管线到此终止 👆👆👆

        // 👇👇👇 新增：专业模型的【衍生落盘】逻辑 👇👇👇
        if (agentMode === 'pro_model') {
            console.log(`[Pipeline] 专业模型计算完成，正在将结果导出为物理文件并挂载到文件树...`);
            
            // 1. 将 List of Dict 转为 CSV 字符串 (添加 UTF-8 BOM 防止 Excel 乱码)
            const csvString = '\uFEFF' + Papa.unparse(aggregatedData);
            
            // 2. 生成物理文件并存入硬盘
            const modelName = blueprint.task_type || 'Model_Result';
            const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
            const newFileName = `${modelName}_${timestamp}.csv`;
            const uploadDir = path.join(process.cwd(), 'uploads');
            const newFilePath = path.join(uploadDir, newFileName);
            
            await fs.promises.writeFile(newFilePath, csvString, 'utf8');
            
            // 3. 注册到数据库 (FileNodes 表)
            const fileNodeObj = FileNode.createFileNodeObject({
                name: newFileName,
                type: 'file',
                parent_id: null,
                path: newFilePath,
                size: Buffer.byteLength(csvString, 'utf8'),
                extension: '.csv',
                mime_type: 'text/csv'
            });
            const savedNode = await FileNode.insertFileNode(fileNodeObj);
            
            // 🌟 🌟 🌟 核心修复：将结果数据写入 spatial_features 要素表 🌟 🌟 🌟
            if (aggregatedData && aggregatedData.length > 0) {
                console.log(`[Pipeline] 正在将模型结果行写入 spatial_features 表，以供前端表格渲染...`);
                const featuresToInsert = aggregatedData.map((row: any, index: number) => {
                    return {
                        fileId: savedNode.id, // 绑定刚刚生成的新文件 ID
                        type: 'Feature',
                        geometry: null,       // CSV 纯属性表，无几何数据
                        properties: {
                            id: `model_res_${Date.now()}_${index}`, // 生成唯一行 ID
                            ...row
                        }
                    };
                });
                // 批量插入数据库（确保文件头部引了 import * as Feature from '../models/Feature';）
                await Feature.insertFeaturesBatch(savedNode.id, featuresToInsert);
            }
            // 🌟 🌟 🌟 修复结束 🌟 🌟 🌟
            // 获取 AI 蓝图中规划的图表类型（如果 AI 觉得该画热力图，就会在这里体现）
            const aiChartType = blueprint.visualization_spec?.chart_type?.toLowerCase() || null;

            console.log(`======================================================\n`);
            
            // 返回特殊结构，告诉前端去刷新文件树
            res.json({
                code: 200,
                blueprint: blueprint,
                tableData: aggregatedData, 
                // 👇👇👇 核心修复：如果 AI 规划了图表，就触发前端 ECharts 接管渲染 👇👇👇
                engine: aiChartType ? 'echarts' : null,
                aiChartType: aiChartType,
                // 👆👆👆 修复结束 👆👆👆
                message: `✅ 模型执行成功！分析结果已自动保存为文件：[${newFileName}]`,
                newFileId: savedNode.id,   
                pythonCode: pythonCode
            });
            return;
        }
        // 👆👆👆 专业模型落盘逻辑结束 👆👆👆

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
            // 👇👇👇 修改：变量名同步为了 pythonCode 👇👇👇
            pythonCode: pythonCode // 依然返回 pivot 代码供用户检查修改
        });

    } catch (error: any) {
        // 提取执行上下文，方便前端展示错误原因及出错的代码
        const details = error.response?.data?.detail || error.response?.data?.details || error.message;
        console.error("\n[Pipeline错误]", details);
        
        res.status(500).json({ 
            error: '执行失败', 
            details: details,
            // blueprint / pythonCode 已提升到外层作用域，可直接安全访问
            blueprint: blueprint,
            // 👇👇👇 修改：捕获异常时也返回当前的 pythonCode 👇👇👇
            pythonCode: pythonCode || null
        });
    }
};