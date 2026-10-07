import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage, normalizeRemote, normalizeUsage } from '../shared/usage.js';

export const usage = { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, reasoning: 15, totalTokens: 180, cost: { total: 0.02 } };
export const entry = (id='call1', at='2026-01-01T12:00:00.000Z') => ({ type:'message', id, timestamp:at, message:{ role:'assistant', provider:'openai-codex', model:'gpt-example', stopReason:'stop', timestamp:Date.parse(at), usage, content:[{type:'text',text:'SECRET SOURCE CODE'}] } });
const header = { id:'session1',cwd:'/secret/path' }, project = { key:'github.com/user/repo',name:'repo' };

test('tokens are disjoint; reasoning is not double-counted',()=>{
  assert.equal(normalizeUsage(usage).total,180);
  assert.equal(normalizeUsage({...usage,totalTokens:undefined}).total,180);
});
test('missing usage and catalog-zero prices remain unknown',()=>{
  assert.equal(normalizeUsage(null).total,null);
  assert.equal(normalizeUsage({...usage,cost:{total:0}}).cost,null);
  assert.equal(normalizeUsage({...usage,cost:{total:0}},undefined,'local').cost,0);
});
test('configured rates include cache reads and writes',()=>{
  const result=normalizeUsage(usage,{input:1,output:2,cacheRead:0.1,cacheWrite:1.25});
  assert.ok(Math.abs(result.cost-0.0001575)<1e-12); assert.equal(result.costSource,'configured');
});
test('fork and clone copies have stable identifiers across sessions and machines',()=>{
  const first=extractUsage(entry(),header,project,{});
  const copy=extractUsage(entry(),{id:'forked-session'},{key:'another',name:'another'},{});
  assert.equal(first.id,copy.id);
  assert.notEqual(first.id,extractUsage(entry('different'),header,project,{}).id);
});
test('metadata excludes prompts, paths, content, and tool output',()=>{
  const result=extractUsage(entry(),header,project,{});
  const json=JSON.stringify(result);
  assert.ok(!json.includes('SECRET'));assert.ok(!json.includes('/secret'));assert.equal(result.title,null);
});
test('exact billing rules win; titles are opt-in and bounded',()=>{
  const config={billingRules:[{provider:'openai-codex',billing:'api'},{provider:'openai-codex',model:'gpt-example',billing:'subscription'}],sendSessionTitles:true};
  const result=extractUsage(entry(),{...header,title:'A\nB'},project,config);
  assert.equal(result.billing,'subscription');assert.equal(result.title,'AB');
});
test('compaction without usage is explicitly unknown, never inferred from selected model',()=>{
  const result=extractUsage({type:'compaction',id:'summary',timestamp:'2026-01-01T00:00:00Z',summary:'secret'},header,project,{});
  assert.equal(result.total,null);assert.equal(result.model,'unknown');assert.equal(result.cost,null);
});
test('usage entries with unknown kinds and nested tools are retained',()=>{
  assert.equal(extractUsage({type:'usage',id:'u1',timestamp:'2026-01-01',kind:'future_operation',provider:'p',model:'m',usage},header,project,{}).kind,'future_operation');
  assert.equal(extractUsage({type:'message',id:'t1',timestamp:'2026-01-01',message:{role:'toolResult',usage,content:'secret'}},header,project,{}).provider,'unknown');
});
test('pending and non-usage messages are ignored',()=>{
  const e=entry();e.message.stopReason='pending';assert.equal(extractUsage(e,header,project,{}),null);
  assert.equal(extractUsage({type:'message',message:{role:'user',content:'secret'}},header,project,{}),null);
});
test('SSH and HTTPS remotes normalize without credentials',()=>{
  assert.equal(normalizeRemote('git@github.com:User/Repo.git'),'github.com/user/repo');
  assert.equal(normalizeRemote('https://user:secret@github.com/User/Repo.git?token=secret'),'github.com/user/repo');
  assert.equal(normalizeRemote('/some/local/path'),null);
  assert.equal(normalizeRemote('ssh://person@review.example.org:29418/project'),'review.example.org:29418/project');
});
