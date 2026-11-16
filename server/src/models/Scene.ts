import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import pool from '../config/db';
import { transaction } from '../modules/analysis/database';

export const DEFAULT_SCENE_ID = '00000000-0000-4000-8000-000000000001';

export interface Scene {
  id: string;
  name: string;
  isDefault: boolean;
}

const sceneFields = `id, name, (id = '${DEFAULT_SCENE_ID}') AS "isDefault"`;

export const listScenes = async (): Promise<Scene[]> => {
  const result = await pool.query<Scene>(
    `SELECT ${sceneFields} FROM scenes ORDER BY "isDefault" DESC, created_at, id`,
  );
  return result.rows;
};

export const createScene = async (name: string): Promise<Scene> => {
  const result = await pool.query<Scene>(
    `INSERT INTO scenes(id, name) VALUES($1, $2) RETURNING ${sceneFields}`,
    [randomUUID(), name],
  );
  return result.rows[0];
};

export const sceneExists = async (id: string): Promise<boolean> => {
  const result = await pool.query('SELECT 1 FROM scenes WHERE id = $1', [id]);
  return result.rowCount === 1;
};

export const sceneContainsFiles = async (
  db: Pool | PoolClient, sceneId: string, fileIds: string[],
): Promise<boolean> => {
  const unique = [...new Set(fileIds)];
  const result = await db.query(
    "SELECT id FROM file_nodes WHERE scene_id = $1 AND id = ANY($2::text[]) AND type = 'file'",
    [sceneId, unique],
  );
  return result.rowCount === unique.length;
};

// Serialize changes to a scene's resource tree, including name allocation and subtree deletion.
export const lockSceneResources = async (client: PoolClient, id: string): Promise<void> => {
  await client.query('SELECT id FROM scenes WHERE id = $1 FOR NO KEY UPDATE', [id]);
};

const migrations = [
  async (client: PoolClient) => {
    await client.query(`
      CREATE TABLE scenes (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL CHECK (btrim(name) <> ''),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query('INSERT INTO scenes(id, name) VALUES($1, $2)', [DEFAULT_SCENE_ID, '默认场景']);
    // The column default also covers inserts from legacy analysis result writers.
    await client.query(`
      ALTER TABLE file_nodes
        ADD COLUMN scene_id UUID NOT NULL DEFAULT '${DEFAULT_SCENE_ID}' REFERENCES scenes(id),
        ADD CONSTRAINT geocsv_file_nodes_scene_node UNIQUE (scene_id, id);
      CREATE INDEX geocsv_file_nodes_scene_parent ON file_nodes(scene_id, parent_id);
      -- Preserve historical rows even if the old tree contained a dangling parent.
      ALTER TABLE file_nodes ADD CONSTRAINT geocsv_file_nodes_scene_parent
        FOREIGN KEY (scene_id, parent_id) REFERENCES file_nodes(scene_id, id) NOT VALID;
    `);
  },
];

export const migrateScenes = async (db: Pool): Promise<void> => {
  await transaction(db, 'BEGIN', async client => {
    await client.query('SELECT pg_advisory_xact_lock(193607248)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS geocsv_scene_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM geocsv_scene_migrations ORDER BY version',
    );
    if (rows.length > migrations.length || rows.some((row, index) => row.version !== index + 1)) {
      throw new Error('场景迁移版本记录与当前服务不兼容');
    }
    for (let index = rows.length; index < migrations.length; index++) {
      await migrations[index](client);
      await client.query('INSERT INTO geocsv_scene_migrations(version) VALUES($1)', [index + 1]);
    }
  });
};
