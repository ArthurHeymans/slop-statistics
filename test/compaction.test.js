import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, guest, signedIn } from './lakebed-helpers.js';
import { event } from './fixtures.js';
import { classify, emptySettings, metrics, tokenBreakdown, validateBatch } from '../capsule/shared/usage.ts';
import { mergeSummary, validateStoredEvent } from '../capsule/shared/compaction.ts';

const yesterday = () => new Date(Date.parse(new Date().toISOString().slice(0, 10)) - 86400000).toISOString();
const today = () => new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
const batch = events => ({ machine: { id: 'laptop', name: 'Laptop' }, events });
async function history(f) {
  const args = [{ pagination: { cursor: null, numItems: 900 } }];
  return [...(await f.query('events', args)).page, ...(await f.query('summaryEvents', args)).page];
}
async function compact(f) { for (let i = 0; i < 100; i++) if (!(await f.mutate('compact')).more) return; throw Error('did not finish'); }
function equalMetrics(actual, expected) {
  for (const key of Object.keys(expected)) {
    if (typeof expected[key] === 'number') assert.ok(Math.abs(actual[key] - expected[key]) < 1e-8, `${key}: ${actual[key]} != ${expected[key]}`);
    else assert.deepEqual(actual[key], expected[key]);
  }
}
test('UTC daily compaction preserves all totals, missingness, cache share and sessions; today is untouched', async () => {
  const f = fixture(); await f.mutate('claim', ['setup-secret']);
  const older = Array.from({ length: 120 }, (_, i) => ({ ...event('old-' + i, i % 2 ? 'repo/a' : 'repo/b', yesterday()),
    sessionId: i % 2 ? 'session-a' : 'session-b', billing: i % 3 ? 'subscription' : 'unknown',
    billingExplicit: i % 3 !== 0, input: i % 4 ? 100 : null, cost: i % 5 ? .02 : null, costSource: i % 5 ? 'pi' : 'unknown' }));
  for (let i = 0; i < older.length; i += 40) await f.ingest(batch(older.slice(i, i + 40)));
  await f.ingest(batch([event('midnight', 'repo/a', today()), event('current', 'repo/b', new Date().toISOString())]));
  const before = await history(f), rawToday = before.filter(e => e.at >= today());
  await compact(f); const after = await history(f), metadata = await f.query('metadata');
  equalMetrics(metrics(after), metrics(before));
  assert.deepEqual(tokenBreakdown(after), tokenBreakdown(before));
  assert.deepEqual(after.filter(e => e.count === undefined).sort((a,b) => a.id.localeCompare(b.id)), rawToday.sort((a,b) => a.id.localeCompare(b.id)));
  assert.equal(metadata.calls, 122); assert.equal(metadata.compacted, 120); assert.equal(metadata.rows, after.length);
  assert.equal(metadata.compactionPending, false); assert.ok(after.filter(e => e.count !== undefined).every(e => e.at === yesterday()));
  const unchanged = await f.state.dump(); await compact(f); assert.deepEqual((await f.state.dump()).tables, unchanged.tables);
});
test('compacted IDs prevent replay even with a different machine, session or timestamp', async () => {
  const f = fixture(); await f.mutate('claim', ['setup-secret']);
  const records = Array.from({length: 40}, (_, i) => event('replay-' + i, 'repo/a', yesterday()));
  await f.ingest(batch(records)); await compact(f);
  const token = 'slop_' + 'b'.repeat(43); await f.mutate('addToken', ['Other', token]);
  const result = await f.ingest({ machine: { id: 'other', name: 'Other' }, events: records.map(e => ({ ...e, sessionId: 'copy', at: today() })) }, token);
  assert.equal(result.accepted, 40); assert.equal(result.inserted, 0); assert.equal(await f.count(), 40);
  assert.equal(metrics(await history(f)).sessions, 1);
});
test('compaction remains transactional, within free scan limits, and reduces repeated history storage', async () => {
  const f = fixture(); await f.mutate('claim', ['setup-secret']);
  for (let i = 0; i < 5; i++) await f.ingest(batch(Array.from({length:40}, (_,j) => event('size-' + (i*40+j), 'repo/a', yesterday()))));
  const before = await f.state.dump();
  f.state.limits.maxWrites = 2;
  await assert.rejects(f.mutate('compact'), /writes limit/);
  assert.deepEqual((await f.state.dump()).tables, before.tables);
  f.state.limits.maxWrites = 1000; await compact(f);
  const after = await f.state.dump();
  assert.equal(after.tables.events.length, 0); assert.equal(after.tables.summaries.length, 1);
  assert.ok(JSON.stringify(after.tables).length < JSON.stringify(before.tables).length * .6);
  assert.equal(metrics(await history(f)).calls, 200);
});
test('classification defaults and overrides remain retroactive after aggregation', async () => {
  const f = fixture(); await f.mutate('claim', ['setup-secret']);
  await f.ingest(batch(Array.from({length:6}, (_,i) => ({ ...event('billing-'+i, 'repo/a', yesterday()), billing:'unknown', billingExplicit:i%2===0 }))));
  await compact(f);
  await f.ingest({ ...batch([]), billingDefaults: { 'openai-codex':'subscription' } });
  const rows = await history(f); assert.equal(metrics(rows).unknownBilling, 3);
  const settings = { ...emptySettings(), billingRules: [{ provider:'openai-codex', model:'', billing:'api' }], aliases:{'repo/a':'canonical'} };
  const changed = rows.map(e => classify(e, settings)); assert.equal(metrics(changed).unknownBilling, 0);
  assert.ok(changed.every(e => e.project.key === 'canonical' && e.billing === 'api'));
});
test('large summary sums validate without loosening collector validation; summaries cannot be forged', () => {
  const e = { ...event('large', 'repo/a', yesterday()), machine:'laptop', machineName:'Laptop', input:1e12, total:1e12, cost:1e6 };
  const summary = mergeSummary('a'.repeat(64), undefined, e);
  const combined = mergeSummary(summary.id, summary, e); assert.equal(combined.input, 2e12);
  validateStoredEvent(combined); assert.throws(() => validateBatch(batch([combined])), /Invalid token count|summaries/);
  assert.throws(() => validateStoredEvent({...combined, count:0}), /count/);
});
test('only owners or valid machine credentials may trigger maintenance', async () => {
  const f = fixture(); await f.mutate('claim', ['setup-secret']);
  assert.equal((await f.maintain('laptop', 'slop_' + 'z'.repeat(43))).status, 401);
  await f.ingest(batch([event('maintenance', 'repo/a', yesterday())]));
  assert.equal((await f.maintain('other')).status, 401);
  assert.deepEqual(await f.maintain(), { status: 200, more: false });
  const token = (await f.query('metadata')).tokens[0]; await f.mutate('revokeToken', [token.id]);
  assert.equal((await f.maintain()).status, 401);
  for (const auth of [guest(), signedIn('attacker')]) {
    await assert.rejects(f.mutate('compact', [], auth));
    await assert.rejects(f.query('summaryEvents', [{pagination:{cursor:null,numItems:900}}], auth));
  }
});
