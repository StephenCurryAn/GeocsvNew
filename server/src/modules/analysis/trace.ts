import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { authorizedAgentCallback } from '../../integrations/agent/auth';
import { AnalysisError } from './errors';

export const traceHeader = 'x-geocsv-trace-id';
const requestHeader = 'x-geocsv-request-id';
const uuid = (value: unknown) => typeof value === 'string'
  && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value) ? value.toLowerCase() : undefined;
const trace = new AsyncLocalStorage<{ traceId: string; requestId?: string } | undefined>();
export const analysisTrace = () => trace.getStore();
export const withRunTrace = <T>(traceId: string | null, work: () => T) =>
  trace.run(traceId ? { traceId } : undefined, work);

export function traceHeaders() {
  const active = analysisTrace();
  return active ? {
    [traceHeader]: active.traceId,
    ...(active.requestId ? { [requestHeader]: active.requestId } : {}),
  } : {};
}

export function traceEvent(event: string, fields: Record<string, string | number | boolean | null | undefined>) {
  const active = analysisTrace();
  if (active) console.info(JSON.stringify({ ts: new Date().toISOString(), service: 'express', event, ...active, ...fields }));
}

export const traceError = (error: unknown, fallback = 'INTERNAL_ERROR') =>
  error instanceof AnalysisError ? error.errorCode : fallback;

export async function traceRequest(req: Request, res: Response, operation: string, work: () => Promise<void>) {
  const sceneId = uuid(req.params.sceneId);
  const threadId = uuid(req.params.threadId);
  const internal = operation.startsWith('workflow.callback.') && authorizedAgentCallback(req.get('authorization'));
  const forwarded = internal ? req.get(traceHeader) : undefined;
  const traceId = sceneId && threadId
    ? createHash('sha256').update(`workflow:${sceneId}:${threadId}`).digest('hex').slice(0, 32)
    : forwarded && /^[a-f\d]{32}$/.test(forwarded) ? forwarded : randomUUID().replace(/-/g, '');
  const requestId = (internal ? uuid(req.get(requestHeader)) : uuid(req.body?.requestId)) ?? randomUUID();
  const start = performance.now();
  res.setHeader(traceHeader, traceId);
  await trace.run({ traceId, requestId }, async () => {
    try {
      await work();
    } finally {
      traceEvent(operation, { sceneId, threadId, httpStatus: res.statusCode, durationMs: Math.round(performance.now() - start) });
    }
  });
}
