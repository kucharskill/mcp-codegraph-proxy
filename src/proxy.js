import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { startChild } from './child.js';
import { log } from './meta.js';
const discovery = new Set(['initialize', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']);
const cacheable = new Set(['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']);
const key = value => JSON.stringify(value);

/** One pending-request ledger, one deadline, one timer. Only workers expire. */
export class Proxy {
  constructor({ target, role, env = process.env, cwd = process.cwd(), idleMs = 1800000, discoveryMs = 60000, cacheMs = 300000, startupMs = 180000, exit = () => {}, spawn = startChild }) {
    Object.assign(this, { target, role, env, cwd, idleMs, discoveryMs, cacheMs, startupMs, exit, spawn });
    this.pending = new Map(); this.serverPending = new Set(); this.cache = new Map();
    this.expiresAt = 0; this.closed = false;
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
  invalidate() { this.cache.clear(); }
  async receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      this.error(null, -32600, 'Invalid request'); return;
    }
    if (this.closed) return;
    const hasId = Object.hasOwn(message, 'id');
    if (!message.method) {
      this.serverPending.delete(key(message.id));
      this.child?.send(message); this.arm(); return;
    }
    if (!hasId) {
      if (message.method === 'notifications/initialized') this.initialized = message;
      if (message.method === 'notifications/roots/list_changed') this.invalidate();
      // Late cancellation or roots notifications never start a backend.
      if (this.child && !this.stopping) this.child.send(message);
      return;
    }
    const id = key(message.id);
    if (this.pending.has(id)) { this.error(message.id, -32600, 'Duplicate request ID'); return; }
    // Transport health checks must not wake or retain an expensive executor.
    if (message.method === 'ping') { this.send({ jsonrpc: '2.0', id: message.id, result: {} }); return; }
    const cacheKey = key([message.method, message.params ?? {}]);
    const cached = this.cache.get(cacheKey);
    if (this.role === 'adapter' && cached && Date.now() < cached.until) {
      log({ role: this.role, event: 'cache-hit', method: message.method });
      this.send({ jsonrpc: '2.0', id: message.id, result: cached.result }); return;
    }
    clearTimeout(this.timer);
    this.pending.set(id, { id: message.id, method: message.method, cacheKey });
    if (message.method === 'initialize') this.initialize = message;
    try {
      await this.ensureStarted(message.method === 'initialize');
      if (this.closed) return;
      this.child.send(message);
    } catch (error) {
      // A disconnect callback may already have answered this request.
      if (this.pending.delete(id)) this.error(message.id, -32603, error.message);
      this.arm();
    }
  }
  async ensureStarted(initializing) {
    if (this.stopping) await this.stopping;
    if (this.closed) throw new Error('Proxy is closing');
    if (this.starting) return this.starting;
    if (this.child) return;
    if (!this.starting) this.starting = (async () => {
      const resolved = await this.target();
      if (this.closed) throw new Error('Proxy is closing');
      const generation = Symbol(); this.generation = generation;
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
  fromBackend(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.method === 'notifications/tools/list_changed') this.invalidate();
    if (message.method && Object.hasOwn(message, 'id')) this.serverPending.add(key(message.id));
    if (!message.method && this.bootstrap && message.id === this.bootstrap.id) {
      if (message.error) this.bootstrap.reject(new Error(message.error.message));
      else { this.observeInitialization(message.result); this.bootstrap.resolve(); }
      return;
    }
    if (!message.method && Object.hasOwn(message, 'id')) {
      const request = this.pending.get(key(message.id));
      this.pending.delete(key(message.id));
      if (request) {
        if (request.method === 'initialize' && message.result) this.observeInitialization(message.result);
        if (this.role === 'adapter' && cacheable.has(request.method) && message.result && !message.error) {
          this.cache.set(request.cacheKey, { result: message.result, until: Date.now() + this.cacheMs });
        }
        const keepAlive = discovery.has(request.method) ? this.discoveryMs : this.idleMs;
        this.expiresAt = Math.max(this.expiresAt, Date.now() + keepAlive);
      }
    }
    this.send(message); this.arm();
  }
  observeInitialization(result) {
    const version = key(result?.serverInfo ?? {});
    if (this.backendInfo && this.backendInfo !== version) {
      this.invalidate(); this.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    this.backendInfo = version;
  }
  disconnected(failure) {
    this.child = undefined; this.generation = undefined;
    clearTimeout(this.timer); this.bootstrap?.reject(failure ?? new Error('Backend disconnected'));
    for (const request of this.pending.values()) this.error(request.id, -32603, 'Backend disconnected. Operation outcome may be unknown; no automatic retry was performed.');
    this.pending.clear(); this.serverPending.clear();
    log({ role: this.role, event: 'backend-disconnected' });
    if (this.role === 'worker' && !this.closed) void this.close('upstream-disconnected');
  }
  arm() {
    clearTimeout(this.timer);
    if (this.role !== 'worker' || !this.idleMs || this.closed || this.starting || this.stopping || !this.child || this.pending.size || this.serverPending.size) return;
    const delay = Math.max(0, this.expiresAt - Date.now());
    this.timer = setTimeout(() => { void this.close('idle-expired'); }, delay);
  }
  close(reason = 'shutdown') {
    if (this.stopping) return this.stopping;
    this.closed = true; clearTimeout(this.timer);
    log({ role: this.role, event: reason });
    this.stopping = (async () => {
      await this.child?.close();
      await this.starting?.catch(() => {});
      await this.child?.close();
      this.exit();
    })();
    return this.stopping;
  }
}
