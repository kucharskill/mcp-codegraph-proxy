import { createInterface } from 'node:readline';
const version = process.env.FIXTURE_VERSION ?? '1';
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
    case 'initialize': reply({ protocolVersion: m.params.protocolVersion, serverInfo: { name: 'fixture', version }, capabilities: { tools: {} }, instructions: 'Verbatim upstream instructions.' }); break;
    case 'tools/list':
      if (m.params?.roots) { rootsRequest = m.id; console.log(JSON.stringify({ jsonrpc: '2.0', id: 'server-roots', method: 'roots/list' })); }
      else reply({ tools: [{ name: 'fixture_echo', description: 'Echo arguments', inputSchema: { type: 'object' } }] });
      break;
    case 'tools/call': {
      if (m.params.arguments?.crash) return process.exit(1);
      if (m.params.arguments?.delay) setTimeout(() => reply({ content: [{ type: 'text', text: 'done' }] }), m.params.arguments.delay);
      else reply({ content: [{ type: 'text', text: JSON.stringify(m.params.arguments) }] });
      break;
    }
    default: reply({ receivedMethod: m.method, params: m.params });
  }
}).once('close', () => process.exit(0));
