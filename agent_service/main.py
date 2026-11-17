import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from secrets import compare_digest
from time import perf_counter
from typing import Annotated
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from openai import (
    APIError,
    APIResponseValidationError,
    APITimeoutError,
    ContentFilterFinishReasonError,
    LengthFinishReasonError,
    RateLimitError,
)
from pydantic import ValidationError

from contracts import Draft, PlanningRequest
from observability import bind_trace, trace_event
from planner import InvalidDraft, build_model, plan
from workflow import (CallbackError, WorkflowEngine, WorkflowEvent, WorkflowResponse,
                      build_workflow, open_event_ledger, prepare_checkpoint_store)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.token = os.getenv("AGENT_SERVICE_TOKEN", "")
    app.state.model = build_model()
    checkpoint_path = os.getenv("AGENT_CHECKPOINT_PATH", "/data/checkpoints.sqlite")
    if checkpoint_path != ":memory:":
        Path(checkpoint_path).parent.mkdir(parents=True, exist_ok=True)
    await prepare_checkpoint_store(checkpoint_path)
    async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as checkpointer:
        await checkpointer.setup()
        ledger = await open_event_ledger(checkpoint_path)
        app.state.workflow = WorkflowEngine(build_workflow(checkpointer), ledger)
        try:
            yield
        finally:
            await ledger.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health():
    return {"status": "ok"}


def authorize(request: Request, authorization: Annotated[str | None, Header()] = None):
    token = request.app.state.token
    if not token:
        raise HTTPException(503, "planner_unconfigured")
    expected = f"Bearer {token}".encode()
    if authorization is None or not compare_digest(authorization.encode(), expected):
        raise HTTPException(401, "unauthorized")


@app.post("/plan", response_model=Draft, dependencies=[Depends(authorize), Depends(bind_trace)])
async def create_plan(body: PlanningRequest, request: Request):
    if request.app.state.model is None:
        trace_event("planner.unconfigured", perf_counter(), errorCategory="MODEL_UNCONFIGURED")
        raise HTTPException(503, "planner_unconfigured")
    try:
        async with asyncio.timeout(27):
            return await plan(request.app.state.model, body)
    except (TimeoutError, APITimeoutError):
        raise HTTPException(504, "model_timeout") from None
    except RateLimitError:
        raise HTTPException(429, "model_rate_limited") from None
    except (InvalidDraft, ValidationError, APIResponseValidationError,
            ContentFilterFinishReasonError, LengthFinishReasonError):
        raise HTTPException(502, "model_invalid_response") from None
    except APIError:
        raise HTTPException(502, "model_unavailable") from None


@app.post("/workflow/{scene_id}/{thread_id}/events", response_model=WorkflowResponse,
          dependencies=[Depends(authorize), Depends(bind_trace)])
async def workflow_event(scene_id: UUID, thread_id: UUID, body: WorkflowEvent, request: Request):
    started = perf_counter()
    fields = {"sceneId": str(scene_id), "threadId": str(thread_id), "action": body.action}
    try:
        result = await request.app.state.workflow.post(scene_id, thread_id, body)
    except CallbackError:
        trace_event("langgraph.event.error", started, **fields, errorCategory="CALLBACK_UNAVAILABLE")
        raise HTTPException(502, "workflow_callback_unavailable") from None
    except HTTPException as error:
        trace_event("langgraph.event.error", started, **fields, httpStatus=error.status_code,
                    errorCategory=getattr(error, "error_code", None) or "WORKFLOW_REQUEST_FAILED")
        raise
    trace_event("langgraph.event.completed", started, **fields, status=result.status,
                interactionId=str(result.interactionId) if result.interactionId else None, runId=result.runId)
    return result


@app.get("/workflow/{scene_id}/{thread_id}", response_model=WorkflowResponse,
         dependencies=[Depends(authorize)])
async def workflow_state(scene_id: UUID, thread_id: UUID, request: Request):
    return await request.app.state.workflow.get(scene_id, thread_id)
