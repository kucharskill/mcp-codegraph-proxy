import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, linkSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { log } from './meta.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const legacyVersions = new Set(['2024-10-07', '2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function invocationKey({ command, args, cwd, env }, { ignoreEnv = [], platform = process.platform } = {}) {
  const normalize = name => platform === 'win32' ? name.toUpperCase() : name;
  const ignored = new Set(['CODEX_TOOL_CALL_ID', ...ignoreEnv].map(normalize));
  const environment = Object.entries(env).filter(([name, value]) => value !== undefined && !ignored.has(normalize(name)) && !/^(PATH$|INIT_|NPM_)/i.test(name))
    .map(([name, value]) => [normalize(name), String(value)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return digest([command, args, cwd, environment]);
}
const listFields = { 'tools/list': 'tools', 'resources/list': 'resources', 'resources/templates/list': 'resourceTemplates', 'prompts/list': 'prompts' };
function cacheableResult(method, result) {
  if (!object(result) || Object.hasOwn(result, '_meta')) return false;
  if (method === 'initialize') return legacyVersions.has(result.protocolVersion) && object(result.capabilities) && object(result.serverInfo) &&
    typeof result.serverInfo.name === 'string' && typeof result.serverInfo.version === 'string' &&
    Object.keys(result.serverInfo).every(key => ['name', 'version', 'title', 'description', 'icons', 'websiteUrl'].includes(key)) &&
    (result.instructions === undefined || typeof result.instructions === 'string') &&
    Object.keys(result).every(key => ['protocolVersion', 'capabilities', 'serverInfo', 'instructions'].includes(key));
  const field = listFields[method];
  if (!field || !Array.isArray(result[field]) || (result.nextCursor !== undefined && typeof result.nextCursor !== 'string')) return false;
  if (!Object.keys(result).every(key => [field, 'nextCursor'].includes(key))) return false;
  return result[field].every(item => object(item) && typeof item.name === 'string' &&
    (method !== 'tools/list' || object(item.inputSchema)) &&
    (method !== 'resources/list' || typeof item.uri === 'string') &&
    (method !== 'resources/templates/list' || typeof item.uriTemplate === 'string'));
}
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Metadata only. A separate revision prevents a concurrent writer from resurrecting invalidated data. */
export class DiscoveryCache {
  constructor({ invocation, ignoreEnv = [], directory = join(tmpdir(), 'mcp-codegraph-proxy', 'discovery'), ttl = 600000 }) {
    this.key = invocationKey(invocation, { ignoreEnv }); this.directory = directory; this.ttl = ttl;
    this.file = join(directory, `${this.key}.json`); this.revisionFile = join(directory, `${this.key}.revision`);
    this.queue = Promise.resolve();
  }
  atomic(path, text, exclusive = false) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' }); if (exclusive) linkSync(temporary, path); else renameSync(temporary, path); }
    finally { try { unlinkSync(temporary); } catch {} }
  }
  revision() {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (!existsSync(this.revisionFile)) {
        try { this.atomic(this.revisionFile, randomUUID(), true); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const revision = readFileSync(this.revisionFile, 'utf8');
      if (/^[a-f0-9-]{36}$/.test(revision)) return revision;
      this.atomic(this.revisionFile, randomUUID());
      return readFileSync(this.revisionFile, 'utf8');
    } catch { return undefined; }
  }
  load(revision) {
    try {
      if (!revision || statSync(this.file).size > 8 * 1024 * 1024) return;
      const doc = JSON.parse(readFileSync(this.file, 'utf8'));
      if (doc.format !== 1 || doc.revision !== revision || !Array.isArray(doc.entries) || !hash(doc.identity)) return;
      if (!doc.entries.every(entry => object(entry) && hash(entry.context) && hash(entry.key) && Number.isSafeInteger(entry.createdAt) &&
        Number.isSafeInteger(entry.expiresAt) && entry.expiresAt >= entry.createdAt && cacheableResult(entry.method, entry.result))) return;
      return doc;
    } catch { return undefined; }
  }
  get(context, requestKey, method) {
    const revision = this.revision(); const doc = this.load(revision); const now = Date.now();
    const entry = doc?.entries.find(entry => entry.context === context && entry.key === digest(requestKey) && entry.method === method &&
      entry.createdAt <= now && now < Math.min(entry.expiresAt, entry.createdAt + this.ttl));
    return { revision, entry, identity: doc?.identity };
  }
  invalidate() {
    try { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); this.atomic(this.revisionFile, randomUUID()); }
    catch { try { unlinkSync(this.file); } catch {} }
  }
  put(context, requestKey, method, result, revision, identity) {
    if (!this.ttl || !hash(context) || !hash(identity) || !revision || !cacheableResult(method, result)) return;
    // Copy before queuing: the protocol response remains owned by its caller.
    const copy = JSON.parse(JSON.stringify(result));
    this.queue = this.queue.then(async () => {
      const lock = `${this.file}.lock`; let handle;
      try {
        for (let attempt = 0; attempt < 50; attempt++) {
          try { handle = openSync(lock, 'wx', 0o600); break; }
          catch (error) {
            if (error.code !== 'EEXIST') return;
            try { if (Date.now() - statSync(lock).mtimeMs > 30000) unlinkSync(lock); } catch {}
            await sleep(10);
          }
        }
        if (handle === undefined || this.revision() !== revision) { log({ event: 'cache-write-skipped', code: handle === undefined ? 'locked' : 'invalidated' }); return; }
        const createdAt = Date.now();
        let doc = this.load(revision);
        if (doc && doc.identity !== identity) { this.invalidate(); revision = this.revision(); doc = undefined; }
        const entryKey = digest(requestKey);
        const entries = (doc?.entries ?? []).filter(entry => entry.expiresAt > createdAt && !(entry.context === context && entry.key === entryKey));
        entries.push({ context, key: entryKey, method, createdAt, expiresAt: createdAt + this.ttl, result: copy });
        const text = JSON.stringify({ format: 1, revision, identity, entries });
        if (Buffer.byteLength(text) <= 8 * 1024 * 1024 && this.revision() === revision) this.atomic(this.file, text);
      } catch (error) { log({ event: 'cache-write-skipped', code: error.code ?? 'invalid-cache' }); }
      finally { if (handle !== undefined) { try { closeSync(handle); } catch {} try { unlinkSync(lock); } catch {} } }
    });
  }
  flush() { return this.queue; }
}
