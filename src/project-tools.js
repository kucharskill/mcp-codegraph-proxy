import { indexTool, validateIndexArguments, validateProjectArguments, rebuildIndex, executeProjectCommand } from './index-tool.js';
const projectSchema = { type: 'object', properties: { projectPath: { type: 'string', description: 'Exact absolute project directory; never expanded to a parent directory.' } }, required: ['projectPath'], additionalProperties: false };

export const initTool = {
  name: 'codegraph_init',
  description: 'Explicitly initialize CodeGraph and build its first index in the exact absolute projectPath. Runs the official init --yes with its defaults, including project Git sync hooks when upstream requires them. Never runs automatically or installs global MCP configuration. Use codegraph_index for a full rebuild of an existing index.',
  inputSchema: projectSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export const statusTool = {
  name: 'codegraph_status',
  description: 'Read index health, statistics, pending changes and extraction version through the official status --json CLI. An exact directory without .codegraph is reported as uninitialized without searching parent directories. Does not initialize or rebuild the index.',
  inputSchema: projectSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export async function readStatus(args, options) {
  if (!args.indexed) return { content: [{ type: 'text', text: JSON.stringify({ projectPath: args.projectPath, initialized: false }) }] };
  return executeProjectCommand(args, ['status', '--json'], options);
}
export const projectTools = [
  { definition: indexTool, validate: validateIndexArguments, execute: rebuildIndex },
  { definition: initTool, validate: validateProjectArguments, execute: (args, options) => executeProjectCommand(args, ['init', '--yes'], options) },
  { definition: statusTool, validate: validateProjectArguments, execute: readStatus, exclusive: false },
];
