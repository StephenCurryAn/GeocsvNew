import mongoose, { Document, Schema } from 'mongoose';

// 1. 定义 GeoJSON Geometry 的接口结构
// GeoJSON 的 在于 Geometry，它决定了是点、线还是面
interface IGeometry {
  type: 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon';
  coordinates: number[] | number[][] | number[][][]; // 坐标数组嵌套层级不同
}

// 2. 定义 Feature 文档接口
export interface IFeature extends Document {
  fileId: mongoose.Types.ObjectId; // 外键：关联到 FileNode 表，知道这个要素属于哪个文件
  type: 'Feature';                 // GeoJSON 标准固定字段
  geometry: IGeometry | null;             // 空间数据
  properties: Record<string, any>; // 属性数据 (例如: { "name": "北京", "gdp": 100 })
}

// 3. 定义 Schema
const featureSchema = new Schema<IFeature>({
  // 关联字段：指向 FileNode (你的文件表)
  fileId: {
    type: Schema.Types.ObjectId,
    ref: 'FileNode',
    required: true,
    index: true // 加上索引，方便快速查找某个文件的所有要素
  },
  
  // GeoJSON 标准字段: type 必须是 "Feature"
  type: {
    type: String,
    enum: ['Feature'],
    default: 'Feature',
    required: true
  },

  // GeoJSON  : 几何对象
  // 按照 MongoDB 的 GeoJSON 存储规范定义
  geometry: {
    type: {
      type: String,
      enum: ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon'],
      // required: true
    },
    coordinates: {
      type: [], // 使用空数组表示可以是任意层级的数组，或者使用 Schema.Types.Mixed
      // required: true
    }
  },

  // 属性信息: 存放 CSV 的列数据或 Shapefile 的属性表
  // 使用 Mixed 类型，因为我们不知道用户上传的数据有哪些列
  properties: {
    type: Schema.Types.Mixed, 
    default: {}
  }
}, {
  timestamps: false // 数据量极大时（如几万个点），关闭 timestamps 可以稍微节省存储空间和写入性能
});

// 4. 关键索引优化
// 地理空间索引 (Geospatial Index)
//  ：创建 2dsphere 空间索引（最实用最常用最好的索引（曲面球体））
// 这允许你执行 "查找我附近 5km 的点" 或 "查找屏幕矩形范围内的数据"
// featureSchema.index({ geometry: '2dsphere' });

// 复合索引优化 (可选)  
// 如果你经常需要查询 "某个文件内的空间数据"，这个组合索引会非常快
// 比如：只加载 id 为 xxx 的文件在当前地图视口内的数据
// featureSchema.index({ fileId: 1, geometry: '2dsphere' });

const Feature = mongoose.model<IFeature>('Feature', featureSchema);

export default Feature;