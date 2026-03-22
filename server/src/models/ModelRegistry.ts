import mongoose, { Document, Schema } from 'mongoose';

export interface IModelRegistry extends Document {
  modelName: string;       // 例如 "LSI_AHP"
  displayName: string;     // 例如 "AHP滑坡易发性评估"
  description: string;
  parameters: {            // 记录参数，方便后续前端做智能提示
    name: string;
    type: string;
    description: string;
  }[];
  requiredColumns?: string[];
  status: string;
}

const ModelRegistrySchema = new Schema({
  modelName: { type: String, required: true, unique: true },
  displayName: { type: String, required: true },
  description: { type: String },
  parameters: [{
    name: String,
    type: { type: String, enum: ['column', 'number', 'string'] },
    description: String
  }],
  requiredColumns: [{ type: String }], //   新增：记录 AI 解析出的必须列名
  status: { type: String, default: 'active' }
}, { timestamps: true });

export default mongoose.model<IModelRegistry>('ModelRegistry', ModelRegistrySchema);