import os
import json
import pickle
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import geo_expert_sdk

app = FastAPI(title="GeoAI 专业模型微服务集群")

# 契约模型 (对接 Node.js 的 case "expert" 发来的 Payload)
class ExpertRequest(BaseModel):
    data_ref: str        # e.g., "file:///tmp/geo_sandbox/pivot_result_xxx.json"
    y_variable: str      # e.g., "landslide_density"
    x_variables: list    # e.g., ["slope_level", "elevation_level"]

@app.post("/api/expert/geodetector")
def execute_geodetector(req: ExpertRequest):
    print(f"\n[Expert Microservice] 收到地理探测器运算请求!")
    print(f"-> 目标数据指针: {req.data_ref}")
    print(f"-> Y 变量: {req.y_variable}")
    print(f"-> X 变量: {req.x_variables}")
    
    try:
        # 1. 解析数据指针 (专家模型通常在 Pivot 或 Feature 之后执行，所以接手的一定是本地临时文件)
        if not req.data_ref.startswith("file://"):
            raise ValueError("地理探测器微服务只接受 file:// 格式的中间态数据指针")
            
        file_path = req.data_ref.replace("file://", "")
        
        # 2. 动态加载数据 (极度强壮：兼容 JSON, CSV 或 Pickle)
        if file_path.endswith('.json'):
            df = pd.read_json(file_path)
        elif file_path.endswith('.pkl'):
            # 如果前面传来了包含空间几何对象的 GeoPandas 字典
            with open(file_path, "rb") as f:
                gdf_dict = pickle.load(f)
                df = list(gdf_dict.values())[0]
        else:
            df = pd.read_csv(file_path)

        # 3. 执行核心物理算法 (调用 geo_expert_sdk)
        q_values_json = geo_expert_sdk.run_geodetector(df, req.y_variable, req.x_variables)
        result = json.loads(q_values_json)
        
        if isinstance(result, dict) and "error" in result:
            raise ValueError(result["error"])
            
        print(f"[Expert Microservice] 计算成功！生成 {len(result)} 个因子的解释力 Q 值。")
        return {"status": "success", "result": result}
        
    except Exception as e:
        print(f"❌ [Expert Microservice] 运算崩溃: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    # ⚠️ 极其关键：独立端口 8001，与主业务沙盒 (8000) 彻底物理隔离！
    uvicorn.run(app, host="0.0.0.0", port=8001)