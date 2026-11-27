import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('SDK client receives the identical complete public discovery result from a warm replica despite ttlMs zero', async () => {
  mkdirSync('.tmp', { recursive: true });
  const root = mkdtempSync(resolve('.tmp/sdk-discovery-'));
  const options = { directory: join(root, 'discovery'), starts: join(root, 'starts'), cwd: root, worker: true, augment: true, retention: 5000 };
  const env = { ...process.env, FIXTURE_DISCOVERY_EXTRAS: '1' };
  const starts = () => readFileSync(options.starts, 'utf8').trim().split('\n').length;
  function peer() {
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('test/cache-runner.js'), JSON.stringify(options)], env, stderr: 'pipe' });
    const requests = new Map(), responses = new Map();
    const send = transport.send.bind(transport);
    transport.send = message => { if (message.method && Object.hasOwn(message, 'id')) requests.set(message.id, message.method); return send(message); };
    const start = transport.start.bind(transport);
    transport.start = async () => {
      const receive = transport.onmessage;
      transport.onmessage = message => { if (Object.hasOwn(message, 'result')) responses.set(requests.get(message.id), structuredClone(message)); receive?.(message); };
      await start();
    };
    return { client: new Client({ name: 'discovery-sdk-test', version: '1' }), transport, responses };
  }
  const first = peer();
  let cold;
  async function discovery(client) {
    return {
      'tools/list': await client.listTools(),
      'prompts/list': await client.listPrompts(),
      'resources/list': await client.listResources(),
      'resources/templates/list': await client.listResourceTemplates(),
    };
  }
  try {
    await first.client.connect(first.transport); cold = await discovery(first.client);
    assert.equal(starts(), 1);
    for (const result of Object.values(cold)) {
      assert.equal(result.ttlMs, 0); assert.equal(result.cacheScope, 'session'); assert.equal(result.resultType, 'fixture-discovery');
      assert.deepEqual(result._meta, { 'fixture/metadata': { preserved: true } });
      assert.deepEqual(result.futureField, { nested: ['verbatim', 0, false] });
    }
    const catalog = cold['tools/list'].tools;
    for (const name of ['codegraph_init', 'codegraph_index', 'codegraph_status', 'codegraph_sync', 'codegraph_affected', 'codegraph_cycles']) assert.equal(catalog.filter(tool => tool.name === name).length, 1);
    assert.deepEqual(catalog.find(tool => tool.name === 'codegraph_index').inputSchema.required, ['indexPath']);
    assert.deepEqual(catalog[0].outputSchema, { type: 'object' });
    assert.deepEqual(catalog[0].annotations, { readOnlyHint: true, idempotentHint: true });
    assert.deepEqual(catalog[0]._meta, { 'fixture/tool': 'preserved' });
    const doc = JSON.parse(readFileSync(join(options.directory, readdirSync(options.directory).find(name => /^[a-f0-9]{64}\.json$/.test(name))), 'utf8'));
    for (const method of ['initialize', ...Object.keys(cold)]) {
      const entry = doc.entries.find(entry => entry.method === method);
      assert.equal(entry.result.ttlMs, 0); assert.equal(entry.expiresAt - entry.createdAt, 600000);
      assert.deepEqual(entry.result, first.responses.get(method).result);
    }
  } finally { await first.client.close(); }
  const second = peer();
  try {
    await second.client.connect(second.transport);
    assert.deepEqual(second.responses.get('initialize').result, first.responses.get('initialize').result);
    await second.client.ping(); // Shift request IDs to prove cached envelopes are not replayed.
    const warm = await discovery(second.client);
    assert.deepEqual(warm, cold); assert.equal(starts(), 1);
    for (const method of Object.keys(cold)) {
      assert.deepEqual(second.responses.get(method).result, first.responses.get(method).result);
      assert.notEqual(second.responses.get(method).id, first.responses.get(method).id);
    }
    const result = await second.client.callTool({ name: 'fixture_echo', arguments: { query: 'a real delegated operation' } });
    assert.deepEqual(result.structuredContent, { query: 'a real delegated operation' }); assert.equal(starts(), 2);
  } finally { await second.client.close(); }
});
