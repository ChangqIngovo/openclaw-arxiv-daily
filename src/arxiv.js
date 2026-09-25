import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildQuery, topicBatches } from './topics.js';
import { inWindow, previousDayWindow } from './dates.js';

export { DAY } from './dates.js';
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = value => typeof value === 'string' ? value : value?.['#text'] ?? '';
const plain = value => text(value).replace(/\s+/g, ' ').trim();

export function parseFeed(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('arXiv XML 包含不支持的实体声明。');
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error('arXiv 返回的 XML 无法解析。');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false, removeNSPrefix: true }).parse(xml);
  const feed = parsed.feed;
  if (!feed || feed.totalResults == null) throw new Error('arXiv 返回的不是搜索结果。');
  const total = Number(text(feed.totalResults));
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('arXiv totalResults 无效。');
  const papers = array(feed.entry).map(entry => {
    const rawId = plain(entry.id);
    const m = /^https?:\/\/(?:export\.)?arxiv\.org\/abs\/(\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v(\d+))?$/i.exec(rawId);
    if (!m) throw new Error('arXiv 返回错误条目或未知论文编号。');
    const p = {
      id: m[1], version: Number(m[2] ?? 1), title: plain(entry.title),
      // Only normalize XML layout whitespace; no translation, truncation, or paraphrase.
      abstract: plain(entry.summary), authors: array(entry.author).map(a => plain(a.name)),
      published: Date.parse(plain(entry.published)), updated: Date.parse(plain(entry.updated)),
      categories: array(entry.category).map(c => c['@_term']).filter(Boolean),
      url: `https://arxiv.org/abs/${m[1]}`, pdf: `https://arxiv.org/pdf/${m[1]}`,
    };
    if (!p.title || !p.abstract || !Number.isFinite(p.published) || !Number.isFinite(p.updated)) throw new Error('arXiv 条目缺少摘要或日期。');
    return p;
  });
  return {total, papers};
}

export class ArxivClient {
  constructor({store, config, fetchImpl = fetch, clock = Date.now, sleep = delay}) {
    Object.assign(this, {store, config, fetchImpl, clock, sleep});
    this.lastRequest = 0;
  }
  async waitForRequest(signal) {
    signal?.throwIfAborted();
    const wait = this.lastRequest + this.config.requestIntervalMs - this.clock();
    if (wait > 0) await this.sleep(wait, undefined, {signal});
    this.lastRequest = this.clock();
  }
  async refresh(topics, signal, window = previousDayWindow(this.clock(), this.config.timeZone)) {
    const now = this.clock();
    for (const batch of topicBatches(topics)) {
      // The API has inclusive minute precision. Recheck the exclusive end locally.
      const query = buildQuery(batch, window.since, window.until);
      const key = 'previous-day-query:' + createHash('sha256').update(query).digest('hex');
      if (this.store.get(key)?.complete) continue;
      const collected = []; const uniqueIds = new Set(); let start = 0, total = 0;
      do {
        signal?.throwIfAborted();
        await this.waitForRequest(signal);
        const url = new URL('https://export.arxiv.org/api/query');
        url.search = new URLSearchParams({ search_query: query, start: String(start), max_results: '100', sortBy: 'submittedDate', sortOrder: 'descending' }).toString();
        const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
        const response = await this.fetchImpl(url, { signal: requestSignal, headers: { Accept: 'application/atom+xml', 'User-Agent': 'openclaw-arxiv-daily/0.4.0 (OpenClaw literature digest)' } });
        if (!response.ok) throw new Error(`arXiv HTTP ${response.status}，稍后用 /arxiv now 重试。`);
        const declared = Number(response.headers?.get('content-length') ?? 0);
        if (declared > 8_000_000) throw new Error('arXiv 响应过大。');
        const xml = await response.text();
        if (xml.length > 8_000_000) throw new Error('arXiv 响应过大。');
        const page = parseFeed(xml); total = page.total;
        if (total > this.config.maxResultsPerQuery) throw new Error(`方向过宽：${window.day} 返回 ${total} 篇。请缩小方向后重试；没有丢弃或默默截断论文。`);
        if (!page.papers.length && start < total) throw new Error('arXiv 分页未返回完整结果，请稍后重试。');
        let added = 0;
        for (const p of page.papers) { if (!uniqueIds.has(p.id)) { uniqueIds.add(p.id); collected.push(p); added++; } }
        if (page.papers.length && !added) throw new Error('arXiv 分页重复，未把不完整结果记为成功。');
        start += page.papers.length;
      } while (start < total);
      const eligible = collected.filter(p => inWindow(p, window));
      this.store.putPapers(eligible, now);
      this.store.set(key, {complete: true, at: now, count: eligible.length});
    }
    this.store.set('lastFetch', this.clock());
  }
}
