import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collector, initConfig, loadConfig } from '../collector/index.js';
import { httpFixture } from './lakebed-helpers.js';
import { entry } from './fixtures.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'slop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cloud = await httpFixture(t);
  const config = { serverUrl: cloud.origin, token: cloud.token, machineId: 'machine1', machineName: 'Laptop',
    sessionsDir: join(dir, 'sessions'), stateDir: join(dir, 'state'), enrolledAt: '2026-01-01T00:00:00.000Z',
    projectAliases: { '/coding': 'github.com/user/repo' }, billingRules: [{ provider: 'openai-codex', billing: 'subscription' }] };
  await mkdir(config.sessionsDir);
  const collector = await Collector.open(config);
  t.after(() => collector.close());
  return { ...cloud, dir, collector, config };
}
const header = { type: 'session', id: 'session1', cwd: '/coding', version: 3 };
const lines = (...entries) => entries.map(e => JSON.stringify(e) + '\n').join('');

test('configuration protects credentials and stable machine identity', async t => {
  const { dir } = await fixture(t);
  const path = join(dir, 'private', 'collector.json'), token = 'slop_' + 'a'.repeat(43);
  await assert.rejects(initConfig('http://public.example.com', token, path), /HTTPS/);
  const initial = await initConfig('https://example.lakebed.app', token, path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(initConfig('https://example.lakebed.app', token, path), { code: 'EEXIST' });
  const loaded = await loadConfig(path);
  assert.equal(loaded.machineId, initial.machineId); assert.equal(loaded.intervalSeconds, 180);
});
test('collector imports metadata only and deduplicates history', async t => {
  const { count, collector, config } = await fixture(t);
  await writeFile(join(config.sessionsDir, 'one.jsonl'), lines(header, entry('old', '2025-01-01T12:00:00.000Z'), entry('new')));
  await collector.sync(); assert.equal(await count(), 1);
  await collector.sync({ history: true, drain: true }); assert.equal(await count(), 2);
  await collector.sync({ history: true }); assert.equal(await count(), 2); assert.equal(collector.status().pending, 0);
  assert.ok(!JSON.stringify(collector.db.prepare('SELECT * FROM events').all()).includes('PRIVATE CONVERSATION'));
});
test('incomplete UTF-8 tails survive until the complete line arrives', async t => {
  const { count, collector, config } = await fixture(t); const path = join(config.sessionsDir, 'one.jsonl');
  const next = entry('two'); next.message.content = [{ type: 'text', text: '日本語' }];
  const first = Buffer.from(lines(header, entry('one'))), second = Buffer.from(JSON.stringify(next));
  const cut = second.indexOf(Buffer.from('日')) + 1;
  await writeFile(path, Buffer.concat([first, second.subarray(0, cut)])); await collector.sync();
  assert.equal(await count(), 1);
  await appendFile(path, Buffer.concat([second.subarray(cut), Buffer.from('\n')])); await collector.sync();
  assert.equal(await count(), 2);
});
test('failed uploads remain durable and another collector retries', async t => {
  const { count, collector, config } = await fixture(t);
  await writeFile(join(config.sessionsDir, 'one.jsonl'), lines(header, entry()));
  const original = collector.config.serverUrl; collector.config.serverUrl = 'http://127.0.0.1:1';
  await assert.rejects(collector.sync()); assert.equal(collector.status().pending, 1);
  const second = await Collector.open({ ...config, serverUrl: original });
  try { await second.sync(); assert.equal(second.status().pending, 0); assert.equal(await count(), 1); }
  finally { await second.close(); }
});
test('rotation and cloned session history do not double-charge', async t => {
  const { count, collector, config } = await fixture(t); const path = join(config.sessionsDir, 'one.jsonl');
  await writeFile(path, lines(header, entry())); await collector.sync();
  await writeFile(path, lines(header)); await collector.sync();
  await appendFile(path, lines(entry(), entry('new'))); await collector.sync();
  await writeFile(join(config.sessionsDir, 'fork.jsonl'), lines({ ...header, id: 'fork' }, entry(), entry('new'), entry('forknew')));
  await collector.sync({ history: true }); assert.equal(await count(), 3);
});
test('Pi extension captures ephemeral entries and closes cleanly', async t => {
  const { count, dir, config } = await fixture(t);
  const path = join(dir, 'config.json'); await writeFile(path, JSON.stringify({ ...config, stateDir: join(dir, 'extension-state'), intervalSeconds: 180 }));
  const previous = process.env.SLOP_CONFIG; process.env.SLOP_CONFIG = path;
  t.after(() => { if (previous) process.env.SLOP_CONFIG = previous; else delete process.env.SLOP_CONFIG; });
  const { default: extension } = await import('../extension/index.ts');
  const handlers = new Map(), commands = new Map();
  extension({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, command) => commands.set(name, command) });
  assert.ok(commands.has('slop-status'));
  const entries = [entry('ephemeral')];
  const ctx = { hasUI: false, cwd: '/coding', sessionManager: { getSessionId: () => 'ephemeral-session',
    getSessionFile: () => undefined, getSessionName: () => undefined, getEntries: () => entries } };
  await handlers.get('session_start')({}, ctx); await handlers.get('agent_end')({}, ctx); await handlers.get('session_shutdown')({}, ctx);
  assert.equal(await count(), 1);
});
test('idle collectors use no mutation quota; backfills obey the 40-record limit', async t => {
  const { count, collector, config, server } = await fixture(t); let requests = 0;
  server.on('request', () => requests++);
  await collector.sync(); assert.equal(requests, 0);
  await writeFile(join(config.sessionsDir, 'many.jsonl'), lines(header, ...Array.from({ length: 91 }, (_, i) => entry('call' + i))));
  await collector.sync({ drain: true }); assert.equal(await count(), 91); assert.equal(requests, 4); // One compatibility probe plus three uploads.
});
test('auth profiles refresh without history reimport and idle requests stop after acknowledgement', async t => {
  const { collector, config, dir, count, server } = await fixture(t); let requests = 0;
  server.on('request', () => requests++);
  const authFile = join(dir, 'auth.json'); config.authFile = authFile;
  await writeFile(authFile, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'PRIVATE_TOKEN' } }));
  await collector.sync(); assert.equal(requests, 1); assert.equal(await count(), 0);
  await collector.sync(); assert.equal(requests, 1);
  const second = await Collector.open(config);
  try { await second.sync(); assert.equal(requests, 1); } finally { await second.close(); }
  await writeFile(authFile, JSON.stringify({ 'openai-codex': { type: 'api_key', key: 'PRIVATE_KEY' } }));
  await collector.sync(); assert.equal(requests, 2);
  assert.ok(!JSON.stringify(collector.db.prepare('SELECT * FROM status').all()).includes('PRIVATE'));
  await writeFile(authFile, '{'); await collector.sync(); assert.equal(requests, 2);
});
test('daily maintenance runs after UTC midnight, survives restarts, and keeps the local raw history', async t => {
  const now = Date.parse('2030-01-10T12:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const dir = await mkdtemp(join(tmpdir(), 'slop-maint-')); t.after(() => rm(dir, { recursive:true, force:true }));
  const cloud = await httpFixture(t, { maintenance:true });
  await cloud.mutate('claim', ['setup-secret']);
  const config = { serverUrl:cloud.origin, token:cloud.token, machineId:'machine1', machineName:'Laptop',
    sessionsDir:join(dir,'sessions'), stateDir:join(dir,'state'), enrolledAt:'2020-01-01T00:00:00.000Z', projectAliases:{'/coding':'repo/a'} };
  await mkdir(config.sessionsDir);
  await writeFile(join(config.sessionsDir,'day.jsonl'), lines(header, entry('today', new Date().toISOString())));
  const collector = await Collector.open(config);
  await collector.sync(); assert.equal((await cloud.state.dump()).tables.events.length, 1);
  let requests = 0; cloud.server.on('request', () => requests++);
  await collector.sync(); assert.equal(requests, 0); await collector.close();
  t.mock.timers.setTime(now + 86400000);
  const restarted = await Collector.open(config);
  try {
    await restarted.sync(); assert.equal(requests, 1);
    const dump = await cloud.state.dump(); assert.equal(dump.tables.events.length, 0); assert.equal(dump.tables.summaries.length, 1);
    assert.equal(restarted.db.prepare('SELECT count(*) AS n FROM events WHERE sent=1').get().n, 1);
    await restarted.sync(); assert.equal(requests, 1);
  } finally { await restarted.close(); }
});
test('daily quota Retry-After survives collector restarts', async t => {
  const { collector, config } = await fixture(t);
  await writeFile(join(config.sessionsDir, 'one.jsonl'), lines(header, entry()));
  const originalFetch = globalThis.fetch; let uploads = 0;
  globalThis.fetch = async () => { uploads++; return new Response('{}', { status: 429, headers: { 'Retry-After': '3600' } }); };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(collector.sync(), /quota reached/);
  const second = await Collector.open(config);
  try { await assert.rejects(second.sync(), /deferred until/); assert.equal(uploads, 1); assert.equal(second.status().pending, 1); }
  finally { await second.close(); }
});
