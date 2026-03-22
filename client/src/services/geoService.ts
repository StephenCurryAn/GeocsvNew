import apiClient from './apiClient';

// 定义后端统一的响应结构 (Wrapper)
interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

//  定义标记页数后端响应接口
export interface PaginatedGeoResponse {
  type: 'FeatureCollection';
  features: any[]; // 你的 Feature 类型
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
}

//   定义上传响应接口 (不再包含 geoJson 全量数据)
export interface UploadResponse {
  _id: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  totalFeatures: number; // 告知前端有多少条数据
}

//  原始上传响应的接口
// /**
//  * 上传响应接口
//  * 定义后端文件上传接口返回的数据结构
//  * @interface UploadResponse
//  * @property {number} code - 响应状态码
//  * @property {string} message - 响应消息
//  * @property {any} data - 响应数据，包含转换后的 GeoJSON
//  */
// export interface UploadResponse {
//   code: number;
//   message: string;
//   data: {
//     _id: string;
//     geoJson: any; // 上传文件转换后的 GeoJSON 数据
//     fileName: string; // 上传的文件名
//     fileSize: number; // 文件大小
//     fileType: string; // 文件类型
//   } | null;
// }

/**
 * 地理数据服务
 * 提供与地理数据处理相关的 API 接口
 * 定义类来进行service封装，封装与后端地理数据处理服务的通信逻辑
 * 把用户在浏览器里选好的文件，打包好，安全、准确地送到后端，并把回执拿回来
 */
class GeoService {
  
  // //  原始的上传地理数据的节点（后续需要保存csv或者下载的时候使用）
  // /**
  //  * 上传地理数据文件
  //  * 支持 CSV、GeoJSON 等格式的文件上传，并转换为 GeoJSON 格式
  //  * @param {FileList | File[]} files - 上传地理数据文件，用户选择的文件列表 (支持多文件)
  //  * @returns {Promise<UploadResponse>} 包含 GeoJSON 数据的响应对象
  //  * @throws {Error} 当上传失败时抛出错误
  //  */
  // // : Promise<UploadResponse>是输出承诺，会返回一个UploadResponse类型的数据
  // // files是浏览器原生提供的文件对象(通常通过文件输入框获取)
  // async uploadGeoData(files: FileList | File[], parentId?: string): Promise<UploadResponse> {
  //   try {
  //     const fileArray = Array.from(files); // 转为标准数组
  //     if (fileArray.length === 0) throw new Error('请选择文件');
  //     // 1. 检查文件类型
  //     const hasShp = fileArray.some(f => f.name.toLowerCase().endsWith('.shp'));
  //     // 2. 如果包含了 .shp，则必须进行完整性校验
  //     if (hasShp) {
  //         const hasDbf = fileArray.some(f => f.name.toLowerCase().endsWith('.dbf'));
  //         const hasShx = fileArray.some(f => f.name.toLowerCase().endsWith('.shx'));
  //         const hasPrj = fileArray.some(f => f.name.toLowerCase().endsWith('.prj'));
  //         if (!hasDbf || !hasShx || !hasPrj) {
  //             throw new Error('上传 Shapefile 时，必须同时选中 .shp, .dbf, .shx 和 .prj 文件');
  //         }
  //     }

  //     // 构建表单数据，用于文件上传
  //     // new FormData() 是在内存里创建了一个 “虚拟的 HTML 表单”。
  //     // 它的核心作用是：专门用来打包“文件流”和“数据”，以便通过代码（Ajax/Axios）发送给后端
  //     // 通常我们跟后端交互用的是 JSON 格式（比如 { "name": "张三", "age": 18 }）。 
  //     // JSON 处理纯文本非常方便，但它有一个巨大的弱点：它不擅长运送“二进制文件”（比如图片、视频、SHP文件等）。
  //     // 如果你想用 JSON 发文件，你得把文件转成一长串乱码（Base64），这会让文件体积暴增，传输极慢。
  //     // FormData 就是为了解决这个问题诞生的。
  //     const formData = new FormData();

  //     // 注意：这里循环 append，字段名统一为 'files' (对应后端的 upload.array('files'))
  //     // 将文件添加到表单数据中，字段名为 'file'
  //     // 第一个'files'与后端 Multer 中间件里的 upload.array('files')一致
  //     // formData.append('file', file);
  //     fileArray.forEach(file => {
  //         formData.append('files', file);
  //     });
  //     // 如果有 parentId，就塞进表单发给后端
  //     if (parentId) {
  //       formData.append('parentId', parentId);
  //     }

  //     // 发送 POST 请求到后端文件上传接口
  //     // 注意：Content-Type 会被自动设置为 multipart/form-data，包含边界字符串
  //     // await：“等待”。意思是：“在后端给我回复之前，代码先停在这儿，别往下跑。”
  //     const response = await apiClient.post<UploadResponse>('/files/upload', formData, {
  //       headers: {
  //         // 重要：当使用 FormData 时，不要手动设置 Content-Type
  //         // 浏览器会自动设置为 multipart/form-data 并添加正确的边界
  //         // 'Content-Type': 'multipart/form-data', // 这行会被浏览器忽略
  //         'Content-Type': undefined,
  //       },
  //       // 上传大文件时显示进度（可选功能，后续可扩展）
  //       onUploadProgress: (progressEvent) => {
  //         const progress = Math.round((progressEvent.loaded * 100) / (progressEvent.total || 1));
  //         console.log(`上传进度: ${progress}%`);
  //       },
  //     });

  //     return response.data;
  //   } catch (error: any) {
  //     // 错误处理：将错误转换为统一格式
  //     console.error('文件上传失败:', error);
      
  //     // 如果是 Axios 错误，提供更详细的信息
  //     if (error.response) {
  //       // 服务器响应了错误状态码
  //       throw new Error(`上传失败: ${error.response.data?.message || '服务器错误'} (${error.response.status})`);
  //     } else if (error.request) {
  //       // 请求已发出但没有收到响应
  //       throw new Error('网络错误: 无法连接到服务器');
  //     } else {
  //       // 其他错误
  //       throw new Error(`请求错误: ${error.message}`);
  //     }
  //   }
  // }

  // //  原始的获取数据的节点（后续需要保存csv或者下载的时候使用）
  // /**
  //  * 获取文件内容 (修复 App.tsx 报错的关键)
  //  * 用于点击左侧文件树时，从后端拉取文件内容
  //  */
  // async getFileContent(fileId: string): Promise<any> {
  //   try {
  //     // 发送 GET 请求到 /api/files/content/:id
  //     const response = await apiClient.get(`/files/content/${fileId}`);
  //     return response.data;
  //   } catch (error: any) {
  //     console.error('获取文件内容失败:', error);
  //     throw error;
  //   }
  // }

  /**
   *  分页获取文件数据
   * 替代原有的全量 getFileContent
   * @param id 文件ID
   * @param page 页码 (默认 1)
   * @param pageSize 每页数量 (默认 20)
   */
  async getFileData(id: string, page = 1, pageSize = 20): Promise<PaginatedGeoResponse> {
    // 对应后端路由: GET /api/files/:id/data?page=1&pageSize=20
    const res = await apiClient.get<ApiResponse<PaginatedGeoResponse>>(`/files/${id}/data`, {
      params: { page, pageSize }
    });
    // 注意：apiClient 拦截器通常已经处理了 response.data，
    // 如果你的 apiClient 依然返回 axios 原始对象，请使用 response.data.data
    // 这里假设 apiClient 已经解包，直接返回后端 json 中的 data 字段
    return res.data.data; 
  }

  //  获取指定文件的所有数据 (用于地图全量展示)
  // 传入一个足够大的 pageSize 来获取所有数据
  async getAllFileData(id: string): Promise<PaginatedGeoResponse> {
    // 假设后端允许较大的 pageSize，或者你可以专门写一个后端接口 /api/files/:id/all
    // 这里我们直接复用分页接口，请求 100 万条数据
    const res = await apiClient.get<ApiResponse<PaginatedGeoResponse>>(`/files/${id}/data`, {
      params: { page: 1, pageSize: 1000000 } 
    });
    return res.data.data;
  }

  /**
   * 上传地理数据文件
   * @param files 文件列表
   * @param parentId 父文件夹ID
   */
  async uploadFile(files: FileList | File[], parentId: string | null = null): Promise<UploadResponse> {
    const formData = new FormData();
    // 兼容 FileList 和 Array
    if (files instanceof FileList) {
        Array.from(files).forEach((file) => formData.append('files', file));
    } else {
        files.forEach((file) => formData.append('files', file));
    }
    
    // 只有当 parentId 存在且有效时才添加
    if (parentId) {
        formData.append('parentId', parentId);
    }

    // 对应后端路由: POST /api/files/upload
    const res = await apiClient.post<{ data: UploadResponse }>('/files/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000,
    });
    
    // 返回后端响应中的 data 字段 (包含 _id, totalFeatures 等)
    // 第一个data是默认的属性值（res.data），第二个data是我定义的变量名称
    return res.data.data;
  }

  /**
   * 重命名节点
   */
  async renameNode(id: string, newName: string): Promise<any> {
    try {
        const response = await apiClient.put(`/files/${id}`, { name: newName });
        return response.data;
    } catch (error: any) {
        // 如果后端返回 409 (重名)，抛出具体错误信息
        const msg = error.response?.data?.message || '重命名失败';
        throw new Error(msg);
    }
  }

  /**
   * 删除节点
   */
  async deleteNode(id: string): Promise<any> {
    try {
        const response = await apiClient.delete(`/files/${id}`);
        return response.data;
    } catch (error: any) {
        throw new Error('删除失败: ' + error.message);
    }
  }

  // /**
  //  * 更新文件数据 (用于表格编辑保存)
  //  * @param fileId 文件ID
  //  * @param recordId 行id
  //  * @param data 修改后的数据 (Properties)
  //  */
  // async updateFileData(fileId: string, recordId: number | string, data: any): Promise<any> {
  //   try {
  //       // 发送 POST 请求到后端更新接口
  //       // 假设后端接口路由为: POST /api/files/:id/update
  //       const response = await apiClient.post(`/files/${fileId}/update`, {
  //           recordId,
  //           data
  //       });
  //       return response.data;
  //   } catch (error: any) {
  //       console.error('更新数据失败:', error);
  //       const msg = error.response?.data?.message || '保存失败';
  //       throw new Error(msg);
  //   }
  // }
  /**
   * 更新文件数据 (修改行)
   * @param fileId 文件ID
   * @param recordId 行ID (properties.id)
   * @param data 修改后的属性对象
   */
  async updateFileData(fileId: string, recordId: number | string, data: any): Promise<any> {
    // 对应后端路由: PUT /api/files/:id/update
    const response = await apiClient.post(`/files/${fileId}/update`, {
      recordId,
      data
    });
    return response.data;
  }

  /**
   * 新增行
   */
  async addRow(fileId: string): Promise<any> {
    const res = await apiClient.post(`/files/${fileId}/row`);
    return res.data;
  }

  /**
   * 删除行
   */
  async deleteRow(fileId: string, recordId: number | string): Promise<any> {
    const res = await apiClient.post(`/files/${fileId}/row/delete`, { recordId });
    return res.data;
  }

  /**
   * 新增列
   */
  async addColumn(fileId: string, fieldName: string, defaultValue: string = ''): Promise<any> {
    const res = await apiClient.post(`/files/${fileId}/column`, { fieldName, defaultValue });
    return res.data;
  }

  /**
   * 删除列
   */
  async deleteColumn(fileId: string, fieldName: string): Promise<any> {
    const res = await apiClient.post(`/files/${fileId}/column/delete`, { fieldName });
    return res.data;
  }

  // 重命名列名
  async renameColumn(fileId: string, oldName: string, newName: string): Promise<any> {
    const response = await apiClient.put(`/files/${fileId}/columns/rename`, {
        oldName,
        newName
    });
    return response.data;
  }

  /**
   * 导出文件
   * @param fileId 文件ID
   * @param fileName 文件名 (用于默认保存名称)
   */
  async exportFile(fileId: string, fileName: string): Promise<boolean> {
    try {
      // 1. 请求后端接口
      // responseType: 'blob' 这里的关键，告诉 axios 返回的是二进制流
      const response = await apiClient.get(`/files/${fileId}/export`, {
        responseType: 'blob'
      });

      // 2. 创建 Blob 对象
      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });

      // 3. 创建临时下载链接
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      // 设置下载文件名
      // 如果文件名没有后缀，强制加上 .csv
      const safeName = fileName.endsWith('.csv') ? fileName : `${fileName}.csv`;
      link.setAttribute('download', safeName);
      
      // 4. 触发点击并清理
      document.body.appendChild(link);
      link.click();
      
      // 延时清理，确保下载触发
      setTimeout(() => {
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      }, 100);

      return true;
    } catch (error) {
      console.error('导出文件失败:', error);
      throw error;
    }
  }

  /**
   *   [修改] 真实调用后端生成空间网格
   */
  async generateGridAggregation(fileId: string, config: {
      shape: 'hex' | 'square',
      size: number,
      method: string,
      targetField?: string | null
  }) {
      // 使用 POST 请求发送配置
      const response = await apiClient.post('/analysis/grid', {
          fileId,
          ...config
      });
      return response.data; // 预期返回 { success: true, data: GeoJSON }
  }

  /**
   *   [新增] 导出网格数据 (触发下载)
   */
  async exportGridAggregation(fileId: string, config: any) {
      try {
          const response = await apiClient.post('/analysis/export-grid', {
              fileId,
              ...config
          }, {
              responseType: 'blob' // 重要：接收二进制流
          });

          // 创建 Blob URL 并下载
          const url = window.URL.createObjectURL(new Blob([response.data]));
          const link = document.createElement('a');
          link.href = url;
          link.setAttribute('download', `grid_analysis_${config.shape}_${new Date().toISOString().slice(0,10)}.geojson`);
          document.body.appendChild(link);
          link.click();
          link.remove();
          
          return true;
      } catch (error) {
          console.error("Export failed", error);
          return false;
      }
  }

  //   新增：公式执行服务调用
  async executeModelFormula( data: { fileId: string; modelName: string; rawArgs: string[] } ) {
    const response = await apiClient.post('/analysis/execute-formula', data);
    return response.data;
  };

  // ==========================================
  // 🤖 GeoAI 智能体接口
  // ==========================================
  async  generateModelByAI(data: { userDescription: string }){
    const response = await apiClient.post('/analysis/agent/generate-model', data);
    return response.data;
  };

}

// 导出 GeoService 实例，使其他模块可以直接使用
export const geoService = new GeoService();