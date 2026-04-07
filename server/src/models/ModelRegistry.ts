import pool from '../config/db';

export interface IModelRegistry {
  id?: number;
  model_name: string;
  description?: string;
  parameters_schema?: any; // JSONB
  created_at?: Date;
}

export const findModelByName = async (modelName: string): Promise<IModelRegistry | null> => {
  const sql = `SELECT * FROM models_registry WHERE model_name = $1 LIMIT 1`;
  const result = await pool.query(sql, [modelName]);
  return result.rows.length > 0 ? result.rows[0] : null;
};

export const registerOrUpdateModel = async (modelData: IModelRegistry) => {
  const sql = `
    INSERT INTO models_registry (model_name, description, parameters_schema)
    VALUES ($1, $2, $3)
    ON CONFLICT (model_name) DO UPDATE 
    SET description = EXCLUDED.description,
        parameters_schema = EXCLUDED.parameters_schema
    RETURNING *;
  `;
  const values = [
    modelData.model_name, 
    modelData.description, 
    modelData.parameters_schema ? JSON.stringify(modelData.parameters_schema) : null
  ];
  const result = await pool.query(sql, values);
  return result.rows[0];
};

export const getAllModels = async (): Promise<IModelRegistry[]> => {
  const sql = `SELECT * FROM models_registry ORDER BY id ASC`;
  const result = await pool.query(sql);
  return result.rows;
};