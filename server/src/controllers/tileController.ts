import { Request, Response } from 'express';
import { query } from '../config/db';

/**
 * 动态矢量瓦片 MVT 接口封装
 * /api/tiles/:fileId/:z/:x/:y
 */
export const getVectorTile = async (req: Request, res: Response): Promise<void> => {
    try {
        const { fileId, z, x, y } = req.params;

        if (!fileId || !z || !x || !y) {
             res.status(400).json({ error: "Missing required parameters: fileId, z, x, y" });
             return;
        }

        const zInt = parseInt(z as string, 10);
        const xInt = parseInt(x as string, 10);
        const yInt = parseInt(y as string, 10);

        // SQL 利用 PostGIS 提供的高效内置函数 ST_TileEnvelope 和 ST_AsMVT
        // ST_TileEnvelope() 生成当前瓦片的边界矩形，使用 Web Mercator EPSG:3857。
        // 由于我们的数据存储为 4326，必须将其 ST_Transform(geom, 3857) 后才能被正确匹配并切分。
        const tileQuery = `
            WITH bounds AS (
                SELECT ST_TileEnvelope($2, $3, $4) AS geom
            ),
            mvtgeom AS (
                SELECT 
                    id, 
                    properties,
                    ST_AsMVTGeom(
                        ST_Transform(s.geom, 3857), 
                        bounds.geom, 
                        4096, 
                        256, 
                        true
                    ) AS geom
                FROM spatial_features s, bounds
                WHERE s.file_id = $1 
                -- 空间过滤：交集判断 (使用 3857 与 bound 判断)
                AND ST_Intersects(ST_Transform(s.geom, 3857), bounds.geom)
            )
            SELECT ST_AsMVT(mvtgeom, 'default_layer') AS tile 
            FROM mvtgeom;
        `;

        const { rows } = await query(tileQuery, [fileId, zInt, xInt, yInt]);

        if (rows.length === 0 || !rows[0].tile) {
            // 如果此瓦片范围没有数据，需返回 HTTP 204 No Content，以便 MapboxGL 正常处理而不报 404
             res.status(204).send();
             return;
        }

        // 获取底层的二进制 Buffer
        const tileBuffer = rows[0].tile;

        res.setHeader('Content-Type', 'application/x-protobuf');
        res.setHeader('Content-Disposition', 'inline');
        // 加入缓存控制提高前端体验
        res.setHeader('Cache-Control', 'public, max-age=3600');
        
        res.send(tileBuffer);
    } catch (error) {
        console.error(`[MVT Error] Failed to generate map tile for ${req.params.fileId}:`, error);
        res.status(500).send("Internal Server Error generating tile");
    }
};
