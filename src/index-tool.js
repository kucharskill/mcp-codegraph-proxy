import { isAbsolute, join } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { resolveLatest } from './resolve.js';
import { runCommand } from './run-command.js';

export const indexTool = {
  name: 'codegraph_index',
  description: 'Rebuild the existing CodeGraph index at the exact projectPath using the current official CLI. Use when the extraction engine changed or a full rebuild is requested. Waits for active reads, releases this worker\'s readers and returns the completed CLI result. Does not initialize unindexed projects or retry failures automatically.',
  inputSchema: { type: 'object', properties: { projectPath: { type: 'string', description: 'Absolute project directory containing its own .codegraph directory.' } }, required: ['projectPath'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};
export async function validateIndexArguments(args) {
  const validated = await validateProjectArguments(args);
  if (!validated.indexed) throw new Error('The exact projectPath has no .codegraph directory. Use codegraph_init to explicitly initialize this project. This tool does not expand to a parent directory.');
  return { projectPath: validated.projectPath };
}
export async function validateProjectArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'projectPath') || typeof args.projectPath !== 'string' || !isAbsolute(args.projectPath)) throw new Error('projectPath must be an absolute project directory; no other arguments are accepted');
  const projectPath = await realpath(args.projectPath);
  if (!(await stat(projectPath)).isDirectory()) throw new Error('projectPath is not a directory');
  let indexed = false;
  try { indexed = (await stat(join(projectPath, '.codegraph'))).isDirectory(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { projectPath, indexed };
}
export async function rebuildIndex(args, { signal, env = process.env } = {}) {
  return executeProjectCommand(args, ['index', '--quiet'], { signal, env });
}
export async function executeProjectCommand(args, command, { signal, env = process.env, positionalPath = true, isSuccessful = result => result.exitCode === 0 } = {}) {
  signal?.throwIfAborted();
  const resolved = await resolveLatest('@colbymchenry/codegraph');
  signal?.throwIfAborted();
  const result = await runCommand([resolved.entry, ...command, ...(positionalPath ? [args.projectPath] : [])], { signal, env, cwd: args.projectPath });
  return {
    isError: !isSuccessful(result),
    content: [{ type: 'text', text: JSON.stringify({ projectPath: args.projectPath, upstreamVersion: resolved.version, ...result }) }],
  };
}
