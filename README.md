# 融合地理模型服务的在线数据透视分析平台

## 项目概述
本项目是一个类似IDE的WebGIS分析工具，支持用户上传数据、在表格中通过公式调用后端地理模型，并实现地图与表格的实时联动。

## 技术栈
- 前端：React 18 + TypeScript + Vite + Tailwind CSS(v4) + Ant Design
- 地图：MapLibre GL JS
- 表格：AG Grid React
- 后端：Node.js + Express + TypeScript
- 计算库：Turf.js

## 项目结构
```
Geo_csv/
├── client/                 # 前端代码
│   ├── public/             # 静态资源
│   ├── src/                # 源码目录
│   │   ├── components/     # 可复用组件
│   │   ├── pages/          # 页面组件
│   │   ├── hooks/          # 自定义Hook
│   │   ├── services/       # API服务
│   │   ├── utils/          # 工具函数
│   │   ├── types/          # TypeScript类型定义
│   │   ├── store/          # 状态管理
│   │   └── App.tsx         # 主应用组件
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
├── server/                 # 后端代码
│   ├── src/
│   │   ├── controllers/    # 控制器层
│   │   ├── models/         # 数据模型层
│   │   ├── routes/         # 路由层
│   │   ├── services/       # 业务逻辑层
│   │   ├── middleware/     # 中间件
│   │   ├── utils/          # 工具函数
│   │   └── app.ts          # 应用入口
│   ├── config/             # 配置文件
│   ├── uploads/            # 用户上传文件存储
│   ├── dist/               # 编译输出目录
│   ├── package.json
│   └── tsconfig.json
├── shared/                 # 前后端共享类型定义
├── docs/                   # 文档
├── tests/                  # 测试文件
├── .gitignore
├── README.md
└── package.json            # 根目录包配置
```

## 开发说明
### 前端 (client/)
- 使用Vite作为构建工具，提供快速的开发体验
- 采用MVC分层架构，便于维护和扩展
- 组件化开发，提高代码复用性

### 后端 (server/)
- 提供RESTful API接口
- 使用Turf.js进行地理空间计算
- 实现文件上传和数据处理功能

## 运行项目
### 前端
```bash
cd client
npm install
npm run dev
```

### 后端
```bash
cd server
npm install
npm run dev
```