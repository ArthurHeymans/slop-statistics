import { boolean, capsule, endpoint, json, mutation, number, query, string, table, userId,
  type PaginationOptions } from 'lakebed/server';
import { applyBillingDefaults, emptySettings, pack, unpack, validateBatch, validateBillingDefaults, validateSettings, validText, type Settings } from '../shared/usage.ts';
import { credentialDigest, requireOwner, sameSecret } from './security.ts';

function readDefaults(value: unknown) {
  try { return validateBillingDefaults(JSON.parse(String(value))); }
  catch { throw new Error('Stored machine billing defaults are invalid.'); }
}

export default capsule({
  name: 'Slop Statistics',
  // Upload-only collectors have no Lakebed session. Every browser operation is guarded below.
  auth: { requireSignIn: false },
  schema: {
    owner: table({ subject: userId(), settings: string() }),
    tokens: table({ digest: string(), label: string(), machine: string().default(''), revoked: boolean().default(false) })
      .index('by_digest', ['digest']),
    events: table({ key: string(), at: number(), data: string() }).index('by_key', ['key']).index('by_at', ['at']),
    stats: table({ calls: number(), payloadBytes: number() }),
    machines: table({ key: string(), name: string(), billing: string() }).index('by_key', ['key'])
  },
  queries: {
    access: query(async ctx => {
      const account = ctx.auth.requireSignedIn();
      const owner = await ctx.db.owner.withIndex('by_creation').first();
      return { configured: Boolean(owner), allowed: owner?.subject === account.userId, userId: account.userId };
    }),
    metadata: query(async ctx => {
      const owner = await requireOwner(ctx);
      const rows = await ctx.db.tokens.withIndex('by_creation').take(40);
      const stats = await ctx.db.stats.withIndex('by_creation').first();
      const machines = await ctx.db.machines.withIndex('by_creation').take(40);
      let settings: Settings;
      try { settings = validateSettings(JSON.parse(String(owner.settings))); }
      catch { throw new Error('Stored dashboard settings are invalid.'); }
      return { settings, detectedBilling: machines.map(row => ({ machine: String(row.key), name: String(row.name), defaults: readDefaults(row.billing) })),
        tokens: rows.map(row => ({ id: row.id, label: String(row.label), machine: String(row.machine), revoked: Boolean(row.revoked) })),
        calls: Number(stats?.calls ?? 0), payloadBytes: Number(stats?.payloadBytes ?? 0) };
    }),
    events: query(async (ctx, args: { pagination: PaginationOptions }) => {
      await requireOwner(ctx);
      const pagination = args?.pagination;
      if (!pagination || !Number.isSafeInteger(pagination.numItems) || pagination.numItems < 1 || pagination.numItems > 900) throw new Error('Invalid page size.');
      const machines = await ctx.db.machines.withIndex('by_creation').take(40);
      const defaults = new Map(machines.map(row => [String(row.key), readDefaults(row.billing)]));
      const result = await ctx.db.events.withIndex('by_at').order('desc').paginate(pagination);
      return { ...result, page: result.page.map(row => {
        const event = unpack(String(row.data));
        return applyBillingDefaults(event, defaults.get(event.machine) ?? {});
      }) };
    })
  },
  mutations: {
    claim: mutation(async (ctx, key: string) => {
      const account = ctx.auth.requireSignedIn();
      const expected = ctx.env.OWNER_SETUP_KEY;
      if (!expected || typeof key !== 'string' || !sameSecret(key, expected)) throw new Error('Invalid setup key.');
      if (await ctx.db.owner.withIndex('by_creation').first()) throw new Error('Dashboard already has an owner.');
      await ctx.db.owner.insert({ subject: account.userId, settings: JSON.stringify(emptySettings()) });
    }),
    settings: mutation(async (ctx, settings: Settings) => {
      const owner = await requireOwner(ctx);
      await ctx.db.owner.update(owner.id, { settings: JSON.stringify(validateSettings(settings)) });
    }),
    addToken: mutation(async (ctx, label: string, token: string) => {
      await requireOwner(ctx);
      if (!validText(label, 120) || typeof token !== 'string' || !/^slop_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid credential.');
      if ((await ctx.db.tokens.withIndex('by_creation').count()) >= 40) throw new Error('Maximum 40 credentials.');
      const digest = credentialDigest(token);
      if (await ctx.db.tokens.withIndex('by_digest', q => q.eq('digest', digest)).first()) throw new Error('Credential already exists.');
      await ctx.db.tokens.insert({ label, digest });
    }),
    revokeToken: mutation(async (ctx, id: string) => {
      await requireOwner(ctx);
      const token = await ctx.db.tokens.get(id);
      if (!token) throw new Error('Credential not found.');
      await ctx.db.tokens.update(id, { revoked: true });
    })
  },
  endpoints: {
    health: endpoint({ method: 'GET', path: '/api/health', readOnly: true }, () => json({ ok: true })),
    ingest: endpoint({ method: 'POST', path: '/api/ingest', readOnly: false }, async (ctx, req) => {
      const authorization = req.headers.get('authorization') ?? '';
      const credential = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!/^slop_[A-Za-z0-9_-]{43}$/.test(credential)) return json({ error: 'Unauthorized.' }, { status: 401 });
      const digest = credentialDigest(credential);
      let token = await ctx.db.tokens.withIndex('by_digest', q => q.eq('digest', digest)).first();
      const bootstrap = ctx.env.BOOTSTRAP_UPLOAD_TOKEN;
      if (!token && (!bootstrap || !sameSecret(credential, bootstrap))) return json({ error: 'Unauthorized.' }, { status: 401 });
      if (token?.revoked) return json({ error: 'Credential revoked.' }, { status: 401 });
      let batch;
      try {
        const body = await req.text();
        if (body.length > 128_000) throw new Error('Batch too large.');
        batch = validateBatch(JSON.parse(body));
      } catch { return json({ error: 'Invalid usage batch (maximum 40 events).' }, { status: 400 }); }
      if (token?.machine && token.machine !== batch.machine.id) return json({ error: 'Credential belongs to another machine.' }, { status: 401 });
      if (!token) {
        token = await ctx.db.tokens.insert({ label: 'Bootstrap machine', digest, machine: batch.machine.id });
      } else if (!token.machine) await ctx.db.tokens.update(token.id, { machine: batch.machine.id });
      if (batch.billingDefaults !== undefined) {
        // Upload-only credentials can describe their own machine, not change global rules.
        const machine = await ctx.db.machines.withIndex('by_key', q => q.eq('key', batch.machine.id)).first();
        const billing = JSON.stringify(batch.billingDefaults);
        if (!machine) await ctx.db.machines.insert({ key: batch.machine.id, name: batch.machine.name, billing });
        else if (machine.billing !== billing || machine.name !== batch.machine.name) {
          await ctx.db.machines.update(machine.id, { name: batch.machine.name, billing });
        }
      }
      let inserted = 0, bytes = 0;
      for (const event of batch.events) {
        if (await ctx.db.events.withIndex('by_key', q => q.eq('key', event.id)).first()) continue;
        const data = pack({ ...event, machine: batch.machine.id, machineName: batch.machine.name });
        await ctx.db.events.insert({ key: event.id, at: Date.parse(event.at), data });
        inserted++; bytes += data.length;
      }
      if (inserted) {
        const stats = await ctx.db.stats.withIndex('by_creation').first();
        if (stats) await ctx.db.stats.update(stats.id, { calls: Number(stats.calls) + inserted, payloadBytes: Number(stats.payloadBytes) + bytes });
        else await ctx.db.stats.insert({ calls: inserted, payloadBytes: bytes });
      }
      return json({ accepted: batch.events.length, inserted, ...(batch.billingDefaults !== undefined ? { billingDefaultsApplied: true } : {}) });
    })
  }
});
