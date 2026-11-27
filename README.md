# CodeGraph MCP Proxy

An on-demand stdio proxy for the official [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) MCP server. It keeps discovery inexpensive, resolves current executors through npx, and closes owned process trees after inactivity.

## Setup

Requires Node.js 22+ and npm/npx. The upstream package supplies its own platform runtime; a global CodeGraph installation is not required or modified. Registry connectivity is required when checking current versions and fetching uncached packages. No external API key or billable service is required by the proxy.

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "npx",
      "args": ["-y", "--prefer-online", "mcp-codegraph-proxy@latest"]
    }
  }
}
```

Use the original upstream tool names, schemas and arguments, including `projectPath`:

```js
codegraph_explore({ projectPath: "/path/to/indexed/project", query: "AuthService login" })
```

The available tool catalog follows upstream and any `CODEGRAPH_MCP_TOOLS` setting inherited from the process environment. The proxy does not add instance identifiers, rewrite results, initialize indexes, change global installations, install agent instructions, or migrate existing indexes. Initialize or rebuild a project explicitly with the upstream CLI when needed. A newer upstream release can require rebuilding older indexes; its own diagnostics describe compatibility.

## Execution and updates

```text
MCP client
  -> stable stdio adapter with discovery cache
     -> current proxy worker
        -> current official CodeGraph MCP
```

When launched through npx from the npm cache, the adapter resolves `mcp-codegraph-proxy@latest` for each new worker. The worker resolves `@colbymchenry/codegraph@latest` before starting `serve --mcp`. Package resolution finishes before execution. Running processes keep their loaded versions; later workers pick up published updates without reconnecting the client. Updating the stable adapter itself still requires reconnecting MCP.

Direct `node src/cli.js` uses the local worker for development. `CG_PROXY_RUNNER=local|latest` overrides selection. The official backend always resolves through npx.

## Lifecycle

One worker owns one deadline and timer, with pending requests tracked in both directions:

- Discovery metadata has five minutes of adapter-local cache. A hit does not start or retain any executor. Tool-list and roots-change notifications invalidate cache; pagination parameters are part of the cache key.
- Standard MCP `ping` is acknowledged locally and never starts or retains an executor.
- Discovery answered by the backend retains the worker for one minute. Other requests retain it for 30 minutes after the actual response. The deadline uses `max(previous, now + retention)`, so discovery cannot shorten a longer retention period.
- Pending client requests and backend requests such as `roots/list` prevent idle expiry. Client timeouts and cancellation notifications do not imply backend work ended.
- On expiry the worker closes CodeGraph and exits. The next real request starts a current worker and repeats the original initialization handshake. Ordinary notifications do not start a worker.
- On disconnect or failure, operations are never replayed automatically. Errors can indicate an unknown outcome. The adapter can lazily recover for subsequent requests.
- Initial instructions, server identity, tool schemas, results, notifications, roots requests and extension methods pass through as MCP messages. There is no tool-specific translation. Clients may retain initial server metadata until reconnect, even if a later executor changes version.

CodeGraph is started with its supported `CODEGRAPH_NO_DAEMON=1` setting. This keeps execution owned by the proxy instead of starting a detached shared daemon. Existing external CodeGraph daemons are never enumerated or terminated by the proxy. Upstream may report lock conflicts when another process owns an indexed project; resolve those through CodeGraph itself. Project selection otherwise follows upstream and the client's MCP roots.

Windows uses gated child startup and parent-owned kill-on-close Job Objects. Graceful stdin shutdown is attempted first, with a bounded force-close fallback. Only owned trees are targeted. Normal shutdown on POSIX forwards EOF and terminates the owned process group if necessary; hard-crash behavior also depends on upstream's parent watchdog. No broad process-name killing is used.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `CG_PROXY_RUNNER` | automatic | `local` or `latest` worker |
| `CG_PROXY_IDLE_MS` | `1800000` | Retention after real work; 0 disables idle expiry |
| `CG_PROXY_DISCOVERY_IDLE_MS` | `60000` | Retention after backend discovery |
| `CG_PROXY_DISCOVERY_CACHE_MS` | `300000` | Adapter discovery cache lifetime; 0 disables cache |
| `CG_PROXY_STARTUP_MS` | `180000` | Registry resolution and bootstrap timeout |
| `CG_PROXY_DIAGNOSTICS` | off | Set `1` for lifecycle metadata on stderr |

Other upstream configuration is inherited from the environment, except that the worker always sets `CODEGRAPH_NO_DAEMON=1`. stdout contains MCP messages only. Diagnostic logs contain methods, lifecycle events and versions, not arguments or credentials. CodeGraph's own stderr remains its responsibility.

## Development and validation

```sh
npm ci
node src/cli.js --help
npm run check
npm run release:prepare
node scripts/smoke.mjs
```

The smoke test creates and indexes only a synthetic repository under `.tmp/`, checks discovery cache after worker expiry, then calls `codegraph_explore` after lazy restart. Release archives use an explicit allowlist; local configuration, indexes, logs and temporary data are excluded. MIT licensed.
