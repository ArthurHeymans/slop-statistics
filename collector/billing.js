import { readFile } from 'node:fs/promises';

/** Read credential types only. Never resolve key commands or upload credentials. */
export async function readBillingDefaults(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
    return Object.fromEntries(Object.entries(data).flatMap(([provider, credential]) => {
      if (credential?.type === 'oauth') return [[provider, 'subscription']];
      if (credential?.type === 'api_key') return [[provider, 'api']];
      return [];
    }).slice(0, 40));
  } catch { return undefined; } // Missing/unreadable auth must not erase a known profile.
}
