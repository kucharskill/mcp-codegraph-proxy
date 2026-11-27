import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Proxy } from '../src/proxy.js';
import { DiscoveryCache } from '../src/discovery-cache.js';
const options = JSON.parse(process.argv[2]);
const worker = options.role === 'worker';
const args = options.worker && !worker ? [fileURLToPath(import.meta.url), JSON.stringify({ ...options, role: 'worker' })] : [fileURLToPath(new URL('./fixture.js', import.meta.url)), ...(options.args ?? [])];
const env = { ...process.env };
const sharedCache = new DiscoveryCache({ invocation: { command: process.execPath, args, cwd: options.cwd, env }, directory: options.directory, ttl: options.ttl ?? 600000 });
const proxy = new Proxy({ role: worker ? 'worker' : 'adapter', cwd: options.cwd, env, sharedCache: worker ? undefined : sharedCache,
  discoveryMs: options.retention ?? 60000, idleMs: options.retention ?? 1800000,
  target: async () => { if (!worker) appendFileSync(options.starts, 'start\n'); return { args, version: 'fixture' }; },
  exit: () => { if (worker && options.exits) appendFileSync(options.exits, 'exit\n'); process.exit(0); },
});
proxy.connect(process.stdin, process.stdout);
