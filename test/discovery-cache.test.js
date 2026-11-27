import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { DiscoveryCache, invocationKey, digest } from '../src/discovery-cache.js';
const init = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cache-test', version: '1' } };
const initialized = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' }, instructions: 'Original instructions' };
const tools = { tools: [{ name: 'echo', description: 'Metadata', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } }] };
const context = digest(init); const identity = digest(initialized.serverInfo);
function directory() { mkdirSync('.tmp', { recursive: true }); return mkdtempSync(resolve('.tmp/discovery-cache-')); }
function cache(options = {}) { return new DiscoveryCache({ invocation: { command: 'fixture', args: ['serve', '--mcp'], cwd: '/project', env: { SECRET: 'not-for-cache' } }, directory: directory(), ...options }); }

test('invocation hash includes command, args, cwd and the whole environment, excluding configured volatile names', () => {
  const invocation = { command: 'node', args: ['a', 'b'], cwd: '/project', env: { B: '2', A: '1', CODEX_TOOL_CALL_ID: 'one' } };
  assert.equal(invocationKey(invocation), invocationKey({ ...invocation, env: { CODEX_TOOL_CALL_ID: 'two', A: '1', B: '2' } }));
  for (const change of [{ command: 'other' }, { args: ['a b'] }, { cwd: '/other' }, { env: { ...invocation.env, EXTRA: 'value' } }]) assert.notEqual(invocationKey(invocation), invocationKey({ ...invocation, ...change }));
  assert.equal(invocationKey({ ...invocation, env: { Path: 'bin', codex_tool_call_id: 'a' } }, { platform: 'win32' }), invocationKey({ ...invocation, env: { PATH: 'bin', CODEX_TOOL_CALL_ID: 'b' } }, { platform: 'win32' }));
  assert.equal(invocationKey({ ...invocation, env: { VOLATILE: 'a', A: '1' } }, { ignoreEnv: ['VOLATILE'] }), invocationKey({ ...invocation, env: { VOLATILE: 'b', A: '1' } }, { ignoreEnv: ['VOLATILE'] }));
});

test('disk cache has a fixed ten-minute expiry and contains only validated discovery metadata', async () => {
  const c = cache(); const revision = c.get(context, 'tools', 'tools/list').revision;
  c.put(context, 'tools', 'tools/list', tools, revision, identity); await c.flush();
  const first = c.get(context, 'tools', 'tools/list').entry;
  assert.deepEqual(first.result, tools); assert.equal(first.expiresAt - first.createdAt, 600000);
  await sleep(5); assert.equal(c.get(context, 'tools', 'tools/list').entry.expiresAt, first.expiresAt);
  c.put(context, 'call', 'tools/call', { content: [{ type: 'text', text: 'tool-result-secret' }] }, revision, identity);
  c.put(context, 'init', 'initialize', { ...initialized, sessionId: 'session-secret' }, revision, identity);
  c.put(context, 'meta', 'initialize', { ...initialized, _meta: { sessionId: 'session-secret' } }, revision, identity);
  await c.flush();
  const text = readFileSync(c.file, 'utf8');
  for (const secret of ['not-for-cache', 'tool-result-secret', 'session-secret', 'CODEX_TOOL_CALL_ID']) assert.equal(text.includes(secret), false);
});

test('expiry, malformed or old documents and invalid metadata safely miss', async () => {
  const c = cache({ ttl: 25 });
  c.put(context, 'init', 'initialize', initialized, c.revision(), identity); await c.flush();
  assert.ok(c.get(context, 'init', 'initialize').entry); await sleep(40);
  assert.equal(c.get(context, 'init', 'initialize').entry, undefined);
  for (const text of ['{broken', '{"format":0}', JSON.stringify({ format: 1, revision: c.revision(), identity, entries: [{ context, key: digest('tools'), method: 'tools/list', result: { tools: [{ name: 'bad' }] }, createdAt: Date.now(), expiresAt: Date.now() + 10000 }] })]) {
    writeFileSync(c.file, text); assert.equal(c.get(context, 'tools', 'tools/list').entry, undefined);
  }
});

test('revision invalidation prevents a stale concurrent writer from restoring an old catalog', async () => {
  const c = cache(); const other = cache({ directory: c.directory }); const revision = c.revision();
  c.put(context, 'tools', 'tools/list', tools, revision, identity); await c.flush();
  other.invalidate(); c.put(context, 'tools', 'tools/list', tools, revision, identity); await c.flush();
  assert.equal(other.get(context, 'tools', 'tools/list').entry, undefined);
  other.put(context, 'tools', 'tools/list', tools, other.revision(), identity); await other.flush();
  assert.deepEqual(c.get(context, 'tools', 'tools/list').entry.result, tools);
});

function replica(options, env = process.env, roots = []) {
  const child = spawn(process.execPath, [resolve('test/cache-runner.js'), JSON.stringify(options)], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); const notifications = []; let sequence = 0; let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const closed = once(child, 'exit');
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method) notifications.push(message);
    if (message.method === 'roots/list') child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { roots } }) + '\n');
    pending.get(message.id)?.(message); pending.delete(message.id);
  });
  const request = (method, params) => new Promise((done, reject) => {
    const id = ++sequence; const timer = setTimeout(() => reject(new Error(`No response for ${method}: ${errors}`)), 5000);
    pending.set(id, message => { clearTimeout(timer); done(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
  });
  return { request, notifications, errors: () => errors, async init(params = init) { const r = await request('initialize', params); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); return r; }, async close() { child.stdin.end(); const [code] = await closed; assert.equal(code, 0, errors); } };
}
function options() { const root = directory(); return { directory: join(root, 'discovery'), starts: join(root, 'starts'), cwd: root }; }
function starts(o) { try { return readFileSync(o.starts, 'utf8').trim().split('\n').length; } catch { return 0; } }

test('a second process initializes and lists tools from shared cache without starting a backend; real work starts it and retains original env', async () => {
  const o = options(); const first = replica(o, { ...process.env, CODEX_TOOL_CALL_ID: 'first-id' });
  let hello, catalog;
  try { hello = await first.init(); catalog = await first.request('tools/list'); } finally { await first.close(); }
  assert.equal(starts(o), 1);
  const second = replica(o, { ...process.env, CODEX_TOOL_CALL_ID: 'second-id' });
  try {
    assert.deepEqual((await second.init()).result, hello.result);
    assert.deepEqual((await second.request('tools/list')).result, catalog.result);
    assert.deepEqual((await second.request('ping')).result, {}); assert.equal(starts(o), 1);
    const result = await second.request('tools/call', { name: 'fixture_env', arguments: {} });
    assert.equal(JSON.parse(result.result.content[0].text).callId, 'second-id'); assert.equal(starts(o), 2);
  } finally { await second.close(); }
});

test('cold ping and declared modern ping never start a backend; modern ping is not synthesized', async () => {
  const o = options(); const p = replica(o);
  try { assert.deepEqual((await p.request('ping')).result, {}); assert.equal(starts(o), 0);
    assert.equal((await p.request('ping', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } })).error.code, -32601); assert.equal(starts(o), 0);
    await p.request('server/discover'); const count = starts(o);
    assert.equal((await p.request('ping')).error.code, -32601); assert.equal(starts(o), count);
  } finally { await p.close(); }
});

test('different protocol/capabilities, args, cwd or environment cannot reuse incompatible discovery', async () => {
  const o = options(); const first = replica(o); try { await first.init(); await first.request('tools/list'); } finally { await first.close(); }
  for (const change of [{ args: ['changed'] }, { cwd: directory() }]) {
    const p = replica({ ...o, ...change }); try { await p.init(); } finally { await p.close(); }
  }
  const p = replica(o, { ...process.env, EXTRA_CACHE_ENV: 'changed' }); try { await p.init(); } finally { await p.close(); }
  const differentProtocol = replica(o); try { await differentProtocol.init({ ...init, protocolVersion: '2024-11-05', capabilities: { roots: {} } }); } finally { await differentProtocol.close(); }
  assert.equal(starts(o), 5);
});

test('two fixture processes merge concurrent discovery writes under a short lock', async () => {
  const o = options(); mkdirSync(o.directory);
  const a = replica(o), b = replica(o);
  try {
    await Promise.all([a.init(), b.init()]);
    // Hold the metadata lock while both discovery results are queued, then release it.
    const file = readdirSync(o.directory).find(name => name.endsWith('.json'));
    const lock = join(o.directory, file + '.lock'); writeFileSync(lock, '');
    const responses = Promise.all([a.request('resources/list'), b.request('prompts/list')]);
    await sleep(60); unlinkSync(lock); await responses;
  } finally { await Promise.all([a.close(), b.close()]); }
  const doc = JSON.parse(readFileSync(join(o.directory, readdirSync(o.directory).find(name => name.endsWith('.json'))), 'utf8'));
  assert.ok(doc.entries.some(entry => entry.method === 'resources/list'), a.errors() + b.errors()); assert.ok(doc.entries.some(entry => entry.method === 'prompts/list'), a.errors() + b.errors());
});

test('catalog notifications invalidate disk metadata visible to another live replica', async () => {
  const o = options(); const flag = join(o.cwd, 'catalog'); writeFileSync(flag, 'original');
  const env = { ...process.env, FIXTURE_CATALOG_FILE: flag };
  const a = replica(o, env); await a.init(); await a.request('tools/list');
  const b = replica(o, env);
  try {
    await b.init(); await b.request('tools/list'); assert.equal(starts(o), 1);
    writeFileSync(flag, 'updated');
    await a.request('tools/call', { name: 'fixture_echo', arguments: { listChanged: true } });
    await a.request('tools/list');
    assert.ok((await b.request('tools/list')).result.tools.some(tool => tool.name === 'fixture_updated'));
    assert.equal(starts(o), 1);
  } finally { await Promise.all([a.close(), b.close()]); }
});

test('changed backend identity invalidates a warm initialization and catalog', async () => {
  const o = options(); const version = join(o.cwd, 'version'); writeFileSync(version, '1');
  const env = { ...process.env, FIXTURE_VERSION_FILE: version };
  const a = replica(o, env); try { await a.init(); await a.request('tools/list'); } finally { await a.close(); }
  const b = replica(o, env);
  try {
    assert.equal((await b.init()).result.serverInfo.version, '1'); assert.equal(starts(o), 1);
    writeFileSync(version, '2');
    await b.request('tools/call', { name: 'fixture_echo', arguments: {} });
    assert.ok(b.notifications.some(message => message.method === 'notifications/tools/list_changed'));
    const c = replica(o, env); try { assert.equal((await c.init()).result.serverInfo.version, '2'); } finally { await c.close(); }
    assert.equal(starts(o), 3);
  } finally { await b.close(); }
});

test('shared cache hits and ping do not extend a running worker deadline', async () => {
  const o = { ...options(), worker: true, retention: 120 }; o.exits = join(o.cwd, 'exits');
  const p = replica(o);
  try {
    await p.init(); await p.request('tools/list');
    for (let i = 0; i < 8; i++) { await sleep(30); await p.request('tools/list'); await p.request('ping'); }
    assert.equal(starts(o), 1); assert.ok(readFileSync(o.exits, 'utf8').includes('exit'));
    await p.request('tools/call', { name: 'fixture_echo', arguments: {} }); assert.equal(starts(o), 2);
  } finally { await p.close(); }
});

test('catalogs are partitioned by a client roots snapshot without storing its paths', async () => {
  const o = options(); const params = { ...init, capabilities: { roots: {} } };
  const rootsA = [{ uri: 'file:///private-workspace-a', name: 'workspace-a' }];
  const a = replica(o, process.env, rootsA);
  try { await a.init(params); await a.request('tools/list'); } finally { await a.close(); }
  const b = replica(o, process.env, [{ uri: 'file:///private-workspace-b' }]);
  try { await b.init(params); assert.equal(starts(o), 1); await b.request('tools/list'); assert.equal(starts(o), 2); } finally { await b.close(); }
  const c = replica(o, process.env, rootsA);
  try { await c.init(params); await c.request('tools/list'); assert.equal(starts(o), 2); } finally { await c.close(); }
  for (const file of readdirSync(o.directory).filter(name => name.endsWith('.json'))) assert.equal(readFileSync(join(o.directory, file), 'utf8').includes('private-workspace'), false);
});

test('a protocol change during warm bootstrap requires a fresh negotiation', async () => {
  const o = options(); const protocol = join(o.cwd, 'protocol'); writeFileSync(protocol, init.protocolVersion);
  const env = { ...process.env, FIXTURE_PROTOCOL_FILE: protocol };
  const a = replica(o, env); try { await a.init(); await a.request('tools/list'); } finally { await a.close(); }
  const b = replica(o, env);
  try {
    await b.init(); writeFileSync(protocol, '2024-11-05');
    const result = await b.request('tools/call', { name: 'fixture_echo', arguments: {} });
    assert.ok(result.error); assert.equal(result.result, undefined);
  } finally { await b.close(); }
  const c = replica(o, env); try { assert.equal((await c.init()).result.protocolVersion, '2024-11-05'); assert.equal(starts(o), 3); } finally { await c.close(); }
});
