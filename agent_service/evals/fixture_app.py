"""Offline evaluation entry point. Run only via the eval Compose override."""

import json
from pathlib import Path

import httpx
from langchain_openai import ChatOpenAI

import main

suite = json.loads(Path(__file__).with_name("chicago311.json").read_text(encoding="utf-8"))
responses = {}
for case in suite["cases"]:
    if "fixture" in case:
        responses[case["prompt"]] = case["fixture"]
    if "answer" in case:
        answer = case["answer"]
        responses[case["prompt"] + "\n用户补充：" + answer["prompt"]] = answer["fixture"]


def respond(request: httpx.Request):
    messages = json.loads(request.content)["messages"]
    context = json.loads(messages[-1]["content"])
    fixture = responses.get(context["userPrompt"])
    if fixture is None:
        return httpx.Response(422, json={"error": {"message": "Unknown evaluation fixture"}})
    if "providerStatus" in fixture:
        return httpx.Response(fixture["providerStatus"], json={"error": {"message": "Fixture rate limit"}})
    if "questions" in fixture:
        draft = {"status": "clarification", "questions": fixture["questions"]}
    else:
        ref = fixture.get("ref") or next(
            dataset["ref"] for dataset in context["datasets"] if dataset["name"] == suite["layerName"]
        )
        draft = {
            "status": "ready",
            "operator": {"id": "spatial_autocorrelation", "version": 2},
            "inputs": {"target": {"ref": ref, "fields": {"valueField": fixture["field"]}}},
            "parameters": fixture["parameters"],
        }
    return httpx.Response(200, json={
        "id": "chicago311_fixture",
        "model": "chicago311-fixture",
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": json.dumps(draft)}}],
    })


def build_fixture():
    return ChatOpenAI(
        model="chicago311-fixture", base_url="https://fixture.invalid/v1", api_key="fixture-only",
        http_async_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
        use_responses_api=False, max_retries=0,
    )


main.build_model = build_fixture
app = main.app
