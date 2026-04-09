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

# ==========================================
# 模块三：空间数据透视聚合算子 (OLAP Aggregation - The "M" & "V")
# ==========================================

def safe_aggregate(joined_gdf, agg_method='size', value_col=None):
    """
    【安全透视聚合算子】: 彻底封装 level=0 索引对齐逻辑。
    支持 size(计数), sum(求和), mean(平均), max, min。
    """
    if joined_gdf.empty:
        return pd.Series(dtype=float)
        
    # 基于主表索引 (level=0) 进行安全分组
    grouped = joined_gdf.groupby(level=0)
    
    agg_method = str(agg_method).lower()
    
    if agg_method in ['size', 'count']:
        return grouped.size()
        
    if not value_col or value_col not in joined_gdf.columns:
        raise ValueError(f"聚合方法 {agg_method} 必须指定有效的透视数值列 (value_col)")
        
    # 强制数值类型转换，防止因为字符串 '123' 导致 sum 变成字符串拼接
    joined_gdf[value_col] = pd.to_numeric(joined_gdf[value_col], errors='coerce')
    
    if agg_method == 'sum':
        return grouped[value_col].sum()
    elif agg_method == 'mean':
        return grouped[value_col].mean()
    elif agg_method == 'max':
        return grouped[value_col].max()
    elif agg_method == 'min':
        return grouped[value_col].min()
    else:
        raise ValueError(f"不支持的空间聚合方法: {agg_method}")