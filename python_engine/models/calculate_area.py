import pandas as pd
import numpy as np
import geopandas as gpd
from pyproj import CRS

def execute(df, parameters):
    """
    计算每个几何要素的面积。
    如果原始CRS是地理坐标系（如EPSG:4326），则自动转换为UTM投影坐标系进行计算。
    返回一个字典，包含新增的'AREA_M2'列，值为每个要素的面积（平方米）。
    """
    # 1. 检查输入是否为GeoDataFrame
    if not isinstance(df, gpd.GeoDataFrame):
        raise ValueError("输入数据必须是一个GeoDataFrame。")
    
    # 2. 检查几何列是否存在
    if df.geometry is None or df.geometry.empty:
        raise ValueError("GeoDataFrame中未找到有效的几何列。")
    
    # 3. 获取当前CRS
    current_crs = df.crs
    
    # 4. 判断是否需要投影转换
    # 如果CRS未定义或者是地理坐标系（单位是度），则需要投影
    needs_projection = False
    if current_crs is None:
        needs_projection = True
        print("警告：数据未定义CRS，将尝试估计UTM投影进行计算。")
    else:
        # 检查是否是地理坐标系（通常单位是度）
        # 地理坐标系通常没有线性单位，或者其单位是度
        crs_obj = CRS(current_crs)
        if crs_obj.is_geographic:
            needs_projection = True
            print(f"信息：检测到地理坐标系（{current_crs}），将转换为UTM投影以计算面积。")
    
    # 5. 计算面积
    if needs_projection:
        try:
            # 尝试估计合适的UTM CRS
            utm_crs = df.estimate_utm_crs()
            if utm_crs is None:
                raise ValueError("无法估计UTM CRS，请确保数据有有效的几何和地理位置。")
            # 投影到UTM
            projected_gdf = df.to_crs(utm_crs)
            areas = projected_gdf.geometry.area
            print(f"信息：已投影到 {utm_crs} 并计算面积。")
        except Exception as e:
            print(f"错误：在投影或计算面积时发生异常: {e}")
            # 如果投影失败，尝试使用原始几何计算（可能不准确）
            print("警告：使用原始几何计算面积，结果单位可能不是平方米。")
            areas = df.geometry.area
    else:
        # 当前CRS已经是投影坐标系，直接计算
        areas = df.geometry.area
        print(f"信息：使用当前投影坐标系（{current_crs}）计算面积。")
    
    # 6. 确保areas是一个与df行数一致的Series
    if len(areas) != len(df):
        raise ValueError(f"计算出的面积序列长度({len(areas)})与输入数据行数({len(df)})不匹配。")
    
    # 7. 返回结果字典
    # 将面积值四舍五入到两位小数，并转换为列表
    area_list = areas.round(2).tolist()
    
    return {
        "AREA_M2": area_list
    }
