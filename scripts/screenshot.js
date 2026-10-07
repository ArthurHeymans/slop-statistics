// Render documentation with synthetic data only, never a hosted/private account.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { fixture } from '../test/lakebed-helpers.js';

const backend = fixture();
await backend.mutate('claim', ['setup-secret']);
const secondToken = 'slop_' + 'b'.repeat(43);
await backend.mutate('addToken', ['Demo laptop', secondToken]);
const models = [
  { provider: 'openai-codex', model: 'gpt-5.4', rates: [2.5, 15, .25, 0] },
  { provider: 'anthropic', model: 'claude-opus-4-6', rates: [5, 25, .5, 6.25] },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', rates: [3, 15, .3, 3.75] }
];
const projects = ['compiler', 'web-client', 'cli-tools'];
const today = Date.parse(new Date().toISOString().slice(0, 10));
for (const [index, name] of ['Workstation', 'Laptop'].entries()) {
  const machine = { id: 'demo-' + index, name };
  const events = Array.from({ length: 168 }, (_, i) => {
    const { provider, model, rates } = models[(i + index) % models.length];
    const project = projects[(Math.floor(i / 3) + index) % projects.length];
    const day = Math.floor(i / 12);
    const input = 1400 + (i * 97 % 2400), output = 350 + (i * 43 % 1700);
    const cacheRead = 48000 + (i * 1237 % 18000), cacheWrite = provider === 'anthropic' ? 4400 + (i * 29 % 800) : 0;
    const cost = [input, output, cacheRead, cacheWrite].reduce((sum, count, j) => sum + count * rates[j], 0) / 1e6;
    return { id: createHash('sha256').update(`${index}:${i}`).digest('hex'),
      at: new Date(today - day * 86400000 + (9 + i % 12) * 3600000).toISOString(),
      kind: 'message', provider, model, billing: 'subscription', billingExplicit: false,
      input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite,
      cost: Number(cost.toFixed(6)), costSource: 'configured',
      project: { key: 'github.com/example/' + project, name: project }, sessionId: `demo-${index}-${day}-${project}` };
  });
  for (let i = 0; i < events.length; i += 40) {
    const receipt = await backend.ingest({ machine, events: events.slice(i, i + 40) }, index ? secondToken : backend.env.BOOTSTRAP_UPLOAD_TOKEN);
    if (receipt.status !== 200) throw new Error('Demo ingestion failed.');
  }
}
const bundle = await build({
  stdin: { contents: 'import {h,render} from "preact"; import {App} from "./capsule/client/index.tsx"; render(h(App,{}),document.getElementById("app"));', resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact',
  alias: { 'lakebed/client': resolve('test/browser/transport.tsx') }
});
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/rpc' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const { kind, name, args } = JSON.parse(Buffer.concat(chunks).toString());
      if (kind !== 'query') throw new Error('The screenshot server is read-only.');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await backend.query(name, args))); return;
    }
    if (req.url === '/app.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>');
  } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('Live · Lakebed free', { exact: true }).waitFor();
  await page.getByLabel('Period', { exact: true }).selectOption('all');
  await page.locator('.account').evaluate(account => { account.firstChild.textContent = 'Demo workspace'; });
  await page.getByRole('heading', { name: 'Top repositories', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const timeline = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Usage over time', exact: true }) });
  const bounds = await timeline.boundingBox();
  if (!bounds) throw new Error('Timeline did not render.');
  await page.setViewportSize({ width: 1440, height: Math.ceil(bounds.y + bounds.height + 18) });
  await mkdir('docs', { recursive: true });
  await page.screenshot({ path: 'docs/screenshot.png', animations: 'disabled' });
  console.log('Saved docs/screenshot.png (synthetic demo data).');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
