import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const hash=text=>createHash('sha256').update(text).digest('hex');
function fixture(version='0.1.1') {
  const dir=mkdtempSync(join(tmpdir(),'arxiv-upgrade-'));
  const old={
    'package.json':JSON.stringify({name:version==='0.1.0'?'arxiv-daily-local':'openclaw-arxiv-daily',version}),
    'openclaw.plugin.json':JSON.stringify({id:'arxiv-daily',version}),
    'src/example.js':'old public source',
  };
  mkdirSync(join(dir,'src'));
  for(const [name,content] of Object.entries(old))writeFileSync(join(dir,name),content);
  const next={...old,'package.json':JSON.stringify({name:'openclaw-arxiv-daily',version:'0.3.1'}),
    'src/example.js':'new source',
    'upgrade-manifests.json':JSON.stringify({[version]:Object.fromEntries(Object.entries(old).map(([n,c])=>[n,hash(c)]))})};
  const payload=Object.entries(next).map(([name,content])=>({name,sha256:hash(content),data:Buffer.from(content).toString('base64')}));
  const template=readFileSync(new URL('../installer-template.cjs',import.meta.url),'utf8');
  const module={exports:{}};
  runInNewContext(template.replace('__ARXIV_PAYLOAD__',JSON.stringify(payload)),{require:createRequire(import.meta.url),module,Buffer,process,console});
  return {dir,check:()=>module.exports.checkUpgrade(dir),next};
}

test('upgrade accepts a clean public installation and an interrupted mix of known old/new files without touching state', t=>{
  for(const version of ['0.1.0','0.1.1','0.2.0','0.3.0']){
    const {dir,check,next}=fixture(version);t.after(()=>rmSync(dir,{recursive:true,force:true}));
    writeFileSync(join(dir,'state.sqlite'),'subscription and delivery fixture');
    check();
    writeFileSync(join(dir,'package.json'),next['package.json']);check();
    writeFileSync(join(dir,'src/example.js'),next['src/example.js']);check();
    assert.equal(readFileSync(join(dir,'state.sqlite'),'utf8'),'subscription and delivery fixture');
  }
});

test('upgrade rejects local edits and a different plugin before changing any files', t=>{
  const {dir,check}=fixture();t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,'src/example.js'),'my manual changes');
  assert.throws(check,/Locally modified plugin file/);
  assert.equal(readFileSync(join(dir,'src/example.js'),'utf8'),'my manual changes');
  writeFileSync(join(dir,'openclaw.plugin.json'),JSON.stringify({id:'unrelated-plugin'}));
  assert.throws(check,/Only a supported/);
});
