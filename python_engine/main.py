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

app = FastAPI(title="动态模型计算引擎")
# ==========================================
#   核心突破：配置直连 MongoDB
# ==========================================
MONGO_URI = os.getenv("MONGO_URI", "mongodb://admin:123456@172.18.0.2:27017/Geoex?authSource=admin")
DB_NAME = "Geoex" # 如果你建库时取了别的名字（如 geocsv），请改这里！
client = MongoClient(MONGO_URI)
db = client[DB_NAME]

# ==========================================
#   数据模型改造：不再接收海量 Data，只接收“指令”
# ==========================================
class ModelInput(BaseModel):
    model_name: str
    file_id: str             #   Node.js 传来的文件ID
    columns: List[str]       #   Node.js 告诉我们需要拉取哪些属性列
    parameters: Dict[str, Any]

MODEL_REGISTRY = {}

# ==========================================
# 模型热发现与重载机制
# ==========================================
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)