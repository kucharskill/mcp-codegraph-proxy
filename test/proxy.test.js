import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Proxy } from '../src/proxy.js';
import { runnerMode } from '../src/cli.js';
import { indexTool } from '../src/index-tool.js';
import { projectTools, statusTool } from '../src/project-tools.js';
function fixture(options = {}) {
  const { localTool, ...proxyOptions } = options;
  let starts = 0;
  const input = new PassThrough(); const output = new PassThrough();
  const messages = [];
  output.on('data', data => { for (const line of String(data).trim().split('\n')) messages.push(JSON.parse(line)); });
  const p = new Proxy({ role: 'adapter', target: async () => { starts++; return { args: [fileURLToPath(new URL('./fixture.js', import.meta.url))], version: '1' }; }, localTools: localTool ? [localTool] : [], ...proxyOptions });
  p.connect(input, output);
  const send = message => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const response = async id => {
    for (let i = 0; i < 300; i++) { const m = messages.find(x => x.id === id && !x.method); if (m) return m; await sleep(10); }
    throw new Error(`No response for ${id}`);
  };
  const init = async () => { send({ id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }); const r = await response(0); send({ method: 'notifications/initialized' }); return r; };
  return { p, input, messages, send, response, init, starts: () => starts };
}
test('runner selection supports local development and npx latest', () => {
  assert.equal(runnerMode({}, '/repo/src/cli.js'), 'local');
  assert.equal(runnerMode({ npm_command: 'exec' }, '/cache/_npx/id/node_modules/pkg/src/cli.js'), 'latest');
  assert.equal(runnerMode({ CG_PROXY_RUNNER: 'local', npm_command: 'exec' }, '/cache/_npx/id/node_modules/pkg/src/cli.js'), 'local');
  assert.throws(() => runnerMode({ CG_PROXY_RUNNER: 'bad' }));
});
test('preserves initialization, schemas, arguments and arbitrary methods', async () => {
  const f = fixture();
  try {
    assert.equal((await f.init()).result.instructions, 'Verbatim upstream instructions.');
    f.send({ id: 1, method: 'tools/list' });
    assert.equal((await f.response(1)).result.tools[0].name, 'fixture_echo');
    f.send({ id: 2, method: 'tools/call', params: { name: 'fixture_echo', arguments: { projectPath: '/sample', query: 'hello' } } });
    assert.equal(JSON.parse((await f.response(2)).result.content[0].text).projectPath, '/sample');
    f.send({ id: 3, method: 'custom/method', params: { untouched: true } });
    assert.deepEqual((await f.response(3)).result, { receivedMethod: 'custom/method', params: { untouched: true } });
  } finally { await f.p.close(); }
});
test('cached discovery does not start backend; real call bootstraps lazily', async () => {
  const f = fixture();
  try {
    await f.init(); f.send({ id: 1, method: 'tools/list' }); await f.response(1);
    await f.p.child.close();
    f.send({ id: 2, method: 'tools/list' }); await f.response(2);
    assert.equal(f.starts(), 1);
    f.send({ id: 3, method: 'tools/call', params: { name: 'fixture_echo', arguments: {} } });
    assert.ok((await f.response(3)).result); assert.equal(f.starts(), 2);
  } finally { await f.p.close(); }
});
test('one worker deadline uses max and cannot expire pending work', async () => {
  const f = fixture({ role: 'worker', idleMs: 90, discoveryMs: 15 });
  try {
    await f.init();
    f.send({ id: 1, method: 'tools/call', params: { name: 'fixture_echo', arguments: { delay: 130 } } });
    await sleep(45); assert.equal(f.p.closed, false); assert.equal(f.p.pending.size, 1);
    await f.response(1); const deadline = f.p.expiresAt;
    f.send({ id: 2, method: 'tools/list' }); await f.response(2);
    assert.ok(f.p.expiresAt >= deadline);
    await sleep(35); assert.equal(f.p.closed, false);
    await sleep(120); assert.equal(f.p.closed, true);
  } finally { await f.p.close(); }
});
test('cache invalidates on roots changes; late notifications never start backend', async () => {
  const f = fixture();
  try {
    await f.init(); f.send({ id: 1, method: 'tools/list' }); await f.response(1); await f.p.child.close();
    f.send({ method: 'notifications/roots/list_changed' });
    await sleep(10); assert.equal(f.starts(), 1); assert.equal(f.p.cache.size, 0);
    f.send({ id: 2, method: 'tools/list' }); await f.response(2); assert.equal(f.starts(), 2);
  } finally { await f.p.close(); }
});
test('backend crash returns unknown outcome without replaying the tool', async () => {
  const f = fixture();
  try {
    await f.init(); f.send({ id: 1, method: 'tools/call', params: { name: 'fixture_echo', arguments: { crash: true } } });
    assert.match((await f.response(1)).error.message, /unknown/);
    assert.equal(f.starts(), 1);
  } finally { await f.p.close(); }
});
test('backend roots requests and client responses pass through', async () => {
  const f = fixture();
  try {
    await f.init(); f.send({ id: 1, method: 'tools/list', params: { roots: true } });
    for (let i = 0; i < 100 && !f.messages.some(m => m.method === 'roots/list'); i++) await sleep(10);
    assert.ok(f.messages.some(m => m.method === 'roots/list'));
    f.send({ id: 'server-roots', result: { roots: [{ uri: 'file:///fixture' }] } });
    assert.equal((await f.response(1)).result.roots[0].uri, 'file:///fixture');
  } finally { await f.p.close(); }
});
test('cancellation does not release still-executing work or restart backend', async () => {
  const f = fixture({ role: 'worker', idleMs: 50, discoveryMs: 10 });
  try {
    await f.init(); f.send({ id: 1, method: 'tools/call', params: { name: 'fixture_echo', arguments: { delay: 120 } } });
    await sleep(15); f.send({ method: 'notifications/cancelled', params: { requestId: 1 } });
    await sleep(60); assert.equal(f.p.pending.size, 1); assert.equal(f.p.closed, false);
    await f.response(1); assert.equal(f.starts(), 1);
  } finally { await f.p.close(); }
});
test('upstream version change invalidates catalog after lazy bootstrap', async () => {
  const f = fixture();
  try {
    await f.init(); f.send({ id: 1, method: 'tools/list' }); await f.response(1); await f.p.child.close();
    f.p.env = { ...process.env, FIXTURE_VERSION: '2' };
    f.send({ id: 2, method: 'tools/call', params: { name: 'fixture_echo', arguments: {} } }); await f.response(2);
    assert.equal(f.p.cache.size, 0);
    assert.ok(f.messages.some(m => m.method === 'notifications/tools/list_changed'));
  } finally { await f.p.close(); }
});
test('ping is answered locally after backend expiry', async () => {
  const f = fixture();
  try {
    await f.init(); await f.p.child.close();
    f.send({ id: 1, method: 'ping' });
    assert.deepEqual((await f.response(1)).result, {});
    assert.equal(f.starts(), 1);
  } finally { await f.p.close(); }
});
test('new work waits for a draining worker and is sent only to its replacement', async () => {
  const f = fixture({ env: { ...process.env, FIXTURE_DRAIN: '1' } });
  try {
    await f.init(); f.send({ id: 1, method: 'tools/list' }); await f.response(1);
    f.send({ id: 2, method: 'tools/call', params: { name: 'fixture_echo', arguments: { replacement: true } } });
    const response = await f.response(2);
    assert.ok(!response.error, JSON.stringify(response));
    assert.equal(JSON.parse(response.result.content[0].text).replacement, true);
    assert.equal(f.starts(), 2);
    assert.equal(f.messages.some(m => m.method === 'notifications/mcp-codegraph-proxy/closing'), false);
  } finally { await f.p.close(); }
});
test('worker augments the native catalog without replacing its tools', async () => {
  const f = fixture({ role: 'worker', localTool: { definition: indexTool, validate: async x => x, execute: async () => ({ content: [] }) } });
  try {
    await f.init(); f.send({ id: 1, method: 'tools/list' });
    const tools = (await f.response(1)).result.tools;
    assert.deepEqual(tools.map(x => x.name), ['fixture_echo', 'codegraph_index']);
    assert.equal(tools[0].description, 'Echo arguments');
  } finally { await f.p.close(); }
});
test('index waits for running reads and queues later reads, then restarts upstream', async () => {
  let executed = 0;
  const f = fixture({ role: 'worker', idleMs: 0, localTool: { definition: indexTool, validate: async x => x, execute: async () => { executed++; await sleep(70); return { content: [{ type: 'text', text: 'indexed' }] }; } } });
  try {
    await f.init();
    f.send({ id: 1, method: 'tools/call', params: { name: 'fixture_echo', arguments: { delay: 100 } } });
    await sleep(15);
    f.send({ id: 2, method: 'tools/call', params: { name: 'codegraph_index', arguments: { projectPath: '/fixture' } } });
    f.send({ id: 3, method: 'tools/call', params: { name: 'fixture_echo', arguments: { after: true } } });
    await sleep(30); assert.equal(executed, 0);
    assert.ok((await f.response(1)).result);
    assert.equal((await f.response(2)).result.content[0].text, 'indexed');
    assert.equal(JSON.parse((await f.response(3)).result.content[0].text).after, true);
    assert.equal(f.starts(), 2);
  } finally { await f.p.close(); }
});
test('invalid index request preserves the existing reader; failure is a tool result', async () => {
  const f = fixture({ role: 'worker', localTool: { definition: indexTool, validate: async () => { throw new Error('invalid path'); }, execute: async () => { throw new Error('must not run'); } } });
  try {
    await f.init(); f.send({ id: 1, method: 'tools/call', params: { name: 'codegraph_index', arguments: {} } });
    assert.equal((await f.response(1)).result.isError, true);
    assert.equal(f.starts(), 1); assert.ok(f.p.child);
  } finally { await f.p.close(); }
});
test('worker expires after a local index even with upstream readers detached', async () => {
  const f = fixture({ role: 'worker', idleMs: 30, discoveryMs: 30, localTool: { definition: indexTool, validate: async x => x, execute: async () => ({ content: [] }) } });
  try {
    await f.init(); f.send({ id: 1, method: 'tools/call', params: { name: 'codegraph_index', arguments: {} } });
    await f.response(1); assert.equal(f.p.child, undefined);
    await sleep(90); assert.equal(f.p.closed, true);
  } finally { await f.p.close(); }
});
test('an upstream tool with the same name is kept and executed natively', async () => {
  let localCalls = 0;
  const f = fixture({ role: 'worker', env: { ...process.env, FIXTURE_NATIVE_INDEX: '1' }, localTool: { definition: indexTool, validate: async x => x, execute: async () => { localCalls++; return { content: [] }; } } });
  try {
    await f.init(); f.send({ id: 1, method: 'tools/list' });
    const tools = (await f.response(1)).result.tools;
    assert.equal(tools.filter(x => x.name === 'codegraph_index').length, 1);
    assert.equal(tools.find(x => x.name === 'codegraph_index').description, 'Native index definition');
    f.send({ id: 2, method: 'tools/call', params: { name: 'codegraph_index', arguments: { native: true } } });
    assert.equal(JSON.parse((await f.response(2)).result.content[0].text).native, true);
    assert.equal(localCalls, 0);
  } finally { await f.p.close(); }
});
test('disconnect aborts owned local execution and waits for it to settle', async () => {
  let running = false, aborted = false;
  const f = fixture({ role: 'worker', localTool: { definition: indexTool, validate: async x => x, execute: async (_args, { signal }) => {
    running = true;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('stopped')); }, { once: true }));
  } } });
  await f.init(); f.send({ id: 1, method: 'tools/call', params: { name: 'codegraph_index', arguments: {} } });
  for (let i = 0; i < 100 && !running; i++) await sleep(10);
  assert.equal(running, true); assert.equal(f.p.pending.size, 1);
  await f.p.close(); assert.equal(aborted, true);
});

test('multiple supplements preserve a paginated native catalog and status collision', async () => {
  const f = fixture({ role: 'worker', env: { ...process.env, FIXTURE_NATIVE_STATUS: '1', FIXTURE_PAGES: '1' }, localTools: projectTools });
  try {
    await f.init(); f.send({ id: 1, method: 'tools/list' });
    const first = (await f.response(1)).result;
    assert.equal(first.nextCursor, 'second');
    assert.deepEqual(first.tools.map(x => x.name), ['codegraph_status']);
    f.send({ id: 2, method: 'tools/list', params: { cursor: first.nextCursor } });
    const second = (await f.response(2)).result;
    assert.deepEqual(second.tools.map(x => x.name), ['fixture_echo', 'codegraph_index', 'codegraph_init']);
    f.send({ id: 3, method: 'tools/call', params: { name: 'codegraph_status', arguments: { native: true } } });
    assert.equal(JSON.parse((await f.response(3)).result.content[0].text).native, true);
  } finally { await f.p.close(); }
});

test('local status preserves the active backend reader', async () => {
  const f = fixture({ role: 'worker', localTools: [{ definition: statusTool, validate: async x => x, execute: async () => ({ content: [] }), exclusive: false }] });
  try {
    await f.init(); const child = f.p.child;
    f.send({ id: 1, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
    assert.ok((await f.response(1)).result);
    assert.equal(f.p.child, child); assert.equal(f.starts(), 1);
  } finally { await f.p.close(); }
});

test('a worker using a cached client catalog still discovers native name collisions', async () => {
  const f = fixture({ role: 'worker', env: { ...process.env, FIXTURE_NATIVE_STATUS: '1', FIXTURE_PAGES: '1' }, localTools: projectTools });
  try {
    await f.init();
    // A fresh worker can receive a call without tools/list from the adapter cache.
    f.send({ id: 1, method: 'tools/call', params: { name: 'codegraph_status', arguments: { native: true } } });
    assert.equal(JSON.parse((await f.response(1)).result.content[0].text).native, true);
    assert.equal(f.messages.some(m => String(m.id).startsWith('catalog-')), false);
  } finally { await f.p.close(); }
});
