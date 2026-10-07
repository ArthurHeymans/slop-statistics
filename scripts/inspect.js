import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

try {
  const root = new URL('../', import.meta.url);
  const binding = JSON.parse(await readFile(new URL('capsule/lakebed.json', root), 'utf8'));
  if (typeof binding.deployId !== 'string' || !/^dep_[A-Za-z0-9_-]+$/.test(binding.deployId)) throw new Error('Invalid Lakebed deployment binding.');
  const cli = fileURLToPath(new URL('node_modules/lakebed/bin/lakebed.js', root));
  const result = spawnSync(process.execPath, [cli, 'inspect', binding.deployId, ...process.argv.slice(2)],
    { cwd: fileURLToPath(new URL('capsule/', root)), stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (e) { console.error(e.message); process.exitCode = 1; }
