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
  console.log(JSON.stringify({ upstreamVersion: client.getServerVersion().version, tools: tools.tools.length, discoveryCacheWithoutWorker: 'passed', workerExpiry: 'passed', lazyRestart: 'passed', syntheticProjectExplore: 'passed', initViaMcp: 'passed', statusViaMcp: 'passed', indexViaMcp: 'passed', readAfterIndex: 'passed' }));
} catch (error) { console.error(logs); throw error; }
finally { await client.close(); }
