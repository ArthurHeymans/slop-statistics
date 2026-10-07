import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Collector, loadConfig } from '../collector/index.js';
import { extractUsage } from '../shared/usage.js';

/** No resources are opened until session_start. Never contact model providers. */
export default function (pi: ExtensionAPI) {
  let collector: Collector | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let context: ExtensionContext | undefined;
  let starting: Promise<void> | undefined;

  const notice = (ctx: ExtensionContext, message: string, level: 'info' | 'warning' | 'error' = 'info') => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };
  const capture = async (ctx: ExtensionContext) => {
    if (!collector) return;
    // Capturing entries also covers ephemeral sessions. Nothing but usage leaves
    // this process. Persistent sessions are scanned for summaries and child runs.
    const header = { id: ctx.sessionManager.getSessionId(), title: ctx.sessionManager.getSessionName() };
    const project = await collector.project(ctx.cwd);
    const insert = collector.db.prepare('INSERT OR IGNORE INTO events(id,payload) VALUES(?,?)');
    for (const entry of ctx.sessionManager.getEntries()) {
      const event = extractUsage(entry, header, project, collector.config);
      if (event && (collector.config.backfill || event.at >= collector.config.enrolledAt)) insert.run(event.id, JSON.stringify(event));
    }
  };
  const sync = async (ctx: ExtensionContext, history = false, drain = false) => {
    if (!collector) return;
    await collector.serial(() => capture(ctx));
    return collector.sync({ currentFile: ctx.sessionManager.getSessionFile(), history, drain });
  };

  pi.on('session_start', async (_event, ctx) => {
    context = ctx;
    if (starting) await starting;
    if (collector) return;
    starting = (async () => {
      try {
        collector = await Collector.open(await loadConfig());
        timer = setInterval(() => { if (context) void sync(context).catch(() => {}); }, collector.config.intervalSeconds * 1000);
        timer.unref();
        // Startup collection/upload is detached: network must not delay coding.
        void sync(ctx).catch(() => {});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') notice(ctx, `Slop Statistics: ${(error as Error).message}`, 'warning');
      }
    })();
    await starting; starting = undefined;
  });
  pi.on('agent_end', async (_event, ctx) => {
    context = ctx;
    if (collector) void collector.serial(() => capture(ctx)).catch(() => {});
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    if (timer) clearInterval(timer); timer = undefined;
    const active = collector;
    if (!active) return;
    try { await sync(ctx); } catch { /* Pending events stay on disk. */ }
    await active.close(); collector = undefined; context = undefined;
  });
  pi.registerCommand('slop-status', {
    description: 'Show usage collector status (no prompts or code are uploaded)',
    handler: async (_args, ctx) => {
      if (!collector) return notice(ctx, 'Slop Statistics is not configured. Initialize it with the collector CLI.', 'warning');
      const status = collector.status();
      notice(ctx, `${collector.config.machineName}: ${status.collected} records, ${status.pending} queued. Last sync: ${status.lastSync || 'never'}.${status.error ? ` ${status.error}` : ''}`);
    }
  });
  pi.registerCommand('slop-sync', {
    description: 'Upload queued Pi usage metadata now',
    handler: async (_args, ctx) => {
      if (!collector) return notice(ctx, 'Initialize the Slop Statistics collector first.', 'warning');
      try { const result = await sync(ctx, false, true); notice(ctx, `Uploaded ${result?.uploaded || 0} records.`); }
      catch (error) { notice(ctx, `Sync failed; queued locally: ${(error as Error).message}`, 'warning'); }
    }
  });
  pi.registerCommand('slop-import', {
    description: 'Import and upload historical Pi usage (metadata only, deduplicated)',
    handler: async (_args, ctx) => {
      if (!collector) return notice(ctx, 'Initialize the Slop Statistics collector first.', 'warning');
      try { const result = await sync(ctx, true, true); notice(ctx, `History import complete: ${result?.uploaded || 0} uploaded, ${result?.collected || 0} collected.`); }
      catch (error) { notice(ctx, `Import/upload failed; queued locally: ${(error as Error).message}`, 'warning'); }
    }
  });
}
