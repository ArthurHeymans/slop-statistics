import { createHash } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Pi input/output/cache fields are disjoint; reasoning is already part of output. */
export function normalizeUsage(usage, rates, billing = 'unknown') {
  if (!usage || typeof usage !== 'object') return { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, cost: null, costSource: 'unknown' };
  const input = number(usage.input), output = number(usage.output);
  const cacheRead = number(usage.cacheRead), cacheWrite = number(usage.cacheWrite);
  const fields = { input, output, cacheRead, cacheWrite };
  const total = number(usage.totalTokens) ?? (Object.values(fields).every(v => v !== null) ? input + output + cacheRead + cacheWrite : null);
  const recorded = number(usage.cost?.total);
  // A zero in Pi's catalog often means "unpriced", rather than a free request.
  let cost = recorded !== null && (recorded > 0 || total === 0 || billing === 'local') ? recorded : null;
  let costSource = cost === null ? 'unknown' : 'pi';
  if (rates && Object.entries(fields).every(([key, value]) => value !== null && number(rates[key]) !== null)) {
    cost = Object.entries(fields).reduce((sum, [key, value]) => sum + value * rates[key] / 1_000_000, 0);
    costSource = 'configured';
  }
  return { ...fields, total, cost, costSource };
}

/** No message content is included in the identifier or returned metadata. */
export function extractUsage(entry, header, project, config) {
  const message = entry.message;
  let usage, kind, provider, model;
  if (entry.type === 'message' && message?.role === 'assistant' && message.stopReason !== 'pending') {
    usage = message.usage; kind = 'assistant'; provider = message.provider; model = message.responseModel || message.model;
  } else if (entry.type === 'message' && message?.role === 'toolResult' && message.usage) {
    usage = message.usage; kind = 'tool'; provider = message.provider; model = message.model;
  } else if (entry.type === 'usage' || ['compaction', 'branch_summary'].includes(entry.type)) {
    usage = entry.usage; kind = entry.type === 'usage' ? String(entry.kind || 'other') : entry.type;
    provider = entry.provider || usage?.provider; model = entry.model || usage?.model;
  } else return null;
  provider ||= 'unknown'; model ||= 'unknown';
  const timestamp = message?.timestamp || entry.timestamp;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const at = date.toISOString();
  const rule = config.billingRules?.find(r => r.provider === provider && r.model === model) || config.billingRules?.find(r => r.provider === provider && !r.model);
  const inferred = config.billingDefaults && Object.hasOwn(config.billingDefaults, provider) ? config.billingDefaults[provider] : undefined;
  const billing = rule?.billing || inferred || 'unknown';
  const rates = config.prices?.find(r => r.provider === provider && r.model === model);
  const normalized = normalizeUsage(usage, rates, billing);
  // Forks/clones preserve entry IDs and timestamps. Do not use the new session ID,
  // project, or machine in the key, or copied history would become new spending.
  const id = hash(JSON.stringify([entry.id || header.id, at, kind, provider, model, normalized.input, normalized.output, normalized.cacheRead, normalized.cacheWrite, normalized.total]));
  return { id, at, kind, provider, model, billing, billingExplicit: Boolean(rule), ...normalized, project,
    sessionId: String(header.id), title: config.sendSessionTitles ? String(header.title || '').replace(/[\x00-\x1f]/g, '').slice(0, 256) || null : null };
}

export function normalizeRemote(remote) {
  if (!remote || /[\r\n]/.test(remote)) return null;
  try {
    let url;
    if (/^[\w.-]+@[^:]+:/.test(remote)) {
      const match = remote.match(/^[\w.-]+@([^:]+):(.+)$/);
      url = new URL(`ssh://${match[1]}/${match[2]}`);
    } else url = new URL(remote);
    if (!['ssh:', 'https:', 'http:', 'git:'].includes(url.protocol)) return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    if (!url.hostname || !path) return null;
    // GitHub/GitLab repository paths are case insensitive; custom hosts may not be.
    const normalizedPath = ['github.com', 'gitlab.com'].includes(url.hostname) ? path.toLowerCase() : path;
    return `${url.hostname.toLowerCase()}${url.port ? ':' + url.port : ''}/${normalizedPath}`;
  } catch { return null; }
}
