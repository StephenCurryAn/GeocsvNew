import os
import sys
import importlib
import time
import traceback
import json
import math
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import pandas as pd
import geopandas as gpd
from sqlalchemy import create_engine, text
from psycopg2.extras import execute_batch

# 绘图库
import plotly.express as px
import plotly.graph_objects as go
import folium
import numpy as np

app = FastAPI(title="动态模型计算引擎")

# 配置 PostgreSQL + PostGIS (替代原来的 MongoDB)
PG_URI = os.getenv("PG_URI", "postgresql://geocsv:geocsv@127.0.0.1:5432/geocsv")
engine = create_engine(PG_URI, pool_size=10, max_overflow=20)

# 数据模型改造
class ModelInput(BaseModel):
    model_name: str
    file_id: str             # Node.js 传来的文件ID
    columns: List[str]       # Node.js 告诉我们需要拉取哪些属性列
    parameters: Dict[str, Any]

MODEL_REGISTRY = {}

# 模型重载机制
def auto_discover_models():
    global MODEL_REGISTRY
    loaded_count = 0
    models_dir = os.path.join(os.path.dirname(__file__), "models")
    if not os.path.exists(models_dir):
        os.makedirs(models_dir)
    init_file = os.path.join(models_dir, "__init__.py")
    if not os.path.exists(init_file):
        with open(init_file, "w") as f:
            f.write("")

    if os.path.dirname(__file__) not in sys.path:
        sys.path.insert(0, os.path.dirname(__file__))

    importlib.invalidate_caches()
    for filename in os.listdir(models_dir):
        if filename.endswith(".py") and not filename.startswith("__"):
            module_name = filename[:-3]
            full_module_name = f"models.{module_name}"
            try:
                if full_module_name in sys.modules:
                    module = importlib.reload(sys.modules[full_module_name])
                else:
                    module = importlib.import_module(full_module_name)
                    
                if hasattr(module, 'execute'):
                    model_key = module_name.upper()
                    MODEL_REGISTRY[model_key] = module.execute
                    loaded_count += 1
            except Exception as e:
                print(f"[!] 加载模型 {module_name} 失败: {str(e)}")
                
    print(f"[*] 动态扫描完成，目前已挂载 {loaded_count} 个模型: {list(MODEL_REGISTRY.keys())}")

auto_discover_models()

def _flatten_vector_frame(df):
    if df.empty:
        return df

    if df.crs is None:
        df = df.set_crs(epsg=4326)

    flat_df = df.copy()
    flat_df['__record_id__'] = flat_df['id']

    df_props = pd.json_normalize(flat_df['properties'])
    if 'id' not in df_props.columns:
        df_props['id'] = flat_df['id']

    merged = pd.concat([flat_df[['geom', '__record_id__']], df_props], axis=1)
    merged = merged.loc[:, ~merged.columns.duplicated()]
    return gpd.GeoDataFrame(merged, geometry='geom', crs=df.crs)

@app.post("/api/models/execute")
async def execute_model(payload: ModelInput):
    start_time = time.time()
    try:
        model_key = payload.model_name.upper()

        if model_key not in MODEL_REGISTRY:
            print(f"[!] 内存中未找到模型 {model_key}，正在扫描硬盘热加载...")
            auto_discover_models()        
            if model_key not in MODEL_REGISTRY:
                raise HTTPException(status_code=404, detail=f"模型 {payload.model_name} 不存在。")

        print(f"\n[*] 正在从 PostGIS 拉取数据: file_id={payload.file_id}")
        
        # 1. 构造 SQL 语句，直接利用 PostGIS 在底层过滤，并将需要的 properties 平铺出来
        # 通过 -> 获取的是 jsonb 对象，但我们需要基本类型以便 pandas 处理，所以大部分时候用 ->> 提取文本
        # 为了更好地保持数据类型，最稳妥的方法是取回整个 properties 在 pandas 端展平。GeoPandas 读取底层的速度远高于 pymongo!
        sql = text("SELECT id, geom, properties FROM spatial_features WHERE file_id = :file_id")
        
        # 2. 空间觉醒与坐标系处理: 直接通过 gpd.read_postgis 完成，它底层调用 C 库将 WKB 转为 Geometry！
        # 使用 with 语句防止数据库连接泄露
        with engine.connect() as conn:
            df = gpd.read_postgis(sql, con=conn, geom_col='geom', params={"file_id": payload.file_id})
        
        if df.empty:
            raise HTTPException(status_code=400, detail="未在数据库中找到对应文件的数据")
            
        if df.crs is None:
            df.set_crs(epsg=4326, inplace=True)
            
        # 3. 展开 properties
        # 将 properties 字典中的相关列解析为扁平的 DataFrame 列
        for col in payload.columns:
            df[col] = df['properties'].apply(lambda props: props.get(col) if isinstance(props, dict) else None)
            # 处理空字符串的情况
            df[col] = df[col].replace(r'^\s*$', np.nan, regex=True)

        # 同样展开 properties 中的 id 以防模型用
        df['prop_id'] = df['properties'].apply(lambda props: props.get('id') if isinstance(props, dict) else None)
        df['id_col'] = df['prop_id'].combine_first(df['id'])
        
        # 4. 执行 AI 模型计算
        print(f"[*] 开始执行空间分析: {model_key}")
        target_func = MODEL_REGISTRY[model_key]
        raw_result_dict = target_func(df, payload.parameters)

        # 5. 极速打包与回写 (使用 postgresql 的 UPDATE)
        print("[*] 计算完成，正在打包回写 PostGIS...")
        result_col_names = list(raw_result_dict.keys())
        
        standardized_results = {}
        for col_name, col_data in raw_result_dict.items():
            if hasattr(col_data, 'tolist'):
                standardized_results[col_name] = col_data.tolist()
            else:
                standardized_results[col_name] = list(col_data)

        # 准备批量参数
        update_data = []
        num_rows = len(df)
        row_ids = df['id'].tolist()
        
        for i in range(num_rows):
            update_payload = {}
            for col_name in result_col_names:
                try:
                    x = standardized_results[col_name][i]
                except IndexError:
                    raise ValueError(f"严重错误：模型返回的列 '{col_name}' 长度与输入数据行数不一致！")
                    
                if pd.isna(x) or (isinstance(x, float) and math.isinf(x)):
                    score = None
                elif hasattr(x, 'item'):
                    score = x.item()
                else:
                    score = x
                update_payload[col_name] = score

            # 使用 || 操作符拼接 jsonb。我们将 Python dict 转为 JSON 字符串
            update_data.append((json.dumps(update_payload), row_ids[i]))

        # 使用 psycopg2.extras.execute_batch 批量极速写入
        if update_data:
            update_sql = "UPDATE spatial_features SET properties = properties || %s::jsonb WHERE id = %s"
            
            with engine.connect() as conn:
                raw_conn = conn.connection
                raw_cursor = raw_conn.cursor()
                # page_size=10000 ensures large datasets don't kill string interpolation limits
                execute_batch(raw_cursor, update_sql, update_data, page_size=5000)
                raw_conn.commit()
                raw_cursor.close()

        print(f"[*] 成功更新了 {len(update_data)} 条要素的 {len(result_col_names)} 个属性！")

        # 拼装给前端的 result_data，仅提取更新的数据
        result_data = []
        for i in range(num_rows):
            rd = {"id": df['id_col'].iloc[i]}
            for col_name in result_col_names:
                 x = standardized_results[col_name][i]
                 rd[col_name] = x.item() if hasattr(x, 'item') else x
            result_data.append(rd)

        return {
            "status": "success",
            "result_col_names": result_col_names,
            "result_data": result_data,
            "execution_time_ms": round((time.time() - start_time) * 1000, 2)
        }

    except Exception as e:
        print(f"\n{'='*50}")
        print(f"  算子执行崩溃: {payload.model_name}")
        traceback.print_exc()
        print(f"{'='*50}\n")
        raise HTTPException(status_code=500, detail=str(e))

# 透视与绘图的输入数据模型
class PivotInput(BaseModel):
    python_code: str
    file_ids: List[str]
    parameters: Optional[Dict[str, Any]] = {}

class ChartInput(BaseModel):
    python_code: str
    data: List[Dict[str, Any]] # Node.js 传来的 JSON 数组
    parameters: Optional[Dict[str, Any]] = {}

@app.post("/api/models/pivot_only")
async def execute_pivot_only(payload: PivotInput):
    start_time = time.time()
    try:
        gdf_dict = {}
        print(f"\n[Pivot Sandbox] 收到透视任务，准备从 PostGIS 提取 {len(payload.file_ids)} 个文件的数据...")
        
        for fid in payload.file_ids:
            sql = text("SELECT id, geom, properties FROM spatial_features WHERE file_id = :file_id")
            # 使用 with 语句，确保查询完毕后连接立刻归还给连接池
            with engine.connect() as conn:
                df = gpd.read_postgis(sql, con=conn, geom_col='geom', params={"file_id": fid})
            
            if df.empty:
                print(f"[Pivot Sandbox] 警告：file_id={fid} 未找到数据，跳过。")
                continue
            
            # === 关键步骤：统一坐标系到 EPSG:3857（米制）===
            # 4326 (WGS84 经纬度) -> 3857 (Web Mercator 米制)
            # 米制坐标系是做 buffer/距离计算的必要条件！
            if df.crs is None:
                df = df.set_crs(epsg=4326)
            if df.crs.to_epsg() != 3857:
                df = df.to_crs(epsg=3857)
                print(f"[Pivot Sandbox]  file_id={fid} 坐标系已统一为 EPSG:3857 (Web Mercator)")
                
            # 展开 properties 到外层列，方便 AI 代码直接用列名访问
            df_props = pd.json_normalize(df['properties'])
            # 防止列名重复    
            # 默认只保留几何列
            base_cols = ['geom']
            # 如果 properties 里面没有 id，我们才去借用数据库的 id
            if 'id' not in df_props.columns:
                base_cols.append('id')
            
            # 拼接数据
            df = pd.concat([df[base_cols], df_props], axis=1)
            
            # 终极防御：移除任何可能意外重名的列（保留第一个）
            df = df.loc[:, ~df.columns.duplicated()]
            
            gdf_dict[fid] = df

        if not gdf_dict:
            raise ValueError("所有传入的文件ID均未在数据库中找到数据！")

        print(f"[Pivot Sandbox] 数据装载完毕，已加载 {len(gdf_dict)} 个图层。正在执行 AI 动态算子...")
        print(f"[Pivot Sandbox] 图层列表: {list(gdf_dict.keys())}")

        # 扩展执行沙盒，注入空间分析所需的全部工具
        # 【核心修复】：合并为一个唯一的执行环境 (exec_env)
        exec_env = {
            "pd": pd,
            "gpd": gpd,
            "np": np,
            "math": math,
            "sjoin": gpd.sjoin,
            "sjoin_nearest": gpd.sjoin_nearest,
            "gdf_dict": gdf_dict,
            "file_ids": payload.file_ids,
        }
        
        # 核心修改：只传入一个字典！这样注入的 SDK 算子和 AI 写的主函数都会在同一个全局作用域中
        exec(payload.python_code, exec_env)
        
        if 'execute_pivot' not in exec_env:
            raise ValueError("AI 生成的代码中未找到主函数 'execute_pivot'！")
            
        execute_pivot = exec_env['execute_pivot']

        result_data = execute_pivot(gdf_dict, payload.parameters)
        
        valid_ids = []
        # 如果 AI 按照我们的新规范返回了包含 chart_data 和 valid_ids 的字典
        if isinstance(result_data, dict) and "chart_data" in result_data:
            valid_ids = result_data.get("valid_ids", [])
            result_data = result_data["chart_data"]

        if isinstance(result_data, (pd.DataFrame, gpd.GeoDataFrame)):
            if isinstance(result_data, gpd.GeoDataFrame) and 'geometry' in result_data.columns:
                result_data = result_data.drop(columns=['geometry'])
            result_data = result_data.to_dict(orient='records')
        elif isinstance(result_data, dict):
            result_data = [result_data]
            
        if not isinstance(result_data, list):
            raise ValueError(f"AI 生成的算子返回了未知格式: {type(result_data)}，期待 list of dicts")
        
        # 清理 Pandas NaN 和 Numpy 浮点数，同时防御异常对象
        clean_result_data = []
        for i, row in enumerate(result_data):
            # 防止 AI 返回纯字符串列表
            if not isinstance(row, dict):
                continue
                
            clean_row = {}
            for k, v in row.items():
                if isinstance(v, (pd.DataFrame, pd.Series, gpd.GeoDataFrame, gpd.GeoSeries)):
                    # 如果结果里嵌套了 DataFrame/Series，这是异常情况，直接跳过或者记录字符串
                    clean_row[k] = f"[{type(v).__name__}]"
                    continue
                
                # 安全的 NA 检查
                try:
                    if pd.api.types.is_scalar(v) and pd.isna(v):
                        clean_row[k] = None
                    elif hasattr(v, 'item'): 
                        clean_row[k] = v.item()
                    else: 
                        # 如果是 geometry 对象，尝试转成 WKT，或者直接丢弃
                        if hasattr(v, 'wkt'):
                            clean_row[k] = v.wkt
                        else:
                            clean_row[k] = v
                except Exception:
                    clean_row[k] = str(v)
                    
            clean_result_data.append(clean_row)
        
        print(f"[Pivot Sandbox] 透视成功！生成了 {len(clean_result_data)} 条高度聚合数据。耗时: {round((time.time() - start_time)*1000, 2)}ms")
        # 把 valid_ids 一起返回给前端
        return {"status": "success", "data": clean_result_data, "valid_ids": valid_ids}

    except Exception as e:
        print(f"\n{'='*50}")
        print(f"内存透视算子执行崩溃，错误类型: {type(e).__name__}, 内容: {str(e)}")
        print(f"AI 写的代码如下:\n{payload.python_code}")
        traceback.print_exc()
        print(f"{'='*50}\n")
        raise HTTPException(status_code=500, detail=str(e))


class SafeGdfDict(dict):
    """自定义的安全字典，专门用于拦截对栅格数据的错误内存读取行为"""
    def __init__(self, original_dict, raster_file_paths):
        super().__init__(original_dict)
        # 将有物理路径且没在 gdf_dict 里的文件视为栅格
        self.raster_ids = set(raster_file_paths.keys())

    def __getitem__(self, key):
        if key not in self and key in self.raster_ids:
            # 抛出带有“强烈提示性”的异常，Fixer Agent 捕获到这行报错后会瞬间顿悟
            raise KeyError(
                f"\n[安全拦截] 致命错误：图层 '{key}' 是栅格数据(Raster)！\n"
                f"栅格数据并未加载至内存，绝对不能使用 gdf_dict['{key}'] 获取。\n"
                f"修复方案：请删除针对该图层的 `gdf_dict` 调用，改为直接获取物理路径：\n"
                f"`raster_path = file_paths_dict['{key}']`，并将其作为参数传递给算子。"
            )
        return super().__getitem__(key)

class FeatureCalcInput(BaseModel):
    python_code: str
    file_ids: List[str]
    parameters: Optional[Dict[str, Any]] = {}

@app.post("/api/models/feature_calc_only")
async def execute_feature_calc_only(payload: FeatureCalcInput):
    start_time = time.time()
    try:
        def clean_rows(rows):
            clean_result_data = []
            for row in rows or []:
                if not isinstance(row, dict):
                    continue
                clean_row = {}
                for k, v in row.items():
                    try:
                        if pd.api.types.is_scalar(v) and pd.isna(v):
                            clean_row[k] = None
                        elif hasattr(v, 'item'):
                            clean_row[k] = v.item()
                        else:
                            clean_row[k] = v
                    except Exception:
                        clean_row[k] = None
                clean_result_data.append(clean_row)
            return clean_result_data

        gdf_dict = {}
        file_paths_dict = {}
        
        for fid in payload.file_ids:
            # 1. 查出文件的绝对物理路径（专为栅格 .tif 准备）
            sql_file = text("SELECT path, extension FROM file_nodes WHERE id = :file_id")
            with engine.connect() as conn:
                res = conn.execute(sql_file, {"file_id": fid}).fetchone()
                if res:
                    file_paths_dict[fid] = res[0] # 物理路径
                    ext = res[1]
                    # 如果是栅格数据，跳过 GeoPandas 加载
                    if ext in ['.tif', '.tiff']:
                        continue 
                        
            # 2. 如果是矢量，常规加载到 gdf_dict
            sql = text("SELECT id, geom, properties FROM spatial_features WHERE file_id = :file_id")
            with engine.connect() as conn:
                df = gpd.read_postgis(sql, con=conn, geom_col='geom', params={"file_id": fid})
            
            if not df.empty:
                if df.crs is None: df = df.set_crs(epsg=4326)
                df_props = pd.json_normalize(df['properties'])
                df_props['__record_id__'] = df['id']
                
                # 防止列名重复
                # 默认只保留几何列
                base_cols = ['geom']
                # 如果 properties 里面没有 id，我们才去借用数据库的 id
                if 'id' not in df_props.columns:
                    base_cols.append('id')
                
                # 拼接数据
                df = pd.concat([df[base_cols], df_props], axis=1)
                
                # 终极防御：移除任何可能意外重名的列（保留第一个）
                df = df.loc[:, ~df.columns.duplicated()]
                gdf_dict[fid] = df

        print(f"[Feature Sandbox] 已加载矢量图层 {len(gdf_dict)} 个，物理文件关联 {len(file_paths_dict)} 个")

        # 将普通的字典包装为会“说话”的安全字典
        safe_gdf_dict = SafeGdfDict(gdf_dict, file_paths_dict)

        exec_env = {
            "pd": pd,
            "gpd": gpd,
            "np": np,
            "gdf_dict": safe_gdf_dict,  # <--- 这里替换为 safe_gdf_dict
            "file_paths_dict": file_paths_dict,
            "file_ids": payload.file_ids,
        }
        
        exec(payload.python_code, exec_env)
        
        #     核心修复：支持两种不同的管线主函数入口    
        if 'execute_pro_model' in exec_env:
            execute_func = exec_env['execute_pro_model']
        elif 'execute_feature_calc' in exec_env:
            execute_func = exec_env['execute_feature_calc']
        else:
            raise ValueError("未找到主函数 'execute_feature_calc' 或 'execute_pro_model'！")
            
        result_data = execute_func(safe_gdf_dict, file_paths_dict, payload.parameters)
        if isinstance(result_data, dict) and result_data.get("result_type") == "sensitivity_score":
            score_rows = clean_rows(result_data.get("score_rows", []))
            weight_rows = clean_rows(result_data.get("weight_rows", []))
            return {
                "status": "success",
                "data": weight_rows,
                "result_type": "sensitivity_score",
                "score_rows": score_rows,
                "weight_rows": weight_rows,
                "summary": result_data.get("summary", {})
            }
        # ==== 修复结束 ====
        
        # 结果降维转 JSON
        if isinstance(result_data, (pd.DataFrame, gpd.GeoDataFrame)):
            if 'geometry' in result_data.columns:
                result_data = result_data.drop(columns=['geometry'])
            result_data = result_data.to_dict(orient='records')
        elif isinstance(result_data, dict):
            result_data = [result_data]
            
        clean_result_data = clean_rows(result_data)

        return {"status": "success", "data": clean_result_data}

    except Exception as e:
        print(f"\n  特征计算算子执行崩溃")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


class ParkAccessibilityInput(BaseModel):
    grid_file_id: str
    street_file_id: str
    distance_field: str
    street_name_field: Optional[str] = None
    normalization_method: str = "linear_reverse"
    grid_score_field: str = "公园可达性得分"
    street_score_field: str = "公园可达性得分"


class SpatialAutocorrelationInput(BaseModel):
    target_file_id: str
    value_column: str
    name_column: Optional[str] = None
    contiguity: str = "queen"
    permutations: int = 199
    significance_level: float = 0.05
    local_i_column: str = "LISA_Local_I"
    p_value_column: str = "LISA_P_Value"
    cluster_column: str = "LISA_Cluster"
    hotspot_column: str = "LISA_Hotspot"
    spatial_lag_column: str = "LISA_Spatial_Lag"
    z_score_column: str = "LISA_Z_Score"
    neighbor_count_column: str = "LISA_Neighbor_Count"


class LandslideSensitivityInput(BaseModel):
    target_file_id: str
    y_column: str
    factor_columns: List[str]
    score_column: str = "滑坡敏感性综合评分"
    level_column: str = "滑坡敏感性等级"
    level_count: int = 5


def _coerce_factor_to_numeric(series: pd.Series) -> pd.Series:
    direct_numeric = pd.to_numeric(series, errors='coerce')
    valid_ratio = direct_numeric.notna().sum() / max(len(series), 1)
    if valid_ratio >= 0.6:
        return direct_numeric.astype(float)

    extracted = series.astype(str).str.extract(r'(-?\d+(?:\.\d+)?)', expand=False)
    extracted_numeric = pd.to_numeric(extracted, errors='coerce')
    extracted_ratio = extracted_numeric.notna().sum() / max(len(series), 1)
    if extracted_ratio >= 0.6:
        return extracted_numeric.astype(float)

    ordered_label_map = {
        '低': 1, '较低': 2, '中': 3, '中等': 3, '较高': 4, '高': 5, '极高': 6,
        'low': 1, 'medium': 3, 'high': 5,
    }
    normalized_text = series.astype(str).str.strip()
    if normalized_text.dropna().isin(ordered_label_map.keys()).all():
        return normalized_text.map(ordered_label_map).astype(float)

    codes, _ = pd.factorize(normalized_text, sort=True)
    result = pd.Series(codes + 1, index=series.index, dtype='float64')
    result[series.isna()] = np.nan
    return result


def _calc_geodetector_q(df: pd.DataFrame, y_col: str, x_col: str):
    valid_df = df[[y_col, x_col]].dropna().copy()
    if valid_df.empty:
        return 0.0, 0, 0

    valid_df[y_col] = pd.to_numeric(valid_df[y_col], errors='coerce')
    valid_df = valid_df.dropna(subset=[y_col])
    n = len(valid_df)
    if n < 2:
        return 0.0, n, int(valid_df[x_col].nunique())

    sst = valid_df[y_col].var(ddof=0) * n
    if pd.isna(sst) or not np.isfinite(sst) or sst <= 0:
        return 0.0, n, int(valid_df[x_col].nunique())

    ssw = 0.0
    for _, group in valid_df.groupby(x_col)[y_col]:
        group_n = len(group)
        if group_n > 1:
            group_var = group.var(ddof=0)
            if pd.notna(group_var) and np.isfinite(group_var):
                ssw += float(group_var) * group_n

    q_value = max(0.0, 1 - (ssw / sst))
    return round(float(q_value), 6), n, int(valid_df[x_col].nunique())


def _classify_score_levels(score_series: pd.Series, level_count: int) -> pd.Series:
    default_labels = ['低', '较低', '中', '较高', '高', '极高', '超高']
    labels = default_labels[:max(1, level_count)]
    valid_scores = score_series.dropna()
    result = pd.Series(index=score_series.index, dtype='object')

    if valid_scores.empty:
        return result

    unique_count = int(valid_scores.nunique())
    if unique_count == 1:
        middle_label = labels[min(len(labels) - 1, len(labels) // 2)]
        result.loc[valid_scores.index] = middle_label
        return result

    k = min(level_count, unique_count)
    active_labels = labels[:k]

    try:
        import mapclassify as mc
        classifier = mc.NaturalBreaks(valid_scores.to_numpy(), k=k)
        bins = classifier.bins
        classified = pd.cut(
            valid_scores,
            bins=[-np.inf] + list(bins[:-1]) + [np.inf],
            labels=active_labels,
            include_lowest=True
        )
        result.loc[valid_scores.index] = classified.astype(str)
        return result
    except Exception:
        ranked = valid_scores.rank(method='average')
        classified = pd.qcut(ranked, q=k, labels=active_labels, duplicates='drop')
        result.loc[valid_scores.index] = classified.astype(str)
        return result


@app.post("/api/models/landslide_sensitivity_score")
async def compute_landslide_sensitivity_score(payload: LandslideSensitivityInput):
    start_time = time.time()
    try:
        sql = text("SELECT id, geom, properties FROM spatial_features WHERE file_id = :file_id")
        with engine.connect() as conn:
            df = gpd.read_postgis(sql, con=conn, geom_col='geom', params={"file_id": payload.target_file_id})

        if df.empty:
            raise HTTPException(status_code=400, detail="目标图层为空或不存在")

        if df.crs is None:
            df = df.set_crs(epsg=4326)

        df = _flatten_vector_frame(df)
        record_id_series = df['__record_id__'] if '__record_id__' in df.columns else (
            df['id'] if 'id' in df.columns else pd.Series(range(len(df)), index=df.index)
        )

        if payload.y_column not in df.columns:
            raise HTTPException(status_code=400, detail=f"因变量字段不存在: {payload.y_column}")

        factor_columns = [col for col in payload.factor_columns if col in df.columns]
        if not factor_columns:
            raise HTTPException(status_code=400, detail="未找到任何可用的因子字段")

        working_df = pd.DataFrame(index=df.index)
        working_df[payload.y_column] = pd.to_numeric(df[payload.y_column], errors='coerce')

        weight_rows = []
        usable_factors = []
        q_values = []
        factor_numeric_map = {}

        for factor_col in factor_columns:
            numeric_factor = _coerce_factor_to_numeric(df[factor_col])
            working_df[factor_col] = numeric_factor
            q_value, sample_count, class_count = _calc_geodetector_q(working_df, payload.y_column, factor_col)
            weight_rows.append({
                '因子字段': factor_col,
                'q值': q_value,
                '权重': 0.0,
                '有效样本数': sample_count,
                '类别数': class_count,
            })
            usable_factors.append(factor_col)
            q_values.append(q_value)
            factor_numeric_map[factor_col] = numeric_factor

        if not usable_factors:
            raise HTTPException(status_code=400, detail="所有因子字段均不可用于评分")

        q_sum = float(np.nansum(q_values))
        if q_sum > 0:
            weights = [float(q) / q_sum for q in q_values]
        else:
            equal_weight = 1.0 / len(usable_factors)
            weights = [equal_weight for _ in usable_factors]

        for row, weight in zip(weight_rows, weights):
            row['权重'] = round(weight, 6)

        weighted_sum = pd.Series(0.0, index=df.index, dtype='float64')
        applied_weight_sum = pd.Series(0.0, index=df.index, dtype='float64')

        for factor_col, weight in zip(usable_factors, weights):
            factor_values = factor_numeric_map[factor_col]
            valid_mask = factor_values.notna()
            weighted_sum = weighted_sum.add(factor_values.fillna(0) * weight, fill_value=0)
            applied_weight_sum = applied_weight_sum.add(valid_mask.astype(float) * weight, fill_value=0)

        score_series = weighted_sum.where(applied_weight_sum > 0, np.nan)
        score_series = score_series / applied_weight_sum.replace(0, np.nan)
        level_series = _classify_score_levels(score_series, payload.level_count)

        score_rows = []
        for idx in df.index:
            score_value = score_series.loc[idx]
            level_value = level_series.loc[idx] if idx in level_series.index else None
            score_rows.append({
                'id': record_id_series.loc[idx],
                payload.score_column: None if pd.isna(score_value) else round(float(score_value), 6),
                payload.level_column: None if pd.isna(level_value) else str(level_value),
            })

        elapsed_ms = round((time.time() - start_time) * 1000, 2)
        return {
            "status": "success",
            "score_rows": score_rows,
            "weight_rows": weight_rows,
            "summary": {
                "target_file_id": payload.target_file_id,
                "y_column": payload.y_column,
                "factor_columns": usable_factors,
                "score_column": payload.score_column,
                "level_column": payload.level_column,
                "level_count": payload.level_count,
                "execution_time_ms": elapsed_ms,
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        print("\n[Sensitivity Score] 执行失败")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def _load_vector_layer(file_id: str) -> gpd.GeoDataFrame:
    sql = text("SELECT id, geom, properties FROM spatial_features WHERE file_id = :file_id")
    with engine.connect() as conn:
        df = gpd.read_postgis(sql, con=conn, geom_col='geom', params={"file_id": file_id})

    if df.empty:
        return df

    if df.crs is None:
        df = df.set_crs(epsg=4326)

    return _flatten_vector_frame(df)


def _normalize_distance_to_accessibility(distance_series: pd.Series, method: str = "linear_reverse") -> pd.Series:
    values = pd.to_numeric(distance_series, errors='coerce')
    result = pd.Series(index=values.index, dtype='float64')
    valid = values.dropna()
    if valid.empty:
        return result

    min_value = float(valid.min())
    max_value = float(valid.max())
    method = (method or "linear_reverse").strip().lower()

    if max_value == min_value:
        result.loc[valid.index] = 1.0
        return result

    if method == "log_reverse":
        denominator = math.log(max_value + 1.0)
        if denominator <= 0:
            result.loc[valid.index] = 1.0
            return result
        normalized = 1.0 - (valid.apply(lambda x: math.log(float(x) + 1.0)) / denominator)
    else:
        normalized = (max_value - valid) / (max_value - min_value)

    normalized = normalized.clip(lower=0.0, upper=1.0)
    result.loc[valid.index] = normalized.astype(float)
    return result


@app.post("/api/models/park_accessibility_score")
async def compute_park_accessibility_score(payload: ParkAccessibilityInput):
    start_time = time.time()
    try:
        grid_gdf = _load_vector_layer(payload.grid_file_id)
        street_gdf = _load_vector_layer(payload.street_file_id)

        if grid_gdf.empty:
            raise HTTPException(status_code=400, detail="网格图层为空或不存在")
        if street_gdf.empty:
            raise HTTPException(status_code=400, detail="街道图层为空或不存在")
        if payload.distance_field not in grid_gdf.columns:
            raise HTTPException(status_code=400, detail=f"距离字段不存在: {payload.distance_field}")

        grid_gdf = grid_gdf.dropna(subset=['geom']).copy()
        street_gdf = street_gdf.dropna(subset=['geom']).copy()
        grid_gdf = grid_gdf[grid_gdf.geometry.geom_type.isin(['Polygon', 'MultiPolygon'])].copy()
        street_gdf = street_gdf[street_gdf.geometry.geom_type.isin(['Polygon', 'MultiPolygon'])].copy()
        if grid_gdf.empty:
            raise HTTPException(status_code=400, detail="网格图层没有有效面要素")
        if street_gdf.empty:
            raise HTTPException(status_code=400, detail="街道图层没有有效面要素")

        if street_gdf.crs != grid_gdf.crs:
            street_gdf = street_gdf.to_crs(grid_gdf.crs)

        grid_gdf[payload.distance_field] = pd.to_numeric(grid_gdf[payload.distance_field], errors='coerce')
        grid_gdf = grid_gdf.dropna(subset=[payload.distance_field]).copy()
        if grid_gdf.empty:
            raise HTTPException(status_code=400, detail="距离字段没有可用于计算的有效数值")

        grid_gdf[payload.grid_score_field] = _normalize_distance_to_accessibility(
            grid_gdf[payload.distance_field],
            payload.normalization_method,
        )

        rep_points = grid_gdf.copy()
        rep_points = rep_points.set_geometry(rep_points.geometry.representative_point())

        street_columns = ['__record_id__', 'geom']
        if payload.street_name_field and payload.street_name_field in street_gdf.columns:
            street_columns.append(payload.street_name_field)

        joined = gpd.sjoin(
            rep_points[['__record_id__', payload.grid_score_field, 'geom']].copy(),
            street_gdf[street_columns].copy(),
            how='left',
            predicate='within'
        )
        if joined['index_right'].isna().all():
            raise HTTPException(status_code=400, detail="网格与街道未形成有效空间匹配，请检查图层范围与坐标系")

        valid_joined = joined.dropna(subset=['index_right']).copy()
        valid_joined['index_right'] = valid_joined['index_right'].astype(int)
        street_score_series = valid_joined.groupby('index_right')[payload.grid_score_field].mean()

        grid_score_rows = []
        for _, row in grid_gdf.iterrows():
            grid_score_rows.append({
                'id': row['__record_id__'] if '__record_id__' in row else row['id'],
                payload.grid_score_field: None if pd.isna(row[payload.grid_score_field]) else round(float(row[payload.grid_score_field]), 6),
            })

        street_score_rows = []
        for idx, street_row in street_gdf.iterrows():
            score_value = street_score_series.get(idx, np.nan)
            street_result = {
                'id': street_row['__record_id__'] if '__record_id__' in street_row else street_row['id'],
                payload.street_score_field: None if pd.isna(score_value) else round(float(score_value), 6),
            }
            if payload.street_name_field and payload.street_name_field in street_gdf.columns:
                street_result[payload.street_name_field] = street_row[payload.street_name_field]
            street_score_rows.append(street_result)

        elapsed_ms = round((time.time() - start_time) * 1000, 2)
        return {
            "status": "success",
            "grid_score_rows": grid_score_rows,
            "street_score_rows": street_score_rows,
            "summary": {
                "grid_file_id": payload.grid_file_id,
                "street_file_id": payload.street_file_id,
                "distance_field": payload.distance_field,
                "street_name_field": payload.street_name_field,
                "normalization_method": payload.normalization_method,
                "grid_score_field": payload.grid_score_field,
                "street_score_field": payload.street_score_field,
                "grid_feature_count": int(len(grid_gdf)),
                "street_feature_count": int(len(street_gdf)),
                "matched_street_count": int(pd.Series([row[payload.street_score_field] for row in street_score_rows]).notna().sum()),
                "distance_min": round(float(grid_gdf[payload.distance_field].min()), 6),
                "distance_max": round(float(grid_gdf[payload.distance_field].max()), 6),
                "score_min": round(float(grid_gdf[payload.grid_score_field].min()), 6),
                "score_max": round(float(grid_gdf[payload.grid_score_field].max()), 6),
                "execution_time_ms": elapsed_ms,
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        print("\n[Park Accessibility Score] 执行失败")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def _round_nested_coords(value, digits=5):
    if isinstance(value, list):
        return [_round_nested_coords(item, digits) for item in value]
    if isinstance(value, float):
        return round(value, digits)
    return value


def _build_polygon_neighbors(gdf: gpd.GeoDataFrame, contiguity: str = "queen") -> List[List[int]]:
    mode = (contiguity or "queen").strip().lower()
    if mode not in {"queen", "rook"}:
        mode = "queen"

    geometries = list(gdf.geometry)
    neighbors: List[List[int]] = [[] for _ in range(len(geometries))]

    try:
        sindex = gdf.sindex
        use_sindex = sindex is not None
    except Exception:
        sindex = None
        use_sindex = False

    for i, geom in enumerate(geometries):
        if geom is None or geom.is_empty:
            continue

        candidate_ids = list(sindex.intersection(geom.bounds)) if use_sindex else list(range(len(geometries)))
        matched: List[int] = []

        for j in candidate_ids:
            if i == j:
                continue
            other = geometries[j]
            if other is None or other.is_empty:
                continue

            try:
                if mode == "rook":
                    boundary_intersection = geom.boundary.intersection(other.boundary)
                    if (not boundary_intersection.is_empty) and getattr(boundary_intersection, "length", 0.0) > 0:
                        matched.append(j)
                else:
                    if geom.touches(other) or geom.intersects(other):
                        matched.append(j)
            except Exception:
                continue

        neighbors[i] = sorted(set(matched))

    return neighbors


def _compute_spatial_autocorrelation(
    values: np.ndarray,
    neighbors: List[List[int]],
    permutations: int = 199,
):
    n = len(values)
    if n < 3:
        raise ValueError("有效样本少于 3 个，无法进行空间自相关分析")

    mean_value = float(np.mean(values))
    centered = values - mean_value
    denom = float(np.sum(centered ** 2))
    if not np.isfinite(denom) or denom <= 0:
        raise ValueError("目标字段没有足够的数值离散性，无法计算 Moran's I")

    variance = float(np.var(values, ddof=0))
    if not np.isfinite(variance) or variance <= 0:
        raise ValueError("目标字段方差为 0，无法计算局部 LISA")

    std_value = float(np.sqrt(variance))
    z_scores = centered / std_value

    row_weight_sums = np.array([float(len(nbrs)) for nbrs in neighbors], dtype="float64")
    lag_centered = np.zeros(n, dtype="float64")
    lag_z = np.zeros(n, dtype="float64")
    for i, nbrs in enumerate(neighbors):
        if not nbrs:
            continue
        weight = 1.0 / len(nbrs)
        lag_centered[i] = float(np.sum(centered[nbrs] * weight))
        lag_z[i] = float(np.sum(z_scores[nbrs] * weight))

    s0 = float(np.sum(row_weight_sums > 0))
    if s0 <= 0:
        raise ValueError("所有面要素都没有相邻街道，无法构建空间权重矩阵")

    global_moran_i = float((n / s0) * (np.sum(centered * lag_centered) / denom))
    expected_i = float(-1.0 / (n - 1))

    m2 = float(denom / n)
    local_i = (centered / m2) * lag_centered

    rng = np.random.default_rng(42)
    global_perm_values = []
    local_extreme_counts = np.ones(n, dtype="int64")

    for _ in range(max(int(permutations), 0)):
        permuted = rng.permutation(centered)
        perm_lag_centered = np.zeros(n, dtype="float64")
        for i, nbrs in enumerate(neighbors):
            if not nbrs:
                continue
            perm_lag_centered[i] = float(np.mean(permuted[nbrs]))

        perm_global_i = float((n / s0) * (np.sum(permuted * perm_lag_centered) / denom))
        global_perm_values.append(perm_global_i)

        perm_local_i = (centered / m2) * perm_lag_centered
        local_extreme_counts += (np.abs(perm_local_i) >= np.abs(local_i)).astype("int64")

    permutation_count = max(int(permutations), 0)
    if permutation_count > 0:
        global_perm_array = np.array(global_perm_values, dtype="float64")
        global_p_value = float((np.sum(np.abs(global_perm_array) >= abs(global_moran_i)) + 1) / (permutation_count + 1))
        perm_mean = float(np.mean(global_perm_array))
        perm_std = float(np.std(global_perm_array, ddof=0))
        global_z_score = float((global_moran_i - perm_mean) / perm_std) if perm_std > 0 else None
    else:
        global_p_value = 1.0
        global_z_score = None

    local_p_values = local_extreme_counts.astype("float64") / float(permutation_count + 1)

    return {
        "global_moran_i": global_moran_i,
        "global_expected_i": expected_i,
        "global_p_value": global_p_value,
        "global_z_score": global_z_score,
        "local_i": local_i,
        "local_p_values": local_p_values,
        "lag_z": lag_z,
        "z_scores": z_scores,
        "neighbor_counts": row_weight_sums.astype("int64"),
    }


@app.post("/api/models/spatial_autocorrelation")
async def compute_spatial_autocorrelation(payload: SpatialAutocorrelationInput):
    start_time = time.time()
    try:
        sql = text("SELECT id, geom, properties FROM spatial_features WHERE file_id = :file_id")
        with engine.connect() as conn:
            df = gpd.read_postgis(sql, con=conn, geom_col='geom', params={"file_id": payload.target_file_id})

        if df.empty:
            raise HTTPException(status_code=400, detail="目标图层为空或不存在")

        if df.crs is None:
            df = df.set_crs(epsg=4326)

        df = _flatten_vector_frame(df)

        if payload.value_column not in df.columns:
            raise HTTPException(status_code=400, detail=f"目标字段不存在: {payload.value_column}")

        name_column = payload.name_column if payload.name_column in df.columns else None

        work_gdf = gpd.GeoDataFrame(df.copy(), geometry='geom', crs=df.crs)
        work_gdf = work_gdf.dropna(subset=['geom']).copy()
        work_gdf = work_gdf[work_gdf.geometry.geom_type.isin(['Polygon', 'MultiPolygon'])].copy()
        if work_gdf.empty:
            raise HTTPException(status_code=400, detail="空间自相关分析仅支持面图层，当前图层没有有效面要素")

        try:
            invalid_mask = ~work_gdf.geometry.is_valid
            if invalid_mask.any():
                work_gdf.loc[invalid_mask, 'geom'] = work_gdf.loc[invalid_mask, 'geom'].buffer(0)
        except Exception:
            pass

        work_gdf[payload.value_column] = pd.to_numeric(work_gdf[payload.value_column], errors='coerce')
        work_gdf = work_gdf.dropna(subset=[payload.value_column]).copy()
        if len(work_gdf) < 3:
            raise HTTPException(status_code=400, detail="目标字段可用于分析的街道数量不足 3 个")

        work_gdf = work_gdf.reset_index(drop=True)
        neighbors = _build_polygon_neighbors(work_gdf, payload.contiguity)
        stats = _compute_spatial_autocorrelation(
            values=work_gdf[payload.value_column].to_numpy(dtype='float64'),
            neighbors=neighbors,
            permutations=payload.permutations,
        )

        significance_level = float(payload.significance_level or 0.05)
        local_i = stats["local_i"]
        local_p_values = stats["local_p_values"]
        lag_z = stats["lag_z"]
        z_scores = stats["z_scores"]
        neighbor_counts = stats["neighbor_counts"]

        cluster_labels = []
        hotspot_labels = []
        for i in range(len(work_gdf)):
            if int(neighbor_counts[i]) == 0:
                cluster_label = "孤立街道"
                hotspot_label = "孤立"
            elif float(local_p_values[i]) > significance_level:
                cluster_label = "不显著"
                hotspot_label = "非热点"
            elif z_scores[i] > 0 and lag_z[i] > 0:
                cluster_label = "高-高聚集"
                hotspot_label = "热点街道"
            elif z_scores[i] < 0 and lag_z[i] < 0:
                cluster_label = "低-低聚集"
                hotspot_label = "冷点街道"
            elif z_scores[i] > 0 and lag_z[i] < 0:
                cluster_label = "高-低异常"
                hotspot_label = "高值异常"
            else:
                cluster_label = "低-高异常"
                hotspot_label = "低值异常"

            cluster_labels.append(cluster_label)
            hotspot_labels.append(hotspot_label)

        work_gdf[payload.local_i_column] = np.round(local_i, 6)
        work_gdf[payload.p_value_column] = np.round(local_p_values, 6)
        work_gdf[payload.cluster_column] = cluster_labels
        work_gdf[payload.hotspot_column] = hotspot_labels
        work_gdf[payload.spatial_lag_column] = np.round(lag_z, 6)
        work_gdf[payload.z_score_column] = np.round(z_scores, 6)
        work_gdf[payload.neighbor_count_column] = neighbor_counts.astype(int)

        cluster_counts = pd.Series(cluster_labels, dtype='object').value_counts(dropna=False).to_dict()

        local_rows = []
        for _, row in work_gdf.iterrows():
            local_row = {
                "id": row['__record_id__'] if '__record_id__' in row else row['id'],
                payload.value_column: None if pd.isna(row[payload.value_column]) else round(float(row[payload.value_column]), 6),
                payload.local_i_column: None if pd.isna(row[payload.local_i_column]) else round(float(row[payload.local_i_column]), 6),
                payload.p_value_column: None if pd.isna(row[payload.p_value_column]) else round(float(row[payload.p_value_column]), 6),
                payload.cluster_column: row[payload.cluster_column],
                payload.hotspot_column: row[payload.hotspot_column],
                payload.spatial_lag_column: None if pd.isna(row[payload.spatial_lag_column]) else round(float(row[payload.spatial_lag_column]), 6),
                payload.z_score_column: None if pd.isna(row[payload.z_score_column]) else round(float(row[payload.z_score_column]), 6),
                payload.neighbor_count_column: int(row[payload.neighbor_count_column]),
            }
            if name_column:
                local_row[name_column] = row[name_column]
            local_rows.append(local_row)

        export_gdf = work_gdf.copy().to_crs(epsg=4326)
        export_gdf['center_lon'] = export_gdf.geometry.centroid.x
        export_gdf['center_lat'] = export_gdf.geometry.centroid.y

        geojson_columns = [
            payload.value_column,
            payload.local_i_column,
            payload.p_value_column,
            payload.cluster_column,
            payload.hotspot_column,
            payload.spatial_lag_column,
            payload.z_score_column,
            payload.neighbor_count_column,
            'center_lon',
            'center_lat',
        ]
        if name_column:
            geojson_columns.insert(0, name_column)

        export_geojson = json.loads(
            gpd.GeoDataFrame(
                export_gdf[geojson_columns + [export_gdf.geometry.name]].copy(),
                geometry=export_gdf.geometry.name,
                crs=export_gdf.crs,
            ).to_json(drop_id=True)
        )
        for feature in export_geojson.get("features", []):
            geometry = feature.get("geometry") or {}
            if "coordinates" in geometry:
                geometry["coordinates"] = _round_nested_coords(geometry["coordinates"], digits=5)

        hotspot_names = []
        coldspot_names = []
        if name_column:
            hotspot_names = work_gdf.loc[work_gdf[payload.cluster_column] == '高-高聚集', name_column].astype(str).tolist()
            coldspot_names = work_gdf.loc[work_gdf[payload.cluster_column] == '低-低聚集', name_column].astype(str).tolist()

        map_payload = [{
            "map_title": f"{payload.value_column} 空间自相关聚类图",
            "geojson": export_geojson,
            "name_column": name_column,
            "value_column": payload.value_column,
            "local_i_column": payload.local_i_column,
            "p_value_column": payload.p_value_column,
            "cluster_column": payload.cluster_column,
            "hotspot_column": payload.hotspot_column,
            "spatial_lag_column": payload.spatial_lag_column,
            "z_score_column": payload.z_score_column,
            "neighbor_count_column": payload.neighbor_count_column,
            "global_moran_i": round(float(stats["global_moran_i"]), 6),
            "global_expected_i": round(float(stats["global_expected_i"]), 6),
            "global_p_value": round(float(stats["global_p_value"]), 6),
            "global_z_score": None if stats["global_z_score"] is None else round(float(stats["global_z_score"]), 6),
            "contiguity": (payload.contiguity or "queen").lower(),
            "significance_level": significance_level,
            "feature_count": int(len(work_gdf)),
            "hotspot_count": int(cluster_counts.get('高-高聚集', 0)),
            "coldspot_count": int(cluster_counts.get('低-低聚集', 0)),
            "cluster_counts": cluster_counts,
            "hotspot_names": hotspot_names[:20],
            "coldspot_names": coldspot_names[:20],
            "center_lat": round(float(export_gdf['center_lat'].mean()), 6),
            "center_lon": round(float(export_gdf['center_lon'].mean()), 6),
        }]

        elapsed_ms = round((time.time() - start_time) * 1000, 2)
        return {
            "status": "success",
            "local_rows": local_rows,
            "map_payload": map_payload,
            "summary": {
                "target_file_id": payload.target_file_id,
                "value_column": payload.value_column,
                "name_column": name_column,
                "contiguity": (payload.contiguity or "queen").lower(),
                "permutations": int(payload.permutations),
                "significance_level": significance_level,
                "global_moran_i": round(float(stats["global_moran_i"]), 6),
                "global_expected_i": round(float(stats["global_expected_i"]), 6),
                "global_p_value": round(float(stats["global_p_value"]), 6),
                "global_z_score": None if stats["global_z_score"] is None else round(float(stats["global_z_score"]), 6),
                "positive_spatial_autocorrelation": bool(stats["global_moran_i"] > 0 and stats["global_p_value"] <= significance_level),
                "feature_count": int(len(work_gdf)),
                "cluster_counts": cluster_counts,
                "hotspot_names": hotspot_names[:20],
                "coldspot_names": coldspot_names[:20],
                "execution_time_ms": elapsed_ms,
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        print("\n[Spatial Autocorrelation] 执行失败")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/models/chart_only")
async def execute_chart_only(payload: ChartInput):
    start_time = time.time()
    try:
        print(f"\n[Chart Sandbox] 收到绘图任务，传入了 {len(payload.data)} 条聚合数据样本...")
        df = pd.DataFrame(payload.data)
        
        # 【核心修复】：单命名空间执行
        exec_env = {"pd": pd, "np": np, "px": px, "go": go, "folium": folium, "df": df}
        
        exec(payload.python_code, exec_env)
        
        if 'execute_chart' not in exec_env:
            raise ValueError("AI 生成的代码中未找到主函数 'execute_chart'！")
            
        execute_chart = exec_env['execute_chart']
        result_dict = execute_chart(df, payload.parameters)
        
        if "echarts_option" in result_dict:
            # 返回 ECharts 配置
            print(f"[Chart Sandbox] ECharts 渲染配置生成成功！耗时: {round((time.time() - start_time)*1000, 2)}ms")
            return {
                "status": "success", 
                "engine": "echarts",
                "chart_option": result_dict["echarts_option"]
            }
        elif "html_string" in result_dict:
            # 返回 HTML 源码
            print(f"[Chart Sandbox] HTML 绘图渲染成功！耗时: {round((time.time() - start_time)*1000, 2)}ms")
            return {
                "status": "success", 
                "engine": "html_iframe",
                "html_string": result_dict["html_string"]
            }
        else:
            raise ValueError("大模型未按规范返回包含 'echarts_option' 或 'html_string' 的字典！")


    except Exception as e:
        print(f"\n{'='*50}")
        print(f"绘图算子执行崩溃，AI 写的代码如下:\n{payload.python_code}")
        traceback.print_exc()
        print(f"{'='*50}\n")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
