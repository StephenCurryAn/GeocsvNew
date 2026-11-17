import asyncio
import hashlib
import json
import os
from typing import Annotated, Literal, TypedDict
from uuid import UUID, uuid4

import aiosqlite
import httpx
from fastapi import HTTPException
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator


class WorkflowState(TypedDict, total=False):
    sceneId: str
    threadId: str
    userPrompt: str
    contextRunId: str | None
    status: str
    interactionId: str | None
    proposal: dict | None
    runId: str | None
    decision: str | None
    pendingRequestId: str
    clarificationCount: int


class WorkflowEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    action: Literal["start", "answer", "confirm", "cancel", "resume"]
    requestId: Annotated[str, StringConstraints(pattern=r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")]
    prompt: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)] | None = None
    interactionId: Annotated[str, StringConstraints(pattern=r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")] | None = None
    contextRunId: Annotated[str, StringConstraints(pattern=r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")] | None = None

    @model_validator(mode="after")
    def check_action_fields(self):
        if self.action == "start" and self.prompt is None:
            raise ValueError("start requires prompt")
        if self.action in {"answer", "confirm", "cancel"} and self.interactionId is None:
            raise ValueError("interactionId is required")
        if self.action == "answer" and self.prompt is None:
            raise ValueError("answer requires prompt")
        if self.action != "start" and self.contextRunId is not None:
            raise ValueError("contextRunId is only valid for start")
        return self


class WorkflowResponse(BaseModel):
    threadId: UUID
    sceneId: UUID
    status: Literal["clarification", "pending_confirmation", "submitted", "cancelled", "unsupported", "view_only", "processing"]
    interactionId: UUID | None = None
    prompt: str
    proposal: dict | None = None
    runId: str | None = None


def _value(state: WorkflowState) -> WorkflowResponse:
    status = state["status"]
    if status in {"planning", "approved"}:
        status = "processing"
    return WorkflowResponse(
        threadId=UUID(state["threadId"]), sceneId=UUID(state["sceneId"]),
        status=status, interactionId=UUID(state["interactionId"]) if state.get("interactionId") else None,
        prompt=state["userPrompt"], proposal=state.get("proposal"), runId=state.get("runId"),
    )


class CallbackError(Exception):
    pass


def callback_status(status: int, body: object):
    if status == 429:
        raise HTTPException(429, "model_rate_limited")
    if status == 504:
        raise HTTPException(504, "workflow_callback_timeout")
    if status in (400, 404, 409, 422):
        detail = body.get("message") if isinstance(body, dict) else None
        raise HTTPException(status, detail or "workflow_request_rejected")
    raise CallbackError("workflow_callback_unavailable")


async def _post_callback(path: str, body: dict) -> dict:
    base_url = os.getenv("AGENT_CALLBACK_URL", "").strip()
    token = os.getenv("AGENT_SERVICE_TOKEN", "").strip()
    if not base_url or not token:
        raise HTTPException(503, "workflow_callback_unconfigured")
    try:
        async with httpx.AsyncClient(timeout=45, follow_redirects=False) as client:
            response = await client.post(
                base_url.rstrip("/") + path,
                json=body,
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.TimeoutException:
        raise HTTPException(504, "workflow_callback_timeout") from None
    except httpx.HTTPError:
        raise CallbackError("workflow_callback_unavailable") from None
    try:
        result = response.json()
    except ValueError:
        callback_status(response.status_code, None)
        raise CallbackError("workflow_callback_unavailable") from None
    if not response.is_success or not isinstance(result, dict) or not isinstance(result.get("data"), dict):
        callback_status(response.status_code, result)
        raise CallbackError("workflow_callback_unavailable")
    return result["data"]


async def request_plan(scene_id: str, user_prompt: str, context_run_id: str | None) -> dict:
    body: dict = {"sceneId": scene_id, "userPrompt": user_prompt}
    if context_run_id:
        body["contextRunId"] = context_run_id
    return await _post_callback("/api/internal/analysis/workflow/plan", body)


async def submit_plan(scene_id: str, thread_id: str, proposal: dict, interaction_id: str) -> dict:
    plan = proposal.get("plan")
    if not isinstance(plan, dict) or not isinstance(plan.get("id"), str) or not isinstance(plan.get("version"), int):
        raise HTTPException(502, "workflow_plan_reference_missing")
    return await _post_callback("/api/internal/analysis/workflow/submit", {
        "sceneId": scene_id, "threadId": thread_id, "planId": plan["id"],
        "planVersion": plan["version"], "interactionId": interaction_id,
    })


def build_workflow(checkpointer: AsyncSqliteSaver):
    async def plan_node(state: WorkflowState) -> WorkflowState:
        proposal = await request_plan(state["sceneId"], state["userPrompt"], state.get("contextRunId"))
        status = proposal.get("status")
        if status == "ready":
            return {"proposal": proposal, "status": "pending_confirmation", "interactionId": str(uuid4()), "runId": None}
        if status == "clarification":
            if state.get("clarificationCount", 0) >= 5:
                return {"proposal": {"status": "unsupported", "message": "多轮补充后仍无法唯一确定分析条件，请明确目标图层、时间范围和统计含义。"},
                        "status": "unsupported", "interactionId": None, "runId": None}
            return {"proposal": proposal, "status": "clarification", "interactionId": str(uuid4()), "runId": None}
        if status == "unsupported":
            return {"proposal": proposal, "status": "unsupported", "interactionId": None, "runId": None}
        if status == "view_only":
            return {"proposal": proposal, "status": "view_only", "interactionId": None,
                    "runId": proposal.get("runId") if isinstance(proposal.get("runId"), str) else None}
        raise HTTPException(502, "workflow_plan_response_invalid")

    async def clarification_node(state: WorkflowState) -> WorkflowState:
        answer = interrupt({
            "status": "clarification", "prompt": state["userPrompt"],
            "interactionId": state["interactionId"], "proposal": state.get("proposal"),
        })
        if not isinstance(answer, dict) or answer.get("action") not in {"answer", "cancel"}:
            raise HTTPException(400, "workflow_answer_invalid")
        if answer["action"] == "cancel":
            return {"status": "cancelled", "interactionId": None}
        response = answer.get("prompt")
        if not isinstance(response, str) or not response.strip() or len(response) > 4000:
            raise HTTPException(422, "workflow_answer_invalid")
        prompt = state["userPrompt"] + "\n用户补充：" + response.strip()
        if len(prompt) > 4000:
            raise HTTPException(422, "workflow_prompt_too_long")
        return {
            "userPrompt": prompt, "status": "planning",
            "clarificationCount": state.get("clarificationCount", 0) + 1,
            "pendingRequestId": answer["requestId"],
        }

    async def review_node(state: WorkflowState) -> WorkflowState:
        decision = interrupt({
            "status": "pending_confirmation", "prompt": state["userPrompt"],
            "interactionId": state["interactionId"], "proposal": state.get("proposal"),
        })
        if not isinstance(decision, dict) or decision.get("action") not in {"confirm", "cancel"}:
            raise HTTPException(400, "workflow_confirmation_invalid")
        if decision["action"] == "cancel":
            return {"status": "cancelled"}
        return {"decision": "confirmed", "status": "approved", "pendingRequestId": decision["requestId"]}

    async def submit_node(state: WorkflowState) -> WorkflowState:
        run = await submit_plan(state["sceneId"], state["threadId"], state["proposal"], state["interactionId"])
        run_id = run.get("id")
        if not isinstance(run_id, str):
            raise HTTPException(502, "workflow_run_response_invalid")
        return {"status": "submitted", "runId": run_id}

    def after_plan(state: WorkflowState) -> str:
        if state["status"] == "clarification":
            return "clarification"
        if state["status"] == "pending_confirmation":
            return "review"
        return END

    def after_clarification(state: WorkflowState) -> str:
        return "plan" if state["status"] == "planning" else END

    def after_review(state: WorkflowState) -> str:
        if state.get("decision") == "confirmed":
            return "submit"
        return END

    builder = StateGraph(WorkflowState)
    builder.add_node("plan", plan_node)
    builder.add_node("clarification", clarification_node)
    builder.add_node("review", review_node)
    builder.add_node("submit", submit_node)
    builder.add_edge(START, "plan")
    builder.add_conditional_edges("plan", after_plan)
    builder.add_conditional_edges("clarification", after_clarification)
    builder.add_conditional_edges("review", after_review)
    builder.add_edge("submit", END)
    return builder.compile(checkpointer=checkpointer)


class WorkflowEngine:
    def __init__(self, graph, ledger: aiosqlite.Connection):
        self.graph = graph
        self.ledger = ledger
        self.locks: dict[str, asyncio.Lock] = {}

    async def _lock(self, key: str):
        lock = self.locks.setdefault(key, asyncio.Lock())
        return lock

    @staticmethod
    def _config(scene_id: UUID, thread_id: UUID) -> dict:
        return {"configurable": {"thread_id": f"{scene_id}:{thread_id}"}}

    @staticmethod
    def _fingerprint(event: WorkflowEvent) -> str:
        encoded = json.dumps(event.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(encoded.encode()).hexdigest()

    async def _receipt(self, scene_id: UUID, thread_id: UUID, event: WorkflowEvent, fingerprint: str):
        cursor = await self.ledger.execute(
            "SELECT fingerprint, response FROM workflow_events WHERE scene_id=? AND thread_id=? AND request_id=?",
            (str(scene_id), str(thread_id), str(event.requestId)),
        )
        row = await cursor.fetchone()
        if not row:
            return None
        if row[0] != fingerprint:
            raise HTTPException(409, "workflow_request_id_conflict")
        return WorkflowResponse.model_validate_json(row[1])

    async def _read(self, scene_id: UUID, thread_id: UUID) -> WorkflowResponse:
        config = self._config(scene_id, thread_id)
        snapshot = await self.graph.aget_state(config)
        if not snapshot.values:
            raise HTTPException(404, "workflow_not_found")
        if snapshot.values.get("sceneId") != str(scene_id) or snapshot.values.get("threadId") != str(thread_id):
            raise HTTPException(404, "workflow_not_found")
        return _value(snapshot.values)

    async def get(self, scene_id: UUID, thread_id: UUID) -> WorkflowResponse:
        checkpoint_id = f"{scene_id}:{thread_id}"
        lock = await self._lock(checkpoint_id)
        async with lock:
            return await self._read(scene_id, thread_id)

    async def post(self, scene_id: UUID, thread_id: UUID, event: WorkflowEvent) -> WorkflowResponse:
        checkpoint_id = f"{scene_id}:{thread_id}"
        lock = await self._lock(checkpoint_id)
        async with lock:
            fingerprint = self._fingerprint(event)
            receipt = await self._receipt(scene_id, thread_id, event, fingerprint)
            if receipt:
                return receipt
            config = self._config(scene_id, thread_id)
            snapshot = await self.graph.aget_state(config)
            values = snapshot.values or {}
            if values and (values.get("sceneId") != str(scene_id) or values.get("threadId") != str(thread_id)):
                raise HTTPException(404, "workflow_not_found")

            if event.action == "start":
                if values and values.get("status") != "planning":
                    raise HTTPException(409, "workflow_already_started")
                if values:
                    if values.get("pendingRequestId") != event.requestId:
                        raise HTTPException(409, "workflow_request_id_conflict")
                    await self.graph.ainvoke(None, config=config)
                else:
                    initial: WorkflowState = {
                        "sceneId": str(scene_id), "threadId": str(thread_id),
                        "userPrompt": event.prompt, "contextRunId": str(event.contextRunId) if event.contextRunId else None,
                        "status": "planning", "interactionId": None, "proposal": None, "runId": None,
                        "pendingRequestId": event.requestId, "clarificationCount": 0,
                    }
                    await self.graph.ainvoke(initial, config=config)
            elif event.action == "resume":
                if not values:
                    raise HTTPException(404, "workflow_not_found")
                if values.get("status") in {"clarification", "pending_confirmation", "planning", "approved"}:
                    active_interaction = values.get("interactionId")
                    if active_interaction:
                        if event.interactionId != active_interaction:
                            raise HTTPException(409, "workflow_interaction_stale")
                    elif values.get("pendingRequestId") != event.requestId:
                        raise HTTPException(409, "workflow_request_id_conflict")
                if values.get("status") in {"planning", "approved"}:
                    await self.graph.ainvoke(None, config=config)
            elif event.action in {"answer", "confirm", "cancel"}:
                if not values:
                    raise HTTPException(404, "workflow_not_found")
                if ((event.action == "answer" and values.get("status") == "planning")
                        or (event.action == "confirm" and values.get("status") == "approved")):
                    if values.get("interactionId") != event.interactionId:
                        raise HTTPException(409, "workflow_interaction_stale")
                    if values.get("pendingRequestId") != event.requestId:
                        raise HTTPException(409, "workflow_request_id_conflict")
                    await self.graph.ainvoke(None, config=config)
                    response = await self._read(scene_id, thread_id)
                    await self._save_receipt(scene_id, thread_id, event, fingerprint, response)
                    return response
                if event.action == "cancel" and values.get("status") == "cancelled":
                    response = _value(values)
                    await self._save_receipt(scene_id, thread_id, event, fingerprint, response)
                    return response
                expected_status = "clarification" if event.action == "answer" else "pending_confirmation"
                same_active = (values.get("status") == expected_status if event.action != "cancel"
                               else values.get("status") in {"clarification", "pending_confirmation"}) \
                    and values.get("interactionId") == str(event.interactionId)
                if not same_active:
                    if event.action == "confirm" and values.get("status") == "submitted" and values.get("interactionId") == str(event.interactionId):
                        response = _value(values)
                        await self._save_receipt(scene_id, thread_id, event, fingerprint, response)
                        return response
                    raise HTTPException(409, "workflow_interaction_stale")
                resumed = {"action": event.action}
                resumed["requestId"] = event.requestId
                if event.prompt is not None:
                    resumed["prompt"] = event.prompt
                await self.graph.ainvoke(Command(resume=resumed), config=config)

            response = await self._read(scene_id, thread_id)
            await self._save_receipt(scene_id, thread_id, event, fingerprint, response)
            return response

    async def _save_receipt(self, scene_id: UUID, thread_id: UUID, event: WorkflowEvent,
                            fingerprint: str, response: WorkflowResponse):
        await self.ledger.execute(
            "INSERT OR IGNORE INTO workflow_events(scene_id,thread_id,request_id,fingerprint,response) VALUES(?,?,?,?,?)",
            (str(scene_id), str(thread_id), str(event.requestId), fingerprint, response.model_dump_json()),
        )
        await self.ledger.commit()


async def open_event_ledger(path: str) -> aiosqlite.Connection:
    return await aiosqlite.connect(path)


async def prepare_checkpoint_store(path: str):
    async with aiosqlite.connect(path) as connection:
        await connection.execute("PRAGMA journal_mode=WAL")
        await connection.execute("""
            CREATE TABLE IF NOT EXISTS workflow_events (
                scene_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                response TEXT NOT NULL,
                PRIMARY KEY (scene_id, thread_id, request_id)
            )
        """)
        await connection.commit()
