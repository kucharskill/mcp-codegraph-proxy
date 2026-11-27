import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, realpath, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { validateIndexArguments } from '../src/index-tool.js';
import { runCommand } from '../src/run-command.js';
import { projectTools, validateAffectedArguments, cycleCommandSucceeded } from '../src/project-tools.js';

test('index tools require an explicit index directory and reject source paths or database files', async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/index-validation-'));
  await assert.rejects(validateIndexArguments({ indexPath: 'relative' }), /absolute/);
  await assert.rejects(validateIndexArguments({ projectPath: root }), /indexPath/);
  await assert.rejects(validateIndexArguments({ indexPath: root, force: true }), /no other/);
  await assert.rejects(validateIndexArguments({ indexPath: root }), /no codegraph.db/);
  await mkdir(join(root, '.codegraph')); await mkdir(join(root, 'subdir'));
  const indexPath = join(root, '.codegraph');
  await writeFile(join(indexPath, 'codegraph.db'), 'fixture');
  assert.deepEqual(await validateIndexArguments({ indexPath }), { projectPath: await realpath(root), indexPath: join(await realpath(root), '.codegraph') });
  await assert.rejects(validateIndexArguments({ indexPath: join(root, 'subdir') }), /no codegraph.db/);
  await assert.rejects(validateIndexArguments({ indexPath: join(indexPath, 'codegraph.db') }), /directory/);
});

test('init and status keep projectPath while existing-index operations expose indexPath', async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/project-validation-'));
  await mkdir(join(root, '.codegraph')); await mkdir(join(root, 'child'));
  for (const name of ['codegraph_init', 'codegraph_status']) {
    const tool = projectTools.find(tool => tool.definition.name === name);
    const args = await tool.validate({ projectPath: join(root, 'child') });
    assert.equal(args.projectPath, await realpath(join(root, 'child')));
    assert.deepEqual(tool.definition.inputSchema.required, ['projectPath']);
    await assert.rejects(tool.validate({ projectPath: root, command: 'uninit' }), /no other/);
  }
  for (const name of ['codegraph_index', 'codegraph_sync', 'codegraph_affected', 'codegraph_cycles']) {
    const schema = projectTools.find(tool => tool.definition.name === name).definition.inputSchema;
    assert.ok(schema.required.includes('indexPath'));
    assert.equal(schema.properties.projectPath, undefined);
  }
});

test('index directory junctions preserve the logical source parent', async () => {
  const root = await mkdtemp(resolve('.tmp/index-junction-'));
  const storage = await mkdtemp(resolve('.tmp/index-storage-'));
  await writeFile(join(storage, 'codegraph.db'), 'fixture');
  await symlink(storage, join(root, '.codegraph'), process.platform === 'win32' ? 'junction' : 'dir');
  const args = await validateIndexArguments({ indexPath: join(root, '.codegraph') });
  assert.equal(args.projectPath, await realpath(root));
  assert.equal(args.indexPath, join(await realpath(root), '.codegraph'));
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
  const indexPath = join(root, '.codegraph');
  await writeFile(join(indexPath, 'codegraph.db'), 'fixture');
  const validated = await validateAffectedArguments({ indexPath, files: ['deleted.js', 'src\\module.js', '--help'], depth: 3, filter: '*.test.js', crossTier: true });
  assert.deepEqual(validated.files, ['deleted.js', 'src/module.js', '--help']);
  for (const files of [[], ['../escape.js'], ['..\\escape.js'], [join(root, 'absolute.js')], [''], [42]]) {
    await assert.rejects(validateAffectedArguments({ indexPath, files }), /files/);
  }
  for (const extra of [{ depth: 1.5 }, { depth: 0 }, { crossTier: 'true' }, { filter: '' }, { force: true }]) {
    await assert.rejects(validateAffectedArguments({ indexPath, files: ['sample.js'], ...extra }));
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
