import { extractUsage } from '../shared/usage.js';
export const usage = { input:100, output:20, cacheRead:50, cacheWrite:10, totalTokens:180, cost:{total:0.02} };
export const entry = (id='call1', at='2026-01-01T12:00:00.000Z') => ({ type:'message', id, timestamp:at, message:{ role:'assistant', provider:'openai-codex', model:'gpt-example', stopReason:'stop', timestamp:Date.parse(at), usage, content:[{type:'text',text:'PRIVATE CONVERSATION'}] } });
export const event = (id='call1', project='github.com/user/repo',at='2026-01-01T12:00:00.000Z') => extractUsage(entry(id,at),{id:'session1'},{key:project,name:project.split('/').at(-1)},{billingRules:[{provider:'openai-codex',billing:'subscription'}]});
