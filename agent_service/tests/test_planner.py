import json
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from langchain_openai import ChatOpenAI

from main import app

TOKEN = "unit-test-token"
CONTEXT = {
    "userPrompt": "用社区图层的 total_requests 做 Moran/LISA，Rook 邻接，199 次置换",
    "datasets": [{
        "ref": "layer_1", "name": "社区.geojson", "geometryTypes": ["ST_Polygon"],
        "fields": ["total_requests"], "numericFields": ["total_requests"],
    }],
    "operators": [{
        "id": "spatial_autocorrelation", "version": 2, "name": "Moran/LISA",
        "aliases": ["Moran", "LISA"], "description": "计算全局与局部空间自相关",
        "inputs": {"target": {"geometryTypes": ["ST_Polygon"],
                              "fields": {"valueField": {"type": "numeric", "required": True, "description": "数值字段"}}}},
        "parameterSchema": "#/$defs/MoranLisaSpec",
        "planningParameters": {"type": "object", "additionalProperties": False, "properties": {
            "contiguity": {"type": "string", "enum": ["queen", "rook"], "default": "queen", "description": "邻接规则"},
            "permutations": {"type": "integer", "minimum": 0, "maximum": 9999, "default": 199, "description": "置换次数"},
        }},
        "eligibleRefs": {"target": ["layer_1"]},
    }],
}


def moran(**overrides):
    draft = {
        "status": "ready", "operator": {"id": "spatial_autocorrelation", "version": 2},
        "inputs": {"target": {"ref": "layer_1", "fields": {"valueField": "total_requests"}}},
        "parameters": {"contiguity": "rook", "permutations": 199},
    }
    return json.dumps(draft | overrides)


def completion(content, finish_reason="stop"):
    return httpx.Response(200, json={
        "id": "test", "model": "test-model",
        "choices": [{"index": 0, "finish_reason": finish_reason,
                     "message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60},
    })


class PlannerContractTest(unittest.TestCase):
    def request(self, response, token=TOKEN, body=CONTEXT):
        calls = []

        def handle(request):
            calls.append(json.loads(request.content))
            if isinstance(response, Exception):
                raise response
            return response

        transport = httpx.MockTransport(handle)
        model = ChatOpenAI(
            model="test-model", base_url="https://provider.test/v1", api_key="test-key",
            http_async_client=httpx.AsyncClient(transport=transport), max_retries=0,
            http_socket_options=(), use_responses_api=False,
        )
        with patch.dict("os.environ", {"AGENT_SERVICE_TOKEN": TOKEN}), patch("main.build_model", return_value=model):
            with TestClient(app) as client:
                result = client.post("/plan", json=body, headers={"Authorization": f"Bearer {token}"})
        return result, calls

    def test_messages_json_mode_and_strict_response(self):
        payload = moran()
        result, calls = self.request(completion(payload))
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json(), json.loads(payload))
        self.assertEqual(len(calls), 1)
        sent = calls[0]
        self.assertEqual(sent["response_format"], {"type": "json_object"})
        self.assertNotIn("tools", sent)
        self.assertEqual([item["role"] for item in sent["messages"]], ["system", "user"])
        self.assertEqual(json.loads(sent["messages"][1]["content"]), CONTEXT)
        self.assertNotIn("spatial_autocorrelation", sent["messages"][0]["content"])
        self.assertNotIn("total_requests", sent["messages"][0]["content"])

    def test_custom_catalog_entry_uses_identical_system_message_and_draft_shape(self):
        third = {
            "id": "test_point_sample", "version": 3, "name": "点抽样",
            "aliases": ["抽取样本"], "description": "从点图层抽样",
            "inputs": {"source": {"geometryTypes": ["ST_Point"]}},
            "parameterSchema": "#/test/PointSampleSpec",
            "planningParameters": {"type": "object", "additionalProperties": False, "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 10, "default": 3, "description": "样本量"},
            }},
            "eligibleRefs": {"source": ["layer_1"]},
        }
        draft = {"status": "ready", "operator": {"id": third["id"], "version": 3},
                 "inputs": {"source": {"ref": "layer_1", "fields": {}}}, "parameters": {}}
        point = {"ref": "layer_1", "name": "设施.geojson", "geometryTypes": ["ST_Point"],
                 "fields": [], "numericFields": []}
        result, calls = self.request(completion(json.dumps(draft)), body={
            "userPrompt": "在设施图层抽取样本", "operators": [third], "datasets": [point],
        })
        _, original_calls = self.request(completion(moran()))
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json(), draft)
        self.assertEqual(calls[0]["messages"][0], original_calls[0]["messages"][0])
        self.assertEqual(json.loads(calls[0]["messages"][1]["content"])["operators"], [third])

    def test_clarification_and_unsupported(self):
        for draft in [{"status": "clarification", "questions": ["请选择字段。"]},
                      {"status": "unsupported", "message": "此算子未注册。"}]:
            with self.subTest(draft=draft):
                result, _ = self.request(completion(json.dumps(draft)))
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json(), draft)

    def test_json_errors_parameters_and_truncation(self):
        for content, finish in [
            ("SELECT * FROM spatial_features", "stop"),
            ("   ", "stop"),
            (moran()[:-1], "stop"),
            (moran(), "length"),
            (moran(), "content_filter"),
            (moran(operator={"id": "spatial_autocorrelation", "version": "2"}), "stop"),
            (moran(parameters={"permutations": [199]}), "stop"),
            (moran(inputs={"target": {"ref": "real-file-id", "fields": {}}}), "stop"),
            (moran(sql="SELECT 1"), "stop"),
        ]:
            with self.subTest(content=content, finish=finish):
                result, calls = self.request(completion(content, finish))
                self.assertEqual(result.status_code, 502)
                self.assertEqual(result.json(), {"detail": "model_invalid_response"})
                self.assertEqual(len(calls), 1)

    def test_token_and_request_privacy(self):
        result, calls = self.request(completion(moran()), token="wrong")
        self.assertEqual(result.status_code, 401)
        self.assertFalse(calls)
        data = CONTEXT["datasets"][0] | {"properties": {"total_requests": 42}}
        result, calls = self.request(completion(moran()), body=CONTEXT | {"datasets": [data]})
        self.assertEqual(result.status_code, 422)
        self.assertFalse(calls)

    def test_timeout_and_rate_limit_are_bounded(self):
        for response, status, detail in [
            (httpx.ReadTimeout("timeout"), 504, "model_timeout"),
            (httpx.Response(429, json={"error": {"message": "private provider response"}}),
             429, "model_rate_limited"),
        ]:
            with self.subTest(status=status):
                result, calls = self.request(response)
                self.assertEqual(result.status_code, status)
                self.assertEqual(result.json(), {"detail": detail})
                self.assertEqual(len(calls), 1)
