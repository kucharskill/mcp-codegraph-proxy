import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createJob } from './job.js';

export async function startChild(args, { env = process.env, cwd = process.cwd(), onmessage, onclose } = {}) {
  const job = await createJob();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./host.js', import.meta.url))], {
    env: { ...env, CG_PROXY_HOST: JSON.stringify({ args, cwd, protect: true }) }, cwd,
    stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
  });
  let exited = false;
  let stopping;
  let failure;
  const done = new Promise(resolve => child.once('close', () => { exited = true; job.close(); onclose?.(failure); resolve(); }));
  child.stdin.on('error', () => {});
  child.on('error', error => { failure = error; });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    try { onmessage(JSON.parse(line)); }
    catch { console.error('mcp-codegraph-proxy: invalid backend message'); }
  });
  const close = () => stopping ??= (async () => {
    if (exited) return;
    child.stdin.end();
    const timer = setTimeout(() => { job.close(); child.kill('SIGKILL'); }, 5000);
    try { await done; } finally { clearTimeout(timer); }
  })();
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    job.assign(child.pid);
    child.stdin.write(JSON.stringify({ method: 'proxy/gate' }) + '\n');
  } catch (error) { await close(); throw error; }
  return {
    pid: child.pid,
    send(message) {
      if (exited || child.stdin.destroyed || child.stdin.writableEnded) throw new Error('Backend disconnected before accepting the message');
      child.stdin.write(JSON.stringify(message) + '\n');
    },
    close,
  };
}
