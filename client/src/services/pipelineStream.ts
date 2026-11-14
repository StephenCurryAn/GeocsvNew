export interface PipelineEvent<TData = unknown> {
  type: string;
  data?: TData;
  message?: string;
  [key: string]: unknown;
}

export interface PipelineStreamErrorOptions {
  status?: number;
  details?: string;
  pythonCode?: string;
  cause?: unknown;
}

export class PipelineStreamError extends Error {
  status?: number;
  details?: string;
  pythonCode?: string;

  constructor(message: string, options: PipelineStreamErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'PipelineStreamError';
    this.status = options.status;
    this.details = options.details;
    this.pythonCode = options.pythonCode;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (record: Record<string, unknown> | undefined, key: string): string | undefined =>
  typeof record?.[key] === 'string' ? record[key] as string : undefined;

const eventError = (data: unknown): PipelineStreamError => {
  if (typeof data === 'string') return new PipelineStreamError(data);
  const record = isRecord(data) ? data : undefined;
  const details = readString(record, 'details');
  const message = readString(record, 'message') || details || '分析服务返回错误';
  return new PipelineStreamError(message, {
    details,
    pythonCode: readString(record, 'pythonCode'),
  });
};

const httpError = async (response: Response): Promise<PipelineStreamError> => {
  let payload: unknown;
  const body = await response.text().catch(() => '');
  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = undefined;
    }
  }
  const payloadRecord = isRecord(payload) ? payload : undefined;
  const data = payloadRecord?.data ?? payload;
  const dataRecord = isRecord(data) ? data : undefined;
  const details = readString(dataRecord, 'details');
  const message = readString(dataRecord, 'message') || details || readString(payloadRecord, 'message') || `分析请求失败（HTTP ${response.status}）`;
  return new PipelineStreamError(message, {
    status: response.status,
    details,
    pythonCode: readString(dataRecord, 'pythonCode'),
  });
};

export const consumeNdjsonResponse = async <TData = unknown>(
  response: Response,
  onEvent: (event: PipelineEvent<TData>) => void | Promise<void>,
): Promise<PipelineEvent<TData>> => {
  if (!response.ok) throw await httpError(response);
  if (!response.body) throw new PipelineStreamError('分析服务没有返回可读取的数据流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let lineNumber = 0;
  let resultEvent: PipelineEvent<TData> | undefined;

  const dispatchLine = async (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    lineNumber += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (cause) {
      throw new PipelineStreamError(`分析进度流第 ${lineNumber} 行不是有效 JSON`, { cause });
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      throw new PipelineStreamError(`分析进度流第 ${lineNumber} 行缺少事件类型`);
    }
    const event = parsed as PipelineEvent<TData>;
    if (!['step', 'result', 'error'].includes(event.type)) {
      throw new PipelineStreamError(`分析进度流第 ${lineNumber} 行包含未知事件类型`);
    }
    if (resultEvent) throw new PipelineStreamError('分析进度流最终结果后仍收到额外事件');
    if (event.type === 'error') throw eventError(event.data);
    if (event.type === 'result' && (!Object.hasOwn(event, 'data') || event.data === null)) {
      throw new PipelineStreamError('分析进度流最终结果缺少 data');
    }

    await onEvent(event);
    if (event.type === 'result') resultEvent = event;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        await dispatchLine(line);
        newlineIndex = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) await dispatchLine(buffer);
    if (!resultEvent) throw new PipelineStreamError('分析进度流已结束，但没有收到最终结果');
    return resultEvent;
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Keep the original protocol, callback, or transport error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
};
