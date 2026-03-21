import multer from 'multer';
import fs from 'fs';
import path from 'path';

// 定义上传目录路径
// __dirname 是当前代码文件所在的绝对路径
// const uploadDir = path.join(__dirname, '../../../uploads');

// 使用 process.cwd() 获取项目根目录，确保上传目录在项目根目录下
// 这里指的是server这个文件夹目录下(在哪敲的npm run dev（后端），就在哪建uploads文件夹)
const uploadDir = path.join(process.cwd(), 'uploads');

// 检查上传目录是否存在，如果不存在则创建
// { recursive: true }如果父级目录不存在，顺便把父级目录也一并创建出来;
// { recursive: true }并且如果文件夹已经存在，Node.js 会直接忽略，不会报错
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log(`📁 上传目录已创建: ${uploadDir}`);
}

// 配置 Multer 存储选项
// diskStorage表示文件直接存入硬盘（HDD/SSD）
// 另一种模式是 memoryStorage（存内存），对于 GIS 数据，存硬盘更安全，不占内存
const storage = multer.diskStorage({
    // 设置文件存储的目标目录
    // req (Request): 当前的 HTTP 请求对象
    // 可以通过 req.body 拿到附带的其他表单数据（例如上传者的 ID）
    // file (File): 正在处理的那个文件对象（包含文件名、大小、MIME 类型等信息）
    // cb (Callback): 回调函数。这是 Multer 给你的一个“开关”，你必须调用它，Multer 才会继续下一步
    destination: function (req: Express.Request, file: Express.Multer.File, cb: (error: Error | null, path: string) => void) {
        // 第一个参数 null：代表没有错误
        // 如果你传了一个 new Error('磁盘满了')，上传就会终止
        // 第二个参数 uploadDir：代表目标文件夹路径
        cb(null, uploadDir);
    },
    // 设置保存的文件名，保持原始文件名并解决中文乱码问题
    filename: function (req: Express.Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) {
        // 使用 Buffer 转换解决中文文件名乱码问题
        // Buffer.from(file.originalname, 'latin1')告诉 Node.js，
        // “我知道你刚才把这一串二进制数据当成 latin1 读错了。
        // 请你把这串乱码字符串，按照 latin1 格式倒回去，变回最原始的二进制字节流 (Buffer)。”
        // 效果：此时我们拿到了“江苏省”这三个字对应的正确二进制数据，只是还没显示出来
        // 然后，.toString('utf8') 再把这个最原始的二进制字节流，
        // 按照正确的 utf8 编码格式重新读一遍，变回正确的中文字符串。
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');

        // // 2. 🚨【关键修复】分离文件名和后缀
        // // 获取后缀 (例如 .json)
        // const ext = path.extname(originalName).toLowerCase();
        // // 获取不带后缀的文件名 (例如 data)
        // const basename = path.basename(originalName, ext);
        // // 3. 生成唯一文件名：文件名 + 时间戳 + 随机数 + 后缀
        // // 这样生成的物理文件可能是: data-17066882312-9921.json
        // // 既保证了唯一性，又保留了正确的 .json 后缀
        // const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
        // const filename = `${basename}-${uniqueSuffix}${ext}`;
        // // 告诉 Multer：“没问题（null），请把这个文件命名为刚才修复好的 filename 存在硬盘里。”
        // cb(null, filename);

        // 保持原始文件名（针对shp类型数据，要是各个文件名称不一样，有点麻烦）
        cb(null, originalName);
    }
});

// 配置文件过滤器，只允许特定类型的文件上传
// req: 当前的 HTTP 请求。如果你的表单里除了文件还填了别的东西（比如用户 ID、项目名称），都在这里面
// file: 这里拿到的不是文件内容，而是文件的元数据（Metadata），比如文件名 (originalname)、MIME 类型 (mimetype) 等
// TypeScript 类型：multer.FileFilterCallback 是为了确保调用 cb 时传的参数格式是正确的（第一个参数是错误对象或 null，第二个是布尔值）
const fileFilter = (req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    // 获取文件扩展名并转换为小写
    const fileExtension = path.extname(file.originalname).toLowerCase();
    
    // 定义允许的文件类型
    const allowedExtensions = ['.json', '.geojson', '.csv', '.shp', '.shx', '.dbf', '.prj', '.cpg'];
    
    // 检查文件扩展名是否在允许列表中
    if (allowedExtensions.includes(fileExtension)) {
        // 允许该文件
        cb(null, true);
    } else {
        // 拒绝该文件，并返回错误信息
        // .join(', ') 会把数组变成字符串 ".json, .geojson, .csv, .shp"
        cb(new Error(`不支持的文件类型: ${fileExtension}. 只允许上传 ${allowedExtensions.join(', ')} 格式的文件.`));
    }
};

// 创建并配置 Multer 上传实例
const upload = multer({
    storage: storage,           // 使用上面定义的存储配置
    fileFilter: fileFilter,     // 使用上面定义的文件过滤器
    limits: {
        fileSize: 1000 * 1024 * 1024, // 限制单个文件大小为 1000MB
        // files: 1                   // 限制每次只能上传 1 个文件
    }
});

// 导出配置好的上传实例
export default upload;