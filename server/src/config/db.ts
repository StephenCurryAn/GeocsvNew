import mongoose from 'mongoose';

/**
 * 数据库连接函数
 * 连接到本地 MongoDB 实例
 */
export const connectDB = async (): Promise<void> => {
  try {
    // MongoDB 连接字符串
    // const mongoURI = 'mongodb://geoapp:geoapp123@localhost:27017/Geoex';
    //   核心修改 1：将 localhost 强行改为 127.0.0.1，避开 Node.js 的 IPv6 解析坑
    //   核心修改 2：使用你刚才 mongosh 测试成功的 admin 账号，并带上 ?authSource=admin
    // const mongoURI = 'mongodb://admin:123456@127.0.0.1:27017/Geoex?authSource=admin';
    
    //   核心修改 3：如果你的 MongoDB 是在 Docker 里跑的，确保用容器 IP 而不是 localhost
    // 容器 IP 可以通过 `docker inspect <container_id>` 查看
    const mongoURI = 'mongodb://admin:123456@172.18.0.2:27017/Geoex?authSource=admin';

    // （补充：如果你确实在 MongoDB 里专门建过 geoapp 这个子账号，你也可以用下面这行：）
    // const mongoURI = 'mongodb://geoapp:geoapp123@127.0.0.1:27017/Geoex';

    // 连接到 MongoDB
    const conn = await mongoose.connect(mongoURI);
    
    console.log(`MongoDB 连接成功: ${conn.connection.host}`);
  } catch (error) {
    console.error('数据库连接失败:', error);
    process.exit(1); // 连接失败时退出进程
  }
};