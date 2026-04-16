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