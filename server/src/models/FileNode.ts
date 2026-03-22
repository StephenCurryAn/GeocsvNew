// Schema表示文件和文件夹的结构
import mongoose, { Document, Schema } from 'mongoose';
import path from 'path'; // 用于自动提取后缀

// 1. 定义接口

// extends Document:继承 Mongoose 文档的基础功能（比如 _id 属性，save() 方法等）
export interface IFileNode extends Document {
  name: string;          // 文件名
  type: 'file' | 'folder';
  parentId: mongoose.Types.ObjectId | null;
  path?: string;         // 物理存储路径
  size?: number;         // 字节大小
  extension?: string;    // 后缀
  mimeType?: string;
  createdAt: Date;
  updatedAt: Date;

}
  // _id 是 MongoDB 自动生成的，虽然你没写，但它是数据库的默认主键规则
// 2. 定义 Schema(数据库模式)
const fileNodeSchema: Schema<IFileNode> = new Schema({
  name: {
    type: String,
    required: true, // 必填
    trim: true // 去除前后空格
  },
  type: {
    type: String,
    enum: ['file', 'folder'], // 限定只能是 'file' 或 'folder'
    required: true
  },
  parentId: {
    type: Schema.Types.ObjectId, // 类型是数据库 ID
    ref: 'FileNode', // 引用自己！这叫“自引用”。告诉 Mongoose 这个 ID 指向的是另一个 FileNode
    default: null // 默认为 null，表示放在根目录下
  },
  path: {
    type: String,
    // 条件验证 (Conditional Validation) 这里用到了高级技巧：函数式 Required。
    // 只有当 type 是 'file' 时，path 才是必填的。文件夹不需要 path。
    required: function(this: IFileNode) { return this.type === 'file'; }
  },
  size: {
    type: Number,
    required: function(this: IFileNode) { return this.type === 'file'; }
  },
  // 后缀名字段
  extension: {
    type: String,
    lowercase: true, // 强制存为小写，方便查询 (例如 .CSV -> .csv)
    trim: true // 去除前后空格
  },
  // MIME类型 (可选，但推荐)
  mimeType: {
    type: String
  }
}, {
  // timestamps: true表示自动添加 createdAt 和 updatedAt 字段 
  timestamps: true 
});

// 3. 索引优化 (让数据库查询更快，并保证数据逻辑正确。)

// 基础索引：查找子节点,性能优化
// 当你点击一个文件夹（例如文件夹 ID 为 A）时，系统需要查询 parentId 等于 A 的所有子文件。
// 如果没有这个索引，MongoDB 需要扫描全表；有了它，查询瞬间完成。
fileNodeSchema.index({ parentId: 1 });

//   关键优化：复合唯一索引 (Compound Unique Index)，逻辑约束
// 含义：在同一个 parentId (文件夹) 下，name (文件名) 必须唯一
// 效果：防止出现两个 "新建文件夹" 或两个 "data.csv" 在同一目录下

// { parentId: 1, name: 1 }: 这是一个复合索引，意思是把两个字段联合起来看。
// 1: 代表升序排列（Ascending），这对查询性能有帮助，但在唯一性检查中主要是为了定义字段组合
// { unique: true }: 这是关键。它表示**“这两个字段的组合必须是独一无二的”**。
fileNodeSchema.index({ parentId: 1, name: 1 }, { unique: true });

// 4. 自动化逻辑 (Pre-save Hook)
// 注意：不要使用箭头函数 () => {}，因为我们需要用 'this' 关键字来访问当前文档(当前正在被保存的那个文档实例)
// pre('save', ...): 这意味着“在执行 保存 (.save()) 动作之前，先执行这段代码”。
fileNodeSchema.pre('save', async function() {
  // 这里的 this 就是当前的文档
  
  // 逻辑保持不变
  if (this.type === 'file' && this.name && !this.extension) {
    this.extension = path.extname(this.name).toLowerCase();
  }
  
  if (this.type === 'folder') {
    this.extension = undefined;
    this.path = undefined;
    this.size = undefined;
  }

});

// 把我们在前面定义好的规则（Schema）和类型（Interface）
// “编译”成一个可以在代码中直接使用的模型（Model）。

// mongoose.model(...):  输入：你制定的规则（Schema）;  输出：一个能操作数据库的“工具类”（Model）
// 'FileNode': 模型的名称，Mongoose 会自动把它变成复数并小写为 'filenodes' 作为数据库中的集合（Collection）名称
const FileNode = mongoose.model<IFileNode>('FileNode', fileNodeSchema);

export default FileNode;