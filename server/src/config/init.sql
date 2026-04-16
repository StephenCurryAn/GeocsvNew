-- 1. 开启核心：启用 PostGIS 空间扩展
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. 创建文件/目录树表 (替代原 MongoDB 的 FileNode)
CREATE TABLE IF NOT EXISTS file_nodes (
    id VARCHAR(50) PRIMARY KEY,       -- 文件ID (可以继续用类似原先的 uuid)
    name VARCHAR(255) NOT NULL,       -- 文件或文件夹名称
    type VARCHAR(20) NOT NULL,        -- 'file' 或 'folder'
    parent_id VARCHAR(50),            -- 父级目录ID，如果是根目录则为空
    size INTEGER DEFAULT 0,           -- 文件大小
    path VARCHAR(1024),               -- 物理存储路径
    extension VARCHAR(50),            -- 文件后缀
    mime_type VARCHAR(100),           -- 文件 MIME 类型
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. 创建混合存储结构的核心表
CREATE TABLE IF NOT EXISTS spatial_features (
    id SERIAL PRIMARY KEY,
    file_id VARCHAR(50) NOT NULL,
    geom GEOMETRY(Geometry, 4326),  -- 强制存储为 EPSG:4326 坐标系的空间对象
    properties JSONB,               -- 用 JSONB 存储所有动态的不规则属性
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_file_node FOREIGN KEY (file_id) REFERENCES file_nodes(id) ON DELETE CASCADE
);

-- 4. 创建三大核心索引（系统未来不卡顿的关键）
-- 提升按 file_id 过滤的查询速度
CREATE INDEX IF NOT EXISTS idx_spatial_features_file_id ON spatial_features USING btree (file_id);
-- 提升空间计算和矢量瓦片切片的速度（极其重要）
CREATE INDEX IF NOT EXISTS idx_spatial_features_geom ON spatial_features USING gist (geom);
-- 提升对 properties 内部某个属性透视查询的速度
CREATE INDEX IF NOT EXISTS idx_spatial_features_properties ON spatial_features USING gin (properties);


-- 5. 创建模型算子表 (替代原 MongoDB 的 ModelRegistry)
CREATE TABLE IF NOT EXISTS models_registry (
    id SERIAL PRIMARY KEY,
    model_name VARCHAR(100) UNIQUE NOT NULL, -- 算子名称，例如 CALCULATE_AREA
    description TEXT,                        -- 算子描述
    parameters_schema JSONB,                 -- 算子所需的参数配置(前端渲染面板用)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. 创建智能体外部工具/微服务注册表 (Agent Tools)
CREATE TABLE IF NOT EXISTS agent_tools (
    id SERIAL PRIMARY KEY,
    tool_name VARCHAR(100) UNIQUE NOT NULL,   -- 模型唯一标识，如 'geodetector'
    display_name VARCHAR(100) NOT NULL,       -- 前端展示名称，如 '地理探测器'
    description TEXT NOT NULL,                -- 给大模型看的工具说明
    api_endpoint VARCHAR(255) NOT NULL,       -- 独立微服务的 HTTP 地址
    input_schema JSONB,                       -- 强类型参数定义
    status VARCHAR(20) DEFAULT 'active',      -- 'active' 或 'offline'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);