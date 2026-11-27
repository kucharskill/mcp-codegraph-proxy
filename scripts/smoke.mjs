import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const entry = resolve(process.argv[2] ?? 'src/cli.js');
mkdirSync('.tmp', { recursive: true });
const project = mkdtempSync(resolve('.tmp/synthetic-project-'));
mkdirSync(project, { recursive: true });
writeFileSync(`${project}/sample.js`, 'export function greet(name) { return formatGreeting(name); }\nexport function formatGreeting(name) { return "Hello " + name; }\n');
writeFileSync(`${project}/sample.test.js`, 'import { greet } from "./sample.js";\nexport function testGreeting() { return greet("test"); }\n');
const git = spawnSync('git', ['init', project], { encoding: 'utf8', windowsHide: true });
assert.equal(git.status, 0, git.stderr);
const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: {
  ...process.env, CG_PROXY_RUNNER: process.env.CG_PROXY_RUNNER ?? 'local', CODEGRAPH_TELEMETRY: '0',
  CG_PROXY_DIAGNOSTICS: '1', CG_PROXY_DISCOVERY_IDLE_MS: '600', CG_PROXY_IDLE_MS: '600', CG_PROXY_DISCOVERY_CACHE_MS: '30000',
}, stderr: 'pipe' });
let logs = ''; transport.stderr.on('data', data => { logs += data; });
const client = new Client({ name: 'codegraph-smoke', version: '1' }, { capabilities: { roots: {} } });
const { ListRootsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [] }));
const starts = () => (logs.match(/"role":"adapter","event":"backend-start"/g) ?? []).length;
try {
  await client.connect(transport, { timeout: 180000 });
  const tools = await client.listTools({}, { timeout: 180000 });
  assert.ok(tools.tools.some(x => x.name === 'codegraph_explore'));
  assert.equal(tools.tools.filter(x => x.name === 'codegraph_index').length, 1);
  assert.equal(tools.tools.filter(x => x.name === 'codegraph_init').length, 1);
  assert.equal(tools.tools.filter(x => x.name === 'codegraph_status').length, 1);
  for (const name of ['codegraph_sync', 'codegraph_affected', 'codegraph_cycles']) assert.equal(tools.tools.filter(x => x.name === name).length, 1);
  assert.ok(client.getInstructions()?.length);
  assert.equal(starts(), 1);
  for (let i = 0; i < 120 && !logs.includes('idle-expired'); i++) await sleep(100);
  assert.ok(logs.includes('idle-expired'));
  await sleep(400);
  await client.listTools({}, { timeout: 180000 }); assert.equal(starts(), 1);
  const beforeInit = await client.callTool({ name: 'codegraph_status', arguments: { projectPath: project } }, undefined, { timeout: 180000 });
  assert.equal(JSON.parse(beforeInit.content[0].text).initialized, false);
  const initialized = await client.callTool({ name: 'codegraph_init', arguments: { projectPath: project } }, undefined, { timeout: 180000 });
  assert.ok(!initialized.isError, JSON.stringify(initialized));
  const status = await client.callTool({ name: 'codegraph_status', arguments: { projectPath: project } }, undefined, { timeout: 180000 });
  assert.ok(!status.isError, JSON.stringify(status));
  const health = JSON.parse(JSON.parse(status.content[0].text).stdout);
  assert.equal(health.initialized, true); assert.ok(health.nodeCount > 0);
  const result = await client.callTool({ name: 'codegraph_explore', arguments: { projectPath: project, query: 'greet formatGreeting', maxFiles: 2 } }, undefined, { timeout: 180000 });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(JSON.stringify(result).includes('greet'), JSON.stringify(result));
  assert.equal(starts(), 2);
  const indexedViaMcp = await client.callTool({ name: 'codegraph_index', arguments: { projectPath: project } }, undefined, { timeout: 180000 });
  assert.ok(!indexedViaMcp.isError, JSON.stringify(indexedViaMcp));
  assert.equal(JSON.parse(indexedViaMcp.content[0].text).exitCode, 0);
  const afterIndex = await client.callTool({ name: 'codegraph_explore', arguments: { projectPath: project, query: 'greet formatGreeting', maxFiles: 2 } }, undefined, { timeout: 180000 });
  assert.ok(!afterIndex.isError && JSON.stringify(afterIndex).includes('greet'), JSON.stringify(afterIndex));
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: { projectPath: project, ...args } }, undefined, { timeout: 180000 });
    assert.ok(!response.isError, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  const noCycles = await call('codegraph_cycles');
  assert.equal(noCycles.exitCode, 0); assert.equal(JSON.parse(noCycles.stdout).count, 0);
  writeFileSync(`${project}/cycle-a.js`, 'import { cycleB } from "./cycle-b.js";\nexport function cycleA() { return cycleB(); }\n');
  writeFileSync(`${project}/cycle-b.js`, 'import { cycleA } from "./cycle-a.js";\nexport function cycleB() { return cycleA(); }\n');
  writeFileSync(`${project}/sample.js`, 'export function greet(name) { return formatGreeting(name); }\nexport function formatGreeting(name) { return "Hello " + name; }\nexport function syncMarkerAdded() { return greet("sync"); }\n');
  assert.equal((await call('codegraph_sync')).exitCode, 0);
  const afterSync = await client.callTool({ name: 'codegraph_explore', arguments: { projectPath: project, query: 'syncMarkerAdded', maxFiles: 2 } }, undefined, { timeout: 180000 });
  assert.ok(!afterSync.isError && JSON.stringify(afterSync).includes('syncMarkerAdded'), JSON.stringify(afterSync));
  const affected = await call('codegraph_affected', { files: ['sample.js', 'deleted.js', '--help'], depth: 5, filter: '*.test.js', crossTier: false });
  assert.ok(JSON.parse(affected.stdout).affectedTests.includes('sample.test.js'), affected.stdout);
  const cycles = await call('codegraph_cycles');
  assert.equal(cycles.exitCode, 1); assert.ok(JSON.parse(cycles.stdout).count > 0);
  console.log(JSON.stringify({ upstreamVersion: client.getServerVersion().version, tools: tools.tools.length, discoveryCacheWithoutWorker: 'passed', workerExpiry: 'passed', lazyRestart: 'passed', syntheticProjectExplore: 'passed', initViaMcp: 'passed', statusViaMcp: 'passed', indexViaMcp: 'passed', readAfterIndex: 'passed', syncViaMcp: 'passed', readAfterSync: 'passed', affectedTestsViaMcp: 'passed', cyclesWithAndWithoutFindings: 'passed' }));
} catch (error) { console.error(logs); throw error; }
finally { await client.close(); }
