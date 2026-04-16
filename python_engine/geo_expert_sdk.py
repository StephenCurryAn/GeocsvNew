import pandas as pd
import json

def run_geodetector(df, y_col, x_cols):
    """
    【学术级专家模型：地理探测器 (Geodetector)】
    原生纯净实现，用于计算自变量 X 对因变量 Y 的空间分异解释力 (Q值)
    公式: Q = 1 - (Sum of strata variances / Total variance)
    """
    if df.empty or y_col not in df.columns:
        return json.dumps({"error": f"缺少目标列 {y_col}"})
        
    # 1. 提取有效列，并清洗掉任何含有空值的行（地探要求数据绝对完整）
    valid_cols = [y_col] + [x for x in x_cols if x in df.columns]
    df_clean = df[valid_cols].dropna()
    
    if len(df_clean) < 2:
        return json.dumps({"error": "剔除空值后，有效样本数过少"})
        
    # 2. 计算全局总体方差 (SS_total) = 样本方差 * 样本数
    total_var = df_clean[y_col].var(ddof=0) * len(df_clean)
    
    if total_var == 0:
        return json.dumps([{"factor": x, "q_value": 0} for x in x_cols])
        
    results = []
    for x in x_cols:
        if x not in df_clean.columns: 
            continue
        
        # 3. 按自变量 X (必须为离散/分级数据) 进行分层
        strata_var_sum = 0
        grouped = df_clean.groupby(x)
        
        for name, group in grouped:
            # 计算层内方差之和 (SS_within)
            if len(group) > 1:
                strata_var_sum += group[y_col].var(ddof=0) * len(group)
            
        # 4. 计算最终 Q 值核心公式
        q_value = 1 - (strata_var_sum / total_var)
        
        results.append({
            "factor": x, 
            "q_value": round(max(0, float(q_value)), 4) # 防止极小负数浮点误差
        })
        
    # 5. 按解释力 Q 值降序排序
    results.sort(key=lambda item: item['q_value'], reverse=True)
    return json.dumps(results)