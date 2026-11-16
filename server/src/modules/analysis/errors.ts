export type AnalysisErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_SPEC'
  | 'UNSUPPORTED_OPERATOR'
  | 'DATASET_NOT_FOUND'
  | 'UNKNOWN_FIELD'
  | 'INVALID_GEOMETRY'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_VERSION_CONFLICT'
  | 'INPUT_VERSION_CHANGED'
  | 'INPUT_SNAPSHOT_EXPIRED'
  | 'EXECUTION_TIMEOUT'
  | 'WORKER_INTERRUPTED'
  | 'PLANNER_UNAVAILABLE'
  | 'PLANNER_TIMEOUT'
  | 'PLANNER_RATE_LIMITED'
  | 'PLANNER_INVALID_RESPONSE'
  | 'EXECUTION_FAILED';

export class AnalysisError extends Error {
  constructor(readonly status: number, readonly errorCode: AnalysisErrorCode, message: string) {
    super(message);
  }
}

export class AnalysisInputError extends AnalysisError {
  constructor(message: string, code: AnalysisErrorCode = 'INVALID_REQUEST') { super(400, code, message); }
}

export class RequestKeyConflict extends AnalysisError {
  constructor() { super(409, 'IDEMPOTENCY_KEY_CONFLICT', '此请求键已用于不同的分析请求，请使用新请求键重新提交'); }
}

export class InputVersionChanged extends AnalysisError {
  constructor(message: string) { super(409, 'INPUT_VERSION_CHANGED', message); }
}
