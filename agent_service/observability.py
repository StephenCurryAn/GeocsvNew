import json
import logging
import re
from contextvars import ContextVar
from datetime import datetime, timezone
from time import perf_counter
from uuid import UUID

from fastapi import Request

logger = logging.getLogger("uvicorn.error")
TRACE_HEADER = "x-geocsv-trace-id"
REQUEST_HEADER = "x-geocsv-request-id"
trace_context: ContextVar[dict[str, str] | None] = ContextVar("trace_context", default=None)


async def bind_trace(request: Request):
    trace_id = request.headers.get(TRACE_HEADER, "")
    metadata = {}
    if re.fullmatch(r"[a-f0-9]{32}", trace_id):
        metadata["traceId"] = trace_id
        try:
            metadata["requestId"] = str(UUID(request.headers[REQUEST_HEADER]))
        except (KeyError, ValueError):
            pass
    token = trace_context.set(metadata)
    try:
        yield
    finally:
        trace_context.reset(token)


def trace_headers() -> dict[str, str]:
    metadata = trace_context.get() or {}
    return {header: metadata[key] for header, key in (
        (TRACE_HEADER, "traceId"), (REQUEST_HEADER, "requestId"),
    ) if key in metadata}


def trace_event(event: str, start: float, **fields):
    logger.info(json.dumps({
        "ts": datetime.now(timezone.utc).isoformat(),
        "service": "agent",
        "event": event,
        **(trace_context.get() or {}),
        "durationMs": round((perf_counter() - start) * 1000),
        **fields,
    }))
