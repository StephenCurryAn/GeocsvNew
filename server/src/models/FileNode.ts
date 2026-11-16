import type { Pool, PoolClient } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pool from '../config/db';
import { DEFAULT_SCENE_ID } from './Scene';

type Connection = Pool | PoolClient;

export interface IFileNode {
  id: string;
  scene_id: string;
  name: string;
  type: 'file' | 'folder';
  parent_id: string | null;
  path?: string;
  size?: number;
  extension?: string;
  mime_type?: string;
  created_at?: Date;
}

export const createFileNodeObject = (data: Partial<IFileNode>): IFileNode => ({
  id: randomUUID(),
  scene_id: data.scene_id ?? DEFAULT_SCENE_ID,
  name: data.name ?? '',
  type: data.type ?? 'file',
  parent_id: data.parent_id ?? null,
  path: data.path,
  size: data.size ?? 0,
  extension: data.extension,
  mime_type: data.mime_type,
});

export const insertFileNode = async (node: IFileNode, db: Connection = pool): Promise<IFileNode> => {
  const isFile = node.type === 'file';
  const extension = isFile ? node.extension || path.extname(node.name).toLowerCase() || null : null;
  const result = await db.query<IFileNode>(`
    INSERT INTO file_nodes (id, scene_id, name, type, parent_id, size, path, extension, mime_type)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `, [node.id, node.scene_id, node.name, node.type, node.parent_id,
    isFile ? node.size : 0, isFile ? node.path : null, extension, node.mime_type]);
  return result.rows[0];
};

export const findSiblingNames = async (
  sceneId: string, parentId: string | null, type: IFileNode['type'], db: Connection,
): Promise<Set<string>> => {
  const result = await db.query<{ name: string }>(`
    SELECT name FROM file_nodes
    WHERE scene_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND type = $3
  `, [sceneId, parentId, type]);
  return new Set(result.rows.map(row => row.name));
};

export const findFileNodeById = async (
  id: string, sceneId?: string, db: Connection = pool,
): Promise<IFileNode | null> => {
  const result = sceneId
    ? await db.query<IFileNode>('SELECT * FROM file_nodes WHERE id = $1 AND scene_id = $2', [id, sceneId])
    : await db.query<IFileNode>('SELECT * FROM file_nodes WHERE id = $1', [id]);
  return result.rows[0] ?? null;
};

export const updateFileNodeTimestamp = async (id: string): Promise<void> => {
  await pool.query('UPDATE file_nodes SET created_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
};

export const findAllFileNodes = async (sceneId: string): Promise<IFileNode[]> => {
  const result = await pool.query<IFileNode>(`
    SELECT * FROM file_nodes WHERE scene_id = $1 ORDER BY parent_id NULLS FIRST, created_at, id
  `, [sceneId]);
  return result.rows;
};

export const updateFileNodeName = async (
  id: string, sceneId: string, name: string, db: Connection,
): Promise<IFileNode> => {
  // A display name change leaves the on-disk format and path intact.
  const result = await db.query<IFileNode>(
    'UPDATE file_nodes SET name = $1 WHERE id = $2 AND scene_id = $3 RETURNING *', [name, id, sceneId],
  );
  return result.rows[0];
};

export const deleteFileSubtree = async (id: string, sceneId: string, db: Connection): Promise<IFileNode[]> => {
  const result = await db.query<IFileNode>(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM file_nodes WHERE scene_id = $1 AND id = $2
      UNION
      SELECT node.id FROM file_nodes node
      JOIN subtree ON subtree.id = node.parent_id
      WHERE node.scene_id = $1
    )
    DELETE FROM file_nodes WHERE scene_id = $1 AND id IN (SELECT id FROM subtree)
    RETURNING *
  `, [sceneId, id]);
  return result.rows;
};
