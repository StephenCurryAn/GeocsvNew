import os
import sys
import importlib
import time
import traceback
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import pandas as pd
import geopandas as gpd
from shapely.geometry import shape
import math 
from pymongo import MongoClient, UpdateOne
from bson.objectid import ObjectId

# 绘图库
import plotly.express as px
import plotly.graph_objects as go
import folium
import numpy as np


app = FastAPI(title="动态模型计算引擎")

# 配置直连 MongoDB
MONGO_URI = os.getenv("MONGO_URI", "mongodb://admin:123456@172.18.0.2:27017/Geoex?authSource=admin")
DB_NAME = "Geoex" 
client = MongoClient(MONGO_URI)
db = client[DB_NAME]

# 数据模型改造
class ModelInput(BaseModel):
    model_name: str
    file_id: str             #   Node.js 传来的文件ID
    columns: List[str]       #   Node.js 告诉我们需要拉取哪些属性列
    parameters: Dict[str, Any]

MODEL_REGISTRY = {}

# 模型重载机制
def auto_discover_models():
    global MODEL_REGISTRY
    loaded_count = 0
    
    # 强制获取 models 文件夹的绝对路径
    models_dir = os.path.join(os.path.dirname(__file__), "models")
    
    # 防呆设计：如果没有 models 文件夹或 __init__.py，自动补全！
    if not os.path.exists(models_dir):
        os.makedirs(models_dir)
    init_file = os.path.join(models_dir, "__init__.py")
    if not os.path.exists(init_file):
        with open(init_file, "w") as f:
            f.write("")

    # 确保根目录在 sys.path 中
    if os.path.dirname(__file__) not in sys.path:
        sys.path.insert(0, os.path.dirname(__file__))

    # 强制清空模块寻址缓存
    importlib.invalidate_caches()

    for filename in os.listdir(models_dir):
        if filename.endswith(".py") and not filename.startswith("__"):
            module_name = filename[:-3]
            full_module_name = f"models.{module_name}"
            try:
                #   真正的热插拔：被加载过就 reload 刷新，没加载过就 import
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

        # 1. 模型热加载检查
        if model_key not in MODEL_REGISTRY:
            print(f"[!] 内存中未找到模型 {model_key}，正在扫描硬盘热加载...")
            auto_discover_models()        
            if model_key not in MODEL_REGISTRY:
                raise HTTPException(status_code=404, detail=f"模型 {payload.model_name} 不存在。")

        print(f"\n[*] 正在从 MongoDB 拉取数据: fileId={payload.file_id}")
        
        # 2. 构造精确投影
        projection = {"_id": 1, "geometry": 1, "properties.id": 1}
        for col in payload.columns:
            projection[f"properties.{col}"] = 1
            
        cursor = db.features.find({"fileId": ObjectId(payload.file_id)}, projection)
        
        df_data = []
        for doc in cursor:
            row = {"_id": doc["_id"], "_geometry": doc.get("geometry")}
            props = doc.get("properties", {})
            
            # 【修复 2】：绝不随意填 0。如果是空字符串或纯空格，视为 None
            for col in payload.columns:
                val = props.get(col)
                if val == '' or (isinstance(val, str) and str.isspace(val)):
                    val = None
                row[col] = val
                
            if "id" in props:
                row["id"] = props["id"]
                
            df_data.append(row)
            
        if not df_data:
            raise HTTPException(status_code=400, detail="未在数据库中找到对应文件的数据")

        df = pd.DataFrame(df_data)
        
        # 3. 空间觉醒与坐标系处理
        if '_geometry' in df.columns:
            # 安全解析 GeoJSON
            df['geometry'] = df['_geometry'].apply(
                lambda g: shape(g) if isinstance(g, dict) and g.get('type') else None
            )
            df = gpd.GeoDataFrame(df, geometry='geometry')
            
            # 【修复 3】：仅在没有 CRS 的情况下才默认设为 4326，绝不强制覆盖！
            if df.crs is None:
                df.set_crs(epsg=4326, inplace=True)
            
            df.drop(columns=['_geometry'], inplace=True)

        # 4. 执行 AI 模型计算
        print(f"[*] 开始执行空间分析: {model_key}")
        target_func = MODEL_REGISTRY[model_key]
        raw_result_dict = target_func(df, payload.parameters)

        # 5. 极速打包与回写
        print("[*] 计算完成，正在打包回写 MongoDB...")

        result_col_names = list(raw_result_dict.keys())
        bulk_ops = []
        result_data = []
        
        # 将结果列统一转为标准的 Python List，避免 Pandas 索引错位
        standardized_results = {}
        for col_name, col_data in raw_result_dict.items():
            if hasattr(col_data, 'tolist'):
                standardized_results[col_name] = col_data.tolist()
            else:
                standardized_results[col_name] = list(col_data)
        
        # 【修复 1】：抛弃极慢的 df.iterrows()，提取纯 Python 列表进行极速遍历
        doc_ids = df['_id'].tolist()
        row_ids = df['id'].tolist() if 'id' in df.columns else [str(x) for x in doc_ids]
        num_rows = len(df)

        for i in range(num_rows):
            doc_id = doc_ids[i]
            row_id = row_ids[i]
            
            update_fields = {}
            row_scores = {"id": row_id}
            
            for col_name in result_col_names:
                try:
                    x = standardized_results[col_name][i]
                except IndexError:
                    raise ValueError(f"严重错误：模型返回的列 '{col_name}' 长度与输入数据行数不一致！")
                
                # 安全的类型转换：处理 NaN, NaT, Inf
                if pd.isna(x) or (isinstance(x, float) and math.isinf(x)):
                    score = None
                elif hasattr(x, 'item'):
                    score = x.item()
                else:
                    score = x
                    
                update_fields[f"properties.{col_name}"] = score
                row_scores[col_name] = score
                
            result_data.append(row_scores)
            
            bulk_ops.append(
                UpdateOne(
                    {"_id": doc_id},
                    {"$set": update_fields}
                )
            )
        
        # 【修复 4】：分批写入 MongoDB，防止内存爆炸 (Chunk Size = 10,000)
        if bulk_ops:
            BATCH_SIZE = 10000
            for i in range(0, len(bulk_ops), BATCH_SIZE):
                batch = bulk_ops[i:i + BATCH_SIZE]
                db.features.bulk_write(batch, ordered=False) # ordered=False 进一步提升写入速度
        
        print(f"[*] 成功更新了 {len(bulk_ops)} 条要素的 {len(result_col_names)} 个属性！")

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



# ==========================================
# 数据透视和绘图的可扩展

# 透视与绘图的输入数据模型
class PivotInput(BaseModel):
    python_code: str
    file_ids: List[str]
    parameters: Optional[Dict[str, Any]] = {}

class ChartInput(BaseModel):
    python_code: str
    data: List[Dict[str, Any]] # Node.js 传来的 JSON 数组
    parameters: Optional[Dict[str, Any]] = {}

# 数据透视引擎 (只读数据库)
@app.post("/api/models/pivot_only")
async def execute_pivot_only(payload: PivotInput):
    start_time = time.time()
    try:
        gdf_dict = {}
        print(f"\n[Pivot Sandbox] 收到透视任务，准备提取 {len(payload.file_ids)} 个文件的数据...")
        
        # 1. 循环拉取所有被选中的文件，组装成字典
        for fid in payload.file_ids:
            cursor = db.features.find({"fileId": ObjectId(fid)})
            df_data = []
            for doc in cursor:
                row = {"_id": str(doc["_id"]), "_geometry": doc.get("geometry")}
                props = doc.get("properties", {})
                row.update(props) # 把 properties 拍平拉出来
                df_data.append(row)
                
            if not df_data:
                continue
                
            df = pd.DataFrame(df_data)
            
            # 空间几何列恢复
            if '_geometry' in df.columns:
                df['geometry'] = df['_geometry'].apply(
                    lambda g: shape(g) if isinstance(g, dict) and g.get('type') else None
                )
                df = gpd.GeoDataFrame(df, geometry='geometry')
                if df.crs is None:
                    df.set_crs(epsg=4326, inplace=True)
                df.drop(columns=['_geometry'], inplace=True)
                
            # 将组装好的 GeoDataFrame 放入字典，键名为 fileId
            gdf_dict[fid] = df

        if not gdf_dict:
            raise ValueError("所有传入的文件ID均未在数据库中找到数据！")

        print("[Pivot Sandbox] 数据装载完毕，正在执行 AI 动态算子...")

        # 2. 安全沙盒环境准备 (自动注入常用的包，防止 AI 忘记 import)
        exec_globals = {
            "pd": pd, "gpd": gpd, "np": np, "math": math
        }
        local_scope = {}
        
        # 3. 动态执行 AI 生成的代码
        exec(payload.python_code, exec_globals, local_scope)
        
        if 'execute_pivot' not in local_scope:
            raise ValueError("AI 生成的代码中未找到主函数 'execute_pivot'！")
            
        execute_pivot = local_scope['execute_pivot']
        
        # 4. 执行透视计算！
        result_data = execute_pivot(gdf_dict, payload.parameters)
        
        print(f"[Pivot Sandbox] 透视成功！生成了 {len(result_data)} 条高度聚合数据。耗时: {round((time.time() - start_time)*1000, 2)}ms")
        
        return {
            "status": "success",
            "data": result_data # 直接返回 List of Dicts
        }

    except Exception as e:
        print(f"\n{'='*50}")
        print(f"内存透视算子执行崩溃，AI 写的代码如下:\n{payload.python_code}")
        traceback.print_exc()
        print(f"{'='*50}\n")
        raise HTTPException(status_code=500, detail=str(e))


# 绘图引擎 (脱离数据库，只认数据)
@app.post("/api/models/chart_only")
async def execute_chart_only(payload: ChartInput):
    start_time = time.time()
    try:
        print(f"\n[Chart Sandbox] 收到绘图任务，传入了 {len(payload.data)} 条聚合数据样本...")
        
        # 1. 把 Node.js 传来的 JSON 直接转回 Pandas DataFrame
        df = pd.DataFrame(payload.data)
        
        # 2. 准备绘图沙盒 (给 AI 准备好画笔)
        exec_globals = {
            "pd": pd, "np": np, 
            "px": px, "go": go, "folium": folium
        }
        local_scope = {}
        
        # 3. 动态执行 AI 写的绘图代码
        exec(payload.python_code, exec_globals, local_scope)
        
        if 'execute_chart' not in local_scope:
            raise ValueError("AI 生成的代码中未找到主函数 'execute_chart'！")
            
        execute_chart = local_scope['execute_chart']
        
        # 4. 执行画图！
        result_dict = execute_chart(df, payload.parameters)
        
        if "html_string" not in result_dict:
            raise ValueError("大模型未按规范返回包含 'html_string' 的字典！")
            
        print(f"[Chart Sandbox] 绘图渲染成功！耗时: {round((time.time() - start_time)*1000, 2)}ms")
        
        return {
            "status": "success",
            "html_string": result_dict["html_string"]
        }

    except Exception as e:
        print(f"\n{'='*50}")
        print(f"绘图算子执行崩溃，AI 写的代码如下:\n{payload.python_code}")
        traceback.print_exc()
        print(f"{'='*50}\n")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)