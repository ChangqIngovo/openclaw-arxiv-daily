import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync, readdirSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { Store, subscriberKey } from '../src/store.js';
import { resolveConfig, DigestService } from '../src/service.js';
import { initializePersonal } from '../src/personal.js';
import { createInboundHandler } from '../src/commands.js';
import { CredentialVault, loadApp } from '../src/zotero-auth.js';
import { ZoteroService } from '../src/zotero-service.js';
import { ZoteroStore } from '../src/zotero-store.js';
import { ZoteroApi } from '../src/zotero-api.js';
import { prepareZotero, commitZotero, writePrivateJson } from '../src/personal-setup.js';
import { configureModel, availableModels, PROVIDERS } from '../src/setup-model.js';
import { question } from '../src/setup-ui.js';

const now = Date.parse('2026-09-25T00:00:00Z');
const config = resolveConfig({allowedAccountIds:['mine'],ownerPeerId:'owner@im.wechat'});
const quiet = {info(){},warn(){},error(){}};
const context = (account = 'mine',peer = 'owner@im.wechat') => ({channelId:'openclaw-weixin',accountId:account,conversationId:peer});
function temporary(t) { const dir = mkdtempSync(join(tmpdir(),'arxiv-personal-')); t.after(() => rmSync(dir,{recursive:true,force:true})); return dir; }
function installerFunctions() {
  const module = {exports:{}};
  const source = readFileSync(new URL('../installer-template.cjs',import.meta.url),'utf8');
  runInNewContext(source.replace('__ARXIV_PAYLOAD__','[]'),{module,require:createRequire(import.meta.url),process,Buffer,console});
  return module.exports;
}

test('hidden terminal input returns the value without echoing it and restores terminal mode', async () => {
  const input = new PassThrough(), output = new PassThrough(), modes = []; let displayed = '';
  input.isTTY = true; input.setRawMode = value => { modes.push(value); }; output.isTTY = true;
  output.on('data', chunk => { displayed += chunk.toString(); });
  const pending = question('Personal API key','',{hidden:true,input,output});
  input.write('synthetic-secret-123\r');
  assert.equal(await pending,'synthetic-secret-123');
  assert.ok(displayed.includes('Personal API key')); assert.ok(!displayed.includes('synthetic-secret-123'));
  assert.equal(modes.at(-1),false); input.destroy(); output.destroy();
});

test('personal owner is required, one account enforced, same-bot strangers cannot subscribe or inspect', t => {
  assert.throws(() => resolveConfig({allowedAccountIds:['mine']}),/verified peer/);
  assert.throws(() => resolveConfig({allowedAccountIds:['mine','other'],ownerPeerId:'owner@im.wechat'}),/one logged/);
  const store = new Store(':memory:'); t.after(() => store.close());
  const service = {store,config,ready:true,clock:() => now};
  const handle = createInboundHandler(() => service,config,quiet);
  assert.match(handle({content:'/arxiv subscribe'},context('mine','stranger@im.wechat')).text,/只接受/);
  assert.equal(store.subs().length,0);
  assert.match(handle({content:'/arxiv subscribe 21cm, EoR'},context()).text,/建立/);
  assert.match(handle({content:'/arxiv status'},context('mine','stranger@im.wechat')).text,/只接受/);
  handle({content:'/arxiv unsubscribe'},context());
  assert.match(handle({content:'/arxiv subscribe'},context('mine','stranger@im.wechat')).text,/只接受/);
  assert.deepEqual(handle({content:'hello'},context()),{handled:true});
});

test('migration retains old records/preferences but schedules and sends only to the selected owner', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const other = store.addSub({account:'other',peer:'friend@im.wechat',topics:['quantum optics'],language:'en'},now-86400000,50);
  const sameBot = store.addSub({account:'mine',peer:'stranger@im.wechat',topics:['JWST'],language:'en'},now-86400000,50);
  const own = initializePersonal(store,config,now-86400000);
  store.patchSub(own.key,{topics:['EoR','21cm'],language:'en',active:false},now);
  initializePersonal(store,config,now);
  assert.deepEqual(store.sub(own.key).topics,['EoR','21cm']); assert.equal(store.sub(own.key).active,false);
  const service = new DigestService({config,store,clock:() => now,send(){throw new Error('unexpected send');},complete(){throw new Error('unexpected model');},logger:quiet});
  service.schedule(); assert.equal(store.nextRun(now),undefined);
  store.patchSub(own.key,{active:true},now); service.schedule();
  assert.equal(store.nextRun(now).subscriber,own.key);
  for (const user of [other,sameBot]) {
    store.enqueue(user.key,'now',now);
    await service.process(store.latestRun(user.key));
    assert.equal(store.latestRun(user.key).status,'cancelled');
    assert.ok(store.sub(user.key));
  }
});

test('personal Zotero setup identifies the key owner, encrypts only that grant and preserves another old grant', async t => {
  const dir = temporary(t), file = join(dir,'arxiv-daily','zotero-app.json');
  const master = randomBytes(32).toString('base64');
  writePrivateJson(file,{clientKey:'fixture-client',clientSecret:'fixture-secret',callbackUrl:'https://example.org/callback',encryptionKey:master});
  const dbPath = join(dir,'arxiv-daily','state.sqlite'), store = new Store(dbPath);
  const other = store.addSub({account:'old',peer:'old@im.wechat',topics:['physics'],language:'en'},now,50);
  const vault = new CredentialVault(master), db = new ZoteroStore(store), oldCredential = vault.seal(other.key,{apiKey:'old-fixture-key',userId:'222'});
  db.bind(other.key,{userId:'222',username:'old',credential:oldCredential,generation:'old-generation'},now); store.close();
  const requests = [];
  const api = new ZoteroApi({fetchImpl:async (url,options) => {
    requests.push({url,method:options.method});
    assert.equal(options.headers['Zotero-API-Key'],'personal-fixture-key');
    if (url.endsWith('/keys/current')) return new Response(JSON.stringify({userID:111,username:'mine',access:{user:{library:true,notes:true,write:true}}}));
    assert.ok(url.startsWith('https://api.zotero.org/users/111/collections'));
    return new Response(JSON.stringify([{key:'ABCDEFGH',data:{name:'EoR'}}]),{headers:{'Total-Results':'1'}});
  }});
  const prepared = await prepareZotero({stateDir:dir,config,api,ask:async (_label,_fallback,opts) => { assert.equal(opts.hidden,true); return 'personal-fixture-key'; },select:async (_label,rows) => rows[1]});
  assert.equal(loadApp(file).clientKey,'fixture-client');
  assert.ok(requests.every(row => row.method === 'GET'));
  const zconfig = commitZotero(prepared,dir,config,now);
  assert.equal(zconfig.enabled,true); assert.equal(loadApp(file).mode,'personal');
  assert.ok(!readFileSync(file,'utf8').includes('personal-fixture-key'));
  const check = new Store(dbPath);
  try {
  const zdb = new ZoteroStore(check);
  assert.equal(zdb.account(other.key).credential,oldCredential);
  const owner = subscriberKey('mine','owner@im.wechat'), bound = zdb.account(owner);
  assert.equal(vault.open(owner,bound.credential).userId,'111'); assert.equal(bound.target.key,'ABCDEFGH');
  assert.throws(() => vault.open(other.key,bound.credential));
  const zservice = new ZoteroService({store:check,app:loadApp(file),allowedAccountIds:['mine'],ownerPeerId:config.ownerPeerId,send(){throw new Error('no send');},api,logger:quiet});
  assert.equal(zservice.allowed(other.key),false);
  zservice.command(owner,'zotero','disconnect');
  assert.match(zservice.command(owner,'zotero','connect'),/--configure-zotero/);
  assert.equal(zdb.account(owner),undefined); assert.equal(zdb.account(other.key).credential,oldCredential);
  } finally { check.close(); }
});

test('Zotero setup rejects missing permissions and refuses to replace a lost encryption key', async t => {
  const api = new ZoteroApi({fetchImpl:async () => new Response(JSON.stringify({userID:111,access:{user:{library:true,write:false,notes:true}}}))});
  await assert.rejects(api.identify('fixture-key'),/读取、笔记和写入/);
  const dir = temporary(t), store = new Store(join(dir,'arxiv-daily','state.sqlite'));
  const own = initializePersonal(store,config,now), db = new ZoteroStore(store);
  db.bind(own.key,{userId:'111',username:'old',generation:'old',credential:'existing-encrypted-data'},now); store.close();
  await assert.rejects(prepareZotero({stateDir:dir,config,ask(){throw new Error('no prompting yet');}}),/Restore the original/);
});

test('private file writer restricts Windows ACL before writing a secret, and fails without overwriting on ACL rejection', t => {
  const dir = temporary(t), file = join(dir,'credentials.json');
  writeFileSync(file,'original'); let aclChecked = false;
  const run = (cmd,args) => {
    if (cmd === 'whoami.exe') return {status:0,stdout:'"fixture","S-1-5-21-123-456-789-1001"'};
    assert.equal(cmd,'icacls.exe'); assert.equal(readFileSync(args[0],'utf8'),'');
    assert.ok(args.includes('/inheritance:r')); aclChecked = true; return {status:0};
  };
  writePrivateJson(file,{secret:'synthetic'},{platform:'win32',run});
  assert.ok(aclChecked); assert.equal(JSON.parse(readFileSync(file,'utf8')).secret,'synthetic');
  assert.throws(() => writePrivateJson(file,{secret:'replacement'},{platform:'win32',run:(cmd,args) => cmd === 'icacls.exe' ? {status:1} : run(cmd,args)}),/permissions/);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).secret,'synthetic');
  assert.deepEqual(readdirSync(dir),['credentials.json']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777,0o600);
});

test('all four provider entrances use discovered models and configure only the chosen agent', async () => {
  assert.deepEqual(PROVIDERS.filter(p => !['keep','other'].includes(p.id)).map(p => p.id),['openai','anthropic','deepseek','google']);
  for (const provider of ['openai','anthropic','deepseek','google']) {
    const calls = [], model = `${provider}/discovered-fixture-model`;
    const claw = args => {
      calls.push(args);
      if (args[0] === 'models' && args[1] === 'list') return {status:0,stdout:JSON.stringify({models:[{key:model,available:true,input:'text+image'}]})};
      if (args.slice(0,3).join(' ') === 'config get agents.list') return {status:0,stdout:JSON.stringify([{id:'unrelated',model:'other/untouched'},{id:'digest',model:'old/model'}])};
      if (args.slice(0,3).join(' ') === 'config get agents.defaults.models') return {status:0,stdout:'{"old/model":{"alias":"old"}}'};
      return {status:0,stdout:'{}'};
    };
    const chosen = await configureModel({claw,jsonOutput:r => JSON.parse(r.stdout),agentId:'digest',ask:async () => 'y',
      select:async (_label,rows) => rows.find(row => row.id === provider) || rows[0]});
    assert.equal(chosen,model);
    assert.ok(calls.some(args => args.slice(0,7).join(' ') === `models auth login --agent digest --provider ${provider}`));
    assert.ok(calls.some(args => args.includes('--method') && args.at(-1) === (provider === 'openai' ? 'oauth' : 'api-key')));
    const writes = calls.filter(args => args[0] === 'config' && args[1] === 'set' && !args.includes('--dry-run'));
    assert.equal(writes.length,2);
    assert.deepEqual(JSON.parse(writes[1][3]),{primary:model,fallbacks:[]});
    assert.equal(writes[1][2],'agents.list[1].model');
    assert.ok(!calls.some(args => args[0] === 'models' && args[1] === 'set'));
  }
  assert.deepEqual(availableModels({models:[{key:'google/fake',available:false,input:'text'},{key:'openai/other',available:true,input:'text'},{key:'google/image',available:true,input:'image'}]},'google'),[]);
  assert.equal(await configureModel({select:async () => PROVIDERS[0],claw(){throw new Error('keep must not mutate');}}),null);
});

test('installer resolves macOS/npm symlinks and Windows npm layouts, including spaces', t => {
  const dir = temporary(t), {findNodeEntry} = installerFunctions();
  const bin = join(dir,'mac bin'), root = join(dir,'lib','node_modules','openclaw');
  mkdirSync(bin,{recursive:true}); mkdirSync(root,{recursive:true}); writeFileSync(join(root,'openclaw.mjs'),'');
  // Windows symlink creation may need Developer Mode; junction fixture still tests realpath lookup.
  if (process.platform !== 'win32') {
    symlinkSync(join(root,'openclaw.mjs'),join(bin,'openclaw'));
    assert.equal(realpathSync(findNodeEntry('openclaw','openclaw.mjs',{env:{PATH:bin},execPath:join(bin,'node'),platform:'darwin',localState:dir})),realpathSync(join(root,'openclaw.mjs')));
  }
  const win = join(dir,'Program Files','nodejs'), winroot = join(win,'node_modules','openclaw');
  mkdirSync(winroot,{recursive:true}); writeFileSync(join(winroot,'openclaw.mjs'),'');
  assert.equal(findNodeEntry('openclaw','openclaw.mjs',{env:{PATH:win},execPath:join(win,'node.exe'),platform:'win32',localState:dir}),join(winroot,'openclaw.mjs'));
});

test('account discovery exposes only trusted identity, ignores traversal and missing peers; CLI accepts banner plus array JSON', t => {
  const dir = temporary(t), {readWeixinAccounts,jsonOutput} = installerFunctions(), base = join(dir,'openclaw-weixin');
  mkdirSync(join(base,'accounts'),{recursive:true});
  writeFileSync(join(base,'accounts.json'),JSON.stringify(['my-im-bot','missing-peer','../../outside']));
  writeFileSync(join(base,'accounts','my-im-bot.json'),JSON.stringify({token:'never-return-this-token',userId:'owner@im.wechat',baseUrl:'https://example.invalid'}));
  writeFileSync(join(base,'accounts','missing-peer.json'),JSON.stringify({token:'never-return-this-token'}));
  const rows = readWeixinAccounts(dir);
  assert.equal(rows.length,1); assert.equal(rows[0].peer,'owner@im.wechat'); assert.ok(!JSON.stringify(rows).includes('token'));
  assert.equal(jsonOutput({status:0,stdout:'[banner]\n[{"id":"one"}]'}).length,1);
  assert.equal(jsonOutput({status:0,stdout:'banner\n{"plugin":null}'}).plugin,null);
});
