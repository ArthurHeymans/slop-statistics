import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProject } from '../collector/project.js';

const exec=promisify(execFile);
async function fixture(t) { const dir=await mkdtemp(join(tmpdir(),'slop-vcs-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir; }
async function git(cwd,args) {
  let jj=false;try{await exec('jj',['root'],{cwd});jj=true;}catch{}
  if(jj)throw new Error('Refusing a Git mutation in a jj fixture.');
  return exec('git',args,{cwd});
}
test('Git linked worktrees share remote and local repository identities',async t=>{
  const dir=await fixture(t),main=join(dir,'main'),work=join(dir,'work');await mkdir(main);
  await git(main,['init']);await git(main,['-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','Fixture']);
  await git(main,['worktree','add','-b','work',work]);
  const localMain=await resolveProject(main,'machine'),localWork=await resolveProject(work,'machine');assert.equal(localMain.key,localWork.key);
  await git(main,['remote','add','origin','git@github.com:Example/Repo.git']);
  assert.equal((await resolveProject(main,'one')).key,(await resolveProject(work,'two')).key);
});
test('jj workspaces share remote and local identity without invoking Git',async t=>{
  const dir=await fixture(t),main=join(dir,'main'),work=join(dir,'work');
  await exec('jj',['git','init','--colocate',main],{cwd:dir});
  await exec('jj',['workspace','add',work],{cwd:main});
  assert.equal((await resolveProject(main,'machine')).key,(await resolveProject(work,'machine')).key);
  await exec('jj',['git','remote','add','origin','https://github.com/example/repo.git'],{cwd:main});
  assert.equal((await resolveProject(main,'one')).key,'github.com/example/repo');
  assert.equal((await resolveProject(work,'two')).key,'github.com/example/repo');
});
test('explicit aliases cover historical or missing checkouts',async()=>{
  assert.equal((await resolveProject('/nonexistent/checkout','machine',{'/nonexistent/checkout':'github.com/example/repo'})).key,'github.com/example/repo');
});
