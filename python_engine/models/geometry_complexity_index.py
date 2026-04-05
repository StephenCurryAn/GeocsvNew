import numpy as np
import geopandas as gpd

def execute(df, parameters):
    # 创建投影副本用于精确计算
    projected_gdf = df.to_crs(df.estimate_utm_crs())
    
    # 计算顶点数量
    vertex_counts = df.geometry.apply(lambda geom: len(geom.exterior.coords) if geom.geom_type == 'Polygon' else len(geom.coords))
    
    # 计算面积（平方米）
    areas = projected_gdf.geometry.area
    
    # 标准化处理（避免除零错误）
    max_vertices = vertex_counts.max()
    max_area = areas.max()
    
    # 计算复杂度指数 = (顶点数占比 + 面积占比)/2
    complexity_index = (vertex_counts/max_vertices + areas/max_area)/2
    
    return {
        'vertex_count': vertex_counts.tolist(),
        'area_m2': areas.tolist(),
        'complexity_index': complexity_index.tolist()
    }