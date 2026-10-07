import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAuthContext } from 'lakebed/server';
import { StateCell } from 'lakebed/runtime';
import app from '../capsule/server/index.ts';

export const signedIn = (id = 'owner') => createAuthContext({ provider: 'google', userId: id, isAuthenticated: true });
export const guest = () => createAuthContext({ provider: 'guest', userId: 'guest:test' });
export function fixture(options = {}) {
  const state = new StateCell(app.schema, options);
  const env = { OWNER_SETUP_KEY: 'setup-secret', BOOTSTRAP_UPLOAD_TOKEN: 'slop_' + 'a'.repeat(43) };
  const log = { info() {}, warn() {}, error() {} };
  const context = (db, auth) => ({ db, env, log, auth });
  return {
    state, env,
    mutate: (name, args = [], auth = signedIn()) => state.transaction(db => app.mutations[name](context(db, auth), ...args)).then(r => r.result),
    query: (name, args = [], auth = signedIn()) => state.read(db => app.queries[name](context(db, auth), ...args)),
    ingest: (body, token = env.BOOTSTRAP_UPLOAD_TOKEN) => state.transaction(db => app.endpoints.ingest.handler(context(db, createAuthContext(null)), {
      headers: new Headers({ authorization: 'Bearer ' + token }), text: async () => JSON.stringify(body)
    })).then(r => ({ status: r.result.status, ...JSON.parse(r.result.body) })),
    maintain: (machineId = 'laptop', token = env.BOOTSTRAP_UPLOAD_TOKEN) => state.transaction(db => app.endpoints.maintenance.handler(context(db, createAuthContext(null)), {
      headers: new Headers({ authorization: 'Bearer ' + token }), text: async () => JSON.stringify({ machineId })
    })).then(r => ({ status: r.result.status, ...JSON.parse(r.result.body) })),
    count: () => state.read(async db => (await db.stats.withIndex('by_creation').first())?.calls ?? 0)
  };
}
export async function httpFixture(t, { maintenance = false } = {}) {
  const lakebed = fixture();
  const server = createServer(async (req, res) => {
    if ((req.url !== '/api/ingest' && !(maintenance && req.url === '/api/maintenance')) || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const result = req.url === '/api/maintenance' ? await lakebed.maintain(body.machineId, req.headers.authorization?.slice(7)) :
        await lakebed.ingest(body, req.headers.authorization?.slice(7));
      res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { ...lakebed, server, origin: `http://127.0.0.1:${server.address().port}`, token: lakebed.env.BOOTSTRAP_UPLOAD_TOKEN };
}
