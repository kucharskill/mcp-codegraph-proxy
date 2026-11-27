import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const startupEnvDirectory = join(tmpdir(), 'mcp-codegraph-proxy', 'discovery');

/** Local troubleshooting only. Never write environment contents to MCP output. */
export function recordStartupEnvironment(directory = startupEnvDirectory, env = process.env) {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(join(directory, 'env-startup.jsonl'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), env }) + '\n', { mode: 0o600 });
  } catch { /* Diagnostics must never prevent MCP startup. */ }
}
