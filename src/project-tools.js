import { indexTool, validateIndexArguments, validateProjectArguments, rebuildIndex, executeProjectCommand } from './index-tool.js';
import { isAbsolute, relative, resolve, sep } from 'node:path';
const projectSchema = { type: 'object', properties: { projectPath: { type: 'string', description: 'Exact absolute project directory; never expanded to a parent directory.' } }, required: ['projectPath'], additionalProperties: false };

export const initTool = {
  name: 'codegraph_init',
  description: 'Explicitly initialize CodeGraph and build its first index in the exact absolute projectPath. Runs the official init --yes with its defaults, including project Git sync hooks when upstream requires them. Never runs automatically or installs global MCP configuration. Use codegraph_index for a full rebuild of an existing index.',
  inputSchema: projectSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const statusTool = {
  name: 'codegraph_status',
  description: 'Find the nearest initialized index at projectPath or a parent using the official status --json CLI. Returns projectPath (the resolved source root), indexPath, health and statistics directly. Use the returned indexPath for supplementary index, sync, affected and cycles tools. Does not initialize or rebuild indexes.',
  inputSchema: { ...projectSchema, properties: { projectPath: { type: 'string', description: 'Absolute source directory; CodeGraph can find an index in a parent directory.' } } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export async function readStatus(args, options) {
  const response = await executeProjectCommand(args, ['status', '--json'], options);
  if (response.isError) return response;
  const result = JSON.parse(response.content[0].text);
  const status = JSON.parse(result.stdout);
  if (result.outputTruncated || typeof status.projectPath !== 'string' || typeof status.indexPath !== 'string') throw new Error('CodeGraph returned an incomplete status result');
  return { ...response, content: [{ type: 'text', text: JSON.stringify({ ...result, ...status, requestedPath: args.projectPath }) }] };
}
export const syncTool = {
  name: 'codegraph_sync',
  description: 'Incrementally update the exact indexPath returned by codegraph_status using the official sync --quiet CLI. Updates the whole selected index. Waits for active reads and releases this worker\'s readers before updating. Does not initialize projects or select a parent index.',
  inputSchema: indexTool.inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const affectedTool = {
  name: 'codegraph_affected',
  description: 'Find tests affected by changed files in the exact indexPath returned by codegraph_status. files are relative to that index\'s source root (projectPath returned by status), including deleted paths. Does not run tests, update indexes or select a parent index. Optional depth, filter and crossTier follow upstream behavior.',
  inputSchema: { type: 'object', properties: {
    ...indexTool.inputSchema.properties,
    files: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Changed paths relative to the source root returned by status as projectPath, confined to that project.' },
    depth: { type: 'integer', minimum: 1, description: 'Maximum dependency traversal depth; upstream defaults to 5.' },
    filter: { type: 'string', minLength: 1, description: 'Optional upstream glob identifying test files.' },
    crossTier: { type: 'boolean', description: 'Also follow links across process boundaries; defaults to false.' },
  }, required: ['indexPath', 'files'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const cyclesTool = {
  name: 'codegraph_cycles',
  description: 'List circular import groups in the exact indexPath returned by codegraph_status using the official cycles --json CLI. Finding cycles is a successful analysis even though upstream returns exit code 1. Does not change indexes or select a parent index.',
  inputSchema: indexTool.inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export async function validateAffectedArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['indexPath', 'files', 'depth', 'filter', 'crossTier'].includes(key))) throw new Error('Only indexPath, files, depth, filter and crossTier are accepted');
  const { projectPath, indexPath } = await validateIndexArguments({ indexPath: args.indexPath });
  if (!Array.isArray(args.files) || !args.files.length) throw new Error('files must be a nonempty array of project-relative paths');
  const files = args.files.map(file => {
    if (typeof file !== 'string' || !file.trim() || file.includes('\0') || isAbsolute(file)) throw new Error('files must contain project-relative paths');
    const path = relative(projectPath, resolve(projectPath, file.replaceAll('\\', '/')));
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('files must stay inside projectPath');
    return path.split(sep).join('/');
  });
  if (args.depth !== undefined && (!Number.isSafeInteger(args.depth) || args.depth < 1)) throw new Error('depth must be a positive safe integer');
  if (args.filter !== undefined && (typeof args.filter !== 'string' || !args.filter.trim() || args.filter.includes('\0'))) throw new Error('filter must be a nonempty glob string');
  if (args.crossTier !== undefined && typeof args.crossTier !== 'boolean') throw new Error('crossTier must be a boolean');
  return { ...args, projectPath, indexPath, files };
}
export async function readAffected(args, options) {
  const command = ['affected', '--json', '--path', args.projectPath];
  if (args.depth !== undefined) command.push('--depth', String(args.depth));
  if (args.filter !== undefined) command.push(`--filter=${args.filter}`);
  if (args.crossTier) command.push('--cross-tier');
  command.push('--', ...args.files);
  return executeProjectCommand(args, command, { ...options, positionalPath: false });
}
export function cycleCommandSucceeded(result) {
  if (result.exitCode === 0) return true;
  if (result.exitCode !== 1 || result.outputTruncated) return false;
  try {
    const data = JSON.parse(result.stdout);
    return Number.isInteger(data.count) && data.count > 0 && Array.isArray(data.cycles) && data.count === data.cycles.length;
  } catch { return false; }
}
export const projectTools = [
  { definition: indexTool, validate: validateIndexArguments, execute: rebuildIndex },
  { definition: initTool, validate: validateProjectArguments, execute: (args, options) => executeProjectCommand(args, ['init', '--yes'], options) },
  { definition: statusTool, validate: validateProjectArguments, execute: readStatus, exclusive: false },
  { definition: syncTool, validate: validateIndexArguments, execute: (args, options) => executeProjectCommand(args, ['sync', '--quiet'], options) },
  { definition: affectedTool, validate: validateAffectedArguments, execute: readAffected, exclusive: false },
  { definition: cyclesTool, validate: validateIndexArguments, execute: (args, options) => executeProjectCommand(args, ['cycles', '--json'], { ...options, isSuccessful: cycleCommandSucceeded }), exclusive: false },
];
