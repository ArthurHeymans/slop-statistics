import type { QueryServerContext, ServerContext, PaginationOptions } from 'lakebed/server';
import { applyBillingDefaults, pack, unpack, validateBillingDefaults, type StoredEvent } from '../shared/usage.ts';
import { ledgerContains, mergeSummary, summaryKey } from '../shared/compaction.ts';
import { credentialDigest, requireOwner } from './security.ts';

export const utcStart = () => Date.parse(new Date().toISOString().slice(0, 10));
export async function historyPage(ctx: QueryServerContext, args: { pagination: PaginationOptions }, summarized = false) {
  await requireOwner(ctx);
  const pagination = args?.pagination;
  if (!pagination || !Number.isSafeInteger(pagination.numItems) || pagination.numItems < 1 || pagination.numItems > 900) throw new Error('Invalid page size.');
  const machines = await ctx.db.machines.withIndex('by_creation').take(40);
  const defaults = new Map(machines.map(row => {
    try { return [String(row.key), validateBillingDefaults(JSON.parse(String(row.billing)))] as const; }
    catch { throw new Error('Stored machine billing defaults are invalid.'); }
  }));
  const table = summarized ? ctx.db.summaries : ctx.db.events;
  const result = await table.withIndex('by_at').order('desc').paginate(pagination);
  return { ...result, page: result.page.map(row => {
    const event = unpack(String(row.data));
    return applyBillingDefaults(event, defaults.get(event.machine) ?? {});
  }) };
}
export async function compactHistory(ctx: ServerContext) {
  // 30 deletions + at most 30 summary and 30 ledger lookups stay below 100 scans.
  const rows = await ctx.db.events.withIndex('by_at', q => q.lt('at', utcStart())).take(30);
  if (!rows.length) return { compacted: 0, more: false };
  const stats = await ctx.db.stats.withIndex('by_creation').first();
  if (!stats) throw new Error('Usage statistics are missing.');
  const summaries = new Map<string, { rowId?: string; oldBytes: number; event: StoredEvent }>();
  const ledgers = new Map<string, { rowId?: string; tails: string }>();
  let payloadDelta = 0;
  for (const row of rows) {
    const event = unpack(String(row.data));
    if (event.count !== undefined) throw new Error('Raw usage table contains a summary.');
    // Escape Unicode to deterministic ASCII for the portable SHA implementation.
    const ascii = summaryKey(event).replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    const key = credentialDigest(ascii, 16000);
    let summary = summaries.get(key);
    if (!summary) {
      const existing = await ctx.db.summaries.withIndex('by_key', q => q.eq('key', key)).first();
      summary = { rowId: existing?.id, oldBytes: existing ? String(existing.data).length : 0,
        event: mergeSummary(key, existing ? unpack(String(existing.data)) : undefined, event) };
    } else summary.event = mergeSummary(key, summary.event, event);
    summaries.set(key, summary);
    const prefix = event.id.slice(0, 2);
    let ledger = ledgers.get(prefix);
    if (!ledger) {
      const existing = await ctx.db.dedup.withIndex('by_prefix', q => q.eq('prefix', prefix)).first();
      ledger = { rowId: existing?.id, tails: existing ? String(existing.tails) : '' };
    }
    if (ledgerContains(ledger.tails, event.id)) throw new Error('Raw event is already compacted.');
    ledger.tails += event.id.slice(2);
    if (ledger.tails.length > 60000) throw new Error('Deduplication ledger is full; export before redesigning storage.');
    ledgers.set(prefix, ledger);
    payloadDelta -= String(row.data).length;
    // Deletes and replacements are one transaction. Free space before inserting rows.
    await ctx.db.events.delete(row.id);
  }
  let addedSummaries = 0;
  for (const [key, summary] of summaries) {
    const data = pack(summary.event); payloadDelta += data.length - summary.oldBytes;
    if (summary.rowId) await ctx.db.summaries.update(summary.rowId, { data });
    else { await ctx.db.summaries.insert({ key, at: Date.parse(summary.event.at), data }); addedSummaries++; }
  }
  for (const [prefix, ledger] of ledgers) {
    if (ledger.rowId) await ctx.db.dedup.update(ledger.rowId, { tails: ledger.tails });
    else await ctx.db.dedup.insert({ prefix, tails: ledger.tails });
  }
  await ctx.db.stats.update(stats.id, { compacted: Number(stats.compacted ?? 0) + rows.length,
    summaryRows: Number(stats.summaryRows ?? 0) + addedSummaries, payloadBytes: Number(stats.payloadBytes) + payloadDelta });
  const next = await ctx.db.events.withIndex('by_at', q => q.lt('at', utcStart())).first();
  return { compacted: rows.length, more: Boolean(next) };
}
