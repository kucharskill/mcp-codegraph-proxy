import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { validateIndexArguments } from '../src/index-tool.js';
import { runCommand } from '../src/run-command.js';
import { projectTools, readStatus, validateAffectedArguments, cycleCommandSucceeded } from '../src/project-tools.js';

test('index tool requires an exact indexed absolute directory', async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/index-validation-'));
  await assert.rejects(validateIndexArguments({ projectPath: 'relative' }), /absolute/);
  await assert.rejects(validateIndexArguments({ projectPath: root, force: true }), /no other/);
  await assert.rejects(validateIndexArguments({ projectPath: root }), /no .codegraph/);
  await mkdir(join(root, '.codegraph')); await mkdir(join(root, 'subdir'));
  assert.equal((await validateIndexArguments({ projectPath: root })).projectPath, await realpath(root));
  await assert.rejects(validateIndexArguments({ projectPath: join(root, 'subdir') }), /no .codegraph/);
});

test('init and status accept exact unindexed projects without using their parent index', async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/project-validation-'));
  await mkdir(join(root, '.codegraph')); await mkdir(join(root, 'child'));
  for (const name of ['codegraph_init', 'codegraph_status']) {
    const tool = projectTools.find(tool => tool.definition.name === name);
    const args = await tool.validate({ projectPath: join(root, 'child') });
    assert.equal(args.indexed, false);
    assert.equal(args.projectPath, await realpath(join(root, 'child')));
    await assert.rejects(tool.validate({ projectPath: root, command: 'uninit' }), /no other/);
  }
  const status = await readStatus({ projectPath: root, indexed: false });
  assert.deepEqual(JSON.parse(status.content[0].text), { projectPath: root, initialized: false });
});
test('non-MCP CLI output is captured and bounded without entering MCP stdout', async () => {
  await mkdir('.tmp', { recursive: true });
  const fixture = resolve('.tmp/command-output.cjs');
  await writeFile(fixture, `console.log('x'.repeat(80000)); console.error('stderr marker'); process.exitCode = 7;`);
  const result = await runCommand([fixture]);
  assert.equal(result.exitCode, 7); assert.equal(result.outputTruncated, true);
  assert.ok(result.stdout.length <= 65536); assert.match(result.stderr, /stderr marker/);
});

test('affected validates deleted paths, confines them to the project and rejects malformed options', async () => {
  const root = await mkdtemp(resolve('.tmp/affected-validation-'));
  await mkdir(join(root, '.codegraph'));
  const validated = await validateAffectedArguments({ projectPath: root, files: ['deleted.js', 'src\\module.js', '--help'], depth: 3, filter: '*.test.js', crossTier: true });
  assert.deepEqual(validated.files, ['deleted.js', 'src/module.js', '--help']);
  for (const files of [[], ['../escape.js'], ['..\\escape.js'], [join(root, 'absolute.js')], [''], [42]]) {
    await assert.rejects(validateAffectedArguments({ projectPath: root, files }), /files/);
  }
  for (const extra of [{ depth: 1.5 }, { depth: 0 }, { crossTier: 'true' }, { filter: '' }, { force: true }]) {
    await assert.rejects(validateAffectedArguments({ projectPath: root, files: ['sample.js'], ...extra }));
  }
});

test('cycles distinguishes findings from command failure', () => {
  assert.equal(cycleCommandSucceeded({ exitCode: 0, stdout: '{"count":0,"cycles":[]}' }), true);
  assert.equal(cycleCommandSucceeded({ exitCode: 1, stdout: '{"count":1,"cycles":[["a.js","b.js"]]}' }), true);
  for (const result of [
    { exitCode: 1, stdout: 'failed to open index' },
    { exitCode: 1, stdout: '{"count":0,"cycles":[]}' },
    { exitCode: 1, stdout: '{"count":2,"cycles":[]}' },
    { exitCode: 2, stdout: '{"count":1,"cycles":[["a.js","b.js"]]}' },
    { exitCode: 1, stdout: '{"count":1,"cycles":[["a.js","b.js"]]}', outputTruncated: true },
  ]) assert.equal(cycleCommandSucceeded(result), false);
});
