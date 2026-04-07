import pool from '../config/db';
import path from 'path';
import { v4 as uuidv4 } from 'uuid'; //  需要 npm install uuid

// 1. 定义接口，代表 PostgreSQL file_nodes 表的每一行
export interface IFileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  parent_id: string | null;
  path?: string;
  size?: number;
  extension?: string;
  mime_type?: string;
  created_at?: Date;
}

// 辅助方法：生成一个新的带有 UUID 的文件节点对象（供 Controller 调用）
export const createFileNodeObject = (data: Partial<IFileNode>): IFileNode => {
  return {
    id: uuidv4(),
    name: data.name || '',
    type: data.type || 'file',
    parent_id: data.parent_id || null,
    path: data.path,
    size: data.size || 0,
    extension: data.extension,
    mime_type: data.mime_type
  };
};

/**
 * 插入一个新的 FileNode 记录到数据库
 */
export const insertFileNode = async (fileNode: IFileNode): Promise<IFileNode> => {
  // 如果是 file 且没有后缀，自动推导
  if (fileNode.type === 'file' && fileNode.name && !fileNode.extension) {
    fileNode.extension = path.extname(fileNode.name).toLowerCase();
  }
  
  if (fileNode.type === 'folder') {
    fileNode.extension = undefined;
    fileNode.path = undefined;
    fileNode.size = 0;
  }

  //  注意：由于用户提供的建表语句中缺少 path, extension, mime_type，
  // 我们尝试插入这些字段，如果您的实际表中没有这些字段，这句 SQL 会报错！
  // 建议在数据库里补上: ALTER TABLE file_nodes ADD COLUMN path VARCHAR, ADD COLUMN extension VARCHAR, ADD COLUMN mime_type VARCHAR;
  const sql = `
    INSERT INTO file_nodes (id, name, type, parent_id, size, path, extension, mime_type)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *;
  `;
  const values = [
    fileNode.id,
    fileNode.name,
    fileNode.type,
    fileNode.parent_id,
    fileNode.size,
    fileNode.path || null,
    fileNode.extension || null,
    fileNode.mime_type || null
  ];

  const result = await pool.query(sql, values);
  return result.rows[0];
};

/**
 * 根据条件查找文件（类似 Mongoose 的 findOne）
 */
export const findOneFileNode = async (conditions: { name?: string, parent_id?: string | null, type?: string }): Promise<IFileNode | null> => {
  let sql = `SELECT * FROM file_nodes WHERE 1=1 `;
  const values: any[] = [];
  let paramIndex = 1;

  if (conditions.name !== undefined) {
    sql += ` AND name = $${paramIndex++}`;
    values.push(conditions.name);
  }
  if (conditions.parent_id !== undefined) {
    if (conditions.parent_id === null) {
      sql += ` AND parent_id IS NULL`;
    } else {
      sql += ` AND parent_id = $${paramIndex++}`;
      values.push(conditions.parent_id);
    }
  }
  if (conditions.type !== undefined) {
    sql += ` AND type = $${paramIndex++}`;
    values.push(conditions.type);
  }

  sql += ` LIMIT 1`;
  const result = await pool.query(sql, values);
  return result.rows.length > 0 ? result.rows[0] : null;
};

/**
 * 根据 ID 查找
 */
export const findFileNodeById = async (id: string): Promise<IFileNode | null> => {
  const sql = `SELECT * FROM file_nodes WHERE id = $1`;
  const result = await pool.query(sql, [id]);
  return result.rows.length > 0 ? result.rows[0] : null;
};

/**
 * 查找所有子节点 (类似 Mongoose find({ parentId: xx }))
 */
export const findFileNodesByParent = async (parentId: string | null): Promise<IFileNode[]> => {
  let sql = ``;
  const values = [];
  if (parentId === null) {
      sql = `SELECT * FROM file_nodes WHERE parent_id IS NULL ORDER BY type DESC, name ASC`;
  } else {
      sql = `SELECT * FROM file_nodes WHERE parent_id = $1 ORDER BY type DESC, name ASC`;
      values.push(parentId);
  }
  const result = await pool.query(sql, values);
  return result.rows;
};

// ... 后续可以添加按 ID 删除、重命名等 repository 方法
export const updateFileNodeTimestamp = async (id: string): Promise<void> => {
  const sql = `UPDATE file_nodes SET created_at = CURRENT_TIMESTAMP WHERE id = $1`;
  await pool.query(sql, [id]);
};

export const deleteFileNodeById = async (id: string): Promise<void> => {
  const sql = `DELETE FROM file_nodes WHERE id = $1`;
  await pool.query(sql, [id]);
};

export const findAllFileNodes = async (): Promise<IFileNode[]> => {
  const sql = `SELECT * FROM file_nodes ORDER BY parent_id NULLS FIRST, created_at ASC`;
  const result = await pool.query(sql);
  return result.rows;
};

export const updateFileNodeName = async (id: string, name: string): Promise<IFileNode | null> => {
    const extension = path.extname(name).toLowerCase();
    const sql = `UPDATE file_nodes SET name = $1, extension = $2 WHERE id = $3 RETURNING *`;
    const result = await pool.query(sql, [name, extension || null, id]);
    return result.rows.length > 0 ? result.rows[0] : null;
};