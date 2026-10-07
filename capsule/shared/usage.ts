export type Billing = 'api' | 'subscription' | 'local' | 'unknown';
export type UsageEvent = {
  id: string; at: string; kind: string; provider: string; model: string; billing: Billing;
  input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null;
  total: number | null; cost: number | null; costSource: 'pi' | 'configured' | 'unknown';
  project: { key: string; name: string }; sessionId: string; title?: string | null; billingExplicit?: boolean;
};
export type StoredEvent = UsageEvent & { machine: string; machineName: string; count?: number };
export const eventCount = (e: { count?: number }) => e.count ?? 1;
export const MAX_BATCH = 40;
export const billingTypes: Billing[] = ['api', 'subscription', 'local', 'unknown'];
export const validText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\ud800-\udfff]/u.test(value);

export function validateBillingDefaults(value: unknown): Record<string, Billing> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 40) throw new Error('Invalid billing defaults.');
  const result: Record<string, Billing> = {};
  for (const [provider, billing] of Object.entries(value)) {
    if (!validText(provider, 100) || !billingTypes.includes(billing as Billing)) throw new Error('Invalid billing default.');
    Object.defineProperty(result, provider, { value: billing, enumerable: true });
  }
  return result;
}
export function validateBatch(value: unknown): { machine: { id: string; name: string }; events: UsageEvent[]; billingDefaults?: Record<string, Billing> } {
  const body = value as { machine?: { id?: unknown; name?: unknown }; events?: unknown; billingDefaults?: unknown } | null;
  if (!body || !validText(body.machine?.id, 100) || !validText(body.machine?.name, 120) ||
      !Array.isArray(body.events) || body.events.length > MAX_BATCH) throw new Error(`Invalid batch (maximum ${MAX_BATCH} events).`);
  const billingDefaults = body.billingDefaults === undefined ? undefined : validateBillingDefaults(body.billingDefaults);
  const events = body.events.map((value: unknown): UsageEvent => {
    const e = value as UsageEvent | null;
    if (!e || !/^[a-f0-9]{64}$/.test(e.id) || !validText(e.at, 40) || !Number.isFinite(Date.parse(e.at)) ||
        new Date(e.at).toISOString() !== e.at || !validText(e.project?.key, 400) || !validText(e.project?.name, 120) ||
        !validText(e.sessionId, 200) || !validText(e.provider, 100) || !validText(e.model, 200) || !validText(e.kind, 100) ||
        !billingTypes.includes(e.billing) || !['pi', 'configured', 'unknown'].includes(e.costSource)) throw new Error('Invalid usage event.');
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
      const count = e[key];
      if (count !== null && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 1e12)) throw new Error('Invalid token count.');
    }
    if (e.cost !== null && (typeof e.cost !== 'number' || !Number.isFinite(e.cost) || e.cost < 0 || e.cost > 1e6)) throw new Error('Invalid cost.');
    if (e.title != null && !validText(e.title, 256)) throw new Error('Invalid title.');
    if (e.billingExplicit !== undefined && typeof e.billingExplicit !== 'boolean') throw new Error('Invalid billing source.');
    if ('count' in e) throw new Error('Collectors cannot upload summaries.');
    // Explicit allowlist: never persist extra fields, prompts, source paths, or messages.
    return { id: e.id, at: e.at, project: { key: e.project.key, name: e.project.name }, sessionId: e.sessionId,
      provider: e.provider, model: e.model, kind: e.kind, billing: e.billing, input: e.input, output: e.output,
      cacheRead: e.cacheRead, cacheWrite: e.cacheWrite, total: e.total, cost: e.cost, costSource: e.costSource, title: e.title ?? null, billingExplicit: e.billingExplicit ?? false };
  });
  return { machine: { id: body.machine.id, name: body.machine.name }, events, ...(billingDefaults !== undefined ? { billingDefaults } : {}) };
}

// Positional JSON keeps Lakebed's small free database useful without losing precision.
export function pack(e: StoredEvent): string {
  return JSON.stringify([e.id, e.at, e.machine, e.machineName, e.project.key, e.project.name, e.sessionId,
    e.provider, e.model, e.kind, e.billing, e.input, e.output, e.cacheRead, e.cacheWrite, e.total, e.cost, e.costSource, e.title ?? null, e.billingExplicit ?? false, e.count ?? null]);
}
export function unpack(data: string): StoredEvent {
  let values;
  try { values = JSON.parse(data); }
  catch { throw new Error('Stored usage payload is corrupt.'); }
  const [id, at, machine, machineName, projectKey, projectName, sessionId, provider, model, kind, billing,
    input, output, cacheRead, cacheWrite, total, cost, costSource, title, billingExplicit, count] = values;
  return { id, at, machine, machineName, project: { key: projectKey, name: projectName }, sessionId, provider,
    model, kind, billing, input, output, cacheRead, cacheWrite, total, cost, costSource, title, billingExplicit: billingExplicit ?? false, ...(count == null ? {} : { count }) };
}

export type Settings = {
  aliases: Record<string, string>;
  billingRules: { provider: string; model: string; billing: Billing }[];
  subscriptions: { label: string; month: string; amount: number }[];
};
export const emptySettings = (): Settings => ({ aliases: {}, billingRules: [], subscriptions: [] });
export function validateSettings(value: Settings): Settings {
  if (!value || !value.aliases || Array.isArray(value.aliases) || typeof value.aliases !== 'object' ||
      Object.keys(value.aliases).length > 100 || !Array.isArray(value.billingRules) || value.billingRules.length > 100 ||
      !Array.isArray(value.subscriptions) || value.subscriptions.length > 120) throw new Error('Invalid settings.');
  const aliases: Record<string, string> = {};
  for (const [source, target] of Object.entries(value.aliases)) {
    if (!validText(source, 400) || !validText(target, 400) || source === target) throw new Error('Invalid project alias.');
    const seen = new Set([source]);
    let next = target;
    for (const _key of Object.keys(value.aliases)) {
      if (!Object.hasOwn(value.aliases, next)) break;
      if (seen.has(next)) throw new Error('Project alias cycle.');
      seen.add(next); next = value.aliases[next];
    }
    if (seen.has(next)) throw new Error('Project alias cycle.');
    Object.defineProperty(aliases, source, { value: next, enumerable: true });
  }
  const billingRules = value.billingRules.map(r => {
    if (!r || !validText(r.provider, 100) || typeof r.model !== 'string' || (r.model && !validText(r.model, 200)) ||
        !billingTypes.includes(r.billing)) throw new Error('Invalid billing rule.');
    return { provider: r.provider, model: r.model, billing: r.billing };
  });
  const subscriptions = value.subscriptions.map(s => {
    if (!s || !validText(s.label, 120) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s.month) ||
        typeof s.amount !== 'number' || !Number.isFinite(s.amount) || s.amount < 0 || s.amount > 1e6) throw new Error('Invalid subscription.');
    return { label: s.label, month: s.month, amount: s.amount };
  });
  const result = { aliases, billingRules, subscriptions };
  if (JSON.stringify(result).length > 24_000) throw new Error('Settings are too large.');
  return result;
}

export function applyBillingDefaults(e: StoredEvent, defaults: Record<string, Billing>): StoredEvent {
  const inferred = Object.hasOwn(defaults, e.provider) ? defaults[e.provider] : undefined;
  return e.billing === 'unknown' && !e.billingExplicit && inferred ? { ...e, billing: inferred } : e;
}

export function classify(e: StoredEvent, settings: Settings): StoredEvent {
  const rule = settings.billingRules.find(r => r.provider === e.provider && r.model === e.model) ??
    settings.billingRules.find(r => r.provider === e.provider && !r.model);
  const target = Object.hasOwn(settings.aliases, e.project.key) ? settings.aliases[e.project.key] : e.project.key;
  return { ...e, billing: rule?.billing ?? e.billing,
    project: { key: target, name: target === e.project.key ? e.project.name : target.split('/').at(-1) || target } };
}

export const tokenCategories = [
  { key: 'input', label: 'Regular input', description: 'Uncached prompt tokens' },
  { key: 'cacheRead', label: 'Cache reads', description: 'Input reused from the prompt cache' },
  { key: 'cacheWrite', label: 'Cache writes', description: 'Input written to the prompt cache' },
  { key: 'output', label: 'Output', description: 'Generated tokens, including reasoning' }
] as const;
export type TokenCategory = typeof tokenCategories[number]['key'];

export function tokenBreakdown(events: readonly (Pick<UsageEvent, TokenCategory> & { count?: number })[]) {
  const categories = tokenCategories.map(category => {
    const known = events.filter(e => e[category.key] !== null);
    return { ...category, tokens: known.length ? known.reduce((sum, e) => sum + (e[category.key] ?? 0), 0) : null,
      missing: events.filter(e => e[category.key] === null).reduce((sum, e) => sum + eventCount(e), 0) };
  });
  const knownTotal = categories.reduce((sum, category) => sum + (category.tokens ?? 0), 0);
  // This is a token-weighted input share, not the percentage of requests with a cache hit.
  // Exclude partial input records so missing uncached counts cannot inflate the ratio.
  const completeInput = events.filter(e => e.input !== null && e.cacheRead !== null && e.cacheWrite !== null);
  const inputTotal = completeInput.reduce((sum, e) => sum + (e.input ?? 0) + (e.cacheRead ?? 0) + (e.cacheWrite ?? 0), 0);
  const readTotal = completeInput.reduce((sum, e) => sum + (e.cacheRead ?? 0), 0);
  return { categories, knownTotal, cacheReadShare: inputTotal > 0 ? readTotal / inputTotal : null,
    incompleteInput: events.filter(e => e.input === null || e.cacheRead === null || e.cacheWrite === null).reduce((sum, e) => sum + eventCount(e), 0),
    incompleteRecords: events.filter(e => tokenCategories.some(category => e[category.key] === null)).reduce((sum, e) => sum + eventCount(e), 0) };
}

export function metrics(events: StoredEvent[]) {
  const sum = (key: 'total' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cost') => events.reduce((s, e) => s + (e[key] ?? 0), 0);
  return { calls: events.reduce((s, e) => s + eventCount(e), 0), tokens: sum('total'), input: sum('input'), output: sum('output'),
    cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), value: sum('cost'),
    apiSpend: events.filter(e => e.billing === 'api').reduce((s, e) => s + (e.cost ?? 0), 0),
    subscriptionValue: events.filter(e => e.billing === 'subscription').reduce((s, e) => s + (e.cost ?? 0), 0),
    unknownBillingValue: events.filter(e => e.billing === 'unknown').reduce((s, e) => s + (e.cost ?? 0), 0),
    unpriced: events.filter(e => e.cost === null).reduce((s, e) => s + eventCount(e), 0), unknownTokens: events.filter(e => e.total === null).reduce((s, e) => s + eventCount(e), 0),
    unknownBilling: events.filter(e => e.billing === 'unknown').reduce((s, e) => s + eventCount(e), 0),
    sessions: new Set(events.map(e => JSON.stringify([e.machine, e.sessionId]))).size };
}
export function group(events: StoredEvent[], key: (e: StoredEvent) => string, label = key) {
  const buckets = new Map<string, StoredEvent[]>();
  for (const e of events) { const k = key(e); const rows = buckets.get(k) ?? []; rows.push(e); buckets.set(k, rows); }
  return [...buckets].map(([key, rows]) => ({ key, name: label(rows[0]), ...metrics(rows) }))
    .sort((a, b) => b.tokens - a.tokens);
}
