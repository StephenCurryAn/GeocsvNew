import type { PoolClient } from 'pg';
import pool from '../config/db';
import { transaction } from '../modules/analysis/database';
import { readDataset } from '../modules/spatialPivot/datasets';

export interface IFeature {
  id?: number;
  file_id: string;
  properties: any;
  geom: any; // GeoJSON geometry 格式
}

/**
 * 批量插入空间数据到 PostGIS
 * @param fileId 文件节点ID
 * @param features GeoJSON 的 features 数组
 */
export const insertFeaturesBatch = async (fileId: string, features: any[], client?: PoolClient): Promise<void> => {
  const insert = async (db: PoolClient) => {
    // Stay below PostgreSQL's 65535-parameter limit (3 parameters per feature).
    for (let offset = 0; offset < features.length; offset += 5000) {
      const values: unknown[] = [];
      const rows = features.slice(offset, offset + 5000).map(feature => {
        const firstParameter = values.length + 1;
        values.push(fileId, feature.geometry ? JSON.stringify(feature.geometry) : null,
          feature.properties ? JSON.stringify(feature.properties) : null);
        return `($${firstParameter}, ST_GeomFromGeoJSON($${firstParameter + 1}), $${firstParameter + 2})`;
      });
      await db.query(`INSERT INTO spatial_features (file_id, geom, properties) VALUES ${rows.join(', ')}`, values);
    }
  };

  if (client) await insert(client);
  else await transaction(pool, 'BEGIN', insert);
};

/**
 * 根据文件 ID 查找所有空间要素 (并将 PostGIS geometry 转换回 GeoJSON)
 */
export const findFeaturesByFileId = async (fileId: string): Promise<any[]> => {
  // 使用 ST_AsGeoJSON 转换回前端和沙盒识别的标准格式
  const sql = `
    SELECT 
        id, 
        file_id, 
        properties, 
        ST_AsGeoJSON(geom)::jsonb AS geometry
    FROM spatial_features
    WHERE file_id = $1
  `;
  const result = await pool.query(sql, [fileId]);
  
  // 组装回 GeoJSON Feature 格式
  return result.rows.map(row => ({
    type: 'Feature',
    id: row.id,
    geometry: row.geometry, // ST_AsGeoJSON 已经转成了纯对象
    properties: row.properties || {}
  }));
};

/**
 * 获取某个文件下的要素（分页）
 */
export const findFeaturesPaginated = async (fileId: string, skip: number, limit: number): Promise<any[]> => {
  const sql = `
    SELECT 
        id, 
        file_id, 
        properties, 
        ST_AsGeoJSON(geom)::jsonb AS geometry
    FROM spatial_features
    WHERE file_id = $1
    ORDER BY id ASC
    OFFSET $2 LIMIT $3
  `;
  const result = await pool.query(sql, [fileId, skip, limit]);
  return result.rows.map(row => ({
    type: 'Feature',
    id: row.id,
    geometry: row.geometry,
    properties: row.properties || {}
  }));
};

/** Locate a feature using the same ID ordering as the attribute table. */
export const findFeatureOffset = async (fileId: string, featureId: number): Promise<number | undefined> => {
  const result = await pool.query<{ preceding: string }>(`
    SELECT (SELECT COUNT(*) FROM spatial_features WHERE file_id = $1 AND id < $2) AS preceding
    FROM spatial_features WHERE file_id = $1 AND id = $2
  `, [fileId, featureId]);
  return result.rows[0] ? Number(result.rows[0].preceding) : undefined;
};

export const getFileExtent = async (fileId: string): Promise<[number, number, number, number] | null> => {
  const result = await pool.query<{ bounds: [number, number, number, number] | null }>(`
    SELECT CASE WHEN extent IS NOT NULL
      THEN ARRAY[ST_XMin(extent), ST_YMin(extent), ST_XMax(extent), ST_YMax(extent)]
    END AS bounds
    FROM (SELECT ST_Extent(geom) AS extent FROM spatial_features WHERE file_id = $1) AS layer_extent
  `, [fileId]);
  return result.rows[0].bounds;
};

/** 统计总数 */
export const getFileGeometryTypes = async (fileId: string): Promise<string[]> => {
  const { rows } = await pool.query<{ types: string[] }>(
    `SELECT COALESCE(array_agg(DISTINCT ST_GeometryType(geom)), '{}') AS types
     FROM spatial_features WHERE file_id = $1 AND geom IS NOT NULL`, [fileId],
  );
  return rows[0].types;
};

export const countFeaturesByFileId = async (fileId: string): Promise<number> => {
  const sql = `SELECT COUNT(*) FROM spatial_features WHERE file_id = $1`;
  const result = await pool.query(sql, [fileId]);
  return parseInt(result.rows[0].count, 10);
};

export const updateFeatureProperty = async (file_id: string, record_id: string, updateFields: Record<string, any>) => {
  const patch: Record<string, any> = {};
  const reservedKeys = new Set(['id', 'rowKey', '__record_id__']);
  
  for (const [k, v] of Object.entries(updateFields)) {
    const keyName = k.replace('properties.', '');
    if (reservedKeys.has(keyName)) continue;
    patch[keyName] = v;
  }

  if (Object.keys(patch).length === 0) return true;

  const sql = `
    UPDATE spatial_features
    SET properties = properties || $3::jsonb
    WHERE file_id = $1::text
      AND (id::text = $2::text OR properties->>'id' = $2::text)
  `;
  
  await pool.query(sql, [file_id, String(record_id), JSON.stringify(patch)]);
  return true;
};

export const updateFeaturePropertiesBatch = async (
  file_id: string,
  rows: Array<{ id: string | number; patch: Record<string, any> }>,
  batchSize = 1000
) => {
  const reservedKeys = new Set(['id', 'rowKey', '__record_id__']);
  const sanitizedRows = rows
    .map(row => ({
      id: String(row.id),
      patch: Object.fromEntries(
        Object.entries(row.patch || {})
          .map(([k, v]) => [k.replace('properties.', ''), v] as const)
          .filter(([k]) => !reservedKeys.has(k))
      )
    }))
    .filter(row => row.id && Object.keys(row.patch).length > 0);

  if (sanitizedRows.length === 0) return 0;

  const client = await pool.connect();
  let updatedCount = 0;

  try {
    await client.query('BEGIN');

    for (let i = 0; i < sanitizedRows.length; i += batchSize) {
      const chunk = sanitizedRows.slice(i, i + batchSize);
      const sql = `
        WITH updates AS (
          SELECT record_id, patch
          FROM jsonb_to_recordset($2::jsonb) AS x(record_id text, patch jsonb)
        )
        UPDATE spatial_features sf
        SET properties = sf.properties || updates.patch
        FROM updates
        WHERE sf.file_id = $1::text
          AND (sf.id::text = updates.record_id OR sf.properties->>'id' = updates.record_id)
      `;
      const payload = chunk.map(row => ({ record_id: row.id, patch: row.patch }));
      const result = await client.query(sql, [file_id, JSON.stringify(payload)]);
      updatedCount += result.rowCount || 0;
    }

    await client.query('COMMIT');
    return updatedCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const countMatchingFeatureIds = async (
  file_id: string,
  ids: Array<string | number>
): Promise<number> => {
  const normalizedIds = Array.from(
    new Set(ids.map(id => String(id)).filter(id => id.length > 0))
  );

  if (normalizedIds.length === 0) return 0;

  const sql = `
    SELECT COUNT(*)::int AS match_count
    FROM spatial_features
    WHERE file_id = $1::text
      AND (id::text = ANY($2::text[]) OR properties->>'id' = ANY($2::text[]))
  `;
  const result = await pool.query(sql, [file_id, normalizedIds]);
  return Number(result.rows[0]?.match_count || 0);
};

export const renameColumnInFeatures = async (fileId: string, oldName: string, newName: string) => {
  const sql = `
    UPDATE spatial_features
    SET properties = (properties - $2::text) || jsonb_build_object($3::text, properties->$2::text)
    WHERE file_id = $1 AND properties ? $2::text
  `;
  await pool.query(sql, [fileId, oldName, newName]);
};

export const unsetFeatureProperty = async (fileId: string, fieldName: string) => {
    const keyName = fieldName.replace('properties.', '');
    const sql = `
        UPDATE spatial_features 
        SET properties = properties - $2
        WHERE file_id = $1
    `;
    await pool.query(sql, [fileId, keyName]);
};

export const insertSingleFeature = async (feature: any) => {
    const sql = `
        INSERT INTO spatial_features (file_id, geom, properties)
        VALUES ($1, ST_GeomFromGeoJSON($2), $3)
        RETURNING *
    `;
    const geomJson = feature.geometry ? JSON.stringify(feature.geometry) : null;
    const propsJson = feature.properties ? JSON.stringify(feature.properties) : null;
    const result = await pool.query(sql, [feature.fileId, geomJson, propsJson]);
    return result.rows[0];
};

export const deleteFeatureByPropertyId = async (fileId: string, recordId: string) => {
    const sql = `DELETE FROM spatial_features WHERE file_id = $1 AND properties->>'id' = $2`;
    const result = await pool.query(sql, [fileId, recordId]);
    return result.rowCount !== null ? result.rowCount : 0;
};


/**
  * 删除文件相关的全部空间数据
  */
export const deleteFeaturesByFileId = async (fileId: string) => {
  const sql = `DELETE FROM spatial_features WHERE file_id = $1`;
  await pool.query(sql, [fileId]);
};

export const addColumnToFeatures = async (fileId: string, fieldName: string, defaultValue: any) => {
    const keyName = fieldName.replace('properties.', '');
    // Only update where the key does not exist yet to mirror $exists: false
    const sql = `
        UPDATE spatial_features
        SET properties = properties || jsonb_build_object($2::text, $3::jsonb)
        WHERE file_id = $1 AND NOT (properties ? $2::text)
    `;
    await pool.query(sql, [fileId, keyName, JSON.stringify(defaultValue || '')]);
};

export const deleteColumnFromFeatures = async (fileId: string, fieldName: string) => {
    const keyName = fieldName.replace('properties.', '');
    const sql = `
        UPDATE spatial_features
        SET properties = properties - $2::text
        WHERE file_id = $1
    `;
    await pool.query(sql, [fileId, keyName]);
};

/**
 * 提取指定文件的轻量级 Schema 摘要 (供大模型作为上下文)
 */
export const getFileSchemaSummary = async (fileId: string) => {
    const fileNodeSql = `SELECT name, extension FROM file_nodes WHERE id = $1`;
    const fnResult = await pool.query(fileNodeSql, [fileId]);
    const fileName = fnResult.rows[0]?.name || 'Unknown';
    const fileExt = fnResult.rows[0]?.extension?.toLowerCase() || '';

    if (fileExt === '.tif' || fileExt === '.tiff') {
        return { 
            fileId, 
            name: fileName, 
            geomType: 'Raster (.tif)', 
            columns: ['Pixel_Value (Continuous Elevation/Data)'] // 告诉大模型这里面存的是像素值
        };
    }
    
    const dataset = await readDataset(pool, fileId);
    return {
        fileId, name: fileName,
        geomType: dataset.geometryTypes.map(type => type.replace('ST_', '')).join(', ') || 'Unknown',
        columns: dataset.fields.filter(key => key !== 'id'),
        featureCount: dataset.featureCount,
    };
};

/**
 * 生成 MVT (Mapbox Vector Tile) 二进制瓦片
 * 利用 PostGIS 的 ST_AsMVT + ST_TileEnvelope 在数据库层直接切片
 * @param fileId 文件ID
 * @param z 缩放级别
 * @param x 瓦片X坐标
 * @param y 瓦片Y坐标
 * @returns Buffer 二进制矢量瓦片数据
 */
export const getMVTTile = async (
  fileId: string,
  z: number,
  x: number,
  y: number
): Promise<Buffer> => {
  // ST_TileEnvelope(z, x, y) 生成瓦片的 EPSG:3857 边界框
  // ST_AsMVT 把 geometry 压缩为 Mapbox Vector Tile 二进制格式
  // ST_AsMVTGeom 把原始几何转换到瓦片坐标系（0-4096）
  const sql = `
    WITH tile_bounds AS (
      SELECT ST_TileEnvelope($2, $3, $4) AS bounds
    ),
    clipped AS (
      SELECT
        sf.id,
        sf.properties,
        ST_AsMVTGeom(
          ST_Transform(sf.geom, 3857),
          tile_bounds.bounds,
          4096,   -- 瓦片分辨率 (标准 4096)
          256,    -- 缩冲距离
          true    -- 剪切几何
        ) AS mvt_geom
      FROM spatial_features sf, tile_bounds
      WHERE sf.file_id = $1
        AND ST_Transform(sf.geom, 3857) && ST_Expand(tile_bounds.bounds, 256)
        AND ST_AsMVTGeom(
              ST_Transform(sf.geom, 3857),
              tile_bounds.bounds, 4096, 256, true
            ) IS NOT NULL
    )
    SELECT ST_AsMVT(clipped.*, 'features', 4096, 'mvt_geom') AS mvt
    FROM clipped
  `;

  const result = await pool.query(sql, [fileId, z, x, y]);
  return result.rows[0]?.mvt || Buffer.alloc(0);
};
