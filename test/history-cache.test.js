import test from 'node:test';
import assert from 'node:assert/strict';
import { clearHistoryCache, readHistoryCache, writeHistoryCache } from '../capsule/client/history-cache.ts';
import { emptySettings } from '../capsule/shared/usage.ts';
import { event } from './fixtures.js';

function storage() {
  const values = new Map();
  return { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const snapshot = () => ({ events: [{ ...event(), machine: 'laptop', machineName: 'Laptop' }], settings: emptySettings(), savedAt: Date.now() });
test('history snapshots are account-scoped, replaced rather than appended, and cleared on logout', () => {
  const store = storage(), first = snapshot();
  writeHistoryCache('owner', first, store);
  assert.deepEqual(readHistoryCache('owner', store), first);
  assert.equal(readHistoryCache('other', store), undefined);
  assert.equal(readHistoryCache(null, store), undefined);
  const updated = { ...snapshot(), events: [] }; writeHistoryCache('owner', updated, store);
  assert.equal(store.length, 1); assert.deepEqual(readHistoryCache('owner', store), updated);
  store.setItem('unrelated', 'keep'); clearHistoryCache(store);
  assert.equal(store.length, 1); assert.equal(store.getItem('unrelated'), 'keep');
});
test('summary snapshots preserve large totals and weighted call counts', () => {
  const store = storage(), value = snapshot();
  value.events[0] = { ...value.events[0], count:20, input:2e12, total:2e12 };
  writeHistoryCache('owner', value, store); assert.deepEqual(readHistoryCache('owner', store), value);
  value.events[0].count = -1; writeHistoryCache('owner', value, store); assert.equal(readHistoryCache('owner', store), undefined);
});
test('expired, corrupt, oversized and invalid snapshots are ignored and removed', () => {
  const store = storage(); writeHistoryCache('owner', snapshot(), store);
  const key = store.key(0), valid = store.getItem(key);
  for (const invalid of ['{', 'x'.repeat(2 * 1024 * 1024 + 1),
    JSON.stringify({ ...JSON.parse(valid), savedAt: Date.now() - 25 * 3600000 }),
    JSON.stringify({ ...JSON.parse(valid), events: ['[]'] })]) {
    store.setItem(key, invalid); assert.equal(readHistoryCache('owner', store), undefined); assert.equal(store.length, 0);
  }
});
test('disabled or full browser storage does not break live history loading', () => {
  const blocked = { get length() { throw Error('blocked'); }, getItem() { throw Error('blocked'); },
    setItem() { throw Error('full'); }, removeItem() { throw Error('blocked'); } };
  assert.doesNotThrow(() => writeHistoryCache('owner', snapshot(), blocked));
  assert.doesNotThrow(() => clearHistoryCache(blocked));
  assert.equal(readHistoryCache('owner', blocked), undefined);
});
