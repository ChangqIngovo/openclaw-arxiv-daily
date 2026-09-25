import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { load } from 'cheerio/slim';

export const EXTRACTOR_VERSION = 'arxiv-body-v1';
export const MAX_BODY_CHARS = 480_000;
const sha = text => createHash('sha256').update(text).digest('hex');

export class BodyUnavailable extends Error {}

export function extractHtml(html) {
  const $ = load(html);
  const article = $('article.ltx_document').first().length ? $('article.ltx_document').first() : $('article').first();
  if (!article.length) throw new BodyUnavailable('HTML 未包含论文正文');
  if (article.find('.ltx_ERROR,.ltx_MISSING').length) throw new BodyUnavailable('HTML 包含正文转换错误');
  article.find('script,style,nav,button,form,iframe,noscript,.ltx_page_navbar,.ltx_page_footer').remove();
  article.find('math').each((_, node) => {
    const math = $(node);
    const formula = math.attr('alttext') || math.find('annotation[encoding="application/x-tex"]').text() || math.text();
    math.replaceWith($('<span>').text(` ${formula} `));
  });
  // Layout breaks preserve headings, paragraphs, tables and captions as plain data.
  article.find('h1,h2,h3,h4,h5,p,div.ltx_para,section,figcaption,tr,li,br').each((_, node) => {
    $(node).before('\n'); $(node).after('\n');
  });
  article.find('td,th').after(' | ');
  const normalize = text => text.replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const body = article.clone(); body.find('.ltx_abstract,.abstract,header,h1').remove();
  if (normalize(body.text()).length < 1200 || !body.find('section,.ltx_section').length && body.find('p').length < 3) {
    throw new BodyUnavailable('HTML 正文过短或只包含摘要');
  }
  const text = normalize(article.text());
  if (text.length > MAX_BODY_CHARS) throw new BodyUnavailable('正文超过 48 万字符处理上限，未截断概括');
  return {text};
}

export function extractPdf(bytes, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-worker.js', import.meta.url), {
      workerData: {bytes: new Uint8Array(bytes), maxChars: MAX_BODY_CHARS, maxPages: 300},
      resourceLimits: {maxOldGenerationSizeMb: 256},
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      void worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result);
    };
    const aborted = () => finish(signal.reason || new Error('Paper reading aborted'));
    const timer = setTimeout(() => finish(new BodyUnavailable('PDF 解析超时，未生成概括')), 60_000);
    signal?.addEventListener('abort', aborted, {once: true});
    if (signal?.aborted) aborted();
    worker.once('message', result => {
      // Keep the parser cause in local test/log errors. PaperReader publishes only
      // the friendly error.message, so filesystem paths do not enter Weixin replies.
      const cause = result.cause ? Object.assign(new Error(result.cause.message), {name: result.cause.name}) : undefined;
      result.error ? finish(new BodyUnavailable(result.error, {cause})) : finish(null, result);
    });
    worker.once('error', error => finish(new BodyUnavailable('PDF 解析失败', {cause: error})));
    worker.once('exit', () => { if (!settled) finish(new BodyUnavailable('PDF 解析进程提前退出')); });
  });
}

async function readLimited(response, limit) {
  if (Number(response.headers.get('content-length') || 0) > limit) {
    await response.body?.cancel(); throw new BodyUnavailable('正文下载超过大小上限');
  }
  if (!response.body) throw new BodyUnavailable('正文响应为空');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new BodyUnavailable('正文下载超过大小上限'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export class PaperReader {
  constructor({store, fetchImpl = fetch, clock = Date.now, waitForRequest = async () => {}, pdfParser = extractPdf}) {
    Object.assign(this, {store, fetchImpl, clock, waitForRequest, pdfParser});
  }
  async download(url, format, signal) {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
    let target = new URL(url);
    for (let redirects = 0; redirects <= 3; redirects++) {
      // Fixed arXiv sources only; a paper's links cannot introduce other fetch targets.
      if (target.protocol !== 'https:' || !['arxiv.org', 'export.arxiv.org'].includes(target.hostname) || target.username || target.password || target.port) {
        throw new BodyUnavailable('正文重定向超出 arXiv 来源');
      }
      await this.waitForRequest(requestSignal);
      const response = await this.fetchImpl(target, {signal: requestSignal, redirect: 'manual', headers: {
        Accept: format === 'HTML' ? 'text/html' : 'application/pdf',
        'User-Agent': 'openclaw-arxiv-daily/0.5.0 (OpenClaw literature digest)',
      }});
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new BodyUnavailable('正文重定向无目标');
        target = new URL(location, target); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new BodyUnavailable(`${format} HTTP ${response.status}`); }
      const bytes = await readLimited(response, format === 'HTML' ? 10_000_000 : 30_000_000);
      if (format === 'PDF' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new BodyUnavailable('下载结果不是 PDF');
      return bytes;
    }
    throw new BodyUnavailable('正文重定向次数过多');
  }
  async get(paper, signal) {
    signal?.throwIfAborted();
    if (!/^(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})$/i.test(paper.id) || !Number.isSafeInteger(paper.version) || paper.version < 1) {
      throw new Error('Invalid arXiv full-text identifier');
    }
    const key = `body:${EXTRACTOR_VERSION}:${paper.id}:v${paper.version}`;
    const cached = this.store.get(key);
    if (cached?.status === 'ready' || cached?.expires > this.clock()) return cached;
    const failures = [];
    for (const format of ['HTML', 'PDF']) {
      const url = `https://arxiv.org/${format.toLowerCase()}/${paper.id}v${paper.version}`;
      try {
        const bytes = await this.download(url, format, signal);
        const parsed = format === 'HTML' ? extractHtml(bytes.toString('utf8')) : await this.pdfParser(bytes, signal);
        const result = {status: 'ready', text: parsed.text, source: {
          format, url, pages: parsed.pages ?? null, characters: parsed.text.length,
          hash: sha(parsed.text), extractor: EXTRACTOR_VERSION,
        }};
        this.store.set(key, result); return result;
      } catch (error) {
        signal?.throwIfAborted();
        failures.push(error instanceof BodyUnavailable ? error.message : `${format} 下载或解析失败`);
      }
    }
    // Avoid fetching the same unavailable body for all subscribers in a batch.
    const result = {status: 'unavailable', reason: failures.join('；'), expires: this.clock() + 30 * 60_000};
    this.store.set(key, result); return result;
  }
}
