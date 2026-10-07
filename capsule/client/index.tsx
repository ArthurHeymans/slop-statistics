import { createClient, Link, Router, SignInWithGoogle, retryAuth, signOut, useAuth, useLocation } from 'lakebed/client';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type app from '../server/index.ts';
import { billingTypes, classify, group, metrics, tokenBreakdown, tokenCategories, type Settings, type StoredEvent } from '../shared/usage.ts';
import styles from './style.ts';
import { clearHistoryCache, readHistoryCache, writeHistoryCache, type HistorySnapshot } from './history-cache.ts';

async function leaveAccount() { clearHistoryCache(); await signOut(); }

const client = createClient<typeof app>();
const integer = (n: number) => new Intl.NumberFormat('en-US').format(n);
const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n && n < 1 ? 3 : 2 }).format(n);
const errorMessage = (e: unknown) => e instanceof Error ? e.message : 'Request failed.';
const views = ['overview', 'projects', 'models', 'machines', 'sessions', 'settings'] as const;
const headings: Record<string, [string, string]> = {
  overview: ['Your usage, at a glance.', 'Follow the tokens. Understand their value.'],
  projects: ['Where the work happens.', 'Checkouts and worktrees, grouped by repository.'],
  models: ['The models behind the work.', 'Usage, estimated value, and cache activity.'],
  machines: ['One workspace. Many machines.', 'Your agent activity across computers.'],
  sessions: ['A closer look at the work.', 'Model calls without conversations or source code.'],
  settings: ['Your workspace, your rules.', 'Collector credentials, repository aliases, and billing.']
};
function Panel({ title, copy, children }: { title: string; copy?: string; children: ComponentChildren }) {
  return <section className="panel"><div className="panel-heading"><h2>{title}</h2>{copy && <p>{copy}</p>}</div>{children}</section>;
}
function Login({ children }: { children: ComponentChildren }) {
  return <div className="login"><section className="login-card"><div className="mark">π</div><p className="eyebrow">SLOP STATISTICS</p><h1>Your agent usage.<br />In one place.</h1>{children}</section></div>;
}
function AccountGate() {
  const auth = useAuth();
  const access = client.useQuery('access');
  const claim = client.useMutation('claim');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (access && access.userId === auth.userId && !access.allowed) clearHistoryCache(); }, [access, auth.userId]);
  if (!access || access.userId !== auth.userId) return <Login><p>Checking dashboard access…</p></Login>;
  if (access.allowed) return <Dashboard key={auth.userId ?? ''} />;
  return <Login>{access.configured ? <p>This dashboard is private to its owner. You are signed in with a different account.</p> : <>
    <p>Bind this private dashboard to your Google account with the setup key in <code>.local/owner-setup-key</code>. Nobody can claim it without that key.</p>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try { await claim(key); setKey(''); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
    }}><label>Owner setup key<input type="password" required value={key} onInput={e => setKey(e.currentTarget.value)} autoComplete="off" /></label>
      <button className="primary" disabled={busy}>Bind my account</button></form>
  </>}{error && <p role="alert">{error}</p>}<button onClick={() => void leaveAccount()}>Sign out</button></Login>;
}
export function App() {
  const auth = useAuth();
  useEffect(() => { if (!auth.isLoading && (!auth.isSignedIn || auth.error)) clearHistoryCache(); }, [auth.isLoading, auth.isSignedIn, auth.error]);
  return <><style>{styles}</style><Router>{auth.isLoading ? <Login><p>Checking session…</p></Login> :
    auth.isSignedIn && !auth.error ? <AccountGate /> : <Login><p>A private dashboard for Pi tokens and estimated usage value. Lakebed provides Google sign-in; no OAuth credentials are needed.</p>
      {auth.error && <p role="alert">{auth.error}</p>}<SignInWithGoogle className="primary" />
      {auth.error && <button onClick={() => void retryAuth()}>Retry</button>}
    </Login>}</Router></>;
}

type Group = ReturnType<typeof group>[number];
function usageValue(usage: Pick<Group, 'calls' | 'unpriced' | 'value'>) {
  if (!usage.calls) return '—';
  return usage.unpriced === usage.calls ? 'Unknown' : money(usage.value);
}
function UsageTable({ rows, title, copy, metric, onSelect }: { rows: Group[]; title: string; copy?: string;
  metric: string; onSelect?: (key: string) => void }) {
  return <Panel title={title} copy={copy}>{rows.length ? <div className="table-wrap"><table><thead><tr>
    <th>Name</th><th className="numeric">{metric === 'tokens' ? 'Tokens' : 'Estimated value'}</th>
    <th className="numeric">{metric === 'tokens' ? 'Estimated value' : 'Tokens'}</th><th className="numeric">Sessions</th><th className="numeric">Unpriced</th>
  </tr></thead><tbody>{rows.map(row => <tr key={row.key}><td>{onSelect ? <button className="link" onClick={() => onSelect(row.key)}>{row.name}</button> : row.name}
    <span className="subtext">{row.key}</span></td><td className="numeric">{metric === 'tokens' ? compact(row.tokens) : usageValue(row)}</td>
    <td className="numeric">{metric === 'tokens' ? usageValue(row) : compact(row.tokens)}</td><td className="numeric">{integer(row.sessions)}</td><td className="numeric">{integer(row.unpriced)}</td></tr>)}</tbody></table></div> :
    <div className="empty">No records match. Connect a machine in Settings or adjust the filters.</div>}</Panel>;
}
const tokenColors = { input: '#7161d7', cacheRead: '#36856a', cacheWrite: '#72b5c4', output: '#b17a32' };
const percentage = (ratio: number | null) => ratio === null ? '—' : new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 }).format(ratio);
function TokenLegend() {
  return <div className="token-legend">{tokenCategories.map(c => <span key={c.key}><i style={{ background: tokenColors[c.key] }} aria-hidden="true" />{c.label}</span>)}</div>;
}
function TokenOverview({ events }: { events: StoredEvent[] }) {
  const breakdown = tokenBreakdown(events);
  const models = group(events, e => JSON.stringify([e.provider, e.model]), e => `${e.model} · ${e.provider}`)
    .map(model => ({ ...model, breakdown: tokenBreakdown(events.filter(e => JSON.stringify([e.provider, e.model]) === model.key)) }));
  return <>
    <Panel title="Detailed token breakdown" copy="Regular input, cache reads, cache writes and output are disjoint. Reasoning is already included in output.">
      <div className="panel-body">
        <div className="token-cards">{breakdown.categories.map(c => <article className="token-card" key={c.key}>
          <h3><i style={{ background: tokenColors[c.key] }} aria-hidden="true" />{c.label}</h3>
          <div className="token-count">{c.tokens === null ? 'Unknown' : integer(c.tokens)}</div>
          <p>{c.description}</p><small>{breakdown.knownTotal && c.tokens !== null ? `${percentage(c.tokens / breakdown.knownTotal)} of known category tokens` : 'No recorded tokens'}</small>
          {c.missing > 0 && <p className="token-missing">Not recorded on {integer(c.missing)} records</p>}
        </article>)}</div>
        {breakdown.knownTotal > 0 && <div className="token-composition" role="img" aria-label={breakdown.categories.map(c => `${c.label}: ${c.tokens === null ? 'unknown' : integer(c.tokens)}`).join(', ')}>
          {breakdown.categories.map(c => <span key={c.key} style={{ width: `${(c.tokens ?? 0) / breakdown.knownTotal * 100}%`, background: tokenColors[c.key] }}
            title={`${c.label}: ${integer(c.tokens ?? 0)}`} aria-hidden="true" />)}</div>}
        <p className="cache-share"><strong>Cache-read share of input: {percentage(breakdown.cacheReadShare)}</strong><br />
          <small>Cache reads ÷ (regular input + cache reads + cache writes). Output is excluded; this is a token share, not a request hit rate.</small></p>
        {breakdown.incompleteRecords > 0 && <p className="muted">{integer(breakdown.incompleteRecords)} records have an incomplete breakdown. Missing counts are unknown, not zero.
          {breakdown.incompleteInput > 0 && ` Cache-read share excludes ${integer(breakdown.incompleteInput)} records with incomplete input counts.`}</p>}
      </div>
    </Panel>
    <Panel title="Tokens by model" copy="Exact category counts for the selected period and filters; provider names distinguish similarly named models.">
      {models.length ? <div className="table-wrap"><table><thead><tr><th>Model / provider</th>{tokenCategories.map(c => <th className="numeric" key={c.key}>{c.label}</th>)}
        <th className="numeric">Known category total</th><th className="numeric">Cache-read share of input</th></tr></thead>
        <tbody>{models.map(model => <tr key={model.key}><td>{model.name}</td>{model.breakdown.categories.map(c => <td className="numeric" key={c.key}>
          {c.tokens === null ? 'Unknown' : integer(c.tokens)}{c.missing > 0 && <span className="subtext">{integer(c.missing)} unrecorded</span>}</td>)}
          <td className="numeric">{integer(model.breakdown.knownTotal)}</td><td className="numeric">{percentage(model.breakdown.cacheReadShare)}
            {model.breakdown.incompleteInput > 0 && <span className="subtext">{integer(model.breakdown.incompleteInput)} partial records excluded</span>}</td></tr>)}</tbody></table></div> :
        <div className="empty">No token records match these filters.</div>}
    </Panel>
  </>;
}
function Timeline({ events, metric }: { events: StoredEvent[]; metric: string }) {
  const days = group(events, e => e.at.slice(0, 10)).sort((a, b) => a.key.localeCompare(b.key));
  const first = days[0], last = days.at(-1);
  const span = first && last ? Math.floor((Date.parse(last.key) - Date.parse(first.key)) / 86400000) + 1 : 0;
  const step = Math.max(1, Math.ceil(span / 60));
  const buckets = Array.from({ length: Math.ceil(span / step) }, (_, i) => {
    const start = Date.parse(first.key) + i * step * 86400000;
    const rows = days.filter(d => Date.parse(d.key) >= start && Date.parse(d.key) < start + step * 86400000);
    const sum = rows.reduce((s, d) => ({ input: s.input + d.input, cacheRead: s.cacheRead + d.cacheRead,
      cacheWrite: s.cacheWrite + d.cacheWrite, output: s.output + d.output, value: s.value + d.value }),
      { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, value: 0 });
    return { ...sum, day: new Date(start).toISOString().slice(0, 10), amount: metric === 'tokens' ? sum.input + sum.cacheRead + sum.cacheWrite + sum.output : sum.value };
  });
  const max = Math.max(1, ...buckets.map(d => d.amount));
  const width = 800, plot = 710, barWidth = plot / Math.max(1, buckets.length);
  return <Panel title="Usage over time" copy={`${metric === 'tokens' ? 'Known token categories, stacked' : 'Known estimated usage value'} · UTC`}>
    {buckets.length && (metric === 'tokens' || events.some(e => e.cost !== null)) ? <div className="panel-body">{metric === 'tokens' && <TokenLegend />}<svg className="chart" viewBox={`0 0 ${width} 220`} role="img" aria-label="Usage over time">
      {[0, .25, .5, .75, 1].map(f => <g key={f}><line className="grid" x1="70" y1={180 - 150 * f} x2="790" y2={180 - 150 * f} />
        <text x="60" y={184 - 150 * f} textAnchor="end">{metric === 'tokens' ? compact(max * f) : money(max * f)}</text></g>)}
      {buckets.map((d, i) => <g key={d.day}>{metric === 'tokens' ? tokenCategories.map((c, index) => {
        const below = tokenCategories.slice(0, index).reduce((sum, previous) => sum + d[previous.key], 0);
        return <rect key={c.key} fill={tokenColors[c.key]} x={70 + i * barWidth + barWidth * .18} y={180 - 150 * (below + d[c.key]) / max}
          width={barWidth * .64} height={150 * d[c.key] / max}><title>{d.day} · {c.label}: {integer(d[c.key])}</title></rect>;
      }) : <rect className="bar" x={70 + i * barWidth + barWidth * .18} y={180 - 150 * d.amount / max}
        width={barWidth * .64} height={150 * d.amount / max} rx="3"><title>{d.day}: {money(d.amount)}</title></rect>}
        {i % Math.max(1, Math.ceil(buckets.length / 7)) === 0 && <text x={70 + (i + .5) * barWidth} y="208" textAnchor="middle">{d.day.slice(5)}</text>}</g>)}
    </svg></div> : <div className="empty">{buckets.length ? 'No known prices for these records.' : 'Your timeline starts when a collector sends its first record.'}</div>}</Panel>;
}
function Dashboard() {
  const auth = useAuth();
  const location = useLocation();
  const view = views.find(v => location.pathname === '/' + v) ?? 'overview';
  const metadata = client.useQuery('metadata');
  const records = client.usePaginatedQuery('events', {}, { initialNumItems: 900 });
  const [snapshot, setSnapshot] = useState<HistorySnapshot | undefined>(() => readHistoryCache(auth.userId));
  const incomplete = !metadata || !records.isDone || records.page.length !== metadata.calls;
  const usingCache = incomplete && Boolean(snapshot);
  const sourceEvents = usingCache ? snapshot!.events : records.page;
  const settings = metadata?.settings ?? snapshot?.settings;
  useEffect(() => { if (records.continueCursor && !records.isDone) records.loadMore(); }, [records.continueCursor, records.isDone]);
  useEffect(() => {
    if (incomplete || !metadata) return;
    // The SDK combines pages into a new array each render; only save a changed snapshot.
    if (snapshot?.settings === metadata.settings && snapshot.events.length === records.page.length &&
        snapshot.events.every((event, i) => event === records.page[i])) return;
    const complete = { events: records.page, settings: metadata.settings, savedAt: Date.now() };
    setSnapshot(complete);
    writeHistoryCache(auth.userId, complete);
  }, [incomplete, records.page, metadata, auth.userId, snapshot]);
  const [metric, setMetric] = useState('tokens');
  const [period, setPeriod] = useState('30');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selectedSession, setSelectedSession] = useState('');
  const events = useMemo(() => settings ? sourceEvents.map(e => classify(e, settings)) : [], [sourceEvents, settings]);
  const filtered = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const from = period === 'all' ? '' : period === 'month' ? today.slice(0, 7) + '-01' : new Date(Date.parse(today) - (Number(period) - 1) * 86400000).toISOString().slice(0, 10);
    return events.filter(e => (!from || e.at >= from) && (!filters.from || e.at.slice(0, 10) >= filters.from) &&
      (!filters.to || e.at.slice(0, 10) <= filters.to) && (!filters.project || e.project.key === filters.project) &&
      (!filters.model || JSON.stringify([e.provider, e.model]) === filters.model) && (!filters.provider || e.provider === filters.provider) &&
      (!filters.machine || e.machine === filters.machine) && (!filters.billing || e.billing === filters.billing));
  }, [events, period, filters]);
  const summary = metrics(filtered);
  const breakdown = tokenBreakdown(filtered);
  const rank = (rows: Group[]) => metric === 'tokens' ? rows : rows.toSorted((a, b) => b.value - a.value);
  const projects = rank(group(filtered, e => e.project.key, e => e.project.name));
  const models = rank(group(filtered, e => JSON.stringify([e.provider, e.model]), e => `${e.model} · ${e.provider}`));
  const machines = rank(group(filtered, e => e.machine, e => e.machineName));
  const sessionKey = (e: StoredEvent) => JSON.stringify([e.machine, e.sessionId]);
  const sessions = rank(group(filtered, sessionKey, e => e.title || `${e.project.name} · ${e.sessionId}`));
  const select = (key: string, value: string) => setFilters(previous => ({ ...previous, [key]: value }));
  const options: Record<string, [string, string][]> = {
    project: group(events, e => e.project.key, e => e.project.name).map(e => [e.key, e.name]),
    model: group(events, e => JSON.stringify([e.provider, e.model]), e => `${e.model} · ${e.provider}`).map(e => [e.key, e.name]),
    provider: [...new Set(events.map(e => e.provider))].sort().map(e => [e, e]),
    machine: group(events, e => e.machine, e => e.machineName).map(e => [e.key, e.name]),
    billing: billingTypes.map(e => [e, e])
  };
  function exportData() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ events: records.page, settings: metadata?.settings }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'slop-statistics.json'; link.click(); URL.revokeObjectURL(url);
  }
  const detail = filtered.filter(e => sessionKey(e) === selectedSession);
  return <><aside><div className="brand"><span className="mark">π</span><span>slop statistics<br /><small>PI USAGE WORKSPACE</small></span></div>
    <nav aria-label="Dashboard">{views.map(v => <Link key={v} to={'/' + v} className={view === v ? 'active' : ''}>{v[0].toUpperCase() + v.slice(1)}</Link>)}</nav>
    <div className="account">{auth.displayName}<button onClick={() => void leaveAccount()}>Sign out</button><p><small>Metadata only. Conversations stay local.</small></p></div></aside>
    <main className="dashboard"><header className="topbar"><span>Workspace / {view}</span><span>{incomplete ? (usingCache ? 'Cached · refreshing…' : 'Loading complete history…') : 'Live · Lakebed free'}</span></header>
      <div className="content"><div className="heading"><div><p className="eyebrow">YOUR PI WORKSPACE</p><h1>{headings[view][0]}</h1><p>{headings[view][1]}</p></div>
        <button onClick={() => setMetric(metric === 'tokens' ? 'value' : 'tokens')}>{metric === 'tokens' ? 'Show money' : 'Show tokens'}</button></div>
      {incomplete && <div className="note" role="status">{usingCache ? <>
        Showing cached totals from {new Date(snapshot!.savedAt).toLocaleString()}; refreshing in the background. These are not live totals yet.
      </> : <>Loading {integer(records.page.length)} of {integer(metadata?.calls ?? 0)} records. Totals below are partial until loading finishes.</>}</div>}
      {view === 'settings' ? metadata && <SettingsPage metadata={metadata} /> : <>
        <div className="filters"><label>Period<select aria-label="Period" value={period} onChange={e => setPeriod(e.currentTarget.value)}>
          <option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="month">This month</option><option value="all">All time / custom</option></select></label>
          {Object.entries(options).map(([key, values]) => <label key={key}>{key[0].toUpperCase() + key.slice(1)}<select aria-label={key[0].toUpperCase() + key.slice(1)} value={filters[key] || ''} onChange={e => select(key, e.currentTarget.value)}>
            <option value="">All</option>{values.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>)}
          <label>From (UTC)<input type="date" value={filters.from || ''} onInput={e => { setPeriod('all'); select('from', e.currentTarget.value); }} /></label>
          <label>Through (UTC)<input type="date" value={filters.to || ''} onInput={e => { setPeriod('all'); select('to', e.currentTarget.value); }} /></label>
          <button onClick={() => { setFilters({}); setPeriod('30'); }}>Reset</button></div>
        <section className="kpis" aria-label="Usage summary">{[
          ['Total tokens', compact(summary.tokens), `${integer(summary.calls)} records · ${summary.sessions} sessions`],
          ['Estimated usage value', usageValue(summary), 'At API rates · includes subscription usage'],
          ['Cache-read share', percentage(breakdown.cacheReadShare), 'Share of input tokens · output excluded'],
          ['Pricing coverage', summary.calls ? `${Math.round((1 - summary.unpriced / summary.calls) * 100)}%` : '—', `${summary.unpriced} records with unknown prices`]
        ].map(([label, value, copy]) => <article className="kpi" key={label}><small>{label}</small><div className="value">{value}</div><small>{copy}</small></article>)}</section>
        <div className="note">Estimated value is the USD valuation of usage at API rates—not a bill. It includes API, subscription, and unclassified usage alike. Missing prices stay unknown; partial totals include only known prices. Actual subscription fees are recorded separately in Settings.</div>
        {view === 'overview' && <><TokenOverview events={filtered} /><Timeline events={filtered} metric={metric} /><div className="two-columns">
          <UsageTable rows={projects.slice(0, 8)} title="Top repositories" metric={metric} onSelect={k => select('project', k)} />
          <UsageTable rows={models.slice(0, 8)} title="Top models" metric={metric} onSelect={k => select('model', k)} /></div>
          <Panel title="Projects × models" copy="Top repositories and models"><div className="table-wrap"><table><thead><tr><th>Repository</th>{models.slice(0, 6).map(m => <th key={m.key}>{m.name}</th>)}</tr></thead>
            <tbody>{projects.slice(0, 12).map(p => <tr key={p.key}><td>{p.name}</td>{models.slice(0, 6).map(m => {
              const cell = metrics(filtered.filter(e => e.project.key === p.key && JSON.stringify([e.provider, e.model]) === m.key));
              return <td key={m.key}>{cell.calls ? <span className="heat">{metric === 'tokens' ? compact(cell.tokens) : usageValue(cell)}</span> : '—'}</td>;
            })}</tr>)}</tbody></table></div></Panel></>}
        {view === 'projects' && <UsageTable rows={projects} title="Repositories" metric={metric} onSelect={k => select('project', k)} />}
        {view === 'models' && <UsageTable rows={models} title="Models and providers" metric={metric} onSelect={k => select('model', k)} />}
        {view === 'machines' && <UsageTable rows={machines} title="Machines" metric={metric} onSelect={k => select('machine', k)} />}
        {view === 'sessions' && <><UsageTable rows={sessions} title="Sessions" metric={metric} onSelect={setSelectedSession} />
          {selectedSession && <section className="details"><h2>Session calls</h2><button onClick={() => setSelectedSession('')}>Close details</button><div className="table-wrap"><table><thead><tr><th>UTC time</th><th>Model</th><th>Kind</th><th>Tokens</th><th>Estimated value</th><th>Billing</th></tr></thead>
            <tbody>{detail.map(e => <tr key={e.id}><td>{e.at.replace('T', ' ').slice(0, 19)}</td><td>{e.model}<span className="subtext">{e.provider}</span></td><td>{e.kind}</td><td>{e.total === null ? 'Unknown' : integer(e.total)}</td><td>{e.cost === null ? 'Unknown' : money(e.cost)}</td><td>{e.billing}</td></tr>)}</tbody></table></div></section>}</>}
      </>}
      <button onClick={exportData} disabled={incomplete}>Export hosted metadata</button><footer>Pi usage metadata · private Lakebed capsule · conversations stay on your machines</footer></div>
    </main></>;
}

type Metadata = NonNullable<ReturnType<typeof client.useQuery<'metadata'>>>;
function SettingsPage({ metadata }: { metadata: Metadata }) {
  const saveSettings = client.useMutation('settings');
  const addToken = client.useMutation('addToken');
  const revoke = client.useMutation('revokeToken');
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    setError(''); setBusy(true);
    try { await fn(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function submit(event: SubmitEvent, update: (s: Settings, data: FormData) => Settings) {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    await run(async () => { await saveSettings(update(metadata.settings, data)); form.reset(); });
  }
  const text = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
  return <>{error && <div className="note error" role="alert">{error}</div>}
    <div className="note">Free plan: 1 MiB database, 1,000 mutations/day, 10,000 requests/day. Nothing is silently pruned. When storage fills, uploads roll back and stay queued locally. {integer(metadata.calls)} hosted records · {compact(metadata.payloadBytes)} characters of packed payload (not total database bytes). Export regularly; inspect exact usage with <code>npm run inspect -- --usage</code>.</div>
    <Panel title="Connect a machine" copy="Each credential is upload-only and binds to its first machine."><div className="panel-body">
      <form className="form" onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const label = text(new FormData(form), 'label');
        void run(async () => {
          const bytes = crypto.getRandomValues(new Uint8Array(32));
          const token = 'slop_' + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
          await addToken(label, token); setSecret(token); form.reset();
        });
      }}><label>Machine label<input name="label" required maxLength={120} /></label><button className="primary" disabled={busy}>Create credential</button></form>
      {secret && <><p>Copy now. This credential is shown only once.</p><pre className="secret">{`SLOP_TOKEN='${secret}' npm run collector -- init --url ${window.location.origin}\npi install ${'/absolute/path/to/slop-statistics'}`}</pre>
        <button onClick={() => setSecret('')}>Hide credential</button></>}
      {metadata.tokens.map(t => <p key={t.id}>{t.label} · {t.machine || 'not enrolled'} · {t.revoked ? 'revoked' : <button disabled={busy} onClick={() => void run(() => revoke(t.id))}>Revoke</button>}</p>)}
    </div></Panel>
    <Panel title="Detected billing by machine" copy="Stored OAuth credentials imply subscription-equivalent usage; stored API keys imply API usage. Only billing types are uploaded, never credentials."><div className="panel-body">
      {metadata.detectedBilling.length ? metadata.detectedBilling.map(machine => <div key={machine.machine}><h3>{machine.name}</h3>
        {Object.entries(machine.defaults).map(([provider, billing]) => <p key={provider}>{provider} → {billing}</p>)}</div>) :
        <p className="muted">No authentication profile has been uploaded. Reload Pi or run the collector sync command.</p>}
      <p className="muted">These defaults fill unclassified historical records on that machine. Explicit classifications and dashboard rules take precedence. Use overrides for flat-rate API-key plans, custom/environment credentials, or history collected with different authentication.</p>
    </div></Panel>
    <Panel title="Billing classification" copy="Exact-model rules override provider-wide rules and detected machine defaults, retroactively. Leave model empty for a provider-wide rule."><div className="panel-body">
      <form className="form" onSubmit={e => void submit(e, (s, data) => {
        const provider = text(data, 'provider'), model = text(data, 'model');
        return { ...s, billingRules: [...s.billingRules.filter(r => r.provider !== provider || r.model !== model), { provider, model, billing: text(data, 'billing') as Settings['billingRules'][number]['billing'] }] };
      })}><label>Provider<input name="provider" required maxLength={100} /></label><label>Model (optional)<input name="model" maxLength={200} /></label>
        <label>Billing<select name="billing" aria-label="Billing">{billingTypes.map(b => <option key={b}>{b}</option>)}</select></label><button disabled={busy}>Save rule</button></form>
      {metadata.settings.billingRules.map((r, i) => <p key={i}>{r.provider}/{r.model || '*'} → {r.billing} <button disabled={busy} onClick={() => void run(() => saveSettings({ ...metadata.settings, billingRules: metadata.settings.billingRules.filter((_, j) => i !== j) }))}>Remove</button></p>)}
    </div></Panel>
    <Panel title="Repository aliases" copy="Merge remotes or local repositories into one project without changing source records."><div className="panel-body">
      <form className="form" onSubmit={e => void submit(e, (s, data) => ({ ...s, aliases: { ...s.aliases, [text(data, 'source')]: text(data, 'target') } }))}>
        <label>Source identity<input name="source" required maxLength={400} /></label><label>Canonical identity<input name="target" required maxLength={400} /></label><button disabled={busy}>Merge</button></form>
      {Object.entries(metadata.settings.aliases).map(([source, target]) => <p key={source}>{source} → {target} <button disabled={busy} onClick={() => void run(() => saveSettings({ ...metadata.settings, aliases: Object.fromEntries(Object.entries(metadata.settings.aliases).filter(([key]) => key !== source)) }))}>Remove</button></p>)}
    </div></Panel>
    <Panel title="Subscription fees" copy="Record actual monthly account fees separately from equivalent token value."><div className="panel-body">
      <form className="form" onSubmit={e => void submit(e, (s, data) => ({ ...s, subscriptions: [...s.subscriptions, { label: text(data, 'label'), month: text(data, 'month'), amount: Number(text(data, 'amount')) }] }))}>
        <label>Subscription<input name="label" required maxLength={120} /></label><label>UTC month<input name="month" type="month" required /></label><label>USD/month<input name="amount" type="number" min="0" max="1000000" step="0.01" required /></label><button disabled={busy}>Add fee</button></form>
      {metadata.settings.subscriptions.map((s, i) => <p key={i}>{s.month} · {s.label} · {money(s.amount)} <button disabled={busy} onClick={() => void run(() => saveSettings({ ...metadata.settings, subscriptions: metadata.settings.subscriptions.filter((_, j) => i !== j) }))}>Remove</button></p>)}
    </div></Panel>
  </>;
}
