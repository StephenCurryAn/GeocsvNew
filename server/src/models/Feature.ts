import pool from '../config/db';

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
export const insertFeaturesBatch = async (fileId: string, features: any[]) => {
  // PostGIS 需要将 GeoJSON 的 geometry 转换为 WKT 或者直接识别 JSON
  // ST_GeomFromGeoJSON() 可以非常方便地解析 GeoJSON 格式字符串入库
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 如果数据量巨大，更推荐用 pg-copy-streams，这里先用批量插入的简单拼装法 (如果上万条可能会慢，后续可优化)
    const values: any[] = [];
    const queryParts: string[] = [];
    
    let paramIndex = 1;
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      // geometry 可能是 null (如单纯的 CSV 行)
      const geomJson = f.geometry ? JSON.stringify(f.geometry) : null;
      const propsJson = f.properties ? JSON.stringify(f.properties) : null;
      
      queryParts.push(`($${paramIndex++}, ST_GeomFromGeoJSON($${paramIndex++}), $${paramIndex++})`);
      values.push(fileId, geomJson, propsJson);
      
      // 做简单的分批，防止参数过多报错 (Postgres 一个查询最多支持 65535 个参数)
      // 我们每条有 3 个参数，65535/3 = 21845 条。保险起见每 5000 条执行一次
      if (queryParts.length >= 5000 || i === features.length - 1) {
        const sql = `
          INSERT INTO spatial_features (file_id, geom, properties)
          VALUES ${queryParts.join(', ')}
        `;
        await client.query(sql, values);
        
        // 清空继续
        queryParts.length = 0;
        values.length = 0;
        paramIndex = 1;
      }
    }
    
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

/**
 * 统计总数
 */
export const countFeaturesByFileId = async (fileId: string): Promise<number> => {
  const sql = `SELECT COUNT(*) FROM spatial_features WHERE file_id = $1`;
  const result = await pool.query(sql, [fileId]);
  return parseInt(result.rows[0].count, 10);
};

export const updateFeatureProperty = async (file_id: string, record_id: string, updateFields: Record<string, any>) => {
  const patch: Record<string, any> = {};
  
  for (const [k, v] of Object.entries(updateFields)) {
    const keyName = k.replace('properties.', '');
    patch[keyName] = v;
  }

  if (Object.keys(patch).length === 0) return true;

  const sql = `
    UPDATE spatial_features 
    SET properties = properties || $3::jsonb
    WHERE file_id = $1::text AND properties->>'id' = $2::text
  `;
  
  await pool.query(sql, [file_id, String(record_id), JSON.stringify(patch)]);
  return true;
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
    
    // 2. 获取一次空间数据的几何类型与属性 JSONB 键
    const featureSql = `
        SELECT ST_GeometryType(geom) as geom_type, properties
        FROM spatial_features
        WHERE file_id = $1
        LIMIT 1
    `;
    const featResult = await pool.query(featureSql, [fileId]);
    
    if (featResult.rowCount === 0) {
        return { fileId, name: fileName, geomType: 'Unknown', columns: [] };
    }

    const row = featResult.rows[0];
    const columns = row.properties ? Object.keys(row.properties).filter(k => k !== 'id') : [];
    let geomType = row.geom_type ? row.geom_type.replace('ST_', '') : 'Unknown';
    
    return { fileId, name: fileName, geomType, columns };
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