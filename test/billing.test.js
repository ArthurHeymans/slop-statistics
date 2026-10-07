import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBillingDefaults } from '../collector/billing.js';
import { extractUsage } from '../shared/usage.js';
import { applyBillingDefaults, classify, emptySettings, metrics, pack, unpack } from '../capsule/shared/usage.ts';
import { fixture } from './lakebed-helpers.js';
import { entry, event } from './fixtures.js';

test('credential metadata becomes billing defaults without exposing or resolving secrets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'slop-billing-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify({
    'openai-codex': { type: 'oauth', access: 'PRIVATE_TOKEN', refresh: 'PRIVATE_REFRESH' },
    anthropic: { type: 'oauth', access: 'PRIVATE_ANTHROPIC_TOKEN' },
    deepseek: { type: 'api_key', key: '!touch /must-not-execute' }, other: { type: 'unsupported', key: 'PRIVATE_KEY' }
  }), { mode: 0o600 });
  const defaults = await readBillingDefaults(path);
  assert.deepEqual(defaults, { 'openai-codex': 'subscription', anthropic: 'subscription', deepseek: 'api' });
  assert.ok(!JSON.stringify(defaults).includes('PRIVATE')); assert.ok(!JSON.stringify(defaults).includes('touch'));
  await writeFile(path, '{'); assert.equal(await readBillingDefaults(path), undefined);
  assert.equal(await readBillingDefaults(join(dir, 'missing')), undefined);
});
test('collected usage uses auth defaults but explicit collector rules win, including unknown', () => {
  const input = entry(), header = { id: 'session' }, project = { key: 'project', name: 'Project' };
  const inferred = extractUsage(input, header, project, { billingDefaults: { 'openai-codex': 'subscription' } });
  assert.equal(inferred.billing, 'subscription'); assert.equal(inferred.billingExplicit, false);
  for (const billing of ['api', 'unknown']) {
    const explicit = extractUsage(input, header, project, { billingDefaults: { 'openai-codex': 'subscription' }, billingRules: [{ provider: 'openai-codex', billing }] });
    assert.equal(explicit.billing, billing); assert.equal(explicit.billingExplicit, true); assert.equal(explicit.id, inferred.id);
  }
});
test('legacy unknown billing gets a fallback without changing known/explicit classifications or prices', () => {
  const e = { ...event(), machine: 'laptop', machineName: 'Laptop', billing: 'unknown', billingExplicit: false };
  const legacy = unpack(JSON.stringify(JSON.parse(pack(e)).slice(0, 19)));
  const inferred = applyBillingDefaults(legacy, { 'openai-codex': 'subscription' });
  assert.equal(inferred.billing, 'subscription'); assert.equal(inferred.cost, e.cost);
  assert.equal(applyBillingDefaults({ ...e, billing: 'api' }, { 'openai-codex': 'subscription' }).billing, 'api');
  assert.equal(applyBillingDefaults({ ...e, billingExplicit: true }, { 'openai-codex': 'subscription' }).billing, 'unknown');
  assert.equal(classify(inferred, { ...emptySettings(), billingRules: [{ provider: 'openai-codex', model: '', billing: 'api' }] }).billing, 'api');
});
test('machine defaults retroactively classify unknown records without reimport or cross-machine effects', async () => {
  const f = fixture(); await f.mutate('claim', ['setup-secret']);
  const otherToken = 'slop_' + 'b'.repeat(43); await f.mutate('addToken', ['Other machine', otherToken]);
  const unknown = id => ({ ...event(id), billing: 'unknown', billingExplicit: false });
  const body = (id, events, billingDefaults) => ({ machine: { id, name: id }, events, ...(billingDefaults ? { billingDefaults } : {}) });
  await f.ingest(body('laptop', [unknown('a')])); await f.ingest(body('desktop', [unknown('b')]), otherToken);
  const query = () => f.query('events', [{ pagination: { cursor: null, numItems: 200 } }]);
  assert.equal(metrics((await query()).page).unknownBilling, 2);
  const receipt = await f.ingest(body('laptop', [], { 'openai-codex': 'subscription' }));
  assert.equal(receipt.billingDefaultsApplied, true); assert.equal(receipt.inserted, 0);
  let summary = metrics((await query()).page);
  assert.equal(summary.subscriptionValue, .02); assert.equal(summary.unknownBilling, 1);
  await f.ingest(body('desktop', [], { 'openai-codex': 'api' }), otherToken);
  summary = metrics((await query()).page);
  assert.equal(summary.subscriptionValue, .02); assert.equal(summary.apiSpend, .02); assert.equal(summary.unknownBilling, 0);
  assert.equal(await f.count(), 2);
  const dump = await f.state.dump(); assert.ok(dump.tables.events.every(row => unpack(row.data).billing === 'unknown'));
  assert.equal((await f.ingest(body('desktop', [], { 'openai-codex': 'subscription' }))).status, 401);
  assert.equal((await f.ingest(body('laptop', [], { 'openai-codex': { access: 'PRIVATE' } }))).status, 400);
  const metadata = await f.query('metadata'); assert.equal(metadata.detectedBilling.length, 2);
  assert.ok(!JSON.stringify(metadata.detectedBilling).includes('PRIVATE'));
});
