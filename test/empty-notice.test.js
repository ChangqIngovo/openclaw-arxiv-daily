import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DigestService, resolveConfig } from '../src/service.js';
import { previousDayWindow, DAY } from '../src/dates.js';
import { runCommand } from '../src/commands.js';

const now=Date.parse('2026-09-26T08:00:00+10:00');
const config=resolveConfig({allowedAccountIds:['fixture'],ownerPeerId:'owner@im.wechat',timeZone:'Australia/Sydney'});
const window=previousDayWindow(now,config.timeZone);
const quiet={info(){},warn(){},error(){}};
const paper=(n,published=window.since+n)=>({id:`2609.${53000+n}`,version:1,published,updated:now,
  title:'Synthetic 21cm fixture',abstract:'Not an actual paper.',authors:[],categories:[],
  url:`https://arxiv.org/abs/2609.${53000+n}`,pdf:`https://arxiv.org/pdf/2609.${53000+n}`});
function setup(t,existing) {
  const store=existing||new Store(':memory:');if(!existing)t.after(()=>store.close());
  const sub=store.subs()[0]||store.addSub({account:'fixture',peer:'owner@im.wechat',topics:['21cm'],language:'zh'},now-DAY,1);
  const state={now,sent:[],queries:0};
  const service=new DigestService({config:{...config},store,logger:quiet,clock:()=>state.now,
    complete:async()=>{throw new Error('Empty notices must not invoke the model');},
    send:async msg=>{state.sent.push(msg);return {messageId:`notice-${state.sent.length}`};}});
  service.client={refresh:async()=>{state.queries++;return {fetched:1,cached:0};}};
  service.summarizer={get:async()=>{throw new Error('Empty notices must not read or summarize papers');}};
  const run=async kind=>{
    assert.equal(store.enqueue(sub.key,kind,state.now,kind==='daily'?previousDayWindow(state.now,config.timeZone).today:null),true);
    await service.process(store.nextRun(state.now));return store.latestRun(sub.key);
  };
  return {store,sub,state,service,run};
}

test('daily, now and test send one dated no-new-paper notice without adding a paper delivery or invoking a model',async t=>{
  for(const kind of ['daily','now','test']) {
    const {store,sub,state,service,run}=setup(t);
    const job=await run(kind);
    assert.equal(state.sent.length,1);assert.equal(state.sent[0].accountId,'fixture');assert.equal(state.sent[0].to,sub.peer);
    assert.match(state.sent[0].text,/没有新论文。/);assert.match(state.sent[0].text,/arXiv 日报 · 2026-09-26/);
    assert.match(state.sent[0].text,/检索范围：2026-09-25（Australia\/Sydney）/);
    assert.equal(job.status,'done');assert.equal(job.sent,0);assert.equal(job.total,0);
    assert.equal(store.runNotice(job.id).status,'submitted');assert.deepEqual(store.deliveryCounts(sub.key),[]);
    assert.match(runCommand('/arxiv status',sub,service),/无新论文通知：已提交/);
    await service.process(job);assert.equal(state.sent.length,1);assert.equal(state.queries,1);
    if(kind==='daily') {
      await service.tick();assert.equal(state.sent.length,1);
      state.now+=DAY;await service.tick();assert.equal(state.sent.length,2);
      assert.match(state.sent[1].text,/检索范围：2026-09-26/);
    }
  }
});

test('already sent papers produce an explanatory notice; later new papers are delivered without an empty notice',async t=>{
  const {store,sub,state,service,run}=setup(t);const p=paper(1);
  store.putPapers([p,paper(9,window.since-1)],now);
  store.prepareDelivery(sub.key,p.id,'zh',['previously sent'],now);store.acknowledgePart(sub.key,p.id,'prior-message',now);
  await run('daily');assert.equal(state.sent.length,1);
  assert.match(state.sent[0].text,/没有新论文可推送.*1 篇已发送/);
  const p2=paper(2);store.putPapers([p2],now);service.summarizer={get:async()=>null};
  const next=await run('now');assert.equal(state.sent.length,2);assert.match(state.sent[1].text,/arXiv:2609\.53002v1/);
  assert.equal(next.sent,1);assert.equal(store.runNotice(next.id),undefined);
  await run('now');assert.equal(state.sent.length,3);assert.match(state.sent[2].text,/2 篇已发送/);
});

test('pause, subscription edits, unsubscribe, date changes and timezone changes during retrieval prevent stale notices',async t=>{
  for(const action of ['pause','topics','unsubscribe','date','zone']) {
    const {store,sub,state,service,run}=setup(t);
    service.client.refresh=async()=>{
      if(action==='pause')store.patchSub(sub.key,{active:false},now);
      if(action==='topics')store.patchSub(sub.key,{topics:['JWST']},now);
      if(action==='unsubscribe')store.forget(sub.key);
      if(action==='date')state.now+=DAY;
      if(action==='zone')service.config.timeZone='Asia/Shanghai';
    };
    const job=await run('daily');assert.equal(state.sent.length,0);
    if(action!=='unsubscribe') {assert.equal(job.status,'cancelled');assert.equal(store.runNotice(job.id),undefined);}
  }
});

test('query failures and blocked paper deliveries never produce a false no-new-paper notice',async t=>{
  for(const reason of ['query','failed','unknown']) {
    const {store,sub,state,service,run}=setup(t);
    if(reason==='query')service.client.refresh=async()=>{throw new Error('arXiv HTTP 503');};
    else {
      const p=paper(1);store.putPapers([p],now);store.prepareDelivery(sub.key,p.id,'zh',['unsent'],now);
      store.deliveryStatus(sub.key,p.id,reason,now,'fixture failure');
    }
    const job=await run('daily');assert.equal(state.sent.length,0);assert.equal(store.runNotice(job.id),undefined);
    assert.ok(job.error);assert.equal(job.status,reason==='query'?'queued':'done');
  }
});

test('notice rejection, missing acknowledgement and uncertain sends stay out of paper counts and never auto-replay',async t=>{
  for(const reason of ['rejected','no-ack','timeout']) {
    const {store,sub,state,service,run}=setup(t);let attempts=0;
    service.send=async()=>{attempts++;if(reason==='no-ack')return {};throw new Error(reason==='rejected'?'sendMessage ret=-2 errmsg=prepare failed':'network timeout');};
    const job=await run('daily');const status=reason==='timeout'?'unknown':'failed';
    assert.equal(job.status,'failed');assert.equal(job.attempts,0);assert.equal(job.sent,0);assert.equal(job.total,0);
    assert.equal(store.runNotice(job.id).status,status);assert.match(job.error,/无新论文通知/);
    assert.ok(!job.error.includes('/arxiv retry'));assert.deepEqual(store.deliveryCounts(sub.key),[]);
    await service.tick();await service.process(job);assert.equal(attempts,1);assert.equal(store.nextRun(now+DAY),undefined);
    assert.match(runCommand('/arxiv status',sub,service),reason==='timeout'?/通知：结果不确定/:/通知：失败/);
    service.send=async msg=>{state.sent.push(msg);return {messageId:'explicit-new-query'};};
    await run('now');assert.equal(state.sent.length,1);
  }
});

test('notice receipts survive restart; interrupted sends become uncertain and acknowledged notices are not repeated',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'arxiv-notices-'));
  try {
    for(const phase of ['sending','submitted']) {
      const file=join(dir,`${phase}.sqlite`);let store=new Store(file);
      try {
        const initial=setup(null,store);
        store.enqueue(initial.sub.key,'daily',now,'2026-09-26');const job=store.nextRun(now);
        store.runStatus(job.id,'running',now);assert.equal(store.startRunNotice(job.id,'fixture notice',now),true);
        assert.equal(store.startRunNotice(job.id,'must not replace receipt',now),false);
        if(phase==='submitted')store.finishRunNotice(job.id,'submitted',now,null,'accepted');
        store.close();store=new Store(file);
        const resumed=setup(null,store);await resumed.service.process(store.nextRun(now));
        assert.equal(resumed.state.sent.length,0);assert.equal(resumed.state.queries,0);
        assert.equal(store.latestRun(resumed.sub.key).status,phase==='submitted'?'done':'failed');
        assert.equal(store.runNotice(job.id).status,phase==='submitted'?'submitted':'unknown');
        store.forget(resumed.sub.key);assert.equal(store.runNotice(job.id),undefined);
      } finally {store.close();}
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('opening an existing version-1 database adds notice storage without losing subscriptions or jobs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'arxiv-notice-migration-')),file=join(dir,'state.sqlite');let store=new Store(file);
  try {
    const initial=setup(null,store);store.enqueue(initial.sub.key,'daily',now,'2026-09-26');
    const job=store.nextRun(now);store.db.exec('DROP TABLE run_notices');store.close();store=new Store(file);
    assert.deepEqual(store.sub(initial.sub.key).topics,['21cm']);assert.equal(store.nextRun(now).id,job.id);
    const resumed=setup(null,store);await resumed.service.process(store.nextRun(now));
    assert.equal(resumed.state.sent.length,1);assert.equal(store.runNotice(job.id).status,'submitted');
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
