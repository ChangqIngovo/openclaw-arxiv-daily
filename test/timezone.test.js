import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { computerClock, createSystemTimeZoneResolver, effectiveTimeZone, readSystemTimeZone, TIME_ZONE_REFRESH_MS } from '../src/timezone.js';
import { previousDayWindow, localStamp, isCurrentWindow, DAY } from '../src/dates.js';
import { DigestService, resolveConfig, shouldSchedule } from '../src/service.js';
import { Store } from '../src/store.js';
import { ArxivClient } from '../src/arxiv.js';
import { runCommand } from '../src/commands.js';

const quiet = {info(){},warn(){},error(){}};
const now = Date.parse('2026-09-25T01:00:00Z');
const makeConfig = () => resolveConfig({personal:false,allowedAccountIds:['fixture']});
const paper = (id,published) => ({id,version:1,published,updated:now,title:'Synthetic 21cm fixture',
  abstract:'Synthetic timezone test, not a real paper.',authors:[],categories:[],url:`https://arxiv.org/abs/${id}`});
function setup(t) {
  const config = makeConfig(), store = new Store(':memory:'); t.after(() => store.close());
  const sub = store.addSub({account:'fixture',peer:'owner@im.wechat',topics:['21cm'],language:'none'},now-DAY,50);
  const sends=[];
  const service = new DigestService({config,store,clock:()=>now,logger:quiet,
    send:async msg=>{sends.push(msg);return{messageId:`fixture-${sends.length}`};}});
  service.client={refresh:async()=>{}}; service.summarizer={get:async()=>null};
  return {config,store,sub,sends,service};
}

test('system zone comes from a fresh native process and ignores a fixed parent TZ override', () => {
  const before = process.env.TZ;
  try {
    const actual = readSystemTimeZone();
    assert.ok(actual); assert.doesNotThrow(()=>new Intl.DateTimeFormat('en',{timeZone:actual}));
    process.env.TZ = actual === 'Pacific/Kiritimati' ? 'America/New_York' : 'Pacific/Kiritimati';
    assert.equal(readSystemTimeZone(),actual);
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('runtime refresh detects a new OS zone, handles clock reversal, and never reuses a stale zone after failure', () => {
  let time=100_000, zone='Australia/Sydney', reads=0;
  const resolve = createSystemTimeZoneResolver({clock:()=>time,read:()=>{reads++; if (!zone) throw new Error('fixture'); return zone;}});
  assert.equal(resolve(),'Australia/Sydney'); zone='Asia/Shanghai';
  time+=TIME_ZONE_REFRESH_MS-1; assert.equal(resolve(),'Australia/Sydney'); assert.equal(reads,1);
  time++; assert.equal(resolve(),'Asia/Shanghai'); assert.equal(reads,2);
  zone='America/New_York'; time-=DAY; assert.equal(resolve(),zone);
  zone=null; time+=TIME_ZONE_REFRESH_MS; assert.throws(resolve,/电脑时区/);
  assert.throws(resolve,/电脑时区/);
  zone='Australia/Sydney'; assert.equal(resolve(),zone);
});

test('default config, status, displayed date and 08:00 scheduling all follow the computer', t => {
  let zone='Australia/Sydney'; t.mock.method(computerClock,'timeZone',()=>zone);
  const {config,store,sub,service} = setup(t);
  assert.equal(config.timeZone,'system'); assert.equal(effectiveTimeZone(),zone);
  const eight = Date.parse('2026-09-24T22:00:00Z');
  assert.deepEqual(localStamp(eight),{day:'2026-09-25',time:'08:00'});
  assert.equal(shouldSchedule(sub,eight-1,config),false);
  assert.equal(shouldSchedule(sub,eight,config),true);
  assert.match(runCommand('/arxiv status',sub,service),/08:00 Australia\/Sydney（跟随电脑）/);
  zone='Asia/Shanghai';
  assert.equal(shouldSchedule(sub,eight,config),false);
  assert.match(runCommand('/arxiv status',sub,service),/08:00 Asia\/Shanghai（跟随电脑）/);
  assert.equal(effectiveTimeZone('America/New_York'),'America/New_York');
  service.schedule(); service.schedule();
  assert.equal(store.nextRun(now).day,'2026-09-25');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n,1);
});

test('computer-day windows move with the zone and include complete 23/25-hour Sydney DST days', t => {
  let zone='Australia/Sydney'; t.mock.method(computerClock,'timeZone',()=>zone);
  const spring=previousDayWindow(Date.parse('2026-10-05T00:00Z'));
  assert.equal(spring.day,'2026-10-04'); assert.equal(spring.until-spring.since,23*3600000);
  assert.equal(spring.since,Date.parse('2026-10-03T14:00Z')); assert.equal(spring.until,Date.parse('2026-10-04T13:00Z'));
  const autumn=previousDayWindow(Date.parse('2026-04-06T00:00Z'));
  assert.equal(autumn.day,'2026-04-05'); assert.equal(autumn.until-autumn.since,25*3600000);
  const before=previousDayWindow(now);
  assert.equal(before.since,Date.parse('2026-09-23T14:00Z'));
  zone='Asia/Shanghai'; const after=previousDayWindow(now);
  assert.equal(after.since,Date.parse('2026-09-23T16:00Z'));
  assert.equal(before.today,after.today); assert.equal(isCurrentWindow(before,now,'system'),false);
  assert.equal(isCurrentWindow(after,now,'system'),true);
  assert.equal(previousDayWindow(Date.parse('2026-09-25T14:30Z')).day,'2026-09-24');
  zone='Australia/Sydney';
  assert.equal(previousDayWindow(Date.parse('2026-09-25T14:30Z')).day,'2026-09-25');
});

test('system-mode API fetch, first-submission filtering and paper header use the same resolved window', async t => {
  t.mock.method(computerClock,'timeZone',()=>'Australia/Sydney');
  const {config,store,sub,sends,service}=setup(t), window=previousDayWindow(now);
  const entries=[paper('2609.50001',window.since-1),paper('2609.50002',window.since),
    paper('2609.50003',window.until-1),paper('2609.50004',window.until)];
  let query;
  service.client=new ArxivClient({config,store,clock:()=>now,fetchImpl:async url=>{
    query=url.searchParams.get('search_query');
    return new Response(`<feed><totalResults>4</totalResults>${entries.map(p=>`<entry><id>${p.url}v1</id><title>${p.title}</title><summary>${p.abstract}</summary><published>${new Date(p.published).toISOString()}</published><updated>${new Date(p.updated).toISOString()}</updated></entry>`).join('')}</feed>`);
  }});
  store.enqueue(sub.key,'now',now); await service.process(store.nextRun(now));
  assert.match(query,/submittedDate:\[202609231400 TO 202609241400\]/);
  assert.equal(sends.length,2);
  assert.deepEqual(sends.map(msg=>/arXiv:(\d{4}\.\d+)v1/.exec(msg.text)[1]),['2609.50003','2609.50002']);
  assert.ok(sends.every(msg=>msg.text.includes('首次提交 2026-09-24 Australia/Sydney')));
  store.enqueue(sub.key,'now',now); await service.process(store.nextRun(now)); assert.equal(sends.length,3);
  assert.match(sends[2].text,/没有新论文可推送.*2 篇已发送/);
});

test('zone change or failed timezone refresh during reading stops delivery even on the same local date', async t => {
  for (const fail of [false,true]) {
    let zone='Australia/Sydney';
    const stub=t.mock.method(computerClock,'timeZone',()=>{if (!zone) throw new Error('无法读取电脑时区'); return zone;});
    const {store,sub,sends,service}=setup(t);
    store.putPapers([paper('2609.50002',Date.parse('2026-09-24T00:00Z'))],now);
    service.summarizer={get:async()=>{zone=fail ? null : 'Asia/Shanghai'; return null;}};
    store.enqueue(sub.key,'now',now); await service.process(store.nextRun(now));
    assert.equal(sends.length,0); assert.equal(store.latestRun(sub.key).status,'cancelled');
    stub.mock.restore();
  }
});

test('zone change between message chunks prevents the rest from using the old window', async t => {
  let zone='Australia/Sydney'; t.mock.method(computerClock,'timeZone',()=>zone);
  const {store,sub,service}=setup(t);
  const p=paper('2609.50002',Date.parse('2026-09-24T00:00Z'));
  store.putPapers([p],now); store.prepareDelivery(sub.key,p.id,'none',['first','second'],now);
  let sent=0; service.send=async()=>{sent++; zone='Asia/Shanghai'; return{messageId:'fixture'};};
  assert.equal(await service.sendDelivery(sub.key,p.id,sub.revision),false);
  assert.equal(sent,1); assert.equal(store.delivery(sub.key,p.id).next_part,1);
});

test('installer switches old default to system and preserves explicitly different fixed zones', () => {
  const module={exports:{}};
  const source=readFileSync(new URL('../installer-template.cjs',import.meta.url),'utf8');
  runInNewContext(source.replace('__ARXIV_PAYLOAD__','[]'),{module,require:createRequire(import.meta.url),process,Buffer,console});
  const migrate=module.exports.timeZoneForInstall;
  assert.equal(migrate(),'system'); assert.equal(migrate({timeZone:'Asia/Shanghai'}),'system');
  assert.equal(migrate({timeZone:'system'}),'system');
  assert.equal(migrate({timeZone:'Australia/Sydney'}),'Australia/Sydney');
  const schema=JSON.parse(readFileSync(new URL('../openclaw.plugin.json',import.meta.url),'utf8'));
  assert.equal(schema.configSchema.properties.timeZone.default,'system');
});
