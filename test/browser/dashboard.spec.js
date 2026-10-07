import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fixture, guest, signedIn } from '../lakebed-helpers.js';
import { event } from '../fixtures.js';

let bundle;
async function startApp() {
  bundle ??= build({ stdin: { contents: 'import {h,render} from "preact"; import {App} from "./capsule/client/index.tsx"; render(h(App,{}),document.getElementById("app"));', resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact', alias: { 'lakebed/client': resolve('test/browser/transport.tsx') } });
  const js = (await bundle).outputFiles[0].text;
  const backend = fixture(); await backend.mutate('claim', ['setup-secret']);
  for (let i = 0; i < 7; i++) {
    const events = Array.from({ length: Math.min(40, 260 - i * 40) }, (_, j) => {
      const id = i * 40 + j, project = id % 2 ? 'github.com/user/alpha' : 'github.com/user/beta';
      const e = { ...event('call' + id, project, new Date(Date.now() - id * 1000).toISOString()), billing: 'unknown', billingExplicit: false };
      if (id === 0) e.model = '<img src=x onerror=alert(1)>';
      return e;
    });
    await backend.ingest({ machine: { id: 'laptop', name: 'Laptop' }, events });
  }
  const eventRequests = [];
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/rpc') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const { kind, name, args } = JSON.parse(Buffer.concat(chunks).toString());
        if (kind === 'query' && name === 'events') eventRequests.push(args[0].pagination);
        const user = String(req.headers['x-test-user'] ?? 'owner');
        const auth = user === 'signed-out' ? guest() : signedIn(user);
        const result = kind === 'query' ? await backend.query(name, args, auth) : await backend.mutate(name, args, auth);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result ?? null)); return;
      }
      if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); return; }
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>');
    } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  });
  return { server, backend, eventRequests };
}
let server, backend, eventRequests;
test.beforeEach(async ({ page }) => {
  ({ server, backend, eventRequests } = await startApp());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.getByText('Live · Lakebed free', { exact: true })).toBeVisible();
});
test.afterEach(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });

test('all views show complete totals in one large page; session details and XSS-safe labels render', async ({ page }) => {
  expect(eventRequests).toEqual([{ cursor: null, numItems: 900 }]);
  await expect(page.locator('.kpis')).toContainText('260 records');
  await expect(page.locator('.kpis')).toContainText('46.8K');
  for (const view of ['Projects', 'Models', 'Machines', 'Sessions']) {
    await page.getByRole('link', { name: view, exact: true }).click();
    await expect(page.locator('h1')).toBeVisible(); await expect(page.locator('tbody tr').first()).toBeVisible();
  }
  await page.locator('tbody button.link').first().click();
  await expect(page.getByRole('heading', { name: 'Session calls' })).toBeVisible();
  await expect(page.locator('.details')).toContainText('<img src=x onerror=alert(1)>');
  expect(await page.locator('img').count()).toBe(0);
  await page.getByLabel('Project', { exact: true }).selectOption('github.com/user/alpha');
  await expect(page.locator('.kpis')).toContainText('130 records');
});
test('money values include subscription, API and unclassified usage without requiring billing setup', async ({ page }) => {
  const value = page.locator('.kpi').filter({ hasText: 'Estimated usage value' }).locator('.value');
  await expect(value).toHaveText('$5.20');
  await backend.ingest({ machine: { id: 'laptop', name: 'Laptop' }, events: [], billingDefaults: { 'openai-codex': 'subscription' } });
  await page.evaluate(() => window.dispatchEvent(new Event('refresh')));
  await expect(value).toHaveText('$5.20');
  const at = new Date().toISOString();
  await backend.ingest({ machine: { id: 'laptop', name: 'Laptop' }, events: [
    { ...event('api-paid', 'github.com/user/alpha', at), billing: 'api' },
    { ...event('unclassified-value', 'github.com/user/alpha', at), billing: 'unknown' }
  ] });
  await page.evaluate(() => window.dispatchEvent(new Event('refresh')));
  await expect(value).toHaveText('$5.24');
  await expect(page.locator('.kpis')).toContainText('262 records');
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Estimated value', exact: true })).toBeVisible();
  await expect(page.locator('tbody tr').first()).toContainText('$5.22');
  await page.getByRole('button', { name: 'Show money', exact: true }).click();
  await expect(page.locator('tbody tr').first().locator('td').nth(1)).toHaveText('$5.22');
});
test('missing prices stay unknown in the unified value card and comparison tables', async ({ page }) => {
  await backend.ingest({ machine: { id: 'laptop', name: 'Laptop' }, events: [
    { ...event('missing-price', 'unpriced', new Date().toISOString()), cost: null, costSource: 'unknown' }
  ] });
  await page.evaluate(() => window.dispatchEvent(new Event('refresh')));
  await page.getByLabel('Project', { exact: true }).selectOption('unpriced');
  await expect(page.locator('.kpi').filter({ hasText: 'Estimated usage value' }).locator('.value')).toHaveText('Unknown');
  await page.getByRole('button', { name: 'Show money', exact: true }).click();
  await expect(page.getByText('No known prices for these records.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page.locator('tbody tr').first().locator('td').nth(1)).toHaveText('Unknown');
});
test('overview shows exact token categories, input-only cache share, model details and stacked history', async ({ page }) => {
  const panel = name => page.locator('section.panel').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const tokens = panel('Detailed token breakdown');
  const category = name => tokens.locator('.token-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(category('Regular input').locator('.token-count')).toHaveText('26,000');
  await expect(category('Cache reads').locator('.token-count')).toHaveText('13,000');
  await expect(category('Cache writes').locator('.token-count')).toHaveText('2,600');
  await expect(category('Output').locator('.token-count')).toHaveText('5,200');
  await expect(tokens).toContainText('Cache-read share of input: 31.25%');
  await expect(panel('Tokens by model').locator('tbody tr')).toHaveCount(2);
  await expect(panel('Tokens by model').getByRole('cell', { name: '46,620', exact: true })).toBeVisible();
  await expect(panel('Usage over time').locator('.token-legend')).toContainText('Cache reads');
  const cacheWrites = await panel('Usage over time').locator('svg title').filter({ hasText: 'Cache writes' }).allTextContents();
  expect(cacheWrites.reduce((sum, title) => sum + Number(title.split(': ').at(-1).replaceAll(',', '')), 0)).toBe(2600);
  await page.getByLabel('Project', { exact: true }).selectOption('github.com/user/alpha');
  await expect(category('Regular input').locator('.token-count')).toHaveText('13,000');
  await expect(category('Cache reads').locator('.token-count')).toHaveText('6,500');
  await expect(panel('Tokens by model').locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Show money', exact: true }).click();
  await expect(category('Cache reads').locator('.token-count')).toHaveText('6,500');
  await expect(panel('Usage over time').locator('.token-legend')).toHaveCount(0);
});
test('settings save real capsule mutations: aliases, billing, fees and revocable credentials', async ({ page }) => {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const panel = name => page.locator('section.panel').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const billing = panel('Billing classification');
  await billing.getByLabel('Provider', { exact: true }).fill('openai-codex');
  await billing.getByLabel('Billing', { exact: true }).selectOption('api'); await billing.getByRole('button', { name: 'Save rule' }).click();
  await expect(billing).toContainText('openai-codex/* → api');
  const aliases = panel('Repository aliases');
  await aliases.getByLabel('Source identity').fill('github.com/user/beta');
  await aliases.getByLabel('Canonical identity').fill('github.com/user/alpha'); await aliases.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(aliases).toContainText('github.com/user/beta → github.com/user/alpha');
  const fees = panel('Subscription fees');
  await fees.getByLabel('Subscription', { exact: true }).fill('ChatGPT'); await fees.getByLabel('UTC month').fill('2026-10');
  await fees.getByLabel('USD/month').fill('20'); await fees.getByRole('button', { name: 'Add fee' }).click();
  await expect(fees).toContainText('2026-10 · ChatGPT · $20.00');
  const machines = panel('Connect a machine');
  await machines.getByLabel('Machine label').fill('Workstation'); await machines.getByRole('button', { name: 'Create credential' }).click();
  await expect(machines.locator('pre')).toContainText('slop_');
  await machines.getByRole('button', { name: 'Hide credential' }).click();
  await expect(machines.locator('pre')).toHaveCount(0);
  await machines.locator('p').filter({ hasText: 'Workstation' }).getByRole('button', { name: 'Revoke' }).click();
  await expect(machines).toContainText('Workstation · not enrolled · revoked');
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('.kpi').filter({ hasText: 'Estimated usage value' }).locator('.value')).toHaveText('$5.20');
});
test('reload shows a complete cached snapshot while refreshing, then replaces it and clears on logout', async ({ page }) => {
  const cachedKeys = () => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('slop-statistics:history:')).length);
  await expect.poll(cachedKeys).toBe(1);
  await backend.ingest({ machine: { id: 'laptop', name: 'Laptop' }, events: [event('new-after-cache', 'github.com/user/alpha', new Date().toISOString())] });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/rpc', async route => {
    if (route.request().postDataJSON()?.name === 'events') await pending;
    await route.continue();
  });
  try {
    await page.reload();
    await expect(page.getByText('Cached · refreshing…', { exact: true })).toBeVisible();
    await expect(page.locator('.kpis')).toContainText('260 records');
    await expect(page.getByRole('button', { name: 'Export hosted metadata' })).toBeDisabled();
    release();
    await expect(page.getByText('Live · Lakebed free', { exact: true })).toBeVisible();
    await expect(page.locator('.kpis')).toContainText('261 records');
    await expect(page.getByRole('button', { name: 'Export hosted metadata' })).toBeEnabled();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    expect(await cachedKeys()).toBe(0);
  } finally { release(); await page.unroute('**/rpc'); }
});
test('a different account cannot display the previous owner’s browser cache', async ({ page }) => {
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('slop-statistics:history:')))).toBe(true);
  await page.evaluate(() => sessionStorage.setItem('test-auth-user', 'attacker'));
  await page.reload();
  await expect(page.getByText('This dashboard is private to its owner.', { exact: false })).toBeVisible();
  await expect(page.locator('.kpis')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('slop-statistics:history:')))).toBe(false);
});
test('older calls compact automatically without changing totals; session detail and cache show weighted summaries', async ({ page }) => {
  const day = new Date(Date.parse(new Date().toISOString().slice(0, 10)) - 86400000).toISOString();
  await backend.ingest({ machine:{id:'laptop',name:'Laptop'}, events:Array.from({length:40}, (_,i) => event('archive-' + i, 'github.com/user/alpha', day)) });
  await page.evaluate(() => window.dispatchEvent(new Event('refresh')));
  await expect.poll(async () => (await backend.query('metadata')).compacted).toBe(40);
  await expect(page.getByText('Live · Lakebed free', {exact:true})).toBeVisible();
  await expect(page.locator('.kpis')).toContainText('300 records');
  await expect(page.locator('.kpis')).toContainText('$6.00');
  await expect(page.getByText(/40 older calls are represented by 1 daily summaries/)).toBeVisible();
  await page.getByRole('link', {name:'Sessions',exact:true}).click();
  await page.locator('.panel tbody .link').first().click();
  await expect(page.locator('.details')).toContainText('Daily summary · 40 calls');
  await page.reload();
  await expect(page.getByText('Live · Lakebed free', {exact:true})).toBeVisible();
  await expect(page.locator('.kpis')).toContainText('300 records');
});
test('mobile layout fits and filter navigation remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('.token-count').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Provider', { exact: true }).selectOption('openai-codex');
  await expect(page.locator('.kpis')).toContainText('260 records');
});
