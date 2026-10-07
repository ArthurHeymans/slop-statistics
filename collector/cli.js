import { Collector, defaultConfigPath, initConfig, loadConfig } from './index.js';

const args = process.argv.slice(2);
const argument = (name) => args[args.indexOf(name)+1];
try {
  const path = args.includes('--config') ? argument('--config') : defaultConfigPath();
  if (args[0] === 'init') {
    const url = args.includes('--url') ? argument('--url') : null;
    const token = process.env.SLOP_TOKEN;
    if (!url || !token) throw new Error('Usage: SLOP_TOKEN=slop_... npm run collector -- init --url https://usage.example.com [--config path]');
    await initConfig(url,token,path);
    console.log(`Collector initialized at ${path}. Install this directory with pi install /absolute/path/to/slop-statistics.`);
  } else {
    const collector = await Collector.open(await loadConfig(path));
    try {
      if (args[0] === 'status') console.log(JSON.stringify(collector.status(),null,2));
      else if (args[0] === 'sync' || args[0] === 'import') console.log(JSON.stringify(await collector.sync({ history: args[0] === 'import', drain: true }),null,2));
      else throw new Error('Commands: init, status, sync, import. Optional: --config path.');
    } finally { await collector.close(); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
