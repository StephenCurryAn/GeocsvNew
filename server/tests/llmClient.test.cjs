const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Node LLM client initializes with legacy GIS browser globals present', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalKey = process.env.ALIYUN_API_KEY;
  try {
    // fileController installs these compatibility globals before the first model request.
    globalThis.window = globalThis;
    globalThis.document = {};
    process.env.ALIYUN_API_KEY = 'test-not-a-real-key';
    const { getLLMClient } = require('../src/integrations/llm/client');
    const client = getLLMClient();
    assert.equal(typeof client.chat.completions.create, 'function');
    assert.equal(getLLMClient(), client);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
    if (originalKey === undefined) delete process.env.ALIYUN_API_KEY;
    else process.env.ALIYUN_API_KEY = originalKey;
  }
});
