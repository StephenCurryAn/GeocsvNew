import pool from '../config/db';

export interface IAgentTool {
  id?: number;
  tool_name: string;
  display_name: string;
  description: string;
  api_endpoint: string;
  input_schema?: any;
  status?: 'active' | 'offline';
  created_at?: Date;
}

// 核心查询方法：给 Workflow 引擎用的
export const findToolByName = async (toolName: string): Promise<IAgentTool | null> => {
  const sql = `SELECT * FROM agent_tools WHERE tool_name = $1 AND status = 'active' LIMIT 1`;
  const result = await pool.query(sql, [toolName]);
  return result.rows.length > 0 ? result.rows[0] : null;
};

// 测试用的插入方法 (你可以用这个在代码里手动注入一条地理探测器的数据)
export const insertOrUpdateTool = async (tool: IAgentTool): Promise<IAgentTool> => {
  const sql = `
    INSERT INTO agent_tools (tool_name, display_name, description, api_endpoint, input_schema, status)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (tool_name) DO UPDATE 
    SET api_endpoint = EXCLUDED.api_endpoint,
        status = EXCLUDED.status
    RETURNING *;
  `;
  const values = [
    tool.tool_name,
    tool.display_name,
    tool.description,
    tool.api_endpoint,
    tool.input_schema ? JSON.stringify(tool.input_schema) : null,
    tool.status || 'active'
  ];
  const result = await pool.query(sql, values);
  return result.rows[0];
};