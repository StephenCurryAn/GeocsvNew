"""Compatibility endpoint for the original spatial autocorrelation statistics."""

import json
import time
import traceback
from typing import List, Optional

import geopandas as gpd
import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from vector_data import engine, flatten_vector_frame


router = APIRouter()


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


@router.post("/api/models/spatial_autocorrelation")
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

        df = flatten_vector_frame(df)

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
