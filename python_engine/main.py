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

from pymongo import MongoClient, UpdateOne
from bson.objectid import ObjectId

app = FastAPI(title="动态模型计算引擎")
# ==========================================
# 🌟 核心突破：配置直连 MongoDB
# ==========================================
MONGO_URI = os.getenv("MONGO_URI", "mongodb://admin:123456@172.18.0.2:27017/Geoex?authSource=admin")
DB_NAME = "Geoex" # 如果你建库时取了别的名字（如 geocsv），请改这里！
client = MongoClient(MONGO_URI)
db = client[DB_NAME]

# ==========================================
# 🌟 数据模型改造：不再接收海量 Data，只接收“指令”
# ==========================================
class ModelInput(BaseModel):
    model_name: str
    file_id: str             # ✅ Node.js 传来的文件ID
    columns: List[str]       # ✅ Node.js 告诉我们需要拉取哪些属性列
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
                # 🌟 真正的热插拔：被加载过就 reload 刷新，没加载过就 import
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

        # 每次收到请求时，如果发现模型不在内存里，强制再扫描一次硬盘！
        if model_key not in MODEL_REGISTRY:
            print(f"[!] 内存中未找到模型 {model_key}，正在扫描硬盘热加载...")
            auto_discover_models()        
            
            if model_key not in MODEL_REGISTRY:
                raise HTTPException(status_code=404, detail=f"模型 {payload.model_name} 在物理硬盘上也不存在，请先使用 AI 生成。")

        # ==========================================
        # Data Locality (数据本地化直连)
        # ==========================================
        print(f"\n[*] 正在从 MongoDB 拉取数据: fileId={payload.file_id}")
        
        # 构造精确投影 (Projection)：只把计算必须的列拉进内存，完美解决 Python 端的 OOM
        projection = {"_id": 1, "geometry": 1, "properties.id": 1}
        for col in payload.columns:
            projection[f"properties.{col}"] = 1
            
        # 直接通过 PyMongo 游标查询 features 集合
        cursor = db.features.find({"fileId": ObjectId(payload.file_id)}, projection)
        
        # 将 BSON 转换为普通平铺字典列表
        df_data = []
        for doc in cursor:
            row = {"_id": doc["_id"], "_geometry": doc.get("geometry")}
            props = doc.get("properties", {})
            
            # 提取用户请求的列，空值补 0 (继承你原有的优秀防呆设计)
            for col in payload.columns:
                val = props.get(col)
                row[col] = 0 if val is None or val == '' else val
                
            if "id" in props:
                row["id"] = props["id"]
                
            df_data.append(row)
            
        if not df_data:
            raise HTTPException(status_code=400, detail="未在数据库中找到对应文件的数据")

        # 转换为 DataFrame
        df = pd.DataFrame(df_data)
        
        # ==========================================
        # 🌟 空间觉醒 (保持你原有的逻辑不变)
        # ==========================================
        if '_geometry' in df.columns:
            df['geometry'] = df['_geometry'].apply(lambda g: shape(g) if isinstance(g, dict) and g.get('type') else None)
            df = gpd.GeoDataFrame(df, geometry='geometry')
            df.set_crs(epsg=4326, inplace=True, allow_override=True)
            df.drop(columns=['_geometry'], inplace=True)

        # 执行模型核心逻辑
        print(f"[*] 开始执行空间分析: {model_key}")
        target_func = MODEL_REGISTRY[model_key]
        raw_result_dict = target_func(df, payload.parameters)

        # ==========================================
        # Python 原地异步写回数据库(支持多列)
        # ==========================================
        print("[*] 计算完成，正在打包回写 MongoDB...")

        result_col_names = list(raw_result_dict.keys())
        bulk_ops = []
        result_data = [] # 扁平化数据： [{"id": "xxx", "col1": 1, "col2": 2}]
        
        # 预处理：把可能的 numpy array 全部转成 list
        for col_name, col_data in raw_result_dict.items():
            if hasattr(col_data, 'tolist'):
                raw_result_dict[col_name] = col_data.tolist()
                
        # 逐行构造多字段更新指令
        for index, row in df.iterrows():
            doc_id = row['_id']
            row_id = row.get('id', str(doc_id))
            
            update_fields = {}
            row_scores = {"id": row_id}
            
            # 遍历这行数据的所有新增列
            for col_name in result_col_names:
                x = raw_result_dict[col_name][index]
                # 安全的数值转换 (处理 numpy 的 float64 和 pandas 的 NaT/NaN)
                if pd.isna(x):
                    score = None
                elif hasattr(x, 'item'):
                    score = x.item()
                else:
                    score = x
                    
                update_fields[f"properties.{col_name}"] = score
                row_scores[col_name] = score
                
            result_data.append(row_scores)
            
            # 构造 MongoDB 更新指令（一次性 $set 多个属性）
            bulk_ops.append(
                UpdateOne(
                    {"_id": doc_id},
                    {"$set": update_fields}
                )
            )
        
        # Python 执行极速批量写入，不需要 Node.js 插手！
        if bulk_ops:
            db.features.bulk_write(bulk_ops)
        
        print(f"[*] 成功更新了 {len(bulk_ops)} 条要素的 {len(result_col_names)} 个属性！")

        # 将多列的轻量级结果回传给 Node 网关
        return {
            "status": "success",
            "result_col_names": result_col_names, # ✅ 返回列名数组
            "result_data": result_data,           # ✅ 返回多字段数据包
            "execution_time_ms": (time.time() - start_time) * 1000
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