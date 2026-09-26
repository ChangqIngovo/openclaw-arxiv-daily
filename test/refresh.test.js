import test from 'node:test';
import assert from 'node:assert/strict';
import { ArxivClient } from '../src/arxiv.js';
import { Store } from '../src/store.js';
import { DigestService, resolveConfig } from '../src/service.js';
import { previousDayWindow, DAY } from '../src/dates.js';
import { runCommand } from '../src/commands.js';

const early = Date.parse('2026-09-26T03:45:00+10:00');
const morning = Date.parse('2026-09-26T08:00:00+10:00');
const config = resolveConfig({allowedAccountIds:['fixture'],ownerPeerId:'owner@im.wechat',
  timeZone:'Australia/Sydney',defaultLanguage:'none'});
const window = previousDayWindow(early,config.timeZone);
const paper = (n,published=window.since+n,version=1) => ({
  id:`2609.${52000+n}`,version,published,updated:morning,
  title:'Synthetic 21cm retrieval fixture',abstract:'Synthetic data, not an actual paper.',
  categories:['astro-ph.CO'],authors:[],url:`https://arxiv.org/abs/2609.${52000+n}`,
  pdf:`https://arxiv.org/pdf/2609.${52000+n}`,
});
const feed = papers => `<feed><totalResults>${papers.length}</totalResults>${papers.map(p=>
  `<entry><id>${p.url}v${p.version}</id><title>${p.title}</title><summary>${p.abstract}</summary><published>${new Date(p.published).toISOString()}</published><updated>${new Date(p.updated).toISOString()}</updated><category term="astro-ph.CO"/></entry>`).join('')}</feed>`;

function fixture(t) {
  const store = new Store(':memory:'); t.after(()=>store.close());
  const sub = store.addSub({account:'fixture',peer:'owner@im.wechat',topics:['21cm','astro-ph.CO'],language:'none'},early-DAY,1);
  const state = {now:early,papers:[paper(1),paper(2)],requests:[],sent:[],logs:[],reject:false};
  const clock = ()=>state.now;
  const client = new ArxivClient({store,config,clock,sleep:async ms=>{state.now+=ms;},fetchImpl:async url=>{
    state.requests.push(url.searchParams.get('search_query'));
    return state.reject ? new Response('Unavailable',{status:503}) : new Response(feed(state.papers));
  }});
  const logger = {info:msg=>state.logs.push(msg),warn:msg=>state.logs.push(msg),error:msg=>state.logs.push(msg)};
  const service = new DigestService({config,store,clock,logger,send:async msg=>{
    state.sent.push(msg.text);return {messageId:`fixture-${state.sent.length}`};
  }});
  service.client=client;service.summarizer={get:async()=>null};
  const run = async kind => {
    assert.equal(store.enqueue(sub.key,kind,state.now,kind==='daily' ? '2026-09-26' : null),true);
    await service.process(store.nextRun(state.now));
  };
  return {store,sub,state,client,service,run};
}

test('morning daily rechecks the same date after early test/now and sends only newly available eligible papers',async t=>{
  const {store,sub,state,service,run}=fixture(t);
  await run('test');assert.equal(state.sent.length,1);
  state.now=early+3*60_000;await run('now');assert.equal(state.sent.length,2);
  const earlyQueries=state.requests.length;
  state.now=morning;
  state.papers=[paper(1,window.since+1,2),paper(2),paper(3),paper(4,window.since-1),paper(5,window.until)];
  await service.tick();
  assert.equal(state.requests.length,earlyQueries+1,'daily must actually query after the early manual run');
  assert.equal(new Set(state.requests).size,1,'refresh must preserve the exact first-submission window');
  assert.equal(state.sent.length,3);
  assert.match(state.sent[2],/arXiv:2609\.52003v1/);
  assert.equal(store.latestRun(sub.key).kind,'daily');assert.equal(store.latestRun(sub.key).sent,1);
  assert.equal(store.paper('2609.52001').version,2);
  assert.equal(store.delivery(sub.key,'2609.52004'),undefined);assert.equal(store.delivery(sub.key,'2609.52005'),undefined);
  await service.tick();assert.equal(state.requests.length,earlyQueries+1);assert.equal(state.sent.length,3);
});

test('daily and explicit now bypass even a recent successful query; test stays short-term cached',async t=>{
  const {state,run}=fixture(t);
  state.now=morning-2*60_000;await run('test');assert.equal(state.requests.length,1);
  state.now=morning;state.papers.push(paper(3));await run('daily');
  assert.equal(state.requests.length,2);assert.equal(state.sent.length,3);
  state.now=morning+60_000;state.papers.push(paper(4));await run('now');
  assert.equal(state.requests.length,3);assert.equal(state.sent.length,4);
  state.now+=60_000;await run('test');assert.equal(state.requests.length,3);assert.equal(state.sent.length,4);
});

test('ordinary query cache expires after 15 minutes and cache hits do not pretend a new fetch occurred',async t=>{
  const {store,state,client}=fixture(t);
  await client.refresh(['21cm']);const fetched=store.get('lastFetch');
  state.now=early+14*60_000;await client.refresh(['21cm']);
  assert.equal(state.requests.length,1);assert.equal(store.get('lastFetch'),fetched);
  state.now=early+15*60_000;state.papers.push(paper(3));await client.refresh(['21cm']);
  assert.equal(state.requests.length,2);assert.ok(store.paper('2609.52003'));
  assert.equal(store.get('lastFetch'),state.now);
  // Clock rollback must not make a future timestamp an indefinitely fresh cache.
  state.now=early;await client.refresh(['21cm']);assert.equal(state.requests.length,3);
});

test('zero-result and old complete-only cache entries cannot suppress a later refresh',async t=>{
  const {store,state,client}=fixture(t);
  state.papers=[];await client.refresh(['21cm']);assert.equal(store.papers(0).length,0);
  const key=store.db.prepare("SELECT key FROM meta WHERE key LIKE 'previous-day-query:%'").get().key;
  store.set(key,{complete:true,count:0});state.papers=[paper(1)];
  await client.refresh(['21cm']);assert.equal(state.requests.length,2);assert.ok(store.paper(paper(1).id));
  state.papers.push(paper(2));
  await client.refresh(['21cm'],undefined,window,{force:true});
  assert.equal(state.requests.length,3);assert.ok(store.paper(paper(2).id));
});

test('a failed forced refresh reports the error without accepting stale results as a successful empty run',async t=>{
  const {store,sub,state,service,run}=fixture(t);
  await run('now');const fetched=store.get('lastFetch');assert.equal(state.sent.length,2);
  state.now+=60_000;state.reject=true;await run('now');
  const failed=store.latestRun(sub.key);
  assert.equal(failed.status,'queued');assert.equal(failed.attempts,1);assert.match(failed.error,/arXiv HTTP 503/);
  assert.equal(store.get('lastFetch'),fetched);assert.equal(state.sent.length,2);
  state.now=failed.next_attempt;state.reject=false;state.papers.push(paper(3));
  await service.process(store.nextRun(state.now));
  assert.equal(store.latestRun(sub.key).status,'done');assert.equal(state.sent.length,3);
  assert.match(state.sent[2],/arXiv:2609\.52003v1/);
});

test('status identifies the actual job kind and local date; an empty deduplicated run is not described as zero matching papers',async t=>{
  const {store,sub,state,service,run}=fixture(t);
  await run('now');state.now=morning;await run('daily');
  const status=runCommand('/arxiv status',sub,service);
  assert.match(status,/定时日报/);assert.match(status,/2026-09-26 08:00/);
  assert.match(status,/已提交 0\/0/);assert.match(status,/没有待发论文/);
  assert.ok(state.logs.some(line=>/daily/.test(line)&&/matched=2/.test(line)&&/alreadySubmitted=2/.test(line)&&/sent=0\/0/.test(line)));
  assert.equal(store.latestRun(sub.key).error,null);
});
