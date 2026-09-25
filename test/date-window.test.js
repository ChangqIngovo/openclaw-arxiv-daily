import test from 'node:test';
import assert from 'node:assert/strict';
import { previousDayWindow, DAY } from '../src/dates.js';
import { DigestService, resolveConfig } from '../src/service.js';
import { ArxivClient } from '../src/arxiv.js';
import { Store } from '../src/store.js';
import { runCommand } from '../src/commands.js';

const now = Date.parse('2026-09-25T00:00:00Z');
const config = resolveConfig({allowedAccountIds:['fixture-account'], lookbackDays:7});
const window = previousDayWindow(now, config.timeZone);
const silent = {info(){}, warn(){}, error(){}};
const paper = (id, published, version = 1) => ({id,version,published,updated:now,
  title:'Synthetic 21cm date fixture',abstract:'Not a real paper.',authors:[],categories:[],url:`https://arxiv.org/abs/${id}`,pdf:`https://arxiv.org/pdf/${id}`});
function setup(clock = () => now) {
  const store = new Store(':memory:');
  const sub = store.addSub({account:'fixture-account',peer:'date@im.wechat',topics:['21cm'],language:'none'}, now-DAY,50);
  const sent = [];
  const service = new DigestService({config,store,stateDir:'.',clock,logger:silent,send:async m => {sent.push(m);return{messageId:`m${sent.length}`};}});
  service.client = {refresh:async()=>{}}; service.summarizer = {get:async()=>null};
  return {store,sub,sent,service};
}

test('previous civil day has exact Beijing bounds, survives month/year boundaries and DST', () => {
  assert.equal(config.lookbackDays,1);
  assert.equal(window.day,'2026-09-24');
  assert.equal(window.since,Date.parse('2026-09-23T16:00:00Z'));
  assert.equal(window.until,Date.parse('2026-09-24T16:00:00Z'));
  assert.equal(previousDayWindow(Date.parse('2027-01-01T00:00Z')).day,'2026-12-31');
  assert.equal(previousDayWindow(Date.parse('2028-03-01T00:00Z')).day,'2028-02-29');
  const spring = previousDayWindow(Date.parse('2026-03-09T12:00Z'),'America/New_York');
  const autumn = previousDayWindow(Date.parse('2026-11-02T12:00Z'),'America/New_York');
  assert.equal(spring.until-spring.since,23*3600000);
  assert.equal(autumn.until-autumn.since,25*3600000);
});

test('API query uses UTC equivalents and filters end-inclusive API results by first submission', async () => {
  const store = new Store(':memory:'); let query;
  const fixtures = [paper('2609.30001',window.since-1),paper('2609.30002',window.since),
    paper('2609.30003',window.until-1),paper('2609.30004',window.until),paper('2609.30005',now-10*DAY,2)];
  const xml = `<feed><totalResults>5</totalResults>${fixtures.map(p=>`<entry><id>${p.url}v${p.version}</id><title>${p.title}</title><summary>${p.abstract}</summary><published>${new Date(p.published).toISOString()}</published><updated>${new Date(p.updated).toISOString()}</updated></entry>`).join('')}</feed>`;
  const client = new ArxivClient({store,config,clock:()=>now,fetchImpl:async u => {query=u.searchParams.get('search_query');return new Response(xml);}});
  await client.refresh(['21cm']);
  assert.match(query,/submittedDate:\[202609231600 TO 202609241600\]/);
  assert.deepEqual(store.papers(0).map(p=>p.id),['2609.30003','2609.30002']);
  store.close();
});

test('daily, now and test reject old cached papers and today papers, including recently updated old versions', async () => {
  for (const kind of ['daily','now','test']) {
    const {store,sub,sent,service} = setup();
    store.putPapers([paper('2609.30001',window.since-1),paper('2609.30002',window.since),
      paper('2609.30003',window.until),paper('2609.30004',now-10*DAY,3)],now);
    store.enqueue(sub.key,kind,now); await service.process(store.nextRun(now));
    assert.equal(sent.length,1); assert.match(sent[0].text,/arXiv:2609\.30002v1/);
    assert.match(sent[0].text,/首次提交 2026-09-24 Asia\/Shanghai/);
    store.close();
  }
});

test('no previous-day matches does not fall back to older history or resume old pending chunks', async () => {
  const {store,sub,sent,service} = setup();
  store.putPapers([paper('2609.30001',now-4*DAY)],now);
  store.prepareDelivery(sub.key,'2609.30001','none',['old cached message'],now);
  store.enqueue(sub.key,'now',now); await service.process(store.nextRun(now));
  assert.equal(sent.length,0); assert.equal(store.latestRun(sub.key).total,0);
  store.close();
});

test('manual retry and retry processing only select previous-day papers, even after resume', async () => {
  const {store,sub,sent,service} = setup();
  store.putPapers([paper('2609.30001',now-4*DAY),paper('2609.30002',window.since),paper('2609.30003',window.until)],now);
  for (const id of ['2609.30001','2609.30002','2609.30003']) {
    store.prepareDelivery(sub.key,id,'none',[id],now); store.deliveryStatus(sub.key,id,'failed',now);
  }
  assert.match(runCommand('/arxiv retry',sub,service),/处理队列/);
  assert.equal(store.delivery(sub.key,'2609.30001').status,'failed');
  assert.equal(store.delivery(sub.key,'2609.30003').status,'failed');
  await service.process(store.nextRun(now));
  assert.deepEqual(sent.map(s=>s.text),['2609.30002']); store.close();
});

test('old queued tasks are cancelled; a day change during reading prevents physical delivery', async () => {
  let time = now;
  const {store,sub,sent,service} = setup(()=>time);
  store.enqueue(sub.key,'now',now-DAY); await service.process(store.nextRun(now));
  assert.equal(store.latestRun(sub.key).status,'cancelled');
  store.putPapers([paper('2609.30002',window.since)],now);
  service.summarizer = {get:async()=>{time=Date.parse('2026-09-25T16:00Z');return null;}};
  store.enqueue(sub.key,'now',now); await service.process(store.nextRun(now));
  assert.equal(sent.length,0); assert.equal(store.latestRun(sub.key).status,'cancelled'); store.close();
});

test('a day change between message chunks stops the remaining old-day chunks', async () => {
  let time = Date.parse('2026-09-25T15:59:59Z');
  const {store,sub,service} = setup(()=>time);
  store.putPapers([paper('2609.30002',window.since)],now);
  store.prepareDelivery(sub.key,'2609.30002','none',['first','second'],now);
  let sends=0; service.send=async()=>{sends++; time+=1000; return{messageId:'first'};};
  assert.equal(await service.sendDelivery(sub.key,'2609.30002',sub.revision),false);
  assert.equal(sends,1); assert.equal(store.delivery(sub.key,'2609.30002').next_part,1); store.close();
});
