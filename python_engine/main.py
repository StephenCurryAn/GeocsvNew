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
            df = gpd.read_postgis(sql, con=engine.connect(), geom_col='geom', params={"file_id": payload.file_id})
        
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
        print(f"❌ 算子执行崩溃: {payload.model_name}")
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
                print(f"[Pivot Sandbox] ✅ file_id={fid} 坐标系已统一为 EPSG:3857 (Web Mercator)")
                
            # 展开 properties 到外层列，方便 AI 代码直接用列名访问
            df_props = pd.json_normalize(df['properties'])
            # 防止列名重复 👇👇👇
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
        
        # 自动纠错：如果 AI 没按要求返回 dict 列表，而是直接返回了 DataFrame
        if isinstance(result_data, (pd.DataFrame, gpd.GeoDataFrame)):
            # 如果包含几何列，转换前最好去掉，否则 JSON 序列化会失败
            if isinstance(result_data, gpd.GeoDataFrame) and 'geometry' in result_data.columns:
                result_data = result_data.drop(columns=['geometry'])
            result_data = result_data.to_dict(orient='records')
            
        elif isinstance(result_data, dict):
            # 极少数情况下 AI 会返回单个字典，或者没做 orient='records'
            # 尝试直接包装为列表
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
        return {"status": "success", "data": clean_result_data}

    except Exception as e:
        print(f"\n{'='*50}")
        print(f"内存透视算子执行崩溃，错误类型: {type(e).__name__}, 内容: {str(e)}")
        print(f"AI 写的代码如下:\n{payload.python_code}")
        traceback.print_exc()
        print(f"{'='*50}\n")
        raise HTTPException(status_code=500, detail=str(e))


class FeatureCalcInput(BaseModel):
    python_code: str
    file_ids: List[str]
    parameters: Optional[Dict[str, Any]] = {}

@app.post("/api/models/feature_calc_only")
async def execute_feature_calc_only(payload: FeatureCalcInput):
    start_time = time.time()
    try:
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

        exec_env = {
            "pd": pd,
            "gpd": gpd,
            "np": np,
            "gdf_dict": gdf_dict,
            "file_paths_dict": file_paths_dict,
            "file_ids": payload.file_ids,
        }
        
        exec(payload.python_code, exec_env)
        
        # 👇👇👇 核心修复：支持两种不同的管线主函数入口 👇👇👇
        if 'execute_pro_model' in exec_env:
            execute_func = exec_env['execute_pro_model']
        elif 'execute_feature_calc' in exec_env:
            execute_func = exec_env['execute_feature_calc']
        else:
            raise ValueError("未找到主函数 'execute_feature_calc' 或 'execute_pro_model'！")
            
        result_data = execute_func(gdf_dict, file_paths_dict, payload.parameters)
        # 👆👆👆 修复结束 👆👆👆
        
        # 结果降维转 JSON
        if isinstance(result_data, (pd.DataFrame, gpd.GeoDataFrame)):
            if 'geometry' in result_data.columns:
                result_data = result_data.drop(columns=['geometry'])
            result_data = result_data.to_dict(orient='records')
            
        return {"status": "success", "data": result_data}

    except Exception as e:
        print(f"\n❌ 特征计算算子执行崩溃")
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