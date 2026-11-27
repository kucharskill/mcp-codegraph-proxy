import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { recordStartupEnvironment } from '../src/startup-env.js';

test('startup environment is appended as separate JSONL records without modifying it', () => {
  mkdirSync('.tmp', { recursive: true });
  const directory = mkdtempSync(resolve('.tmp/startup-env-'));
  const first = { CODEX_TOOL_CALL_ID: 'fixture-one', CODEGRAPH_NO_DAEMON: 'original-value', SYNTHETIC_TOKEN: 'fixture-value', PATH: 'fixture-path', INIT_CWD: 'fixture-init', npm_config_local_prefix: 'fixture-prefix', npm_package_json: 'fixture-package' };
  const second = { CODEX_TOOL_CALL_ID: 'fixture-two' };
  recordStartupEnvironment(directory, first); recordStartupEnvironment(directory, second);
  const file = join(directory, 'env-startup.jsonl');
  const records = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  for (const record of records) { assert.equal(record.pid, process.pid); assert.ok(Number.isFinite(Date.parse(record.startedAt))); assert.deepEqual(Object.keys(record).sort(), ['env', 'pid', 'startedAt']); }
  assert.deepEqual(records[0].env, first); assert.deepEqual(records[1].env, second);
  assert.equal(first.CODEGRAPH_NO_DAEMON, 'original-value');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('startup environment storage failure does not interrupt the caller', () => {
  mkdirSync('.tmp', { recursive: true });
  const directory = mkdtempSync(resolve('.tmp/startup-env-failure-'));
  const blocked = join(directory, 'file'); writeFileSync(blocked, 'fixture');
  assert.doesNotThrow(() => recordStartupEnvironment(blocked, { FIXTURE: 'value' }));
});
