import numpy as np
import geopandas as gpd
from shapely.geometry import Polygon

def execute(df, parameters):
    # 创建结果字典
    result = {
        'area': [],
        'perimeter': [],
        'complexity': [],
        'buffer_5000m_count': []
    }
    
    try:
        # 转换为UTM投影计算几何指标
        projected_gdf = df.to_crs(df.estimate_utm_crs())
        
        # 计算几何指标
        result['area'] = projected_gdf.geometry.area.tolist()
        result['perimeter'] = projected_gdf.geometry.length.tolist()
        result['complexity'] = (4 * np.pi * projected_gdf.geometry.area / 
                               (projected_gdf.geometry.length ** 2)).tolist()
        
        # 计算5000米缓冲区内要素数
        for idx, geom in enumerate(projected_gdf.geometry):
            buffer = geom.buffer(5000)
            count = sum(projected_gdf.geometry.intersects(buffer)) - 1  # 排除自身
            result['buffer_5000m_count'].append(count)
        
    except Exception as e:
        print(f"计算错误: {str(e)}")
        # 返回空结果时保持长度一致
        if not result['area']:
            result = {
                'area': [np.nan] * len(df),
                'perimeter': [np.nan] * len(df),
                'complexity': [np.nan] * len(df),
                'buffer_5000m_count': [np.nan] * len(df)
            }
    
    return result