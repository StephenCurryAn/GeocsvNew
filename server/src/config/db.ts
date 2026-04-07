import { Pool } from 'pg';

// 1. 创建 PostgreSQL 连接池
const pool = new Pool({
  user: 'geocsv',             // 你在 Docker 中设置的用户名
  host: '127.0.0.1',          // 本地地址 (避免 localhost 解析问题)
  database: 'geocsv',         // 你在 Docker 中设置的数据库名
  password: 'geocsv',         // 你在 Docker 中设置的密码
  port: 5432,

  // 连接池优化配置
  max: 20,                    // 最大并发连接数
  idleTimeoutMillis: 30000,   // 空闲连接释放时间
  connectionTimeoutMillis: 2000, // 连接超时时间
});

// 监听连接池状态
pool.on('connect', () => {
  console.log('[Database] PostgreSQL 连接池分配成功');
});

pool.on('error', (err) => {
  console.error('[Database] PostgreSQL 连接池发生意外错误', err);
  process.exit(-1);
});

// 2. 导出一个统一的 SQL 执行辅助函数 (防 SQL 注入)
export const query = async (text: string, params?: any[]) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  // 如果查询超过 500ms，打印慢查询日志帮助排查卡顿
  if (duration > 500) {
    console.warn(`[Slow Query] executed query: { text: ${text}, duration: ${duration}ms, rows: ${res.rowCount} }`);
  }
  return res;
};

// 3. 替换你原来的 connectDB 函数，用于 index.ts 启动时的验证
export const connectDB = async (): Promise<void> => {
  try {
    // 测试连接，并顺便查一下 PostGIS 的版本，确认空间扩展正常
    const res = await pool.query('SELECT PostGIS_Version();');
    console.log(`[Database] 成功连接 PostGIS! 版本: ${res.rows[0].postgis_version}`);
  } catch (error) {
    console.error('[Database] 数据库连接失败或未安装 PostGIS 扩展:', error);
    process.exit(1);
  }
};

export default pool;