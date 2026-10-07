import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { credentialDigest } from '../capsule/server/security.ts';
import { classify, emptySettings, group, metrics, pack, unpack, validateBatch, validateSettings } from '../capsule/shared/usage.ts';
import { fixture, guest, signedIn } from './lakebed-helpers.js';
import { event } from './fixtures.js';
const body = (events = [event()], machine = 'laptop') => ({ machine: { id: machine, name: machine }, events });

test('portable credential hash matches standard SHA-256 across padding boundaries', () => {
  for (const value of ['', 'abc', ...[32, 47, 48, 55, 56, 63, 64, 65, 100, 512].map(n => randomBytes(n).toString('base64url').slice(0, n))]) {
    assert.equal(credentialDigest(value), createHash('sha256').update(value).digest('hex'));
  }
  assert.throws(() => credentialDigest('日本語'), /Invalid credential/);
});
test('owner setup requires a secret and signed-in account; all private operations enforce ownership', async () => {
  const f = fixture();
  await assert.rejects(f.mutate('claim', ['setup-secret'], guest()), /Sign in/);
  await assert.rejects(f.mutate('claim', ['bad']), /setup key/);
  await assert.rejects(f.query('metadata'), /private/);
  await f.mutate('claim', ['setup-secret']);
  await assert.rejects(f.mutate('claim', ['setup-secret'], signedIn('attacker')), /already/);
  assert.deepEqual(await f.query('access', [], signedIn('attacker')), { configured: true, allowed: false, userId: 'attacker' });
  for (const auth of [guest(), signedIn('attacker')]) {
    await assert.rejects(f.query('metadata', [], auth));
    await assert.rejects(f.query('events', [{ pagination: { cursor: null, numItems: 200 } }], auth));
    await assert.rejects(f.mutate('settings', [emptySettings()], auth));
    await assert.rejects(f.mutate('addToken', ['bad', 'slop_' + 'b'.repeat(43)], auth));
    await assert.rejects(f.mutate('revokeToken', ['fake'], auth));
  }
});
test('tokens are upload-only, hashed, machine-bound, and revocable', async () => {
  const f = fixture(); await f.mutate('claim', ['setup-secret']);
  const token = 'slop_' + 'b'.repeat(43); await f.mutate('addToken', ['Desktop', token]);
  assert.equal((await f.ingest(body(), 'slop_' + 'z'.repeat(43))).status, 401);
  assert.equal((await f.ingest(body(), token)).inserted, 1);
  assert.equal((await f.ingest(body([event('new')], 'other'), token)).status, 401);
  const metadata = await f.query('metadata');
  assert.ok(!JSON.stringify(metadata).includes(token)); assert.ok(!JSON.stringify(metadata).includes('digest'));
  const dump = await f.state.dump(); assert.ok(!JSON.stringify(dump).includes(token));
  await f.mutate('revokeToken', [metadata.tokens[0].id]);
  assert.equal((await f.ingest(body([event('next')]), token)).status, 401);
  assert.equal(await f.count(), 1);
});
test('ingestion validates the entire batch and stores only allowlisted metadata', async () => {
  const f = fixture();
  const invalid = event('bad'); invalid.total = -1;
  assert.equal((await f.ingest(body([event(), invalid]))).status, 400);
  assert.equal(await f.count(), 0);
  const e = { ...event(), content: 'PRIVATE CONVERSATION', cwd: '/private/source' };
  assert.equal((await f.ingest(body([e]))).inserted, 1);
  const dump = await f.state.dump();
  assert.ok(!JSON.stringify(dump).includes('PRIVATE')); assert.ok(!JSON.stringify(dump).includes('/private/source'));
  assert.throws(() => validateBatch(body(Array.from({ length: 41 }, () => event()))), /Invalid batch/);
  assert.throws(() => validateBatch(body([{ ...event(), input: undefined }])), /token count/);
});
test('deduplication preserves first attribution across machine copies', async () => {
  const f = fixture(); await f.mutate('claim', ['setup-secret']);
  await f.ingest(body()); const token = 'slop_' + 'b'.repeat(43);
  await f.mutate('addToken', ['Other machine', token]);
  const result = await f.ingest(body([event()], 'desktop'), token);
  assert.equal(result.accepted, 1); assert.equal(result.inserted, 0); assert.equal(await f.count(), 1);
  const rows = await f.query('events', [{ pagination: { cursor: null, numItems: 200 } }]);
  assert.equal(rows.page[0].machine, 'laptop');
});
test('Lakebed transaction limits roll back the whole upload and permit safe retry', async () => {
  const f = fixture({ limits: { maxWrites: 2 } });
  await assert.rejects(f.ingest(body()), /writes limit/);
  assert.equal(await f.count(), 0);
  assert.equal((await f.state.dump()).tables.tokens.length, 0);
  f.state.limits.maxWrites = 1000;
  assert.equal((await f.ingest(body())).inserted, 1); assert.equal(await f.count(), 1);
});
test('full batches stay within Lakebed scan budgets; history reads are paginated', async () => {
  const f = fixture(); await f.mutate('claim', ['setup-secret']);
  for (let i = 0; i < 7; i++) {
    const result = await f.ingest(body(Array.from({ length: 40 }, (_, j) => event('call' + (i * 40 + j)))));
    assert.equal(result.accepted, 40);
  }
  let cursor = null; const all = [];
  for (let i = 0; i < 10; i++) {
    const result = await f.query('events', [{ pagination: { cursor, numItems: 100 } }]);
    all.push(...result.page); if (result.isDone) break; cursor = result.continueCursor;
  }
  assert.equal(all.length, 280); assert.equal(new Set(all.map(e => e.id)).size, 280);
  await assert.rejects(f.query('events', [{ pagination: { cursor: null, numItems: 1001 } }]), /page size/);
  assert.equal((await f.query('metadata')).calls, 280);
});
test('900-event pages leave quota headroom for ownership and 40 machine profiles', async () => {
  const f = fixture(); await f.mutate('claim', ['setup-secret']);
  for (let i = 0; i < 925; i += 40) {
    await f.ingest(body(Array.from({ length: Math.min(40, 925 - i) }, (_, j) => event('large-' + (i + j)))));
  }
  for (let i = 0; i < 40; i++) {
    const token = i ? 'slop_' + String(i).padStart(43, 'b') : f.env.BOOTSTRAP_UPLOAD_TOKEN;
    if (i) await f.mutate('addToken', ['Machine ' + i, token]);
    await f.ingest({ machine: { id: i ? 'machine-' + i : 'laptop', name: 'Machine ' + i },
      events: [], billingDefaults: { 'openai-codex': 'subscription' } }, token);
  }
  const first = await f.query('events', [{ pagination: { cursor: null, numItems: 900 } }]);
  assert.equal(first.page.length, 900); assert.equal(first.isDone, false);
  const second = await f.query('events', [{ pagination: { cursor: first.continueCursor, numItems: 900 } }]);
  assert.equal(second.page.length, 25); assert.equal(second.isDone, true);
  assert.equal(new Set([...first.page, ...second.page].map(e => e.id)).size, 925);
  await assert.rejects(f.query('events', [{ pagination: { cursor: null, numItems: 901 } }]), /page size/);
});
test('compact storage is lossless and unknown accounting remains unknown', () => {
  const e = { ...event(), machine: 'laptop', machineName: 'Laptop' };
  assert.deepEqual(unpack(pack(e)), { ...e, title: null });
  const unknown = { ...e, id: 'unknown', total: null, input: null, cost: null, billing: 'unknown' };
  const summary = metrics([e, unknown]);
  assert.equal(summary.calls, 2); assert.equal(summary.tokens, 180); assert.equal(summary.unknownTokens, 1);
  assert.equal(summary.unpriced, 1); assert.equal(summary.subscriptionValue, .02); assert.equal(summary.apiSpend, 0);
  assert.equal(group([e, { ...e, machine: 'desktop' }], x => x.project.key)[0].sessions, 2);
});
test('retroactive billing and canonical aliases are validated and persisted', async () => {
  const f = fixture(); await f.mutate('claim', ['setup-secret']);
  const settings = validateSettings({ aliases: { a: 'b', b: 'c' }, billingRules: [
    { provider: 'openai-codex', model: '', billing: 'api' },
    { provider: 'openai-codex', model: 'gpt-example', billing: 'subscription' }
  ], subscriptions: [{ label: 'ChatGPT', month: '2026-01', amount: 20 }] });
  await f.mutate('settings', [settings]); assert.deepEqual((await f.query('metadata')).settings, settings);
  const classified = classify({ ...event('call', 'a'), machine: 'm', machineName: 'Machine' }, settings);
  assert.equal(classified.project.key, 'c'); assert.equal(classified.billing, 'subscription');
  assert.throws(() => validateSettings({ ...emptySettings(), aliases: { a: 'b', b: 'a' } }), /cycle/);
  assert.throws(() => validateSettings({ ...emptySettings(), subscriptions: [{ label: 'Bad', month: '2026-13', amount: -1 }] }), /subscription/);
});
