import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { hash, normalizeRemote } from '../shared/usage.js';

const run = promisify(execFile);
async function command(cwd, binary, args) {
  try { return (await run(binary, args, { cwd, timeout: 2000, maxBuffer: 128_000 })).stdout.trim(); }
  catch { return null; }
}

export async function resolveProject(cwd, machineId, aliases = {}) {
  if (aliases[cwd]) return { key: aliases[cwd], name: aliases[cwd].split('/').at(-1) };
  // Use jj natively when available; all repository operations are read-only.
  const jjRoot = await command(cwd, 'jj', ['--ignore-working-copy', 'root']);
  const root = jjRoot || await command(cwd, 'git', ['rev-parse', '--show-toplevel']);
  const dir = root || cwd;
  let identity = dir, remote;
  if (jjRoot) {
    const remotes = (await command(dir, 'jj', ['--ignore-working-copy', 'git', 'remote', 'list']) || '').split('\n').map(line => line.match(/^(\S+)\s+(.+)$/)).filter(Boolean);
    remote = (remotes.find(r => r[1] === 'origin') || remotes[0])?.[2];
    // A jj workspace's .jj/repo can be a file pointing at the shared repo.
    let repo = join(dir, '.jj/repo');
    try {
      if ((await lstat(repo)).isFile()) repo = resolve(dirname(repo), (await readFile(repo, 'utf8')).trim());
      repo = await realpath(repo);
      const store = join(repo, 'store');
      try { identity = resolve(store, (await readFile(join(store, 'git_target'), 'utf8')).trim()); }
      catch { identity = repo; }
    } catch { /* Keep the checkout identity for unavailable historical repos. */ }
  } else {
    const common = await command(dir, 'git', ['rev-parse', '--git-common-dir']);
    if (common) identity = resolve(dir, common);
    remote = await command(dir, 'git', ['remote', 'get-url', 'origin']);
    if (!remote) {
      const first = (await command(dir, 'git', ['remote']) || '').split('\n')[0];
      if (first) remote = await command(dir, 'git', ['remote', 'get-url', first]);
    }
  }
  const canonical = normalizeRemote(remote);
  if (canonical) return { key: canonical, name: canonical.split('/').at(-1).slice(0,120) };
  try { identity = await realpath(identity); } catch { /* Deleted historical checkout. */ }
  return { key: `local:${machineId}:${hash(identity).slice(0, 20)}`, name: basename(dir).replace(/[\x00-\x1f]/g, '').slice(0,120) || 'Unassigned' };
}
