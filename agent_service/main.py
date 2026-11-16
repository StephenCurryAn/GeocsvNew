import asyncio
import os
from contextlib import asynccontextmanager
from secrets import compare_digest
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request
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
from planner import InvalidDraft, build_model, logger, plan


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.token = os.getenv("AGENT_SERVICE_TOKEN", "")
    app.state.model = build_model()
    yield


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


@app.post("/plan", response_model=Draft, dependencies=[Depends(authorize)])
async def create_plan(body: PlanningRequest, request: Request):
    if request.app.state.model is None:
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
    except APIError as error:
        logger.warning("Planner provider failure class=%s status=%s", type(error).__name__,
                       getattr(error, "status_code", None))
        raise HTTPException(502, "model_unavailable") from None
