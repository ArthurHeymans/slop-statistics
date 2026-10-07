import { eventCount, validateBatch, type StoredEvent } from './usage.ts';

export const sumFields = ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'cost'] as const;
// Missingness is part of the group: a partial record can never become a complete one.
export function summaryKey(e: StoredEvent): string {
  return JSON.stringify([e.at.slice(0, 10), e.machine, e.machineName, e.project.key, e.project.name,
    e.sessionId, e.provider, e.model, e.kind, e.billing, e.billingExplicit ?? false,
    e.costSource, e.title ?? null, sumFields.map(key => e[key] === null)]);
}
export function mergeSummary(id: string, previous: StoredEvent | undefined, event: StoredEvent): StoredEvent {
  if (previous && summaryKey(previous) !== summaryKey(event)) throw new Error('Summary key mismatch.');
  const result: StoredEvent = { ...(previous ?? event), id, at: event.at.slice(0, 10) + 'T00:00:00.000Z',
    count: (previous ? eventCount(previous) : 0) + eventCount(event) };
  if (!Number.isSafeInteger(result.count)) throw new Error('Summary call count overflow.');
  for (const key of sumFields) {
    result[key] = event[key] === null ? null : (previous?.[key] ?? 0) + event[key];
    if (result[key] !== null && (!Number.isFinite(result[key]) || (key !== 'cost' && !Number.isSafeInteger(result[key])))) throw new Error('Summary overflow.');
  }
  return result;
}
export function validateStoredEvent(e: StoredEvent) {
  const { count, ...raw } = e;
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) throw new Error('Invalid summary count.');
  for (const key of sumFields) {
    const value = e[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key !== 'cost' && !Number.isSafeInteger(value)))) throw new Error('Invalid stored usage.');
  }
  // Reuse the strict metadata validator; summary sums can exceed single-call limits.
  const capped = Object.fromEntries(sumFields.map(key => {
    const value = e[key], limit = key === 'cost' ? 1e6 : 1e12;
    return [key, value === null ? null : Math.min(value, limit)];
  }));
  validateBatch({ machine: { id: e.machine, name: e.machineName }, events: [{ ...raw, ...(count === undefined ? {} : capped) }] });
}
export function ledgerContains(tails: string, id: string): boolean {
  if (tails.length % 62 !== 0) throw new Error('Stored deduplication ledger is corrupt.');
  for (let i = 0; i < tails.length; i += 62) if (tails.slice(i, i + 62) === id.slice(2)) return true;
  return false;
}
