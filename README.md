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

Names, descriptions and schemas are obtained from the actual backend's `tools/list` at runtime, without a proxy-owned list, filter or selection of native tools. Upstream controls its own defaults; any explicit `CODEGRAPH_MCP_TOOLS` setting is inherited unchanged. The proxy supplements that list with `codegraph_index`, `codegraph_init`, `codegraph_status`, `codegraph_sync`, `codegraph_affected` and `codegraph_cycles`. If upstream exposes any of these names, its original definition and execution take precedence. Pagination is preserved; supplements are appended to the final page without duplicates. No instance identifiers are added to calls.

Rebuild an existing index through MCP:

```js
codegraph_index({ indexPath: "/path/to/project/.codegraph" })
```

This explicit operation accepts the absolute index directory returned by status, not the source directory or the `codegraph.db` file. Before executing, the proxy checks that the official CLI recognizes exactly this initialized index under the current configuration. An invalid index cannot silently select a parent. It waits for active reads, closes this worker's upstream readers, resolves the current official CLI and captures its `index --quiet` result. Later reads wait for the operation, then lazily reconnect. The returned tool result includes `projectPath`, `indexPath`, the upstream version, exit code and bounded CLI output. Errors are not retried automatically. Client response timeout does not mark the CLI as finished; disconnect stops owned CLI processes.

Initialize a project or check its index through MCP:

```js
codegraph_status({ projectPath: "/path/to/project/application/src" })
codegraph_init({ projectPath: "/path/to/project" })
```

`codegraph_init` explicitly runs the official `init --yes` to create `.codegraph/` and build the first index. It uses upstream defaults, including project Git sync hooks when upstream requires a fallback for file watching. It does not run the global agent/MCP installer. Existing indexes follow upstream's init behavior; use `codegraph_index` to rebuild them.

`codegraph_status` delegates discovery to the official `status --json`: it finds the nearest initialized index at `projectPath` or in a parent directory. Its JSON tool content directly includes `requestedPath`, the resolved source root as `projectPath`, `indexPath`, `initialized`, index health, counts, pending changes and extraction versions. If none is found it reports `initialized:false`. Status waits for this worker's mutations but keeps its existing backend reader open. The upstream version, exit code, raw stdout, stderr and output-truncation flag are retained too.

Pass the returned `indexPath` to supplementary `index`, `sync`, `affected` and `cycles` calls. These operations require a concrete index and never search for an alternative. The directory's source parent is preserved even when the index directory is a junction or symlink. Custom index directory names follow upstream's `CODEGRAPH_DIR` configuration; status and execution must use the same configuration. This does not add support for an arbitrary external index directory detached from its source root.

Since 0.4.0, these four supplementary tools require `indexPath` instead of `projectPath`. `init` and `status` retain `projectPath`. Native upstream tools always retain their original schemas, including any native tool that takes precedence over a supplement.

Initialization never happens automatically, and `init` uses exactly the requested source directory. Status can discover a parent index without initializing it. The proxy does not change global installations. A newer upstream release can require an explicit `codegraph_index` call on existing indexes. Supplementary tool calls are serialized in the worker, and mutations wait for active reads before releasing its readers. This coordination covers this worker only; independent clients and external processes retain their own ownership and upstream locks.

Update only changed files, find affected tests, or inspect circular imports:

```js
codegraph_sync({ indexPath: "/path/to/project/.codegraph" })
codegraph_affected({ indexPath: "/path/to/project/.codegraph", files: ["application/src/auth.js"], depth: 5, filter: "*.test.js", crossTier: false })
codegraph_cycles({ indexPath: "/path/to/project/.codegraph" })
```

`codegraph_sync` runs `sync --quiet` against the whole selected index and releases this worker's readers using the same coordination as a rebuild. It is an incremental update, not a full rebuild.

`codegraph_affected` runs `affected --json` with a required nonempty list of changed files relative to the selected index's source root (`projectPath` returned by status), not the folder from which status was requested. Deleted files are accepted; paths outside that source root are rejected. Optional `depth`, `filter` and `crossTier` correspond to upstream traversal depth, test-file glob and links across process boundaries. It reports affected tests without running them.

`codegraph_cycles` runs `cycles --json`. Upstream exit code 1 with a valid positive cycle report is returned as a successful tool result, preserving that exit code and report. Other failures remain errors. Both analysis tools keep the worker's backend reader open and use the same bounded CLI result format as status.

## Execution and updates

```text
MCP client
  -> stable stdio adapter with shared TEMP discovery cache
     -> current proxy worker
        -> current official CodeGraph MCP
```

When launched through npx from the npm cache, the adapter resolves `mcp-codegraph-proxy@latest` for each new worker. The worker resolves `@colbymchenry/codegraph@latest` before starting `serve --mcp`. Package resolution finishes before execution. Running processes keep their loaded versions; later workers pick up published updates without reconnecting the client. Updating the stable adapter itself still requires reconnecting MCP.

Direct `node src/cli.js` uses the local worker for development. `CG_PROXY_RUNNER=local|latest` overrides selection. The official backend always resolves through npx.

## Lifecycle

One worker owns one deadline and timer, with pending requests tracked in both directions:

- Legacy initialization and discovery lists have ten minutes of shared disk cache under the user's temporary directory, in `mcp-codegraph-proxy/discovery`. A current entry can answer `initialize` and `tools/list` in another adapter process without starting a worker, upstream backend or npx. Cache hits do not refresh expiry or retain an executor.
- Legacy MCP `ping` receives a local empty success response and never starts or retains an executor. A ping declared as modern MCP, or following `server/discover`, receives a method-not-found response: modern MCP removed this RPC. The wrapper does not synthesize modern protocol support or capabilities.
- Discovery answered by the backend retains the worker for one minute. Other requests retain it for 30 minutes after the actual response. The deadline uses `max(previous, now + retention)`, so discovery cannot shorten a longer retention period.
- Pending client requests and backend requests such as `roots/list` prevent idle expiry. Client timeouts and cancellation notifications do not imply backend work ended.
- On expiry the worker closes CodeGraph and exits. The next real request starts a current worker and repeats the original initialization handshake. Ordinary notifications do not start a worker.
- On disconnect or failure, operations are never replayed automatically. Errors can indicate an unknown outcome. The adapter can lazily recover for subsequent requests.
- Initial instructions, server identity, native tool schemas, results, notifications, roots requests and extension methods pass through as MCP messages. The catalog is augmented only with the six project tools described above when their native names are absent. Clients may retain initial server metadata until reconnect, even if a later executor changes version.

CodeGraph is started with its supported `CODEGRAPH_NO_DAEMON=1` setting. This keeps execution owned by the proxy instead of starting a detached shared daemon. Existing external CodeGraph daemons are never enumerated or terminated by the proxy. Upstream may report lock conflicts when another process owns an indexed project; resolve those through CodeGraph itself. Project selection otherwise follows upstream and the client's MCP roots.

Windows uses gated child startup and parent-owned kill-on-close Job Objects. Graceful stdin shutdown is attempted first, with a bounded force-close fallback. Only owned trees are targeted. Normal shutdown on POSIX forwards EOF and terminates the owned process group if necessary; hard-crash behavior also depends on upstream's parent watchdog. No broad process-name killing is used.

The shared cache filename uses a fixed SHA-256 of the logical upstream command, ordered argument array, working directory and backend environment sorted by variable name. It does not contain a time bucket, executor cache path or adapter identifier. `CODEX_TOOL_CALL_ID`, `PATH` and all names starting with `INIT_` or `NPM_` are excluded case-insensitively on every platform. `CG_PROXY_CACHE_IGNORE_ENV` adds comma-separated exclusions. Other environment names are case-insensitive on Windows. Exclusions affect only hashing: command resolution is unchanged, and the original environment still reaches execution, with the existing `CODEGRAPH_NO_DAEMON=1` policy. The startup environment dump also keeps all original variables.

The invocation is represented only by its hash; its environment and tool-call results are not written to discovery cache. After validating the required structure, the cache retains the complete public discovery `result`, including unknown fields, benign `_meta`, `resultType`, `ttlMs` and `cacheScope`. The tool catalog is cached after supplementary tools have been added, preserving descriptions, input/output schemas, annotations and extensions. Cold and warm responses keep the same complete result; each JSON-RPC envelope uses the current request ID.

The cache's own `expiresAt` is set from its write time plus the local TTL (ten minutes by default), independently of backend hints. Even `ttlMs: 0` does not disable or shorten this explicitly chosen local policy. Backend `ttlMs` and `cacheScope` are still returned unchanged. No response fields are removed to make an entry cacheable: responses containing live session/progress/request-state identifiers are skipped as a whole, while property names inside tool input/output schemas are not treated as live identifiers. Operation results and side effects are never cached.

Handshake requests are partitioned by a hash of their parameters, so a different protocol or capability set cannot reuse an incompatible response. Catalogs also use a hash of the client's roots snapshot when applicable; the adapter can ask a roots-capable client for that snapshot after initialization without starting a backend. The roots themselves are not written to cache. Initialization that requires client roots before its response is obtained live instead. A later executor protocol change requires a reconnect rather than silently changing the negotiated protocol.

Writes use temporary files and atomic replacement, with a short per-key writer lock to merge concurrent updates. An independent invalidation revision prevents old in-flight writers from restoring invalidated data. Tool/resource/prompt list-change notifications, roots-change notifications and detected backend identity changes invalidate cache across replicas. Expired, malformed, oversized or old-format records safely miss. Storage failures fall back to live discovery. These mechanisms coordinate metadata only; they neither merge workers nor add a daemon.

For local troubleshooting, each MCP adapter startup appends one JSONL record `{pid, startedAt, env}` to `mcp-codegraph-proxy/discovery/env-startup.jsonl` under the user's temporary directory. `env` is the adapter's original `process.env`, before backend overrides or cache-key exclusions. Worker/backend starts, discovery and tool calls do not append records. This file contains raw environment values, which can include credentials: keep it local and never publish it. New directories/files request modes 0700/0600 on POSIX; Windows uses the user TEMP directory's inherited permissions. A failed append does not affect MCP startup. The file is append-only with no rotation or additional diagnostics machinery.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `CG_PROXY_RUNNER` | automatic | `local` or `latest` worker |
| `CG_PROXY_IDLE_MS` | `1800000` | Retention after real work; 0 disables idle expiry |
| `CG_PROXY_DISCOVERY_IDLE_MS` | `60000` | Retention after backend discovery |
| `CG_PROXY_DISCOVERY_CACHE_MS` | `600000` | Shared discovery cache lifetime from a successful write; 0 disables cache |
| `CG_PROXY_CACHE_IGNORE_ENV` | empty | Additional comma-separated env names excluded from the invocation hash; execution env is preserved |
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

The smoke test creates only a synthetic repository under `.tmp/`, checks discovery cache after worker expiry, queries uninitialized status, initializes through `codegraph_init`, checks indexed status, calls `codegraph_explore` after lazy restart, rebuilds through `codegraph_index` and verifies reads after reopening the index. It also syncs new symbols and circular imports, verifies reads after sync, finds an affected test and checks cycle reports both with and without findings. Release archives use an explicit allowlist; local configuration, indexes, logs and temporary data are excluded. MIT licensed.

Fixture tests cover cold and warm discovery in separate Node processes, invocation hashing and environment forwarding, fixed expiry, invalid records, concurrent metadata writes, catalog updates across live replicas, backend identity and protocol changes, roots isolation, ping and cache hits during worker idle expiry. Fixture caches and test files stay under `.tmp/`; production shared discovery uses the user's TEMP directory.

`node --test test/discovery-sdk.test.js` reproduces cold/warm discovery using the actual MCP client SDK against separate fixture-backed adapter processes. It checks the complete initialization and all supported discovery list results, including `ttlMs: 0`, `cacheScope`, `resultType`, `_meta`, unknown fields and the final augmented catalog; verifies local expiry and fresh JSON-RPC IDs; and delegates a real fixture operation after a warm start.
