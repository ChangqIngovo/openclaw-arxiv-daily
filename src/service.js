import { join } from 'node:path';
import { Store } from './store.js';
import { ArxivClient } from './arxiv.js';
import { Summarizer, formatPaper, chunkText } from './summary.js';
import { matchingTopics, parseTopics, rankPapers } from './topics.js';
import { localStamp, previousDayWindow, inWindow, isCurrentWindow } from './dates.js';
import { PaperReader } from './fulltext.js';

export { localStamp } from './dates.js';

export function resolveConfig(input = {}) {
  const c = {
    agentId: 'arxiv_bot_v1', defaultTopics: ['21cm', 'EoR', 'high redshift'],
    defaultLanguage: 'zh', sendTime: '08:00', timeZone: 'Asia/Shanghai',
    maxSubscribers: 50, maxResultsPerQuery: 2000, requestIntervalMs: 3200,
    ...input,
    // Accept legacy configs, but never let a previous 7-day setting broaden this range.
    lookbackDays: 1,
  };
  c.defaultTopics = parseTopics(c.defaultTopics);
  c.allowedAccountIds = [...new Set(c.allowedAccountIds || [])];
  if (!c.allowedAccountIds.length || c.allowedAccountIds.some(v => typeof v !== 'string' || !v)) throw new Error('arxiv-daily requires allowedAccountIds.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.sendTime)) throw new Error('Invalid sendTime.');
  new Intl.DateTimeFormat('en', {timeZone: c.timeZone}).format(new Date());
  if (!['zh', 'en', 'none'].includes(c.defaultLanguage)) throw new Error('Invalid defaultLanguage.');
  for (const [key, min, max] of [['maxSubscribers', 1, 50], ['maxResultsPerQuery', 100, 5000], ['requestIntervalMs', 3000, 60_000]]) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw new Error(`Invalid ${key}.`);
  }
  return c;
}

export function shouldSchedule(sub, now, config) {
  const current = localStamp(now, config.timeZone);
  const created = localStamp(sub.created, config.timeZone);
  return sub.active && current.time >= config.sendTime &&
    (created.day < current.day || created.day === current.day && created.time < config.sendTime);
}

function publicError(error) {
  const message = String(error?.message || error);
  if (/arXiv|方向过宽|概括|模型没有返回/.test(message)) return message.slice(0, 250);
  if (/ret=-2|context.?token|prepare failed/i.test(message)) return '微信拒绝主动发送。请先发一条 /arxiv status 刷新会话，再 /arxiv retry。';
  if (/auth|oauth|credential|401|403|sign.?in|login/i.test(message)) return '模型或通道认证失败，请管理员检查登录；不会尝试其他 API 计费方式。';
  if (/policy|override|permission|isolated|runtime|denied|unsupported|not allowed/i.test(message)) return 'OpenClaw 拒绝模型/插件运行，请管理员检查插件策略及版本。';
  if (/quota|rate.?limit|429|usage.?limit/i.test(message)) return '服务额度或频率受限，稍后重试。';
  if (/abort|timeout|timed out/i.test(message)) return '操作中断或超时，请查看发送状态后重试。';
  return '处理失败；请管理员查看 arxiv-daily 日志中的错误类别。';
}

// Only explicit provider rejections are safe automatic retry candidates.
// Network errors/timeouts after send are uncertain, never silently replayed.
export function sendFailureState(error) {
  return /sendMessage ret=-?\d+|account not configured|weixin not configured|session.*(?:expired|inactive)|cancelled by hook/i.test(String(error?.message || error)) ? 'failed' : 'unknown';
}

export class DigestService {
  constructor({config, stateDir, complete, send, logger = console, clock = Date.now, store, fetchImpl}) {
    Object.assign(this, {config, stateDir, complete, send, logger, clock});
    this.store = store; this.fetchImpl = fetchImpl; this.ready = false;
    this.abort = new AbortController(); this.work = null; this.timer = null; this.kickTimer = null;
  }
  start() {
    if (this.ready) return;
    this.store ??= new Store(join(this.stateDir, 'arxiv-daily', 'state.sqlite'));
    this.client = new ArxivClient({store: this.store, config: this.config, clock: this.clock, fetchImpl: this.fetchImpl});
    const reader = new PaperReader({store: this.store, fetchImpl: this.fetchImpl, clock: this.clock,
      waitForRequest: signal => this.client.waitForRequest(signal)});
    this.summarizer = new Summarizer({store: this.store, reader, complete: this.complete, agentId: this.config.agentId, clock: this.clock});
    this.ready = true;
    this.timer = setInterval(() => this.kick(), 30_000); this.timer.unref?.();
    this.logger.info(`[arxiv-daily] ready; daily ${this.config.sendTime} ${this.config.timeZone}; subscription-only Weixin; SQLite enabled.`);
    this.kick();
  }
  kick() {
    if (!this.ready || this.work || this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      this.work = this.tick().catch(error => {
        if (!this.abort.signal.aborted) this.logger.error(`[arxiv-daily] Worker stopped: ${publicError(error)}`);
      }).finally(() => { this.work = null; });
    }, 10);
    this.kickTimer.unref?.();
  }
  async stop() {
    this.ready = false; clearInterval(this.timer); clearTimeout(this.kickTimer);
    this.abort.abort(new Error('arxiv-daily service stopped'));
    if (this.work) await this.work;
    this.store?.close(); this.store = null;
  }
  schedule() {
    const now = this.clock(), day = localStamp(now, this.config.timeZone).day;
    for (const sub of this.store.subs()) {
      if (this.config.allowedAccountIds.includes(sub.account) && shouldSchedule(sub, now, this.config)) this.store.enqueue(sub.key, 'daily', now, day);
    }
  }
  async tick() {
    this.schedule();
    for (let job; !this.abort.signal.aborted && (job = this.store.nextRun(this.clock())); ) {
      await this.process(job);
    }
  }
  allowed(sub) { return sub?.active && this.config.allowedAccountIds.includes(sub.account); }
  async sendDelivery(key, paperId, expectedRevision, window = previousDayWindow(this.clock(), this.config.timeZone)) {
    let d = this.store.delivery(key, paperId);
    if (!d || d.status !== 'pending') return false;
    while (d.next_part < d.parts.length) {
      this.abort.signal.throwIfAborted();
      const current = this.store.sub(key);
      if (!this.allowed(current) || current.revision !== expectedRevision) return false;
      const paper = this.store.paper(paperId);
      if (!isCurrentWindow(window, this.clock()) || !inWindow(paper, window) || !matchingTopics(paper, current.topics).length) return false;
      this.store.deliveryStatus(key, paperId, 'sending', this.clock());
      try {
        const result = await this.send({accountId: current.account, to: current.peer, text: d.parts[d.next_part], signal: this.abort.signal});
        if (!result?.messageId) throw new Error('cancelled by hook: no provider message id');
        // The user may unsubscribe while the physical request is in flight.
        if (!this.store.sub(key)) return false;
        this.store.acknowledgePart(key, paperId, result.messageId, this.clock());
      } catch (error) {
        if (this.store.sub(key)) this.store.deliveryStatus(key, paperId, sendFailureState(error), this.clock(), publicError(error));
        throw error;
      }
      d = this.store.delivery(key, paperId);
    }
    return true;
  }
  async process(job) {
    let sent = 0, total = 0, physicalSend = false;
    const finish = (status, error = null) => this.store.runStatus(job.id, status, this.clock(), error, sent, total);
    const sub = this.store.sub(job.subscriber);
    if (!this.allowed(sub)) { finish('cancelled'); return; }
    const window = previousDayWindow(this.clock(), this.config.timeZone);
    if (localStamp(job.created, this.config.timeZone).day !== window.today || job.day && job.day !== window.today) {
      finish('cancelled', '旧日期任务已取消；只处理本次运行前一个自然日的新论文。'); return;
    }
    const eligibleDelivery = d => {
      const p = this.store.paper(d.paper);
      return inWindow(p, window) && matchingTopics(p, sub.topics).length;
    };
    const stillCurrent = () => isCurrentWindow(window, this.clock());
    finish('running');
    const signal = this.abort.signal;
    try {
      if (job.kind === 'retry') {
        const pending = this.store.unsubmitted(sub.key).filter(d => d.status === 'pending' && eligibleDelivery(d)); total = pending.length;
        for (const d of pending) {
          physicalSend = true;
          if (await this.sendDelivery(sub.key, d.paper, sub.revision, window)) sent++;
          else { finish('cancelled', '订阅或日期已变化，未继续发送。'); return; }
          physicalSend = false;
        }
        finish('done'); return;
      }
      await this.client.refresh(sub.topics, signal, window);
      if (!stillCurrent()) { finish('cancelled', '已跨日，停止旧日期任务。'); return; }
      let papers = rankPapers(this.store.papers(window.since, window.until)
        .filter(p => !this.store.delivery(sub.key, p.id)), sub.topics);
      const outstanding = this.store.unsubmitted(sub.key).filter(eligibleDelivery);
      const pending = outstanding.filter(d => d.status === 'pending');
      if (job.kind === 'test') papers = papers.slice(0, Math.max(0, 1 - pending.length));
      const resumable = job.kind === 'test' ? pending.slice(0, 1) : pending;
      total = papers.length + resumable.length;
      for (const d of resumable) {
        // A partial message continues in its existing format; topic edits do not replay old pending papers.
        physicalSend = true;
        if (await this.sendDelivery(sub.key, d.paper, sub.revision, window)) sent++;
        else { finish('cancelled', '订阅或日期已变化，未继续发送。'); return; }
        physicalSend = false;
      }
      for (let i = 0; i < papers.length; i++) {
        signal.throwIfAborted();
        let current = this.store.sub(sub.key);
        if (!stillCurrent() || !this.allowed(current) || current.revision !== sub.revision) { finish('cancelled', '订阅或日期已变化，未继续发送。'); return; }
        const {paper, matched, priority} = papers[i];
        const summary = await this.summarizer.get(paper, sub.language, signal);
        current = this.store.sub(sub.key);
        if (!stillCurrent() || !this.allowed(current) || current.revision !== sub.revision) { finish('cancelled', '订阅或日期已变化，未继续发送。'); return; }
        this.store.prepareDelivery(sub.key, paper.id, sub.language,
          chunkText(formatPaper(paper, summary, sub.language, matched, i + 1 + resumable.length, total, priority, this.config.timeZone)), this.clock());
        physicalSend = true;
        if (await this.sendDelivery(sub.key, paper.id, sub.revision, window)) sent++;
        else { finish('cancelled', '订阅或日期已变化，未继续发送。'); return; }
        physicalSend = false;
        finish('running');
      }
      if (!this.store.sub(sub.key)) return;
      this.store.patchSub(sub.key, {last_complete: this.clock()}, this.clock());
      const blocked = outstanding.filter(d => ['failed', 'unknown'].includes(d.status));
      finish('done', blocked.length ? `另有 ${blocked.length} 篇发送失败或结果不确定，请 /arxiv status 并按需 /arxiv retry。` : null);
      // Do not send an unsolicited empty-day message. Manual requests can inspect status.
      if (!total) this.logger.info('[arxiv-daily] No new matching paper; no outbound message requested.');
    } catch (error) {
      if (!stillCurrent()) finish('cancelled', '已跨日，停止旧日期任务。');
      else if (!physicalSend && job.attempts < 2 && !signal.aborted && this.allowed(this.store.sub(sub.key))) {
        this.store.reschedule(job, this.clock(), `${publicError(error)} 将在 ${(job.attempts + 1) * 15} 分钟后重试抓取/概括。`, sent, total);
      } else finish('failed', publicError(error));
      this.logger.warn(`[arxiv-daily] Digest ${job.kind} failed (${error?.name || 'Error'}): ${publicError(error)}`);
    }
  }
}
