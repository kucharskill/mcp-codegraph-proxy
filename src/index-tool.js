import { dirname, basename, isAbsolute, join, resolve, relative } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { resolveLatest } from './resolve.js';
import { runCommand } from './run-command.js';

export const indexTool = {
  name: 'codegraph_index',
  description: 'Rebuild the exact existing indexPath returned by codegraph_status, using the current official CLI. Use when the extraction engine changed or a full rebuild is requested. Waits for active reads, releases this worker\'s readers and returns the completed CLI result. Does not initialize projects or select a parent index.',
  inputSchema: { type: 'object', properties: { indexPath: { type: 'string', description: 'Absolute index directory returned by codegraph_status, e.g. /project/.codegraph. Not the source directory or codegraph.db file.' } }, required: ['indexPath'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};
export async function validateIndexArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'indexPath') || typeof args.indexPath !== 'string' || !isAbsolute(args.indexPath)) throw new Error('indexPath must be an absolute index directory from codegraph_status; no other arguments are accepted');
  // Resolve the source parent, not the index target: a junction may store data elsewhere.
  const requested = resolve(args.indexPath);
  const projectPath = await realpath(dirname(requested));
  const indexPath = join(projectPath, basename(requested));
  if (!(await stat(indexPath)).isDirectory()) throw new Error('indexPath must be an index directory, not a database file');
  try { if (!(await stat(join(indexPath, 'codegraph.db'))).isFile()) throw new Error(); }
  catch { throw new Error('indexPath has no codegraph.db. Pass the indexPath returned by codegraph_status, or use codegraph_init to create an index.'); }
  return { projectPath, indexPath };
}
export async function validateProjectArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'projectPath') || typeof args.projectPath !== 'string' || !isAbsolute(args.projectPath)) throw new Error('projectPath must be an absolute project directory; no other arguments are accepted');
  const projectPath = await realpath(args.projectPath);
  if (!(await stat(projectPath)).isDirectory()) throw new Error('projectPath is not a directory');
  return { projectPath };
}
export async function rebuildIndex(args, { signal, env = process.env } = {}) {
  return executeProjectCommand(args, ['index', '--quiet'], { signal, env });
}
export async function executeProjectCommand(args, command, { signal, env = process.env, positionalPath = true, isSuccessful = result => result.exitCode === 0 } = {}) {
  signal?.throwIfAborted();
  const resolved = await resolveLatest('@colbymchenry/codegraph');
  signal?.throwIfAborted();
  if (args.indexPath) {
    // CLI readers and sync can fall back to a parent; verify the exact selected index first.
    const probe = await runCommand([resolved.entry, 'status', '--json', args.projectPath], { signal, env, cwd: args.projectPath });
    let status;
    try { status = JSON.parse(probe.stdout); } catch {}
    if (probe.exitCode !== 0 || probe.outputTruncated || !status?.initialized || typeof status.indexPath !== 'string' || relative(args.indexPath, resolve(status.indexPath)) !== '') throw new Error('The supplied indexPath is not the initialized index selected by CodeGraph for its source directory. Use codegraph_status to obtain indexPath and preserve the same CODEGRAPH_DIR configuration. No operation was performed.');
  }
  const result = await runCommand([resolved.entry, ...command, ...(positionalPath ? [args.projectPath] : [])], { signal, env, cwd: args.projectPath });
  return {
    isError: !isSuccessful(result),
    content: [{ type: 'text', text: JSON.stringify({ projectPath: args.projectPath, ...(args.indexPath ? { indexPath: args.indexPath } : {}), upstreamVersion: resolved.version, ...result }) }],
  };
}
