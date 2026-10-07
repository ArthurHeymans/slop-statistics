import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractUsage, hash } from '../shared/usage.js';
import { resolveProject } from './project.js';
import { readBillingDefaults } from './billing.js';

export const defaultConfigPath = () => process.env.SLOP_CONFIG || join(homedir(), '.config/slop-statistics/collector.json');
function serverOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid collector serverUrl.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS (HTTP is allowed only on loopback for development).');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('serverUrl must be an origin, without path, credentials, query or fragment.');
  return url.origin;
}
export async function loadConfig(path = defaultConfigPath()) {
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw error; throw new Error('Collector configuration must be readable, valid JSON.'); }
  if (!config.machineId || !config.serverUrl || !config.token) throw new Error('Collector needs machineId, serverUrl, and token. Run npm run collector -- init.');
  const origin = serverOrigin(config.serverUrl);
  if (!/^slop_[A-Za-z0-9_-]{43}$/.test(config.token)) throw new Error('Invalid collector upload token format.');
  if (config.intervalSeconds !== undefined && (!Number.isFinite(config.intervalSeconds) || config.intervalSeconds < 60 || config.intervalSeconds > 86400)) throw new Error('intervalSeconds must be between 60 and 86400.');
  for (const key of ['billingRules','prices']) if (config[key] !== undefined && !Array.isArray(config[key])) throw new Error(`${key} must be an array.`);
  const enrolled = new Date(config.enrolledAt || Date.now());
  if (!Number.isFinite(enrolled.getTime())) throw new Error('enrolledAt must be a valid date.');
  for (const rule of config.billingRules || []) if (!rule.provider || !['api','subscription','local','unknown'].includes(rule.billing)) throw new Error('Invalid collector billing rule.');
  for (const price of config.prices || []) if (!price.provider || !price.model || ['input','output','cacheRead','cacheWrite'].some(k => !Number.isFinite(price[k]) || price[k] < 0)) throw new Error('Prices require provider, model, and four nonnegative USD-per-million rates.');
  if (config.authFile !== undefined && (typeof config.authFile !== 'string' || !config.authFile)) throw new Error('authFile must be a path.');
  const authFile = config.authFile || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'auth.json');
  return { ...config, authFile, billingDefaults: await readBillingDefaults(authFile), serverUrl: origin, machineName: config.machineName || hostname(), intervalSeconds: Math.max(60, config.intervalSeconds || 180), sessionsDir: config.sessionsDir || process.env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), '.pi/agent/sessions'), stateDir: config.stateDir || join(homedir(), '.local/state/slop-statistics'), enrolledAt: enrolled.toISOString() };
}
export async function initConfig(serverUrl, token, path = defaultConfigPath()) {
  const origin = serverOrigin(serverUrl);
  if (!/^slop_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid collector upload token format.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const config = { serverUrl: origin, token, machineId: randomUUID(), machineName: hostname(), enrolledAt: new Date().toISOString(), intervalSeconds: 180, backfill: false, sendSessionTitles: false, billingRules: [], prices: [], projectAliases: {} };
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return config;
}

export class Collector {
  constructor(config, db) { this.config = config; this.db = db; this.projects = new Map(); this.work = Promise.resolve(); this.lastError = null; this.scanWarnings = []; }
  static async open(config) {
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(config.stateDir, 'collector.sqlite'));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, inode TEXT, offset INTEGER, header TEXT);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, payload TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS status(key TEXT PRIMARY KEY, value TEXT);`);
    return new Collector(config, db);
  }
  /** @template T @param {() => T | Promise<T>} fn @returns {Promise<T>} */
  serial(fn) {
    const task = this.work.then(fn);
    this.work = task.catch(() => {});
    return task;
  }
  async project(cwd) {
    const cached = this.projects.get(cwd);
    if (cached && Date.now() - cached.time < 300_000) return cached.value;
    const value = await resolveProject(cwd, this.config.machineId, this.config.projectAliases);
    this.projects.set(cwd, { value, time: Date.now() });
    return value;
  }
  async scanFile(path, history = false) {
    let info;
    try { info = await stat(path); } catch { return; }
    if (!info.isFile()) return;
    const inode = `${info.dev}:${info.ino}`;
    const old = this.db.prepare('SELECT * FROM files WHERE path=?').get(path);
    // Explicit history import rescans even previously enrolled files; unique IDs
    // prevent re-uploading existing events. Truncation/rotation is also safe.
    const offset = !history && old?.inode === inode && old.offset <= info.size ? old.offset : 0;
    if (offset === info.size) return;
    let header = null;
    try { header = offset ? JSON.parse(old.header) : null; }
    catch { throw new Error('Collector cursor is corrupt. Restore or remove the local collector database and rescan.'); }
    let project = header ? await this.project(header.cwd) : null;
    let position = offset, pending = Buffer.alloc(0), oversized = false;
    const insert = this.db.prepare('INSERT OR IGNORE INTO events(id,payload) VALUES(?,?)');
    for await (const chunk of createReadStream(path, { start: offset, end: info.size - 1 })) {
      pending = Buffer.concat([pending, chunk]);
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline);
        position += newline + 1;
        pending = pending.subarray(newline + 1);
        if (oversized) { oversized = false; continue; }
        let entry;
        try { entry = JSON.parse(line.toString('utf8')); } catch { if (this.scanWarnings.length < 10) this.scanWarnings.push('Skipped a malformed session entry.'); continue; }
        if (entry.type === 'session') {
          header = { id: String(entry.id || hash(path)), cwd: entry.cwd || dirname(path) };
          project = await this.project(header.cwd);
        } else if (header && entry.type === 'session_info' && this.config.sendSessionTitles) {
          header.title = entry.name;
        } else if (header) {
          const event = extractUsage(entry, header, project, this.config);
          if (event && (history || this.config.backfill || event.at >= this.config.enrolledAt)) insert.run(event.id, JSON.stringify(event));
        }
      }
      if (pending.length > 32 * 1024 * 1024) {
        position += pending.length; pending = Buffer.alloc(0); oversized = true;
        if (this.scanWarnings.length < 10) this.scanWarnings.push('Skipped an oversized session entry (>32 MiB).');
      }
    }
    // Do not checkpoint an incomplete or oversized line. It may still be written.
    if (oversized) return;
    if (header) this.db.prepare('INSERT INTO files VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET inode=excluded.inode,offset=excluded.offset,header=excluded.header').run(path, inode, position, JSON.stringify(header));
  }
  async scan(history = false, currentFile) {
    this.scanWarnings = [];
    const files = new Set(currentFile ? [currentFile] : []);
    const walk = async (dir, depth) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory() && depth < 2) await walk(path, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const info = await stat(path).catch(() => null);
          if (info && (history || this.config.backfill || info.mtime.toISOString() >= this.config.enrolledAt)) files.add(path);
        }
      }
    };
    await walk(this.config.sessionsDir, 0);
    for (const file of files) {
      try { await this.scanFile(file, history); }
      catch (error) {
        if (!['ENOENT','EACCES','EPERM','EISDIR'].includes(error.code)) throw error;
        if (this.scanWarnings.length < 10) this.scanWarnings.push(`Could not read a session (${error.code}); continuing with other files.`);
      }
    }
  }
  async maintain() {
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 100; i++) {
      const response = await fetch(`${this.config.serverUrl}/api/maintenance`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.token}` },
        body: JSON.stringify({ machineId: this.config.machineId }), signal: AbortSignal.timeout(8000), redirect: 'error'
      });
      if (response.status === 404) {
        // Compatibility with capsules deployed before compaction was introduced.
        this.db.prepare("INSERT OR REPLACE INTO status VALUES('maintenanceSupported','no')").run();
      } else {
        if (!response.ok) { this.deferQuota(response); throw new Error(`Maintenance failed (HTTP ${response.status}); records remain queued locally. ${response.status === 429 ? 'Lakebed quota reached.' : ''}`); }
        const result = await response.json();
        if (typeof result.more !== 'boolean') throw new Error('Invalid maintenance response; records remain queued locally.');
        this.db.prepare("INSERT OR REPLACE INTO status VALUES('maintenanceSupported','yes')").run();
        if (result.more) continue;
      }
      this.db.prepare("INSERT OR REPLACE INTO status VALUES('maintenanceDay',?)").run(day);
      this.db.prepare("DELETE FROM status WHERE key='maintenanceNeeded'").run();
      return;
    }
    throw new Error('Compaction is still pending; the next sync will continue. Records remain queued locally.');
  }
  deferQuota(response) {
    const seconds = Number(response.headers.get('retry-after'));
    if (response.status === 429 && Number.isFinite(seconds) && seconds > 0) {
      this.db.prepare("INSERT INTO status VALUES('retryAt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now() + Math.min(seconds, 86400) * 1000));
    }
  }
  async flush() {
    // Raw-ID and compacted-ID checks both fit within the 100-index-scan budget.
    const rows = this.db.prepare('SELECT id,payload FROM events WHERE sent=0 LIMIT 40').all();
    const profile = this.config.billingDefaults ? JSON.stringify(this.config.billingDefaults) : null;
    const profileChanged = profile !== null && profile !== (this.db.prepare("SELECT value FROM status WHERE key='billingProfile'").get()?.value ?? null);
    const day = new Date().toISOString().slice(0, 10);
    const previousDay = this.db.prepare("SELECT value FROM status WHERE key='maintenanceDay'").get()?.value;
    const maintenanceNeeded = Boolean(this.db.prepare("SELECT value FROM status WHERE key='maintenanceNeeded'").get()) ||
      Boolean(previousDay && previousDay !== day) || Boolean(rows.length && previousDay !== day);
    if (!rows.length && !profileChanged && !maintenanceNeeded) return 0;
    const retryAt = Number(this.db.prepare("SELECT value FROM status WHERE key='retryAt'").get()?.value || 0);
    if (retryAt > Date.now()) throw new Error(`Upload deferred until ${new Date(retryAt).toISOString()} (server quota).`);
    if (maintenanceNeeded) await this.maintain();
    if (!rows.length && !profileChanged) return 0;
    let events;
    try { events = rows.map(r => JSON.parse(r.payload)); }
    catch { throw new Error('Collector queue is corrupt. Restore the local collector database.'); }
    const response = await fetch(`${this.config.serverUrl}/api/ingest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.token}` },
      body: JSON.stringify({ machine: { id: this.config.machineId, name: this.config.machineName }, events,
        ...(profile !== null ? { billingDefaults: this.config.billingDefaults } : {}) }),
      signal: AbortSignal.timeout(8000), redirect: 'error'
    });
    if (!response.ok) {
      this.deferQuota(response);
      throw new Error(`Upload failed (HTTP ${response.status}). ${response.status === 429 ? 'Lakebed quota reached; records remain queued locally.' : 'Check the server URL and machine token.'}`);
    }
    const result = await response.json();
    if (result.accepted !== rows.length) throw new Error('Server did not acknowledge the entire batch. Will retry.');
    if (profileChanged && result.billingDefaultsApplied !== true) throw new Error('Server does not support billing profiles. Update the Lakebed capsule.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const mark = this.db.prepare('UPDATE events SET sent=1 WHERE id=?');
      rows.forEach(row => mark.run(row.id));
      this.db.prepare("INSERT INTO status VALUES('lastSync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
      if (profile !== null && result.billingDefaultsApplied === true) {
        this.db.prepare("INSERT INTO status VALUES('billingProfile',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(profile);
      }
      this.db.prepare("DELETE FROM status WHERE key='retryAt'").run();
      if (events.some(e => e.at.slice(0, 10) < day) && this.db.prepare("SELECT value FROM status WHERE key='maintenanceSupported'").get()?.value === 'yes') {
        this.db.prepare("INSERT OR REPLACE INTO status VALUES('maintenanceNeeded','yes')").run();
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.lastError = null;
    return rows.length;
  }
  /** @param {{history?: boolean, currentFile?: string, drain?: boolean}} options */
  sync({ history = false, currentFile, drain = false } = {}) {
    return this.serial(async () => {
      try {
        if (this.config.authFile) this.config.billingDefaults = await readBillingDefaults(this.config.authFile) ?? this.config.billingDefaults;
        await this.scan(history, currentFile);
        let uploaded = await this.flush();
        if (drain) while (this.status().pending) uploaded += await this.flush();
        if (this.db.prepare("SELECT value FROM status WHERE key='maintenanceNeeded'").get()) await this.maintain();
        return { uploaded, ...this.status() };
      } catch (error) { this.lastError = error.message; throw error; }
    });
  }
  status() {
    return { pending: Number(this.db.prepare('SELECT count(*) AS n FROM events WHERE sent=0').get().n), collected: Number(this.db.prepare('SELECT count(*) AS n FROM events').get().n), lastSync: this.db.prepare("SELECT value FROM status WHERE key='lastSync'").get()?.value || null, error: this.lastError, warnings: this.scanWarnings };
  }
  async close() { await this.work; this.db.close(); }
}
