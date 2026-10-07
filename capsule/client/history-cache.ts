import { pack, unpack, validateBatch, validateSettings, validText, type Settings, type StoredEvent } from '../shared/usage.ts';

export type HistorySnapshot = { events: StoredEvent[]; settings: Settings; savedAt: number };
const prefix = 'slop-statistics:history:';
const maxChars = 2 * 1024 * 1024; // At most ~4 MiB of UTF-16 storage; one snapshot, not a growing log.
const maxAge = 24 * 60 * 60 * 1000;
const key = (userId: string) => `${prefix}v1:${userId}`;

export function clearHistoryCache(storage?: Storage) {
  try {
    const store = storage ?? sessionStorage;
    for (let i = store.length - 1; i >= 0; i--) {
      const name = store.key(i);
      if (name?.startsWith(prefix)) store.removeItem(name);
    }
  } catch { /* Storage can be disabled; live loading must still work. */ }
}
export function readHistoryCache(userId: string | null, storage?: Storage): HistorySnapshot | undefined {
  if (!userId) return;
  try {
    const store = storage ?? sessionStorage;
    const serialized = store.getItem(key(userId));
    if (!serialized) return;
    if (serialized.length > maxChars) throw new Error('Oversized cache.');
    const value = JSON.parse(serialized);
    if (value.version !== 1 || !Number.isFinite(value.savedAt) || value.savedAt > Date.now() ||
        Date.now() - value.savedAt > maxAge || !Array.isArray(value.events) || value.events.length > 16384) throw new Error('Invalid cache.');
    const events = value.events.map((data: unknown) => {
      if (typeof data !== 'string') throw new Error('Invalid cached event.');
      const event = unpack(data);
      if (!validText(event.machine, 100) || !validText(event.machineName, 120)) throw new Error('Invalid cached machine.');
      return event;
    }) as StoredEvent[];
    if (new Set(events.map(event => event.id)).size !== events.length) throw new Error('Duplicate cached events.');
    for (let i = 0; i < events.length; i += 40) {
      validateBatch({ machine: { id: 'cache', name: 'cache' }, events: events.slice(i, i + 40) });
    }
    return { events, settings: validateSettings(value.settings), savedAt: value.savedAt };
  } catch {
    try { (storage ?? sessionStorage).removeItem(key(userId)); } catch { /* Optional cache. */ }
  }
}
export function writeHistoryCache(userId: string | null, snapshot: HistorySnapshot, storage?: Storage) {
  if (!userId) return;
  try {
    const store = storage ?? sessionStorage;
    const serialized = JSON.stringify({ version: 1, savedAt: snapshot.savedAt, settings: snapshot.settings, events: snapshot.events.map(pack) });
    if (serialized.length > maxChars) { store.removeItem(key(userId)); return; }
    store.setItem(key(userId), serialized);
  } catch { /* Quota or privacy restrictions must not break the dashboard. */ }
}
