import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createJob } from './job.js';

/** Capture non-MCP CLI output. Cancellation completes only when the process exits. */
export async function runCommand(args, { signal, env = process.env, cwd = process.cwd() } = {}) {
  signal?.throwIfAborted();
  const job = await createJob();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./host.js', import.meta.url))], {
      cwd, env: { ...env, CG_PROXY_HOST: JSON.stringify({ args, cwd, protect: true }) },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const limit = 65536;
    let stdout = '', stderr = '', truncated = false, failure, timer;
    for (const [stream, append] of [[child.stdout, value => { stdout = value; }], [child.stderr, value => { stderr = value; }]]) {
      let tail = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => { tail += chunk; if (tail.length > limit) { tail = tail.slice(-limit); truncated = true; } append(tail); });
    }
    const abort = () => {
      child.stdin.end();
      timer ??= setTimeout(() => { job.close(); child.kill('SIGKILL'); }, 5000);
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {});
    child.once('spawn', () => {
      try {
        job.assign(child.pid);
        if (signal?.aborted) abort();
        else child.stdin.write(JSON.stringify({ method: 'proxy/gate' }) + '\n');
      } catch (error) { failure = error; abort(); }
    });
    child.once('error', error => { failure = error; });
    child.once('close', (exitCode, exitSignal) => {
      signal?.removeEventListener('abort', abort); clearTimeout(timer); job.close();
      if (failure) reject(failure);
      else if (signal?.aborted) reject(new Error('CLI executor stopped because the MCP connection closed. Its outcome may be incomplete.'));
      else resolve({ exitCode: exitCode ?? -1, signal: exitSignal, stdout, stderr, outputTruncated: truncated });
    });
  });
}
