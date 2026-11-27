import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Proxy } from '../src/proxy.js';
import { runnerMode } from '../src/cli.js';
function fixture(options = {}) {
  let starts = 0;
  const input = new PassThrough(); const output = new PassThrough();
  const messages = [];
  output.on('data', data => { for (const line of String(data).trim().split('\n')) messages.push(JSON.parse(line)); });
  const p = new Proxy({ role: 'adapter', target: async () => { starts++; return { args: [fileURLToPath(new URL('./fixture.js', import.meta.url))], version: '1' }; }, ...options });
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
