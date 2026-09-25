import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, win32 } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Store } from '../src/store.js';
import { pdfResourcePaths } from '../src/pdf-resources.js';
import { PaperReader, extractHtml, extractPdf, MAX_BODY_CHARS } from '../src/fulltext.js';
import { Summarizer, splitBody, formatPaper } from '../src/summary.js';

const now=Date.parse('2026-09-25T00:00:00Z');
const paper={id:'2609.40001',version:1,title:'Synthetic body fixture',abstract:'An abstract without detailed methods.',authors:[],published:now-86400000};
const paragraph='Synthetic methods and results for a test fixture, not a real scientific finding. '.repeat(20);
const html=`<html><body><nav>outside-navigation</nav><article class="ltx_document"><h1>${paper.title}</h1><div class="ltx_abstract">${paper.abstract}</div><section><h2>Methods</h2><p>${paragraph}</p><p>Equation <math alttext="x &lt; 7">incorrect duplicate math</math></p></section><section><h2>Conclusions</h2><p>Late conclusion marker: FINAL-BODY-EVIDENCE.</p><figure><figcaption>Caption evidence preserved.</figcaption></figure></section><script>unwanted-script</script></article></body></html>`;
const zhSummary=JSON.stringify({gap:'正文空白：'.repeat(10),work:'正文工作：'.repeat(10),method:'正文方法：'.repeat(10),conclusion:'正文结论：'.repeat(10)});
const goodBody=text=>({status:'ready',text,source:{format:'HTML',url:'https://arxiv.org/html/2609.40001v1',hash:'fixture'}});

// A valid, text-only synthetic PDF exercises the actual PDF.js worker without network.
function fixturePdf(pageTexts) {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageTexts.map((_,i)=>`${4+2*i} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const text of pageTexts) {
    const lines=[''];
    for(const word of text.split(' ')){
      if(lines.at(-1).length+word.length>90)lines.push('');
      lines[lines.length-1]+=(lines.at(-1)?' ':'')+word;
    }
    const content='BT /F1 10 Tf 12 TL 40 750 Td '+lines.map((line,i)=>
      `${i?'T* ':''}(${line.replace(/[\\()]/g,'\\$&')}) Tj`).join(' ')+' ET';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length+2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  let output='%PDF-1.4\n'; const offsets=[0];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(output));output+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const xref=Buffer.byteLength(output);
  output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

test('HTML reads body sections, equations, captions and final conclusions while rejecting abstract-only or oversized pages', () => {
  const result=extractHtml(html);
  assert.match(result.text,/FINAL-BODY-EVIDENCE/); assert.match(result.text,/Caption evidence preserved/);
  assert.match(result.text,/x < 7/); assert.doesNotMatch(result.text,/outside-navigation|unwanted-script|incorrect duplicate/);
  assert.throws(()=>extractHtml(`<article><div class="ltx_abstract">${paragraph}</div></article>`),/过短|摘要/);
  assert.throws(()=>extractHtml('<html><h1>Access denied</h1></html>'),/正文/);
  assert.throws(()=>extractHtml(html.replace('<p>Equation','<span class="ltx_ERROR">broken conversion</span><p>Equation')),/转换错误/);
  assert.throws(()=>extractHtml(html.replace(paragraph,'X'.repeat(MAX_BODY_CHARS+1))),/上限/);
});

test('PDF parser reads every page and fails honestly on an unreadable page', async () => {
  const result=await extractPdf(fixturePdf([paragraph+' FIRST-PAGE',paragraph+' FINAL-PAGE-CONCLUSION']));
  assert.equal(result.pages,2); assert.match(result.text,/FIRST-PAGE/); assert.match(result.text,/FINAL-PAGE-CONCLUSION/);
  await assert.rejects(extractPdf(fixturePdf([paragraph,'2'])),/第 2 页文本不足/);
});

test('PDF.js accepts Windows drive and UNC resource paths, rejecting the old trailing backslash', async () => {
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  for (const root of [String.raw`C:\Users\Example User\研究 #1\node_modules\pdfjs-dist`, String.raw`\\server\share\pdfjs-dist`]) {
    const bytes=fixturePdf([paragraph]);
    assert.throws(()=>getDocument({data:new Uint8Array(bytes),cMapUrl:win32.join(root,'cmaps')+win32.sep}), /must include trailing slash/);
    assert.throws(()=>getDocument({data:new Uint8Array(bytes),standardFontDataUrl:win32.join(root,'standard_fonts')+win32.sep}), /must include trailing slash/);
    const paths=pdfResourcePaths(root);
    assert.ok(Object.values(paths).every(p=>p.endsWith('/')&&!p.includes('\\')));
    const task=getDocument({data:new Uint8Array(bytes),...paths,useWorkerFetch:false,useWasm:false,verbosity:0});
    try { assert.equal((await task.promise).numPages,1); } finally { await task.destroy(); }
  }
  // The same normalized paths still work with Node's actual file reader.
  const installedRoot=dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const paths=pdfResourcePaths(installedRoot.replaceAll('/','\\'));
  assert.ok((await readFile(paths.standardFontDataUrl+'LiberationSans-Regular.ttf')).byteLength>0);
  assert.ok((await readFile(paths.cMapUrl+'Adobe-Japan1-0.bcmap')).byteLength>0);
});

test('PDF parser failures retain their cause for local diagnostics', async () => {
  await assert.rejects(extractPdf(Buffer.from('%PDF-1.4\ninvalid fixture')),error=>{
    assert.equal(error.name,'Error');
    assert.match(error.message,/PDF 无法完整提取文本/);
    assert.ok(error.cause?.message); assert.equal(error.cause.name,'InvalidPDFException');
    return true;
  });
});

test('HTML source is version-pinned and shared across subscribers; a new version triggers a fresh read', async () => {
  const store=new Store(':memory:'); const urls=[];let waits=0;
  const reader=new PaperReader({store,clock:()=>now,waitForRequest:async()=>{waits++;},fetchImpl:async u=>{urls.push(String(u));return new Response(html);}});
  const a=await reader.get(paper),b=await reader.get(paper);
  assert.equal(a.text,b.text);assert.equal(urls.length,1);assert.equal(a.source.format,'HTML');
  await reader.get({...paper,version:2});
  assert.deepEqual(urls,['https://arxiv.org/html/2609.40001v1','https://arxiv.org/html/2609.40001v2']);
  assert.equal(waits,2); store.close();
});

test('missing HTML falls back to PDF; total failure is cached briefly without calling the model', async () => {
  const store=new Store(':memory:');let requests=0,modelCalls=0;
  const reader=new PaperReader({store,clock:()=>now,fetchImpl:async u=>{
    requests++;return String(u).includes('/html/')?new Response('missing',{status:404}):new Response(fixturePdf([paragraph+' PDF-CONCLUSION']));
  }});
  const body=await reader.get(paper);assert.equal(body.status,'ready',body.reason);assert.equal(body.source.format,'PDF');assert.match(body.text,/PDF-CONCLUSION/);assert.equal(requests,2);
  const unavailable=new PaperReader({store,clock:()=>now,fetchImpl:async()=>{requests++;return new Response('missing',{status:404});}});
  const other={...paper,id:'2609.40002'};
  const summarizer=new Summarizer({store,reader:unavailable,agentId:'fixture',complete:async()=>{modelCalls++;}});
  const result=await summarizer.get(other,'zh');await summarizer.get(other,'zh');
  assert.equal(result.status,'unavailable');assert.equal(modelCalls,0);assert.equal(requests,4);
  assert.match(formatPaper(other,result,'zh',['fixture'],1,1),/未生成正文概括/);
  assert.doesNotMatch(formatPaper(other,result,'zh',['fixture'],1,1),/研究空白：/);store.close();
});

test('body download enforces size limits and blocks redirects outside arXiv', async () => {
  const store=new Store(':memory:');const urls=[];
  const reader=new PaperReader({store,clock:()=>now,fetchImpl:async u=>{
    urls.push(String(u));return String(u).includes('/html/')?new Response('',{status:302,headers:{location:'https://example.com/private'}})
      :new Response('%PDF-', {headers:{'content-length':'31000000'}});
  }});
  const result=await reader.get(paper);
  assert.equal(result.status,'unavailable');assert.match(result.reason,/超出 arXiv/);assert.match(result.reason,/大小上限/);
  assert.equal(urls.length,2); assert.ok(urls.every(u=>u.startsWith('https://arxiv.org/'))); store.close();
});

test('summary receives full body evidence, ignores old abstract cache and bypasses reading when language is none', async () => {
  const store=new Store(':memory:');let reads=0,completions=0;
  const oldHash=createHash('sha256').update(JSON.stringify([paper.title,paper.abstract])).digest('hex');
  store.putSummary([paper.id,paper.version,'zh','abstract-four-fields-v1',oldHash].join(':'),{gap:'stale abstract summary'},now);
  const summarizer=new Summarizer({store,agentId:'fixture',clock:()=>now,
    reader:{get:async()=>{reads++;return goodBody(extractHtml(html).text);}},complete:async params=>{
      completions++; const input=JSON.parse(params.messages[0].content);
      assert.match(input.paper_text,/FINAL-BODY-EVIDENCE/);assert.match(params.systemPrompt,/untrusted/);
      assert.equal(params.execution.mode,'isolated-agent-runtime');return{text:zhSummary};
    }});
  assert.equal(await summarizer.get(paper,'none'),null);assert.equal(reads,0);
  const result=await summarizer.get(paper,'zh');await summarizer.get(paper,'zh');
  assert.equal(completions,1);assert.equal(result.status,'ready');assert.equal(result.source.segments,1);
  assert.match(formatPaper(paper,result,'zh',['fixture'],1,1),/依据正文文本；未核验图像/);
  summarizer.reader={get:async()=>goodBody(extractHtml(html).text+' changed body')};
  await summarizer.get(paper,'zh');assert.equal(completions,2);store.close();
});

test('long-paper reading covers all characters and includes last-segment evidence in final summary', async () => {
  const store=new Store(':memory:');const body=('Methods and results 🙂.\n'.repeat(3200))+' END-OF-PAPER';
  assert.equal(splitBody(body).join(''),body);
  const segments=[],finalInputs=[];
  const summarizer=new Summarizer({store,agentId:'fixture',reader:{get:async()=>goodBody(body)},complete:async params=>{
    const input=JSON.parse(params.messages[0].content);
    if(input.segment){
      segments.push(input.paper_text);
      return{text:JSON.stringify({gap:'synthetic',work:'synthetic',method:'synthetic',conclusion:input.paper_text.includes('END-OF-PAPER')?'END-OF-PAPER':'intermediate',limitations:'synthetic'})};
    }
    finalInputs.push(input);return{text:zhSummary};
  }});
  const result=await summarizer.get(paper,'zh');
  assert.equal(segments.join(''),body);assert.equal(result.source.segments,segments.length);
  assert.equal(finalInputs.length,1);assert.equal(finalInputs[0].reading_notes.length,segments.length);
  assert.equal(finalInputs[0].reading_notes.at(-1).conclusion,'END-OF-PAPER');
  await summarizer.get(paper,'zh');assert.equal(finalInputs.length,1);store.close();
});
