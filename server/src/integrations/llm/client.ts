import OpenAI from 'openai';
import 'dotenv/config';
import { ProxyAgent } from 'undici';

let client: OpenAI | undefined;

export const isLLMConfigured = () => Boolean(process.env.ALIYUN_API_KEY?.trim());

export const getLLMClient = (): OpenAI => {
  if (client) return client;
  const apiKey = process.env.ALIYUN_API_KEY;
  if (!apiKey?.trim()) throw new Error('尚未配置 ALIYUN_API_KEY；已验证算子与表单分析仍可使用');
  const proxyUrl = process.env.LLM_PROXY_URL || process.env.https_proxy || process.env.http_proxy;
  client = new OpenAI({
    baseURL: process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey,
    timeout: 180000,
    ...(proxyUrl ? { fetchOptions: { dispatcher: new ProxyAgent(proxyUrl) } } : {}),
  });
  return client;
};
