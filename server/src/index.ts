// 后端入口文件

// 解决 shpjs 等库在 Node 环境报 "self is not defined" 的问题
// 浏览器环境中，self 通常指向全局对象（类似于 window）
// 但是在 Node.js 环境中，self 并不存在(只有global)，导致某些库（如 shpjs）在运行时会报错
// as any是类型断言，因为原本的global对象没有self属性，断言成any后就可以随意添加属性了
// 将 Node.js 的 global 对象本身，赋值给 global 下面的 self 属性
// 这样，shpjs 等库在访问 self 时，就能正确地引用到 global 对象，避免报错
(global as any).self = global;

import { once } from 'node:events';
import express, { Request, Response } from 'express';
import cors from 'cors'; // 跨域资源共享
import sceneRoutes from './routes/sceneRoutes';
import { migrateScenes } from './models/Scene';
import fileRoutes from './routes/fileRoutes'; // 导入文件路由
import analysisRoutes from './routes/analysisRoutes';
import tileRoutes from './routes/tileRoutes';
import { connectDB } from './config/db'; // 导入数据库连接函数
import pool from './config/db';
import { AnalysisService } from './modules/analysis/service';
import { createScenePlannerRouter } from './modules/analysisPlanner/sceneRouter';
import { createWorkflowRouter } from './modules/analysisPlanner/workflowRouter';
import { createAnalysisRouter } from './modules/analysis/router';
import { createSpatialPivotRouter } from './modules/spatialPivot/router';
import { createBasemapRouter } from './modules/basemaps/router';
import { createProfessionalModelRouter } from './modules/professionalModels/router';

const app = express();
// http://localhost:3000
const PORT = Number(process.env.PORT || 3000);

// 1. 中间件配置

// 允许任何域名的前端访问此后端
app.use(cors()); 

// express.json()，解析 JSON 请求体，当客户端发送 POST 请求并携带 JSON 数据（例如 {"name": "test"}）时，
// Express 默认是读不懂的，这行代码会自动把请求体里的 JSON 字符串转换成 JavaScript 对象，
// 并挂载到 req.body 上，方便后续代码直接使用
app.use(express.json()); 


// 这里分别为 http://localhost:3000/api/files 和 http://localhost:3000/api/health

// “http://localhost”的来源： 这是当前的运行环境决定的
// localhost 代表“本机”，即你现在运行代码的这台电脑。因为你在本地开发，所以是 localhost。
// 如果把代码部署到阿里云，这里就会变成阿里云的 IP 地址或域名（如 www.example.com）。

// “:3000”的来源： 这是在代码中指定的端口号。来源于代码底部的 app.listen(PORT)。
// 2. 路由注册 （所有与'/api/files'有关的请求路由，都交给 fileRoutes）
app.use('/api/scenes', sceneRoutes);
app.use('/api/files', fileRoutes); // 挂载文件相关路由

// 注册新路由 (以 /api/analysis 开头的请求都交给 analysisRoutes 处理)
app.use('/api/analysis', analysisRoutes);

// 注册矢量瓦片路由
app.use('/api/tiles', tileRoutes);
app.use('/api', createBasemapRouter());
const analysis = new AnalysisService(pool);
app.use('/api', createProfessionalModelRouter(pool, analysis));
app.use('/api', createScenePlannerRouter(pool, analysis));
app.use('/api', createWorkflowRouter(analysis));
app.use('/api', createAnalysisRouter(pool, analysis));
app.use('/api', createSpatialPivotRouter(pool, analysis));

// 3. 测试路由
app.get('/api/health', (req: Request, res: Response) => {
    res.json({
        status: 'success',
        message: 'WebGIS Backend is running!',
        timestamp: new Date()
    });
});


// 4. 启动服务
const start = async () => {
    await connectDB();
    await migrateScenes(pool);
    await analysis.start();

    const server = app.listen(PORT);
    await once(server, 'listening');

    let closing = false;
    const shutdown = async () => {
        if (closing) return;
        closing = true;
        const stopped = analysis.stop();
        const closed = new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
        await Promise.all([stopped, closed]);
        await pool.end();
    };
    const onSignal = () => {
        void shutdown().catch(error => {
            console.error('[GeoCSV shutdown]', error);
            process.exit(1);
        });
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    console.log('GeoCSV 后端已启动，端口 ' + PORT);
};

void start().catch(error => {
    console.error('[GeoCSV startup]', error);
    process.exit(1);
});

// 捕获未处理的 Promise 拒绝 (比如数据库连不上)
process.on('unhandledRejection', (reason, promise) => {
    console.error('  未处理的 Promise 拒绝:', reason);
    // 这里不退出进程，只是记录错误
});

// 捕获未捕获的异常 (比如代码写错了)
process.on('uncaughtException', (error) => {
    console.error('💥 未捕获的异常:', error);
    // 在生产环境通常建议退出，但在开发环境你可以选择不退出，或者让 nodemon 重启
});
