import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi.testclient import TestClient

from main import app

TOKEN = "workflow-test-token"


def event(action, **values):
    return {"action": action, "requestId": str(uuid4()), **values}


class WorkflowTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.checkpoint_path = str(Path(self.temp.name) / "workflow.sqlite")
        self.scene_id = str(uuid4())
        self.thread_id = str(uuid4())
        self.headers = {"Authorization": f"Bearer {TOKEN}"}
        self.path = f"/workflow/{self.scene_id}/{self.thread_id}"
        self.ready = {"status": "ready", "plan": {"id": str(uuid4()), "version": 1},
                      "spec": {"kind": "test"}}

    def tearDown(self):
        self.temp.cleanup()

    def client(self):
        return TestClient(app)

    def start_ready(self, client):
        with patch("workflow.request_plan", new=AsyncMock(return_value=self.ready)):
            result = client.post(self.path + "/events", json=event("start", prompt="统计社区的服务请求"), headers=self.headers)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["status"], "pending_confirmation")
        return result.json()

    def test_clarify_replan_confirm_and_replay_are_idempotent(self):
        clarify = {"status": "clarification", "questions": ["请选择要分析的月份。"]}
        plan_callback = AsyncMock(side_effect=[clarify, self.ready])
        submit_callback = AsyncMock(return_value={"id": str(uuid4()), "status": "queued"})
        with patch.dict("os.environ", {"AGENT_SERVICE_TOKEN": TOKEN, "AGENT_CHECKPOINT_PATH": self.checkpoint_path}), \
                patch("main.build_model", return_value=None), patch("workflow.request_plan", new=plan_callback), \
                patch("workflow.submit_plan", new=submit_callback):
            with self.client() as client:
                start = client.post(self.path + "/events", json=event("start", prompt="分析服务请求"), headers=self.headers)
                self.assertEqual(start.status_code, 200, start.text)
                first_interaction = start.json()["interactionId"]
                self.assertEqual(start.json()["status"], "clarification")
                answer_event = event("answer", interactionId=first_interaction, prompt="2024年1月")
                answer = client.post(self.path + "/events", json=answer_event, headers=self.headers)
                self.assertEqual(answer.status_code, 200, answer.text)
                self.assertEqual(answer.json()["status"], "pending_confirmation")
                self.assertIn("2024年1月", answer.json()["prompt"])
                confirm_event = event("confirm", interactionId=answer.json()["interactionId"])
                submitted = client.post(self.path + "/events", json=confirm_event, headers=self.headers)
                self.assertEqual(submitted.status_code, 200, submitted.text)
                self.assertEqual(submitted.json()["status"], "submitted")
                replay = client.post(self.path + "/events", json=confirm_event, headers=self.headers)
                self.assertEqual(replay.json(), submitted.json())
                self.assertEqual(submit_callback.await_count, 1)
                self.assertEqual(plan_callback.await_count, 2)
                self.assertEqual(client.get(self.path, headers=self.headers).json(), submitted.json())

    def test_cancel_and_stale_interaction(self):
        submit_callback = AsyncMock()
        with patch.dict("os.environ", {"AGENT_SERVICE_TOKEN": TOKEN, "AGENT_CHECKPOINT_PATH": self.checkpoint_path}), \
                patch("main.build_model", return_value=None), patch("workflow.request_plan", new=AsyncMock(return_value=self.ready)), \
                patch("workflow.submit_plan", new=submit_callback):
            with self.client() as client:
                pending = self.start_ready(client)
                wrong = client.post(self.path + "/events", json=event("confirm", interactionId=str(uuid4())), headers=self.headers)
                self.assertEqual(wrong.status_code, 409)
                cancelled = client.post(self.path + "/events", json=event("cancel", interactionId=pending["interactionId"]), headers=self.headers)
                self.assertEqual(cancelled.status_code, 200, cancelled.text)
                self.assertEqual(cancelled.json()["status"], "cancelled")
                self.assertEqual(submit_callback.await_count, 0)

    def test_retry_resumes_failed_planner_node(self):
        from workflow import CallbackError

        callback = AsyncMock(side_effect=[CallbackError("temporary"), self.ready])
        with patch.dict("os.environ", {"AGENT_SERVICE_TOKEN": TOKEN, "AGENT_CHECKPOINT_PATH": self.checkpoint_path}), \
                patch("main.build_model", return_value=None), patch("workflow.request_plan", new=callback):
            with self.client() as client:
                start_event = event("start", prompt="分析社区请求")
                first = client.post(self.path + "/events", json=start_event, headers=self.headers)
                self.assertEqual(first.status_code, 502)
                retry = client.post(self.path + "/events", json=start_event, headers=self.headers)
                self.assertEqual(retry.status_code, 200, retry.text)
                self.assertEqual(retry.json()["status"], "pending_confirmation")
                self.assertEqual(callback.await_count, 2)

    def test_resume_initial_planning_with_fresh_request_id_after_restart(self):
        from workflow import CallbackError

        callback = AsyncMock(side_effect=[CallbackError("temporary"), self.ready])
        with patch.dict("os.environ", {"AGENT_SERVICE_TOKEN": TOKEN, "AGENT_CHECKPOINT_PATH": self.checkpoint_path}), \
                patch("main.build_model", return_value=None), patch("workflow.request_plan", new=callback):
            with self.client() as client:
                failed = client.post(self.path + "/events", json=event("start", prompt="分析社区请求"), headers=self.headers)
                self.assertEqual(failed.status_code, 502)
            with self.client() as client:
                state = client.get(self.path, headers=self.headers).json()
                self.assertEqual(state["status"], "processing")
                self.assertIsNone(state["interactionId"])
                resumed = client.post(self.path + "/events", json=event("resume"), headers=self.headers)
                self.assertEqual(resumed.status_code, 200, resumed.text)
                self.assertEqual(resumed.json()["status"], "pending_confirmation")
                self.assertEqual(callback.await_count, 2)

    def test_oversized_answer_leaves_clarification_open_for_a_shorter_answer(self):
        clarify = {"status": "clarification", "questions": ["请选择要分析的月份。"]}
        callback = AsyncMock(side_effect=[clarify, self.ready])
        with patch.dict("os.environ", {"AGENT_SERVICE_TOKEN": TOKEN, "AGENT_CHECKPOINT_PATH": self.checkpoint_path}), \
                patch("main.build_model", return_value=None), patch("workflow.request_plan", new=callback):
            with self.client() as client:
                first = client.post(self.path + "/events", json=event("start", prompt="月" * 3990), headers=self.headers)
                self.assertEqual(first.status_code, 200, first.text)
                interaction_id = first.json()["interactionId"]
                oversized = client.post(self.path + "/events",
                    json=event("answer", interactionId=interaction_id, prompt="一" * 20), headers=self.headers)
                self.assertEqual(oversized.status_code, 422, oversized.text)
            with self.client() as client:
                state = client.get(self.path, headers=self.headers)
                self.assertEqual(state.json(), first.json())
                shorter = client.post(self.path + "/events",
                    json=event("answer", interactionId=interaction_id, prompt="一月"), headers=self.headers)
                self.assertEqual(shorter.status_code, 200, shorter.text)
                self.assertEqual(shorter.json()["status"], "pending_confirmation")
                self.assertEqual(callback.await_count, 2)

    def test_rejected_stale_plan_can_be_cancelled_after_restart(self):
        from workflow import callback_status

        async def reject(*_args):
            callback_status(409, {"errorCode": "INPUT_VERSION_CHANGED", "message": "输入数据已改变"})

        submit_callback = AsyncMock(side_effect=reject)
        with patch.dict("os.environ", {"AGENT_SERVICE_TOKEN": TOKEN, "AGENT_CHECKPOINT_PATH": self.checkpoint_path}), \
                patch("main.build_model", return_value=None), patch("workflow.submit_plan", new=submit_callback):
            with self.client() as client:
                pending = self.start_ready(client)
                interaction_id = pending["interactionId"]
                confirm = event("confirm", interactionId=interaction_id)
                rejected = client.post(self.path + "/events", json=confirm, headers=self.headers)
                self.assertEqual(rejected.status_code, 409, rejected.text)
                self.assertEqual(rejected.json()["detail"], "输入数据已改变")
            with self.client() as client:
                restored = client.get(self.path, headers=self.headers)
                self.assertEqual(restored.json(), pending)
                retry = client.post(self.path + "/events", json=confirm, headers=self.headers)
                self.assertEqual(retry.status_code, 409, retry.text)
                cancelled = client.post(self.path + "/events",
                    json=event("cancel", interactionId=interaction_id), headers=self.headers)
                self.assertEqual(cancelled.status_code, 200, cancelled.text)
                self.assertEqual(cancelled.json()["status"], "cancelled")
                self.assertEqual(submit_callback.await_count, 2)

    def test_get_is_read_only_and_resume_retries_failed_submit(self):
        from workflow import CallbackError

        run_id = str(uuid4())
        submit_callback = AsyncMock(side_effect=[CallbackError("temporary"), {"id": run_id, "status": "queued"}])
        with patch.dict("os.environ", {"AGENT_SERVICE_TOKEN": TOKEN, "AGENT_CHECKPOINT_PATH": self.checkpoint_path}), \
                patch("main.build_model", return_value=None), patch("workflow.request_plan", new=AsyncMock(return_value=self.ready)), \
                patch("workflow.submit_plan", new=submit_callback):
            with self.client() as client:
                pending = self.start_ready(client)
                confirm = event("confirm", interactionId=pending["interactionId"])
                failed = client.post(self.path + "/events", json=confirm, headers=self.headers)
                self.assertEqual(failed.status_code, 502)
                state = client.get(self.path, headers=self.headers)
                self.assertEqual(state.status_code, 200)
                self.assertEqual(state.json()["status"], "processing")
                self.assertEqual(submit_callback.await_count, 1)
            with self.client() as client:
                resumed = client.post(self.path + "/events", json=event("resume", interactionId=pending["interactionId"]), headers=self.headers)
                self.assertEqual(resumed.status_code, 200, resumed.text)
                self.assertEqual(resumed.json()["status"], "submitted")
                self.assertEqual(resumed.json()["runId"], run_id)
                self.assertEqual(submit_callback.await_count, 2)

    def test_checkpoint_survives_service_restart(self):
        with patch.dict("os.environ", {"AGENT_SERVICE_TOKEN": TOKEN, "AGENT_CHECKPOINT_PATH": self.checkpoint_path}), \
                patch("main.build_model", return_value=None), patch("workflow.request_plan", new=AsyncMock(return_value=self.ready)):
            with self.client() as client:
                pending = self.start_ready(client)
            with self.client() as client:
                restored = client.get(self.path, headers=self.headers)
                self.assertEqual(restored.status_code, 200, restored.text)
                self.assertEqual(restored.json(), pending)


if __name__ == "__main__":
    unittest.main()
