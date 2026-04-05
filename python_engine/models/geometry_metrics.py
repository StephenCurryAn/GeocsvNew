import numpy as np
import geopandas as gpd

def execute(df, parameters):
    # 创建UTM投影坐标系下的副本
    projected_gdf = df.to_crs(df.estimate_utm_crs())
    
    # 计算周长（米）
    perimeter = projected_gdf.geometry.length
    
    # 计算面积（平方米）
    area = projected_gdf.geometry.area
    
    # 计算形状复杂度指数（4π*面积/周长²）
    complexity = 4 * np.pi * area / (perimeter ** 2)
    complexity = complexity.replace([np.inf, -np.inf], np.nan)
    
    return {
        'perimeter_m': perimeter.tolist(),
        'area_sqm': area.tolist(),
        'shape_complexity': complexity.tolist()
    }