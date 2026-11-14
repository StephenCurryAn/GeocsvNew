import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeNdjsonResponse, PipelineStreamError } from '../src/services/pipelineStream.ts';

const responseFromChunks = (chunks, status = 200) => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  },
}), { status });

test('reads Chinese events split across UTF-8 chunks and accepts a final line without newline', async () => {
  const bytes = new TextEncoder().encode('{"type":"step","message":"正在执行空间分析"}\n{"type":"result","data":{"ok":true}}');
  const events = [];
  const result = await consumeNdjsonResponse(responseFromChunks([
    bytes.slice(0, 28),
    bytes.slice(28, 34),
    bytes.slice(34),
  ]), event => events.push(event));

  assert.deepEqual(events.map(event => event.type), ['step', 'result']);
  assert.equal(events[0].message, '正在执行空间分析');
  assert.equal(result.data.ok, true);
});

test('surfaces non-2xx response details', async () => {
  const response = new Response(JSON.stringify({ message: '引擎不可用', details: 'offline' }), { status: 503 });
  await assert.rejects(consumeNdjsonResponse(response, () => {}), error => {
    assert.ok(error instanceof PipelineStreamError);
    assert.equal(error.status, 503);
    assert.equal(error.message, '引擎不可用');
    return true;
  });
});

test('surfaces server error events and malformed JSON', async () => {
  await assert.rejects(
    consumeNdjsonResponse(responseFromChunks([new TextEncoder().encode('{"type":"error","data":{"message":"计算失败"}}')]), () => {}),
    /计算失败/,
  );
  await assert.rejects(
    consumeNdjsonResponse(responseFromChunks([new TextEncoder().encode('{bad json}')]), () => {}),
    /不是有效 JSON/,
  );
});

test('requires a result event and propagates callback errors while releasing the reader', async () => {
  const noResult = responseFromChunks([new TextEncoder().encode('{"type":"step","message":"started"}')]);
  await assert.rejects(consumeNdjsonResponse(noResult, () => {}), /没有收到最终结果/);

  const callbackResponse = responseFromChunks([new TextEncoder().encode('{"type":"step"}\n')]);
  await assert.rejects(consumeNdjsonResponse(callbackResponse, () => { throw new Error('UI callback failed'); }), /UI callback failed/);
  assert.equal(callbackResponse.body.locked, false);
});

test('rejects missing result data, unknown events, and events after the terminal result', async () => {
  await assert.rejects(
    consumeNdjsonResponse(responseFromChunks([new TextEncoder().encode('{"type":"result"}')]), () => {}),
    /最终结果缺少 data/,
  );
  await assert.rejects(
    consumeNdjsonResponse(responseFromChunks([new TextEncoder().encode('{"type":"progress"}')]), () => {}),
    /未知事件类型/,
  );
  await assert.rejects(
    consumeNdjsonResponse(responseFromChunks([new TextEncoder().encode('{"type":"result","data":{}}\n{"type":"result","data":{}}')]), () => {}),
    /最终结果后仍收到额外事件/,
  );
});

test('propagates a stream interruption rather than treating it as a completed run', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"step"}\n'));
      controller.error(new Error('connection dropped'));
    },
  });
  await assert.rejects(consumeNdjsonResponse(new Response(stream), () => {}), /connection dropped/);
});
