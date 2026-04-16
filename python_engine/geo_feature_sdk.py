import geopandas as gpd
import pandas as pd
import numpy as np
import warnings
from shapely.errors import ShapelyDeprecationWarning
warnings.filterwarnings("ignore", category=ShapelyDeprecationWarning)

def ensure_metric_crs(gdf):
    """【基底防护】确保使用米制投影坐标系，否则算出的面积和距离毫无意义"""
    if gdf.empty or gdf.geometry.isnull().all(): 
        return gdf
    if gdf.crs is None: 
        gdf = gdf.set_crs(epsg=4326)
    if gdf.crs.is_geographic: 
        gdf = gdf.to_crs(epsg=3857) # Web Mercator
    return gdf

def calculate_area(gdf, output_col='area_sqm'):
    """【算子】计算多边形面积"""
    if gdf.empty: 
        return gdf
    gdf_metric = ensure_metric_crs(gdf)
    gdf[output_col] = gdf_metric.geometry.area
    return gdf

def calculate_distance_to_layer(gdf, join_gdf, output_col='dist_to_target'):
    """【算子】计算到另一个目标图层的最短距离"""
    if gdf.empty or join_gdf.empty:
        gdf[output_col] = np.nan
        return gdf
    gdf_metric = ensure_metric_crs(gdf)
    join_metric = ensure_metric_crs(join_gdf)
    
    # 使用 numpy apply 计算最短距离
    distances = gdf_metric.geometry.apply(lambda geom: join_metric.distance(geom).min())
    gdf[output_col] = distances
    return gdf

def buffer_count(gdf, join_gdf, radius=500, output_col='buffer_count'):
    """【算子】计算指定半径缓冲区内的目标要素数量"""
    if gdf.empty or join_gdf.empty:
        gdf[output_col] = 0
        return gdf
    gdf_metric = ensure_metric_crs(gdf)
    join_metric = ensure_metric_crs(join_gdf)
    
    # 建立缓冲区
    buffer_geom = gdf_metric.geometry.buffer(float(radius))
    gdf_buffer = gdf_metric.set_geometry(buffer_geom)
    
    # 空间左连接并按左表索引分组计数
    joined = gpd.sjoin(gdf_buffer, join_metric, how='left', predicate='intersects')
    counts = joined.groupby(joined.index).size() - joined['index_right'].isna().astype(int)
    gdf[output_col] = counts
    return gdf