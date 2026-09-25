import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { CredentialVault, oauthSignature, validateApp } from '../src/zotero-auth.js';
import { ZoteroApi, objectKey, itemArxivId } from '../src/zotero-api.js';
import { ZoteroService } from '../src/zotero-service.js';
import { callbackCommand } from '../src/zotero-callback.js';
import { collectionRows, selectCollection, readingNote, deliverySnapshot } from '../src/zotero-library.js';
import { createInboundHandler } from '../src/commands.js';
import { formatPaper } from '../src/summary.js';
import { protectedCredentialCount } from '../src/zotero-setup-check.js';

const now = Date.parse('2026-09-25T01:00:00Z');
const app = {clientKey:'fixture-client-key',clientSecret:'fixture-client-secret',callbackUrl:'https://example.org/zotero-callback.html',encryptionKey:Buffer.alloc(32,7).toString('base64')};
const paper = {id:'2609.12345',version:1,title:'Synthetic <paper> & "title"',abstract:'Original abstract & evidence.',
  authors:['One Author','Another Author'],published:now-86400000,updated:now-86400000,categories:['astro-ph.CO']};
const summary = {status:'ready',gap:'Gap <script>alert(1)</script>',work:'Measured a fixture',method:'Synthetic method',conclusion:'Fixture only',
  source:{format:'HTML',url:'https://arxiv.org/html/2609.12345v1',segments:1}};
const silent = {info(){},warn(){},error(){}};
const json = (data, status=200, headers={}) => new Response(status===204?null:JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const user = (store, number) => store.addSub({account:`account-${number}`,peer:`peer${number}@im.wechat`,topics:['21cm'],language:'zh'},now,50);

function remote() {
  const state = {calls:[],items:new Map(),requests:0,keys:new Map([['key-111','111'],['key-222','222']]),
    folders:new Map([['111',[{key:'AAAAAAA2',data:{key:'AAAAAAA2',name:'EoR',parentCollection:false}}]],['222',[{key:'BBBBBBB2',data:{key:'BBBBBBB2',name:'Physics',parentCollection:false}}]]]),
    hooks:null, failWrite:false, partialOnce:false, timeoutAfterCreate:false, conflictOnce:false, revoked:false};
  const entries = uid => {if (!state.items.has(uid)) state.items.set(uid,new Map());return state.items.get(uid);};
  state.entries=entries;
  state.fetch=async (address, options={}) => {
    const url=new URL(address),headers=options.headers||{},method=options.method||'GET',body=options.body?JSON.parse(options.body):undefined;
    state.calls.push({url:url.href,method,key:headers['Zotero-API-Key'],body,headers});
    const hookResult=await state.hooks?.(url,options,body);if(hookResult)return hookResult;
    if(url.origin==='https://www.zotero.org') {
      assert.equal(method,'POST');assert.match(headers.Authorization,/oauth_signature=/);assert.equal(options.redirect,'error');
      if(url.pathname==='/oauth/request') {
        const token=`temporary-${++state.requests}`;
        return new Response(new URLSearchParams({oauth_token:token,oauth_token_secret:`secret-${token}`,oauth_callback_confirmed:'true'}));
      }
      const fields=Object.fromEntries([...headers.Authorization.matchAll(/(\w+)="([^"]*)"/g)].map(m=>[m[1],decodeURIComponent(m[2])]));
      const uid=fields.oauth_token==='temporary-1'?'111':'222';
      if(fields.oauth_verifier!==`verify-${uid}`)return json({},403);
      return new Response(new URLSearchParams({oauth_token:`key-${uid}`,oauth_token_secret:`key-${uid}`,userID:uid,username:`user-${uid}`}));
    }
    assert.equal(url.origin,'https://api.zotero.org');assert.equal(options.redirect,'error');
    if(url.pathname==='/items/new')return json({itemType:url.searchParams.get('itemType'),title:'',tags:[],collections:[],relations:{}});
    const uid=state.keys.get(headers['Zotero-API-Key']);
    if(!uid||state.revoked)return json({message:'fixture secret must not be returned'},403);
    if(url.pathname==='/keys/current')return json({userID:Number(uid),username:`user-${uid}`,access:{user:{library:true,write:true,notes:true}}});
    assert.ok(url.pathname.startsWith(`/users/${uid}/`),'API key must match the personal library URL');
    const suffix=url.pathname.slice(`/users/${uid}`.length),items=entries(uid),folders=state.folders.get(uid);
    if(suffix==='/collections'){
      const start=Number(url.searchParams.get('start')||0);return json(folders.slice(start,start+100),200,{'Total-Results':String(folders.length)});
    }
    if(suffix.startsWith('/collections/'))return folders.some(row=>row.key===suffix.split('/')[2])?json(folders.find(row=>row.key===suffix.split('/')[2])):json({},404);
    if(suffix==='/items/top')return json([...items.values()].filter(row=>!['note','attachment'].includes(row.data.itemType)),200,{'Total-Results':String([...items.values()].filter(row=>!['note','attachment'].includes(row.data.itemType)).length)});
    if(suffix==='/items'&&method==='POST'){
      const d=body[0];assert.equal(d.version,0,'new writes must be create-only');
      if(state.failWrite)return json({failed:{0:{code:400,message:'fixture write rejected'}},successful:{},unchanged:{}});
      if(items.has(d.key))return json({failed:{0:{code:412}},successful:{},unchanged:{}});
      const saved={key:d.key,version:1,data:{...d,version:1}};items.set(d.key,saved);
      if(state.timeoutAfterCreate){state.timeoutAfterCreate=false;throw new Error('socket timeout after write');}
      if(state.partialOnce){state.partialOnce=false;return json({failed:{0:{code:503}},successful:{},unchanged:{}});}
      return json({successful:{0:saved},failed:{},unchanged:{}});
    }
    const key=suffix.split('/')[2],item=items.get(key);
    if(!item)return json({},404);
    if(method==='PATCH'){
      if(state.conflictOnce){state.conflictOnce=false;item.version++;item.data.version=item.version;item.data.collections.push('CCCCCCC2');return json({},412);}
      if(Number(headers['If-Unmodified-Since-Version'])!==item.version)return json({},412);
      assert.deepEqual(Object.keys(body),['collections']);item.data.collections=[...body.collections];item.version++;item.data.version=item.version;return json(null,204);
    }
    return json(item);
  };
  return state;
}

function fixture(t, file=':memory:') {
  const store=new Store(file),a=user(store,1),b=user(store,2),server=remote(),messages=[];
  const service=new ZoteroService({store,app,allowedAccountIds:['account-1','account-2'],logger:silent,clock:()=>now,fetchImpl:server.fetch,
    send:async message=>{messages.push(message);return{messageId:randomUUID()};}});
  service.ready=true;
  t.after(()=>{service.ready=false;store.close();});
  const bind=(sub,uid,target={key:uid==='111'?'AAAAAAA2':'BBBBBBB2',label:uid==='111'?'EoR':'Physics'})=>{
    const grant={apiKey:`key-${uid}`,userId:uid,username:`user-${uid}`},generation=randomUUID();
    service.db.bind(sub.key,{...grant,generation,credential:service.vault.seal(sub.key,grant)},now);
    if(target)service.db.target(sub.key,generation,target,now);
  };
  const deliver=(sub,p=paper,s=summary)=>{
    store.putPapers([p],now);store.putReadingSnapshot(sub.key,{paper:p,summary:s,language:sub.language,matched:['21cm']},now);
    store.prepareDelivery(sub.key,p.id,sub.language,[formatPaper(p,s,sub.language,['21cm'],1,1)],now);store.acknowledgePart(sub.key,p.id,'fixture-message',now);
  };
  return{store,a,b,server,service,messages,bind,deliver};
}

test('OAuth signing matches the RFC normalization example including duplicate parameters and escaping',()=>{
  const signature=oauthSignature('POST','http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b',[
    ['c2',''],['a3','2 q'],['oauth_consumer_key','9djdj82h48djs9d2'],['oauth_token','kkk9d7dh3k39sjv7'],
    ['oauth_signature_method','HMAC-SHA1'],['oauth_timestamp','137131201'],['oauth_nonce','7d8f3e4a']], 'j49sk3j29djd','dh893hdasih9');
  assert.equal(signature,'r6/TJjbCOr97/+UU0NsvSne7s5g=');
});

test('encrypted grants cannot be read by a different subscriber, key or tampered ciphertext',()=>{
  const vault=new CredentialVault(app.encryptionKey),sealed=vault.seal('owner-a',{apiKey:'private-fixture'});
  assert.ok(!sealed.includes('private-fixture'));assert.equal(vault.open('owner-a',sealed).apiKey,'private-fixture');
  assert.throws(()=>vault.open('owner-b',sealed));assert.throws(()=>new CredentialVault(Buffer.alloc(32,9).toString('base64')).open('owner-a',sealed));
  const parts=sealed.split('.');parts[1]=Buffer.alloc(16,2).toString('base64');assert.throws(()=>vault.open('owner-a',parts.join('.')));
  assert.throws(()=>validateApp({...app,callbackUrl:'http://example.org/callback'}));
});

test('callback accepts one token/verifier pair and rejects duplicates, injected commands and denied authorization',()=>{
  assert.equal(callbackCommand('https://example.org/?oauth_token=token-a&oauth_verifier=verify-a'),'/arxiv zotero finish token-a verify-a');
  for(const query of ['oauth_token=a&oauth_token=b&oauth_verifier=c','oauth_token=a&oauth_verifier=x%0A%2Farxiv%20save%20id','oauth_problem=denied','oauth_token=a'])assert.throws(()=>callbackCommand('https://example.org/?'+query));
  const html=readFileSync(new URL('../zotero-callback.html',import.meta.url),'utf8');
  assert.match(html,/no-referrer/);assert.match(html,/connect-src 'none'/);assert.ok(!html.includes('https://'));
});

test('two OAuth flows bind only their initiating Weixin identities; replay and cross-user callbacks fail',async t=>{
  const f=fixture(t);for(const sub of [f.a,f.b]){assert.match(f.service.command(sub.key,'zotero','connect'),/队列/);await f.service.tick();}
  assert.match(f.service.command(f.b.key,'zotero','finish temporary-1 verify-111'),/不属于/);
  assert.equal(f.service.db.account(f.b.key),undefined);
  f.service.command(f.a.key,'zotero','finish temporary-1 verify-111');await f.service.tick();
  f.service.command(f.b.key,'zotero','finish temporary-2 verify-222');await f.service.tick();
  assert.equal(f.service.db.account(f.a.key).user_id,'111');assert.equal(f.service.db.account(f.b.key).user_id,'222');
  assert.match(f.service.command(f.a.key,'zotero','finish temporary-1 verify-111'),/无效或已过期/);
  for(const row of f.store.db.prepare('SELECT * FROM zotero_accounts').all())assert.ok(!row.credential.includes('key-'));
  assert.ok(f.messages.every(m=>m.accountId==='account-1'?m.to==='peer1@im.wechat':m.to==='peer2@im.wechat'));
});

test('expired or insufficient personal-library authorization never creates a usable binding',async t=>{
  const f=fixture(t);f.service.command(f.a.key,'zotero','connect');await f.service.tick();
  f.service.clock=()=>now+16*60_000;assert.match(f.service.command(f.a.key,'zotero','finish temporary-1 verify-111'),/过期/);
  f.service.clock=()=>now;f.server.hooks=async url=>url.pathname==='/keys/current'?json({userID:111,access:{user:{library:true,write:false,notes:true}}}):null;
  f.service.command(f.a.key,'zotero','finish temporary-1 verify-111');await f.service.tick();assert.equal(f.service.db.account(f.a.key),undefined);
  assert.equal(f.service.db.latest(f.a.key).status,'failed');assert.match(f.service.status(f.a.key),/权限/);
});

test('folder selection is personal, paginated and explicit when names collide',async t=>{
  const f=fixture(t);f.bind(f.a,'111');f.bind(f.b,'222');
  f.server.folders.get('111').push({key:'CCCCCCC2',data:{key:'CCCCCCC2',name:'EoR',parentCollection:false}});
  f.service.command(f.a.key,'zotero','folder EoR');await f.service.tick();assert.match(f.service.status(f.a.key),/同名/);
  f.service.command(f.a.key,'zotero','folder BBBBBBB2');await f.service.tick();assert.match(f.service.status(f.a.key),/未找到/);
  f.service.command(f.a.key,'zotero','folder CCCCCCC2');await f.service.tick();assert.equal(f.service.db.account(f.a.key).target.key,'CCCCCCC2');
  assert.equal(f.service.db.account(f.b.key).target.key,'BBBBBBB2');
  const many=Array.from({length:101},(_,i)=>{const key=objectKey('111',String(i),'folder');return{key,data:{key,name:'Folder '+i,parentCollection:false}};});
  f.server.folders.set('111',many);f.service.command(f.a.key,'zotero','folders 9');await f.service.tick();
  assert.match(f.service.status(f.a.key),/9\/9/);assert.ok(f.server.calls.some(c=>c.url.includes('start=100')));
  assert.throws(()=>selectCollection(collectionRows([{key:'AAAAAAA2',data:{name:'child',parentCollection:'BBBBBBB2'}}]),'child'));
});

test('two users save only received papers into their own libraries with escaped reading notes and PDF links',async t=>{
  const f=fixture(t);f.bind(f.a,'111');f.bind(f.b,'222');f.deliver(f.a);
  assert.match(f.service.command(f.b.key,'save',paper.id),/已经发给你/);assert.equal(f.server.calls.length,0);
  f.deliver(f.b);for(const sub of [f.a,f.b]){f.service.command(sub.key,'save',paper.id);await f.service.tick();assert.equal(f.service.db.latest(sub.key).status,'done');}
  for(const uid of ['111','222']){
    const rows=[...f.server.entries(uid).values()];assert.equal(rows.length,3);
    const p=rows.find(r=>r.data.itemType==='preprint');assert.equal(p.data.abstractNote,paper.abstract);assert.deepEqual(p.data.collections,[uid==='111'?'AAAAAAA2':'BBBBBBB2']);
    const note=rows.find(r=>r.data.itemType==='note');assert.ok(!note.data.note.includes('<script>'));assert.match(note.data.note,/&lt;script&gt;/);
    const attachment=rows.find(r=>r.data.itemType==='attachment');assert.equal(attachment.data.linkMode,'linked_url');assert.match(attachment.data.url,/v1$/);
  }
});

test('saving again and adding another collection preserve existing metadata, notes and concurrent collection edits',async t=>{
  const f=fixture(t);f.bind(f.a,'111');f.deliver(f.a);f.service.command(f.a.key,'save',paper.id);await f.service.tick();
  const rows=f.server.entries('111'),parent=rows.get(objectKey('111',paper.id,'paper')),note=rows.get(objectKey('111',paper.id,'note'));
  parent.data.title='My edited title';note.data.note='My private annotations';
  f.server.folders.get('111').push({key:'DDDDDDD2',data:{key:'DDDDDDD2',name:'Selected',parentCollection:false}});
  f.service.command(f.a.key,'zotero','folder DDDDDDD2');await f.service.tick();f.server.conflictOnce=true;
  f.service.command(f.a.key,'save',paper.id);await f.service.tick();
  assert.equal(f.service.db.latest(f.a.key).status,'done');assert.equal(rows.size,3);assert.equal(parent.data.title,'My edited title');assert.equal(note.data.note,'My private annotations');
  assert.deepEqual(parent.data.collections,['AAAAAAA2','CCCCCCC2','DDDDDDD2']);
});

test('preexisting arXiv items are reused and duplicate existing candidates are not guessed',async t=>{
  const f=fixture(t);f.bind(f.a,'111');f.deliver(f.a);
  f.server.entries('111').set('ZZZZZZZ2',{key:'ZZZZZZZ2',version:2,data:{key:'ZZZZZZZ2',version:2,itemType:'journalArticle',title:'Published title',url:'https://arxiv.org/abs/2609.12345v2',collections:['CCCCCCC2'],tags:[]}});
  f.service.command(f.a.key,'save',paper.id);await f.service.tick();assert.equal(f.server.entries('111').size,3);
  assert.equal(f.server.entries('111').get('ZZZZZZZ2').data.title,'Published title');
  f.server.entries('111').set('YYYYYYY2',{key:'YYYYYYY2',version:1,data:{itemType:'preprint',repository:'arXiv',archiveID:paper.id,collections:[]}});
  f.service.command(f.a.key,'save',paper.id);await f.service.tick();assert.equal(f.service.db.latest(f.a.key).status,'failed');assert.match(f.service.status(f.a.key),/重复条目/);
});

test('timeout after a completed create and partial multi-write responses reconcile without duplicate items',async t=>{
  const f=fixture(t);f.bind(f.a,'111');f.deliver(f.a);f.server.timeoutAfterCreate=true;f.server.partialOnce=true;
  f.service.command(f.a.key,'save',paper.id);await f.service.tick();assert.equal(f.service.db.latest(f.a.key).status,'done');
  f.service.command(f.a.key,'save',paper.id);await f.service.tick();assert.equal(f.server.entries('111').size,3);
  assert.equal(f.server.calls.filter(c=>c.method==='POST'&&new URL(c.url).pathname.endsWith('/items')).length,3);
});

test('HTTP 200 with failed writes is not reported as saved; a later explicit retry can finish',async t=>{
  const f=fixture(t);f.bind(f.a,'111');f.deliver(f.a);f.server.failWrite=true;
  f.service.command(f.a.key,'save',paper.id);await f.service.tick();assert.equal(f.service.db.latest(f.a.key).status,'failed');assert.equal(f.server.entries('111').size,0);
  assert.ok(!f.service.status(f.a.key).includes('已收藏'));f.server.failWrite=false;
  f.service.command(f.a.key,'save',paper.id);await f.service.tick();assert.equal(f.service.db.latest(f.a.key).status,'done');
});

test('disconnect during a read cancels the pending save before any library write and isolates the other user',async t=>{
  const f=fixture(t);f.bind(f.a,'111');f.bind(f.b,'222');f.deliver(f.a);
  let unblock,reached;const entered=new Promise(resolve=>{reached=resolve;});
  f.server.hooks=async url=>{if(url.pathname==='/keys/current'){reached();await new Promise(resolve=>{unblock=resolve;});}return null;};
  f.service.command(f.a.key,'save',paper.id);const running=f.service.tick();await entered;
  f.service.command(f.a.key,'zotero','disconnect');unblock();await running;
  assert.equal(f.service.db.account(f.a.key),undefined);assert.ok(f.service.db.account(f.b.key));assert.ok(!f.server.calls.some(c=>c.method==='POST'));
});

test('revoked grants, identity mismatches and API backoff prevent writes without leaking response secrets',async t=>{
  const f=fixture(t);f.bind(f.a,'111');f.deliver(f.a);f.server.revoked=true;
  f.service.command(f.a.key,'save',paper.id);await f.service.tick();assert.equal(f.service.db.latest(f.a.key).status,'failed');assert.ok(!f.service.status(f.a.key).includes('fixture secret'));
  f.server.revoked=false;f.server.hooks=async url=>url.pathname==='/keys/current'?json({userID:222,access:{user:{library:true,write:true,notes:true}}}):null;
  f.service.command(f.a.key,'save',paper.id);await f.service.tick();assert.equal(f.service.db.latest(f.a.key).status,'failed');assert.ok(!f.server.calls.some(c=>c.method==='POST'));
  let requests=0;const api=new ZoteroApi({app,store:f.store,clock:()=>now,fetchImpl:async()=>{requests++;return json({},429,{'Retry-After':'60'});}});
  await assert.rejects(api.verify({apiKey:'private-key',userId:'111'}));await assert.rejects(api.verify({apiKey:'private-key',userId:'111'}),/等待/);assert.equal(requests,1);
  assert.equal(f.store.get('zotero-backoff-until'),now+60000);
});

test('queued saves survive a database restart and retain the actual delivered version despite newer shared metadata',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'arxiv-zotero-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let store=new Store(join(dir,'state.sqlite'));const a=user(store,1),server=remote();
  let service=new ZoteroService({store,app,allowedAccountIds:['account-1'],logger:silent,clock:()=>now,fetchImpl:server.fetch,send:async()=>({messageId:'x'})});
  const generation=randomUUID(),grant={userId:'111',username:'User',apiKey:'key-111'};
  service.db.bind(a.key,{...grant,generation,credential:service.vault.seal(a.key,grant)},now);service.db.target(a.key,generation,{key:'AAAAAAA2',label:'EoR'},now);
  assert.equal(protectedCredentialCount(join(dir,'state.sqlite')),1);
  store.putPapers([paper],now);store.putReadingSnapshot(a.key,{paper,summary,language:'zh'},now);store.prepareDelivery(a.key,paper.id,'zh',['old message'],now);store.acknowledgePart(a.key,paper.id,'receipt',now);
  store.putPapers([{...paper,version:2,title:'New version title'}],now+1);service.command(a.key,'save',paper.id);
  service.db.state(service.db.next().id,'running',null,now);store.close();store=new Store(join(dir,'state.sqlite'));
  service=new ZoteroService({store,app,allowedAccountIds:['account-1'],logger:silent,clock:()=>now,fetchImpl:server.fetch,send:async()=>({messageId:'x'})});service.ready=true;
  await service.tick();assert.equal(service.db.latest(a.key).status,'done');assert.match(server.entries('111').get(objectKey('111',paper.id,'paper')).data.url,/v1$/);
  store.forget(a.key);assert.equal(service.db.account(a.key),undefined);assert.equal(service.db.latest(a.key),undefined);assert.equal(store.readingSnapshot(a.key,paper.id),undefined);
  assert.equal(protectedCredentialCount(join(dir,'state.sqlite')),0);store.close();
});

test('old delivered messages can be bookmarked on later days while unknown versions or other users cannot be substituted',t=>{
  const f=fixture(t);f.store.putPapers([paper],now);f.store.prepareDelivery(f.a.key,paper.id,'zh',[formatPaper(paper,summary,'zh',['21cm'],1,1)],now);f.store.acknowledgePart(f.a.key,paper.id,'old',now);
  const snapshot=deliverySnapshot(f.store,f.a.key,paper.id);assert.equal(snapshot.paper.version,1);assert.match(readingNote(snapshot),/自动生成/);
  assert.throws(()=>deliverySnapshot(f.store,f.b.key,paper.id));f.store.putPapers([{...paper,version:2}],now);assert.throws(()=>deliverySnapshot(f.store,f.a.key,paper.id),/对应版本/);
  assert.equal(itemArxivId({data:{itemType:'preprint',url:'https://attacker.invalid/abs/2609.12345'}}),null);
});

test('Weixin Zotero commands remain deterministic and respond immediately without running network or model work in the hook',t=>{
  const f=fixture(t),config={allowedAccountIds:['account-1','account-2']};f.bind(f.a,'111');f.deliver(f.a);
  const inbound=createInboundHandler(()=>({ready:true,store:f.store,config,clock:()=>now,zotero:f.service}),config,silent);
  const context={channelId:'openclaw-weixin',accountId:'account-1',conversationId:'peer1@im.wechat'};
  assert.deepEqual(inbound({content:'你好'},context),{handled:true});
  assert.match(inbound({content:'/arxiv save 2609.12345'},context).text,/队列/);assert.equal(f.server.calls.length,0);
  assert.match(inbound({content:'/arxiv zotero status'},context).text,/等待处理/);
  assert.ok(!inbound({content:'/arxiv zotero status'},{...context,accountId:'account-2',conversationId:'peer2@im.wechat'}).text.includes('user-111'));
});
