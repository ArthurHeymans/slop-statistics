import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

if (existsSync('capsule/.env.lakebed.server')) {
  console.log('Lakebed secrets already exist; leaving them unchanged.');
} else {
  await mkdir('.local', { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('hex');
  const token = 'slop_' + randomBytes(32).toString('base64url');
  await writeFile('capsule/.env.lakebed.server', `OWNER_SETUP_KEY=${key}\nBOOTSTRAP_UPLOAD_TOKEN=${token}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile('.local/owner-setup-key', key + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile('.local/upload-token', token + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Created private Lakebed secrets and .local/owner-setup-key (0600).');
}
