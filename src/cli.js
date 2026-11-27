#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Proxy } from './proxy.js';
import { metadata, milliseconds } from './meta.js';
import { resolveLatest } from './resolve.js';
import { projectTools } from './project-tools.js';
export function runnerMode(env = process.env, modulePath = fileURLToPath(import.meta.url)) {
  const explicit = env.CG_PROXY_RUNNER;
  if (explicit && !['local', 'latest'].includes(explicit)) throw new Error('CG_PROXY_RUNNER must be local or latest');
  return explicit ?? (/[\\/]_npx[\\/]/.test(modulePath) && env.npm_command === 'exec' ? 'latest' : 'local');
}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) return console.log(metadata.version);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return console.log(`Usage: ${metadata.name} [mcp | --worker | --version | --help]\n\nTransparent CodeGraph MCP over stdio. Requires Node.js 22+ and npm/npx.\nCG_PROXY_RUNNER=local|latest selects our worker. Upstream always resolves through npx.\nCG_PROXY_DIAGNOSTICS=1 enables lifecycle metadata on stderr.\nCG_PROXY_IDLE_MS defaults to 1800000; CG_PROXY_DISCOVERY_IDLE_MS to 60000.\nCG_PROXY_DISCOVERY_CACHE_MS defaults to 300000; CG_PROXY_STARTUP_MS to 180000.`);
  const worker = args.length === 1 && args[0] === '--worker';
  if (args.length && !worker && !(args.length === 1 && args[0] === 'mcp')) throw new Error('Unknown arguments. Use --help.');
  const mode = runnerMode();
  const target = worker ? async () => {
    const resolved = await resolveLatest('@colbymchenry/codegraph');
    return { args: [resolved.entry, 'serve', '--mcp'], version: resolved.version };
  } : async () => {
    const resolved = mode === 'local' ? { entry: fileURLToPath(import.meta.url), version: metadata.version } : await resolveLatest(metadata.name);
    return { args: [resolved.entry, '--worker'], version: resolved.version };
  };
  const proxy = new Proxy({
    role: worker ? 'worker' : 'adapter', target,
    localTools: worker ? projectTools : [],
    env: worker ? { ...process.env, CODEGRAPH_NO_DAEMON: '1' } : process.env,
    idleMs: milliseconds('CG_PROXY_IDLE_MS', 1800000),
    discoveryMs: milliseconds('CG_PROXY_DISCOVERY_IDLE_MS', 60000),
    cacheMs: milliseconds('CG_PROXY_DISCOVERY_CACHE_MS', 300000),
    startupMs: milliseconds('CG_PROXY_STARTUP_MS', 180000),
    exit: () => process.exit(0),
  });
  proxy.connect(process.stdin, process.stdout);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void proxy.close(signal); });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
