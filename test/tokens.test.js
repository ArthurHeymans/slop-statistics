import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenBreakdown } from '../capsule/shared/usage.ts';

const usage = { input: 100, cacheRead: 50, cacheWrite: 10, output: 20 };
test('regular, cached and output tokens are disjoint; cache-read share excludes output', () => {
  const result = tokenBreakdown([usage]);
  assert.deepEqual(result.categories.map(c => [c.key, c.tokens, c.missing]), [
    ['input', 100, 0], ['cacheRead', 50, 0], ['cacheWrite', 10, 0], ['output', 20, 0]
  ]);
  assert.equal(result.knownTotal, 180);
  assert.equal(result.cacheReadShare, 50 / 160);
  assert.equal(result.incompleteRecords, 0);
  assert.equal(tokenBreakdown([{ ...usage, output: 10000 }]).cacheReadShare, 50 / 160);
});
test('partial counts stay unknown and cannot inflate the cache-read share', () => {
  const result = tokenBreakdown([usage, { input: null, cacheRead: 900, cacheWrite: null, output: null }]);
  assert.deepEqual(result.categories.map(c => [c.key, c.tokens, c.missing]), [
    ['input', 100, 1], ['cacheRead', 950, 0], ['cacheWrite', 10, 1], ['output', 20, 1]
  ]);
  assert.equal(result.knownTotal, 1080);
  assert.equal(result.cacheReadShare, 50 / 160);
  assert.equal(result.incompleteInput, 1);
  assert.equal(result.incompleteRecords, 1);
});
test('unknown, zero and empty token breakdowns are distinguishable', () => {
  const missing = tokenBreakdown([{ input: null, cacheRead: null, cacheWrite: null, output: null }]);
  assert.ok(missing.categories.every(c => c.tokens === null && c.missing === 1));
  assert.equal(missing.cacheReadShare, null);
  const zero = tokenBreakdown([{ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }]);
  assert.ok(zero.categories.every(c => c.tokens === 0 && c.missing === 0));
  assert.equal(zero.cacheReadShare, null);
  assert.equal(tokenBreakdown([]).knownTotal, 0);
});
