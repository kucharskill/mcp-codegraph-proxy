import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const version = process.env.FIXTURE_VERSION_FILE ? readFileSync(process.env.FIXTURE_VERSION_FILE, 'utf8') : process.env.FIXTURE_VERSION ?? '1';
let rootsRequest;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!Object.hasOwn(m, 'id')) return;
  const reply = result => console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  if (!m.method) {
    if (m.id === 'server-roots' && rootsRequest !== undefined) console.log(JSON.stringify({ jsonrpc: '2.0', id: rootsRequest, result: { tools: [], roots: m.result.roots } }));
    return;
  }
  switch (m.method) {
    case 'initialize': reply({ protocolVersion: process.env.FIXTURE_PROTOCOL_FILE ? readFileSync(process.env.FIXTURE_PROTOCOL_FILE, 'utf8') : m.params.protocolVersion, serverInfo: { name: 'fixture', version }, capabilities: { tools: {} }, instructions: 'Verbatim upstream instructions.' }); break;
    case 'tools/list':
      if (m.params?.roots) { rootsRequest = m.id; console.log(JSON.stringify({ jsonrpc: '2.0', id: 'server-roots', method: 'roots/list' })); }
      else {
        const tools = [{ name: 'fixture_echo', description: 'Echo arguments', inputSchema: { type: 'object' } }];
        if (process.env.FIXTURE_CATALOG_FILE && readFileSync(process.env.FIXTURE_CATALOG_FILE, 'utf8') === 'updated') tools.push({ name: 'fixture_updated', description: 'Updated catalog metadata', inputSchema: { type: 'object' } });
        if (process.env.FIXTURE_NATIVE_INDEX === '1') tools.push({ name: 'codegraph_index', description: 'Native index definition', inputSchema: { type: 'object' } });
        if (process.env.FIXTURE_NATIVE_STATUS === '1') tools.push({ name: 'codegraph_status', description: 'Native status definition', inputSchema: { type: 'object' } });
        if (process.env.FIXTURE_PAGES === '1' && !m.params?.cursor) reply({ tools: tools.slice(-1), nextCursor: 'second' });
        else reply({ tools: process.env.FIXTURE_PAGES === '1' ? tools.slice(0, -1) : tools });
        if (process.env.FIXTURE_DRAIN === '1') {
          console.log(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/mcp-codegraph-proxy/closing' }));
          setTimeout(() => process.exit(0), 200);
        }
      }
      break;
    case 'tools/call': {
      if (m.params.arguments?.listChanged) console.log(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
      if (m.params.name === 'fixture_env') { reply({ content: [{ type: 'text', text: JSON.stringify({ callId: process.env.CODEX_TOOL_CALL_ID, environment: Object.fromEntries((m.params.arguments?.envNames ?? []).map(name => [name, process.env[name]])) }) }] }); break; }
      if (m.params.arguments?.crash) return process.exit(1);
      if (m.params.arguments?.delay) setTimeout(() => reply({ content: [{ type: 'text', text: 'done' }] }), m.params.arguments.delay);
      else reply({ content: [{ type: 'text', text: JSON.stringify(m.params.arguments) }] });
      break;
    }
    case 'resources/list': reply({ resources: [{ uri: 'fixture:///one', name: 'one', description: 'Resource metadata' }] }); break;
    case 'prompts/list': reply({ prompts: [{ name: 'fixture-prompt', description: 'Prompt metadata', arguments: [{ name: 'query', required: true }] }] }); break;
    default: reply({ receivedMethod: m.method, params: m.params });
  }
}).once('close', () => process.exit(0));
