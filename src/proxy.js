import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { startChild } from './child.js';
import { log } from './meta.js';
import { canonical, digest, legacyVersions, cacheableResult } from './discovery-cache.js';
const discovery = new Set(['initialize', 'server/discover', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']);
const cacheable = new Set(['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']);
const key = value => JSON.stringify(value);

/** One pending-request ledger, one deadline, one timer. Only workers expire. */
export class Proxy {
  constructor({ target, role, sharedCache, localTools = [], env = process.env, cwd = process.cwd(), idleMs = 1800000, discoveryMs = 60000, cacheMs = 600000, startupMs = 180000, exit = () => {}, spawn = startChild }) {
    Object.assign(this, { target, role, sharedCache, localTools, env, cwd, idleMs, discoveryMs, cacheMs, startupMs, exit, spawn });
    this.nativeTools = new Set();
    this.pending = new Map(); this.serverPending = new Set(); this.cache = new Map();
    this.rootIds = new Set();
    this.localRootIds = new Set();
    this.expiresAt = 0; this.closed = false;
    this.drainWaiters = new Set();
  }
  connect(input, output) {
    this.output = output;
    createInterface({ input, crlfDelay: Infinity }).on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.error(null, -32700, 'Parse error'); return; }
      void this.receive(message).catch(error => {
        if (message && Object.hasOwn(message, 'id')) this.error(message.id, -32603, error.message);
        else log({ role: this.role, event: 'notification-error' });
      });
    }).once('close', () => { void this.close('client-disconnected'); });
  }
  send(message) { if (!this.closed && !this.output.destroyed) this.output.write(JSON.stringify(message) + '\n'); }
  error(id, code, message) { this.send({ jsonrpc: '2.0', id, error: { code, message } }); }
  invalidate() { this.cache.clear(); this.catalogKnown = false; this.sharedCache?.invalidate(); }
  async receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      this.error(null, -32600, 'Invalid request'); return;
    }
    if (this.closed) return;
    const hasId = Object.hasOwn(message, 'id');
    if (!message.method) {
      if (this.localRootIds.delete(message.id)) {
        if (this.rootLookup?.id === message.id) { this.rememberRoots(message.result); this.rootLookup.resolve(); }
        return;
      }
      if (this.rootIds.delete(key(message.id))) this.rememberRoots(message.result);
      this.serverPending.delete(key(message.id));
      this.child?.send(message); this.notifyDrained(); this.arm(); return;
    }
    if (!hasId) {
      if (message.method === 'notifications/initialized') this.initialized = message;
      if (message.method === 'notifications/roots/list_changed') { this.rootsDigest = undefined; this.invalidate(); }
      // Late cancellation or roots notifications never start a backend.
      if (this.child && !this.stopping) this.child.send(message);
      return;
    }
    const id = key(message.id);
    if (this.pending.has(id)) { this.error(message.id, -32600, 'Duplicate request ID'); return; }
    if (message.method === 'initialize') {
      this.initialize = message; this.modern = false;
      this.cacheContext = legacyVersions.has(message.params?.protocolVersion) ? digest(message.params) : undefined;
    }
    if (message.method === 'server/discover') this.modern = true;
    const declaredVersion = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
    if (typeof declaredVersion === 'string' && !legacyVersions.has(declaredVersion)) this.modern = true;
    // Transport health checks must not wake or retain an expensive executor.
    if (message.method === 'ping') {
      if (this.modern) this.error(message.id, -32601, 'ping is not defined for modern MCP');
      else this.send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    const cacheKey = key(canonical([message.method, message.params ?? {}]));
    const request = { id: message.id, method: message.method, cacheKey, cursor: message.params?.cursor };
    this.pending.set(id, request);
    if (this.role === 'adapter' && this.sharedCache && !this.modern && cacheable.has(message.method)) await this.ensureClientRoots();
    const context = message.method === 'initialize' ? this.cacheContext : this.catalogContext();
    const disk = this.role === 'adapter' && this.sharedCache && context && !this.modern &&
      (message.method !== 'initialize' || !this.initializeDependsOnRoots) &&
      (message.method === 'initialize' || cacheable.has(message.method)) ? this.sharedCache.get(context, cacheKey, message.method) : undefined;
    Object.assign(request, { cacheRevision: disk?.revision ?? ((message.method === 'initialize' || cacheable.has(message.method)) ? this.sharedCache?.revision() : undefined), cacheContext: context });
    const cached = this.sharedCache ? (disk?.entry ? { result: disk.entry.result, until: disk.entry.expiresAt } : undefined) : this.cache.get(cacheKey);
    if (this.role === 'adapter' && cached && Date.now() < cached.until) {
      if (message.method === 'initialize') { this.observeInitialization(cached.result); this.negotiatedProtocol = cached.result.protocolVersion; }
      log({ role: this.role, event: 'cache-hit', method: message.method });
      this.pending.delete(id);
      this.send({ jsonrpc: '2.0', id: message.id, result: cached.result }); return;
    }
    clearTimeout(this.timer);
    const localTool = this.localTools.find(tool => tool.definition.name === message.params?.name);
    if (this.role === 'worker' && localTool && message.method === 'tools/call') return this.callLocal(localTool, message, id);
    try {
      do {
        await this.maintenance?.catch(() => {});
        await this.ensureStarted(message.method === 'initialize');
      } while (this.maintenance && this.role === 'worker');
      if (this.closed) return;
      this.pending.get(id).generation = this.generation;
      this.child.send(message);
    } catch (error) {
      // A disconnect callback may already have answered this request.
      if (this.pending.delete(id)) this.error(message.id, -32603, error.message);
      this.notifyDrained(); this.arm();
    }
  }
  rememberRoots(result) {
    if (Array.isArray(result?.roots) && result.roots.every(root => typeof root?.uri === 'string')) this.rootsDigest = digest(result.roots);
  }
  catalogContext() {
    if (this.initialize?.params?.capabilities?.roots && !this.rootsDigest) return;
    return this.cacheContext ? digest([this.cacheContext, this.rootsDigest ?? null]) : undefined;
  }
  async ensureClientRoots() {
    if (this.modern || !this.initialize?.params?.capabilities?.roots || this.rootsDigest || !this.initialized || this.closed) return;
    if (this.lookingUpRoots) return this.lookingUpRoots;
    let timer;
    this.lookingUpRoots = new Promise(resolve => {
      const id = `roots-${randomUUID()}`;
      this.localRootIds.add(id);
      this.rootLookup = { id, resolve };
      timer = setTimeout(resolve, Math.min(this.startupMs, 1000));
      this.send({ jsonrpc: '2.0', id, method: 'roots/list' });
    }).finally(() => { clearTimeout(timer); this.rootLookup = undefined; this.lookingUpRoots = undefined; });
    return this.lookingUpRoots;
  }
  async ensureStarted(initializing) {
    if (this.closed) throw new Error('Proxy is closing');
    if (this.stopping) await this.stopping;
    if (this.draining) await this.draining;
    if (this.closed) throw new Error('Proxy is closing');
    if (this.starting) return this.starting;
    if (this.child) return;
    if (!this.starting) this.starting = (async () => {
      const resolved = await this.target();
      if (this.closed) throw new Error('Proxy is closing');
      const generation = Symbol(); this.generation = generation; this.catalogKnown = false;
      const child = await this.spawn(resolved.args, {
        cwd: this.cwd, env: this.env,
        onmessage: message => { if (this.generation === generation) this.fromBackend(message); },
        onclose: failure => { if (this.generation === generation) this.disconnected(failure); },
      });
      if (this.closed || this.generation !== generation) { await child.close(); throw new Error('Backend exited during startup'); }
      this.child = child;
      log({ role: this.role, event: 'backend-start', version: resolved.version });
      if (!initializing && this.initialize) {
        const id = `bootstrap-${randomUUID()}`;
        let timer;
        try {
          await new Promise((resolve, reject) => {
            this.bootstrap = { id, resolve, reject };
            timer = setTimeout(() => reject(new Error('Backend initialization timed out')), this.startupMs);
            child.send({ ...this.initialize, id });
          });
          if (this.initialized) child.send(this.initialized);
        } catch (error) { await child.close(); throw error; }
        finally { clearTimeout(timer); this.bootstrap = undefined; }
      }
    })().finally(() => { this.starting = undefined; this.arm(); });
    return this.starting;
  }
  async ensureCatalog() {
    if (this.catalogKnown) return;
    if (this.catalogLoading) return this.catalogLoading;
    let timer;
    this.catalogLoading = new Promise((resolve, reject) => {
      const id = `catalog-${randomUUID()}`;
      this.catalogRequest = { id, resolve, reject };
      this.nativeTools.clear();
      timer = setTimeout(() => reject(new Error('Backend tool discovery timed out')), this.startupMs);
      this.child.send({ jsonrpc: '2.0', id, method: 'tools/list' });
    }).finally(() => { clearTimeout(timer); this.catalogRequest = undefined; this.catalogLoading = undefined; });
    return this.catalogLoading;
  }
  fromBackend(message) {
    let persistence;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (this.role === 'adapter' && message.method === 'notifications/mcp-codegraph-proxy/closing') {
      this.draining = this.child?.close().finally(() => { this.draining = undefined; });
      return;
    }
    if (/^notifications\/(tools|resources|prompts)\/list_changed$/.test(message.method ?? '')) this.invalidate();
    if (message.method === 'roots/list' && Object.hasOwn(message, 'id')) {
      this.rootIds.add(key(message.id));
      // Only initialization that actually needed roots before replying cannot be reused.
      if ([...this.pending.values()].some(request => request.method === 'initialize')) { this.initializeDependsOnRoots = true; this.invalidate(); }
    }
    if (message.method && Object.hasOwn(message, 'id')) this.serverPending.add(key(message.id));
    if (!message.method && this.catalogRequest && message.id === this.catalogRequest.id) {
      if (message.error || !Array.isArray(message.result?.tools)) this.catalogRequest.reject(new Error(message.error?.message ?? 'Invalid upstream tool catalog'));
      else {
        for (const tool of message.result.tools) this.nativeTools.add(tool.name);
        if (message.result.nextCursor) this.child.send({ jsonrpc: '2.0', id: message.id, method: 'tools/list', params: { cursor: message.result.nextCursor } });
        else { this.catalogKnown = true; this.catalogRequest.resolve(); }
      }
      return;
    }
    if (!message.method && this.bootstrap && message.id === this.bootstrap.id) {
      if (message.error) this.bootstrap.reject(new Error(message.error.message));
      else {
        this.observeInitialization(message.result);
        if (this.negotiatedProtocol && message.result?.protocolVersion !== this.negotiatedProtocol) { this.invalidate(); this.bootstrap.reject(new Error('Backend protocol changed; reconnect MCP to negotiate again')); }
        else this.bootstrap.resolve();
      }
      return;
    }
    if (!message.method && Object.hasOwn(message, 'id')) {
      const request = this.pending.get(key(message.id));
      this.pending.delete(key(message.id));
      if (request) {
        request.complete?.();
        if (request.method === 'initialize' && message.result) {
          this.observeInitialization(message.result); this.negotiatedProtocol = message.result.protocolVersion;
          request.cacheRevision = this.sharedCache?.revision();
        }
        if (this.role === 'worker' && request.method === 'tools/list' && message.result?.tools) {
          if (!request.cursor) this.nativeTools.clear();
          for (const tool of message.result.tools) this.nativeTools.add(tool.name);
          if (!message.result.nextCursor) {
            this.catalogKnown = true;
            message.result.tools = [...message.result.tools, ...this.localTools.filter(tool => !this.nativeTools.has(tool.definition.name)).map(tool => tool.definition)];
          }
        }
        if (this.role === 'adapter' && (cacheable.has(request.method) || request.method === 'initialize') && message.result && !message.error) {
          const context = request.method === 'initialize' ? request.cacheContext : this.catalogContext();
          if (this.sharedCache && !this.modern && context && (request.method !== 'initialize' || !this.initializeDependsOnRoots)) {
            this.sharedCache.put(context, request.cacheKey, request.method, message.result, request.cacheRevision, digest(this.backendInfo));
            persistence = this.sharedCache.flush();
          }
          else if (!this.sharedCache && cacheable.has(request.method) && cacheableResult(request.method, message.result)) this.cache.set(request.cacheKey, { result: message.result, until: Date.now() + this.cacheMs });
        }
        const keepAlive = discovery.has(request.method) ? this.discoveryMs : this.idleMs;
        this.expiresAt = Math.max(this.expiresAt, Date.now() + keepAlive);
      }
    }
    const forward = () => { this.send(message); this.notifyDrained(); this.arm(); };
    if (persistence) void persistence.then(forward, forward);
    else forward();
  }
  observeInitialization(result) {
    const version = key(result?.serverInfo ?? {});
    if (this.backendInfo && this.backendInfo !== version) {
      this.invalidate(); this.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    this.backendInfo = version;
  }
  disconnected(failure) {
    const generation = this.generation;
    this.child = undefined; this.generation = undefined;
    clearTimeout(this.timer); this.bootstrap?.reject(failure ?? new Error('Backend disconnected'));
    this.catalogRequest?.reject(failure ?? new Error('Backend disconnected'));
    for (const [id, request] of this.pending) {
      if (request.generation !== generation) continue;
      this.error(request.id, -32603, 'Backend disconnected. Operation outcome may be unknown; no automatic retry was performed.');
      request.complete?.();
      this.pending.delete(id);
    }
    this.serverPending.clear();
    this.rootIds.clear();
    this.notifyDrained();
    log({ role: this.role, event: 'backend-disconnected' });
    if (this.role === 'worker' && !this.closed) void this.close('upstream-disconnected');
  }
  arm() {
    clearTimeout(this.timer);
    if (this.role !== 'worker' || !this.idleMs || this.closed || this.starting || this.stopping || !this.expiresAt || this.pending.size || this.serverPending.size) return;
    const delay = Math.max(0, this.expiresAt - Date.now());
    this.timer = setTimeout(() => { void this.close('idle-expired'); }, delay);
  }
  notifyDrained() {
    if (!this.closed && (this.serverPending.size || [...this.pending.values()].some(request => request.generation))) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
  async callLocal(tool, message, id) {
    const previous = this.maintenance;
    const operation = (async () => {
      await previous?.catch(() => {});
      await this.ensureStarted(false);
      await this.ensureCatalog();
      if (this.closed) throw new Error('Worker is closing');
      if (this.nativeTools.has(tool.definition.name)) {
        await new Promise(resolve => {
          const request = this.pending.get(id);
          request.complete = resolve; request.generation = this.generation;
          this.child.send(message);
        });
        return;
      }
      const args = await tool.validate(message.params.arguments ?? {});
      await this.starting?.catch(() => {});
      if ([...this.pending.values()].some(request => request.generation) || this.serverPending.size) await new Promise(resolve => this.drainWaiters.add(resolve));
      if (this.closed) throw new Error('Worker is closing');
      // Mutations detach drained readers so their normal exit does not stop this worker.
      if (tool.exclusive !== false) {
        const child = this.child; this.child = undefined; this.generation = undefined;
        await child?.close();
      }
      if (this.closed) throw new Error('Worker is closing');
      this.localController = new AbortController();
      return tool.execute(args, { signal: this.localController.signal, env: this.env });
    })();
    this.maintenance = operation;
    try { const result = await operation; if (result !== undefined) this.send({ jsonrpc: '2.0', id: message.id, result }); }
    catch (error) { this.send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } }); }
    finally {
      if (this.maintenance === operation) { this.maintenance = undefined; this.localController = undefined; }
      this.pending.delete(id);
      this.expiresAt = Math.max(this.expiresAt, Date.now() + this.idleMs);
      this.notifyDrained(); this.arm();
    }
  }
  close(reason = 'shutdown') {
    if (this.stopping) return this.stopping;
    if (this.role === 'worker' && reason === 'idle-expired') this.send({ jsonrpc: '2.0', method: 'notifications/mcp-codegraph-proxy/closing' });
    this.closed = true; clearTimeout(this.timer);
    this.catalogRequest?.reject(new Error('Proxy is closing'));
    this.rootLookup?.resolve();
    for (const request of this.pending.values()) request.complete?.();
    this.localController?.abort(); this.notifyDrained();
    log({ role: this.role, event: reason });
    this.stopping = (async () => {
      await this.child?.close();
      await this.maintenance?.catch(() => {});
      await this.starting?.catch(() => {});
      await this.child?.close();
      await this.sharedCache?.flush();
      this.exit();
    })();
    return this.stopping;
  }
}
