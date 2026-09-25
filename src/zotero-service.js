import { CredentialVault } from './zotero-auth.js';
import { ZoteroApi, ZoteroError, baseArxivId } from './zotero-api.js';
import { ZoteroStore } from './zotero-store.js';
import { collectionRows, selectCollection, deliverySnapshot, saveToLibrary } from './zotero-library.js';

export const ZOTERO_HELP = [
  '/arxiv zotero connect — 绑定自己的 Zotero 个人库',
  '/arxiv zotero folders [页码] — 查看文件夹',
  '/arxiv zotero folder 文件夹编号或名称 — 选择默认位置；root 表示根目录',
  '/arxiv save arXiv编号 — 收藏已收到的论文',
  '/arxiv zotero status — 查看绑定及收藏结果',
  '/arxiv zotero disconnect — 解除本人的绑定',
].join('\n');
const safeError = error => error instanceof ZoteroError ? error.message : 'Zotero 操作未能完成，请查看状态后重试；管理员可检查本地配置。';
const credentialPart = value => /^[A-Za-z0-9._~-]{1,256}$/.test(value || '');

export class ZoteroService {
  constructor({store, app, allowedAccountIds, send, logger = console, clock = Date.now, fetchImpl, api}) {
    Object.assign(this, {store, app, allowedAccountIds, send, logger, clock});
    this.db = new ZoteroStore(store); this.vault = new CredentialVault(app.encryptionKey);
    this.api = api || new ZoteroApi({app,store,clock,fetchImpl});
    this.abort = new AbortController(); this.ready = false; this.work = null; this.current = null;
  }
  start() {
    this.ready = true;
    // Background work belongs to the service, outside the short-lived message hook scope.
    this.timer = setInterval(() => this.kick(), 2000); this.timer.unref?.();
    this.kick();
  }
  kick() {
    if (!this.ready || this.work) return;
    this.work = this.tick().catch(() => this.logger.warn('[arxiv-daily] Zotero worker failed; credentials omitted.')).finally(() => {this.work = null;});
  }
  async stop() {
    this.ready = false; clearInterval(this.timer); this.abort.abort();
    if (this.work) await this.work;
  }
  cancelSubscriber(owner) { if (this.current?.owner === owner) this.current.controller.abort(); }
  allowed(owner) { const sub = this.store.sub(owner); return sub && this.allowedAccountIds.includes(sub.account); }
  auth(owner) { const row = this.db.auth(owner); return row?.expires > this.clock() ? row : undefined; }
  active(job) {
    if (!this.allowed(job.subscriber)) return false;
    if (['connect','finish'].includes(job.kind)) return this.auth(job.subscriber)?.generation === job.generation
      || job.kind === 'finish' && this.db.account(job.subscriber)?.generation === job.generation;
    return this.db.account(job.subscriber)?.generation === job.generation;
  }
  status(owner) {
    const account = this.db.account(owner), latest = this.db.latest(owner);
    const names = {queued:'等待处理',running:'处理中',done:'完成',failed:'失败',cancelled:'已取消'};
    return [account ? `Zotero：${account.username}（个人库 ${account.user_id}）\n默认文件夹：${account.target?.label || '尚未选择'}` : 'Zotero：尚未绑定。',
      latest ? `最近操作：${names[latest.status] || latest.status}${latest.result ? '\n' + latest.result : ''}` : '',
      '用 /arxiv zotero 查看指令。'].filter(Boolean).join('\n');
  }
  command(owner, command, args = '') {
    if (!this.allowed(owner)) return '此微信订阅不能使用 Zotero。';
    try {
      if (command === 'zotero') {
        const parsed = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args), action = (parsed?.[1] || 'help').toLowerCase(), value = (parsed?.[2] || '').trim();
        if (action === 'help') return ZOTERO_HELP;
        if (action === 'status') return this.status(owner);
        if (action === 'disconnect') {
          this.cancelSubscriber(owner); this.db.disconnect(owner, this.clock());
          return '已解除你的 Zotero 绑定并取消待处理操作；已发出的保存请求可能仍会完成。\n要撤销 Zotero 端的授权，可在 https://www.zotero.org/settings/keys 删除本应用的授权。';
        }
        if (this.db.busy(owner)) return '你的 Zotero 操作仍在处理中，用 /arxiv zotero status 查看结果。';
        if (action === 'connect') {
          if (this.db.account(owner)) return '你已经绑定 Zotero；重新授权或更换账号前，请先 /arxiv zotero disconnect。';
          const generation = this.db.beginAuth(owner, this.clock());
          return this.enqueue(owner,'connect',generation,{});
        }
        if (action === 'finish') {
          const [token,verifier,extra] = value.split(/\s+/), auth = this.auth(owner);
          if (extra || !credentialPart(token) || !credentialPart(verifier) || !auth?.credential) throw new ZoteroError('授权指令无效或已过期，请从自己的 /arxiv zotero connect 重新开始。');
          const pending = this.vault.open(owner,auth.credential);
          if ((pending.token || pending.sourceToken) !== token) throw new ZoteroError('这条授权指令不属于你的微信会话，本次未绑定。');
          return this.enqueue(owner,'finish',auth.generation,{token,verifier});
        }
        const account = this.db.account(owner);
        if (!account) return '请先发送 /arxiv zotero connect 绑定自己的个人文献库。';
        if (action === 'folders') {
          if (value && !/^[1-9]\d{0,3}$/.test(value)) return '用法：/arxiv zotero folders 或 /arxiv zotero folders 2';
          return this.enqueue(owner,'folders',account.generation,{page:Number(value || 1)});
        }
        if (action === 'folder') {
          if (!value) return '用法：/arxiv zotero folder 文件夹编号或名称；/arxiv zotero folders 查看列表。';
          return this.enqueue(owner,'folder',account.generation,{choice:value});
        }
        return ZOTERO_HELP;
      }
      if (command === 'save') {
        const id = baseArxivId(args), account = this.db.account(owner);
        if (!id) return '用法：/arxiv save 2609.30003（使用日报里的 arXiv 编号）';
        if (!account) return '请先 /arxiv zotero connect 绑定自己的 Zotero。';
        if (!account.target) return '请先 /arxiv zotero folders 查看文件夹，再用 /arxiv zotero folder 选择默认位置。';
        const snapshot = deliverySnapshot(this.store, owner, id);
        const requestedVersion = /v(\d+)$/i.exec(args);
        if (requestedVersion && Number(requestedVersion[1]) !== snapshot.paper.version) throw new ZoteroError(`这篇日报对应 v${snapshot.paper.version}，请使用消息中的版本或不带版本的编号。`);
        if (this.db.busy(owner)) return '你的 Zotero 操作仍在处理中，用 /arxiv zotero status 查看结果。';
        return this.enqueue(owner,'save',account.generation,{snapshot,target:account.target});
      }
      return ZOTERO_HELP;
    } catch (error) { return safeError(error); }
  }
  enqueue(owner, kind, generation, payload) {
    const id = this.db.enqueue(owner,kind,generation,this.vault.seal(owner,payload),this.clock());
    return id ? '已加入 Zotero 处理队列，完成后会回复；/arxiv zotero status 可查看结果。' : '你的 Zotero 操作已经在队列中。';
  }
  async tick() {
    for (let job; this.ready && !this.abort.signal.aborted && (job = this.db.next());) await this.process(job);
  }
  async process(job) {
    const controller = new AbortController(); this.current = {owner:job.subscriber,controller};
    const signal = AbortSignal.any([this.abort.signal,controller.signal]);
    const guard = () => { signal.throwIfAborted(); if (!this.active(job)) throw new ZoteroError('绑定或订阅已变化，本次操作已取消。'); };
    let result, status = 'done';
    try {
      guard(); this.db.state(job.id,'running',null,this.clock());
      const payload = this.vault.open(job.subscriber,job.payload);
      if (job.kind === 'connect') {
        const temporary = await this.api.temporary(signal); guard();
        if (!this.db.authData(job.subscriber,job.generation,'request',this.vault.seal(job.subscriber,temporary))) guard();
        result = `请在 15 分钟内打开 Zotero 官方授权页，登录你自己的账号并授权：\n${this.api.authorizeUrl(temporary.token)}\n授权完成后，把回调页面生成的指令发回本微信会话。`;
      } else if (job.kind === 'finish') {
        const auth = this.auth(job.subscriber);
        if (!auth?.credential) throw new ZoteroError('授权已过期，请重新连接。');
        let grant = this.vault.open(job.subscriber,auth.credential);
        if ((grant.token || grant.sourceToken) !== payload.token) throw new ZoteroError('授权会话不匹配。');
        if (auth.phase !== 'exchanged') {
          grant = await this.api.exchange(grant,payload.verifier,signal); guard();
          this.db.authData(job.subscriber,job.generation,'exchanged',this.vault.seal(job.subscriber,grant));
        }
        await this.api.verify(grant,signal); guard();
        this.db.bind(job.subscriber,{...grant,credential:this.vault.seal(job.subscriber,grant),generation:job.generation},this.clock());
        result = `已绑定你的 Zotero：${grant.username}（个人库 ${grant.userId}）。\n发送 /arxiv zotero folders 选择保存文件夹。`;
      } else {
        const account = this.db.account(job.subscriber), grant = this.vault.open(job.subscriber,account.credential);
        if (String(grant.userId) !== account.user_id) throw new ZoteroError('Zotero 个人账号不匹配。');
        await this.api.verify(grant,signal); guard();
        if (job.kind === 'folders' || job.kind === 'folder') {
          const rows = collectionRows(await this.api.collections(grant,signal)); guard();
          if (job.kind === 'folder') {
            const target = selectCollection(rows,payload.choice);
            if (!this.db.target(job.subscriber,job.generation,target,this.clock())) guard();
            result = `已选择你的 Zotero 文件夹：${target.label}\n收藏论文：/arxiv save arXiv编号`;
          } else {
            const pages = Math.max(1,Math.ceil(rows.length/12)), page = payload.page;
            if (page > pages) throw new ZoteroError(`文件夹列表只有 ${pages} 页。`);
            const labels = rows.slice((page-1)*12,page*12).map(row => `${row.key}  ${row.label.length > 150 ? row.label.slice(0,147)+'…' : row.label}`);
            result = `你的 Zotero 文件夹（${page}/${pages}）：\n${labels.join('\n') || '尚无文件夹；请先在 Zotero 创建并同步。'}\n选择：/arxiv zotero folder 八位编号\n根目录：/arxiv zotero folder root${page < pages ? `\n下一页：/arxiv zotero folders ${page+1}` : ''}`;
          }
        } else if (job.kind === 'save') {
          // Verify ownership again when the queue is processed, including after a restart.
          if (!this.store.delivery(job.subscriber,payload.snapshot.paper.id)?.next_part) throw new ZoteroError('本会话没有这篇论文的发送记录。');
          const saved = await saveToLibrary(this.api,grant,payload.snapshot,payload.target,guard,signal); guard();
          result = `已收藏到你的 Zotero：${saved.target}\narXiv:${payload.snapshot.paper.id}v${payload.snapshot.paper.version}\n条目：${saved.key}\n包含文献信息、可用阅读笔记及 PDF 链接；Zotero 同步后可见。`;
        } else throw new ZoteroError('未知 Zotero 操作。');
      }
      guard();
    } catch (error) { status = signal.aborted || !this.active(job) ? 'cancelled' : 'failed'; result = safeError(error); }
    this.current = null;
    this.db.state(job.id,status,result,this.clock());
    if (!this.active(job) || signal.aborted) return;
    const sub = this.store.sub(job.subscriber);
    // Save result before sending. Delivery failures are inspectable, never blindly replayed.
    try {
      const receipt = await this.send({accountId:sub.account,to:sub.peer,text:result,signal});
      if (!receipt?.messageId) throw new Error('No receipt');
    } catch { this.logger.warn('[arxiv-daily] Zotero result notification unconfirmed; use /arxiv zotero status.'); }
  }
}
