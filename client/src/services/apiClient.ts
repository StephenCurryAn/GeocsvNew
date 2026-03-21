import axios from 'axios';

/**
 * Axios 实例配置
 * 用于与后端 API 进行通信
 * @description 统一的 API 客户端配置，包含基础 URL 和默认请求头设置
 */
const apiClient = axios.create({
  /**
   * 后端 API 基础 URL
   * 开发环境下指向本地服务
   */
  baseURL: 'http://localhost:3000/api',
  
  /**
   * 请求超时时间 (毫秒)
   * 防止长时间等待无响应的请求
   */
  timeout: 888888,
  
  /**
   * 默认请求头
   * Content-Type 将根据具体请求动态覆盖
   */
  // Content-Type和application/json都是默认就有的标准值
  // 常见的 Content-Type 类型包括：
  // application/json	JSON 数据	你现在用的（前后端传对象、文字等）
  // text/html	HTML 网页	浏览器打开网页时
  // image/jpeg	JPG 图片	传输照片时
  // multipart/form-data	多部分表单  上传文件时
  // application/pdf	PDF 文件	下载文档时
  headers: {
    'Content-Type': 'application/json',
  },
});

export default apiClient;