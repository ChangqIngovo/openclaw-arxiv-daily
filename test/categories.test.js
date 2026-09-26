import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { categoryCode } from '../src/categories.js';
import { parseTopics, matchesTopic, matchingTopics, buildQuery, rankPapers, topicBatches } from '../src/topics.js';
import { parseFeed, ArxivClient } from '../src/arxiv.js';
import { Store, subscriberKey } from '../src/store.js';
import { createInboundHandler } from '../src/commands.js';
import { DigestService, resolveConfig } from '../src/service.js';
import { DAY, previousDayWindow } from '../src/dates.js';

const now=Date.parse('2026-09-25T08:00:00Z');
const config=resolveConfig({allowedAccountIds:['fixture'],ownerPeerId:'owner@im.wechat',timeZone:'UTC',defaultLanguage:'none'});
const window=previousDayWindow(now,config.timeZone);
const quiet={info(){},warn(){},error(){}};
const paper=(id,categories,published=window.since+1,title='Synthetic category fixture')=>({
  id,version:1,title,abstract:'Synthetic fixture, not an actual paper.',categories,authors:[],published,updated:now,
  url:`https://arxiv.org/abs/${id}`,pdf:`https://arxiv.org/pdf/${id}`,
});
function feed(papers) {
  return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><totalResults>${papers.length}</totalResults>${papers.map(p=>
    `<entry><id>${p.url}v${p.version}</id><title>${p.title}</title><summary>${p.abstract}</summary><published>${new Date(p.published).toISOString()}</published><updated>${new Date(p.updated).toISOString()}</updated>${p.categories.map(c=>`<category term="${c}" scheme="http://arxiv.org/schemas/atom"/>`).join('')}${p.primaryCategory ? `<arxiv:primary_category term="${p.primaryCategory}"/>` : ''}</entry>`).join('')}</feed>`;
}
function setup(t,topics) {
  const store=new Store(':memory:'); t.after(()=>store.close());
  const sub=store.addSub({account:'fixture',peer:'owner@im.wechat',topics:parseTopics(topics),language:'none'},now-DAY,1);
  const sent=[];
  const service=new DigestService({config,store,clock:()=>now,logger:quiet,
    send:async msg=>{sent.push(msg);return{messageId:`fixture-${sent.length}`};}});
  service.client={refresh:async()=>{}}; service.summarizer={get:async()=>null};
  return {store,sub,sent,service};
}

test('category codes and optional cat prefix normalize and deduplicate without changing mixed priorities',()=>{
  assert.deepEqual(parseTopics('21cm cosmology，astro-ph.co, CAT:ASTRO-PH.CO, cs.ai, quant-ph'),['21cm','astro-ph.CO','cs.AI','quant-ph']);
  assert.deepEqual(parseTopics('ＣＡＴ：ＣＳ．ＡＩ, cat : astro-ph.GA, ASTRO‐PH.co'),['cs.AI','astro-ph.GA','astro-ph.CO']);
  assert.deepEqual(parseTopics('hep-th, math.PR, cond-mat.str-el, physics.plasm-ph'),['hep-th','math.PR','cond-mat.str-el','physics.plasm-ph']);
  assert.deepEqual(parseTopics('cs.NA, math.NA, cat:cs.SY, eess.SY, math.MP, math-ph'),['math.NA','eess.SY','math-ph']);
  assert.equal(categoryCode('Q-FIN.EC'),'econ.GN'); assert.equal(categoryCode('stat.TH'),'math.ST');
  assert.deepEqual(parseTopics('node.js, EoR, high redshift'),['node.js','EoR','high redshift']);
  assert.throws(()=>parseTopics(Array.from({length:13},(_,i)=>`topic ${i}`)),/1–12/);
});

test('invalid selectors, category typos and query syntax are rejected rather than inserted into API queries',()=>{
  for(const value of ['cat:cs.NOPE','astro-ph.BAD','cat:unknown','cat:cs.*','cs.*','cat:','hep-unknown','cat:cs.AI OR all:physics','cs.AI AND cat:cs.LG','ti:21cm','cs.AI") OR all:*']) {
    assert.throws(()=>parseTopics(value),/分类|方向/);
    assert.throws(()=>buildQuery([value],window.since,window.until),/分类|方向/);
  }
});

test('mixed queries use cat only for categories, keep keyword fields, aliases and exact date constraints',()=>{
  const query=buildQuery(['21cm','cat:astro-ph.CO','CS.ai','cs.NA','math.NA'],window.since,window.until);
  assert.match(query,/cat:astro-ph\.CO/); assert.match(query,/cat:cs\.AI/); assert.match(query,/cat:math\.NA/);
  assert.equal(query.match(/cat:math\.NA/g).length,1);
  assert.doesNotMatch(query,/(?:ti|abs):"(?:astro-ph\.CO|cs\.AI|math\.NA)"/);
  assert.match(query,/\(ti:"21cm" OR abs:"21cm"\)/);
  assert.ok(query.endsWith(') AND submittedDate:[202609240000 TO 202609250000]'));
  assert.equal(buildQuery(['cs.AI'],window.since,window.until),'(cat:cs.AI) AND submittedDate:[202609240000 TO 202609250000]');
  const batches=topicBatches(['21cm','EoR','high redshift','astro-ph.CO','cs.AI','math.NA','cat:cs.NA','quant-ph']);
  assert.ok(batches.length>1); assert.equal(batches.flat().filter(t=>t==='math.NA').length,1);
  assert.deepEqual(new Set(batches.flat()),new Set(['21cm','EoR','high redshift','astro-ph.CO','cs.AI','math.NA','quant-ph']));
});

test('category matching uses primary and cross-list metadata, including aliases, never mentions in title or abstract',()=>{
  const cross={...paper('2609.51001',['astro-ph.HE','astro-ph.GA']),primaryCategory:'astro-ph.CO'};
  assert.equal(matchesTopic(cross,'astro-ph.GA'),true);
  assert.equal(matchesTopic(cross,'cat:astro-ph.CO'),true);
  assert.equal(matchesTopic(cross,'astro-ph.EP'),false);
  const mention={...paper('2609.51002',['stat.ML'],window.since,'A cs.AI category mention'),abstract:'astro-ph.CO is just text in this synthetic abstract.'};
  assert.equal(matchesTopic(mention,'cs.AI'),false); assert.equal(matchesTopic(mention,'astro-ph.CO'),false);
  assert.equal(matchesTopic(paper('2609.51003',['cs.NA']),'math.NA'),true);
  assert.equal(matchesTopic(paper('2609.51004',['math.NA']),'cat:cs.NA'),true);
  assert.equal(matchesTopic({...cross,categories:undefined,primaryCategory:undefined},'astro-ph.CO'),false);
});

test('Atom parsing keeps primary and cross-list categories once, even when primary appears only in the extension',()=>{
  const p={...paper('2609.51001',['astro-ph.GA','astro-ph.GA','astro-ph.HE']),primaryCategory:'astro-ph.CO'};
  const parsed=parseFeed(feed([p])).papers[0];
  assert.equal(parsed.primaryCategory,'astro-ph.CO');
  assert.deepEqual(parsed.categories,['astro-ph.GA','astro-ph.HE','astro-ph.CO']);
  assert.deepEqual(matchingTopics(parsed,['21cm','astro-ph.CO','astro-ph.GA']),['astro-ph.CO','astro-ph.GA']);
});

test('mixed ranking selects best priority once and orders same-priority category matches by date',()=>{
  const papers=[paper('2609.51003',['astro-ph.GA']),paper('2609.51002',['astro-ph.CO'],window.since+3000),
    paper('2609.51001',['astro-ph.CO','astro-ph.GA'],window.since+1000,'Synthetic 21cm cosmology'),
    paper('2609.51004',['astro-ph.CO'],window.since+2000)];
  const result=rankPapers(papers,parseTopics('21cm cosmology, astro-ph.CO, astro-ph.GA'));
  assert.deepEqual(result.map(row=>row.paper.id),['2609.51001','2609.51002','2609.51004','2609.51003']);
  assert.deepEqual(result.map(row=>row.priority),[1,2,2,3]);
  assert.deepEqual(result[0].matched,['21cm','astro-ph.CO','astro-ph.GA']);
});

test('Weixin category subscribe/add/remove/priority commands remain deterministic and persist across restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'arxiv-categories-')),file=join(dir,'state.sqlite');
  let store=new Store(file);
  try {
    const key=subscriberKey('fixture','owner@im.wechat');
    const service=()=>({config,store,ready:true,clock:()=>now});
    const handler=createInboundHandler(service,config,quiet);
    const context={channelId:'openclaw-weixin',accountId:'fixture',conversationId:'owner@im.wechat'};
    const command=text=>handler({content:text},context).text;
    assert.match(command('/arxiv subscribe 21cm cosmology, astro-ph.co, CS.ai'),/P1：21cm\nP2：astro-ph.CO\nP3：cs.AI/);
    command('/arxiv add cat:astro-ph.CO');
    command('/arxiv priority 1 cat:CS.AI');
    assert.deepEqual(store.sub(key).topics,['cs.AI','21cm','astro-ph.CO']);
    const before=store.sub(key);
    assert.match(command('/arxiv add cs.BAD'),/分类代码/);
    assert.deepEqual(store.sub(key).topics,before.topics); assert.equal(store.sub(key).revision,before.revision);
    command('/arxiv remove CAT:cs.ai'); command('/arxiv add quant-ph');
    assert.deepEqual(store.sub(key).topics,['21cm','astro-ph.CO','quant-ph']);
    store.close(); store=new Store(file);
    assert.deepEqual(store.sub(key).topics,['21cm','astro-ph.CO','quant-ph']);
    // A pre-upgrade spelling is still movable/removable through its official alias.
    store.patchSub(key,{topics:['21cm','cs.NA']},now);
    command('/arxiv priority 1 math.NA'); assert.equal(store.sub(key).topics[0],'cs.NA');
    command('/arxiv remove cat:math.na'); assert.deepEqual(store.sub(key).topics,['21cm']);
    assert.deepEqual(handler({content:'你好'},context),{handled:true});
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('category-only and mixed daily retrieval retain first-submission boundaries, metadata filtering and deduplication',async t=>{
  const {store,sub,sent,service}=setup(t,'21cm, astro-ph.CO, astro-ph.GA');
  const fixtures=[
    paper('2609.51001',['astro-ph.CO','astro-ph.GA'],window.since,'Synthetic 21cm cosmology'),
    paper('2609.51002',['astro-ph.CO'],window.until-2),
    paper('2609.51003',['astro-ph.GA'],window.until-1),
    paper('2609.51004',['astro-ph.CO'],window.since-1),
    paper('2609.51005',['astro-ph.CO'],window.until),
    paper('2609.51006',['cs.AI'],window.since+1000,'Synthetic astro-ph.CO text mention'),
  ];
  let queries=0;
  service.client=new ArxivClient({store,config,clock:()=>now,fetchImpl:async url=>{
    queries++; assert.match(url.searchParams.get('search_query'),/cat:astro-ph\.CO/);
    return new Response(feed(fixtures));
  }});
  store.enqueue(sub.key,'daily',now,'2026-09-25'); await service.process(store.nextRun(now));
  assert.deepEqual(sent.map(msg=>/arXiv:(\d{4}\.\d+)v1/.exec(msg.text)[1]),['2609.51001','2609.51002','2609.51003']);
  assert.deepEqual(sent.map(msg=>/优先级：P(\d+)/.exec(msg.text)[1]),['1','2','3']);
  assert.match(sent[0].text,/匹配方向：21cm、astro-ph.CO、astro-ph.GA/);
  store.enqueue(sub.key,'now',now+1); await service.process(store.nextRun(now+1));
  assert.equal(sent.length,3); assert.equal(queries,2);
  assert.equal(store.delivery(sub.key,'2609.51004'),undefined); assert.equal(store.delivery(sub.key,'2609.51005'),undefined);
});

test('test chooses the highest matching category priority; retries never resume wrong categories or old papers',async t=>{
  const {store,sub,sent,service}=setup(t,'21cm, astro-ph.CO, astro-ph.GA');
  const best=paper('2609.51001',['astro-ph.CO']),other=paper('2609.51002',['astro-ph.GA'],window.until-1);
  store.putPapers([best,other],now);
  store.enqueue(sub.key,'test',now); await service.process(store.nextRun(now));
  assert.equal(sent.length,1); assert.match(sent[0].text,/优先级：P2 · astro-ph.CO/);
  const old=paper('2609.51003',['astro-ph.CO'],window.since-1),wrong=paper('2609.51004',['cs.AI']);
  store.putPapers([old,wrong],now);
  for(const p of [other,old,wrong]) store.prepareDelivery(sub.key,p.id,'none',[p.id],now);
  store.enqueue(sub.key,'retry',now+1); await service.process(store.nextRun(now+1));
  assert.equal(sent.length,2); assert.equal(sent[1].text,other.id);
  assert.equal(store.delivery(sub.key,old.id).next_part,0); assert.equal(store.delivery(sub.key,wrong.id).next_part,0);
});
