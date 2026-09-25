import { createHash } from 'node:crypto';
import { oauthHeader } from './zotero-auth.js';

const API = 'https://api.zotero.org';
const ID = /^(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?$/i;
export const collectionKey = value => /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(value);
export const baseArxivId = value => ID.test(String(value)) ? String(value).replace(/v\d+$/i, '').toLowerCase() : null;
export class ZoteroError extends Error { constructor(message) { super(message); this.name = 'ZoteroError'; } }

export function objectKey(userId, paperId, kind) {
  const alphabet = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';
  const bytes = createHash('sha256').update(JSON.stringify(['arxiv-daily-zotero-v1', String(userId), paperId, kind])).digest();
  return Array.from(bytes.subarray(0, 8), b => alphabet[b & 31]).join('');
}

export function itemArxivId(item) {
  const d = item?.data || item || {};
  if (['note', 'attachment'].includes(d.itemType)) return null;
  try {
    const url = new URL(d.url);
    if (['arxiv.org','export.arxiv.org','www.arxiv.org'].includes(url.hostname)) {
      const found = /^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/.exec(url.pathname);
      const id = found && baseArxivId(found[1]); if (id) return id;
    }
  } catch {}
  const extra = /^\s*arXiv\s*:\s*((?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?)\s*$/im.exec(d.extra || '');
  return extra ? baseArxivId(extra[1]) : /arxiv/i.test(d.repository || d.archive || '') ? baseArxivId(d.archiveID || '') : null;
}

export class ZoteroApi {
  constructor({app, fetchImpl = fetch, clock = Date.now, store}) { Object.assign(this, {app, fetchImpl, clock, store}); this.pauseUntil = store?.get('zotero-backoff-until') || 0; }
  async request(url, {key, method = 'GET', body, headers = {}, signal, missing = false, form = false} = {}) {
    signal?.throwIfAborted();
    if (this.clock() < this.pauseUntil) throw new ZoteroError(`Zotero 要求等待，请在 ${Math.ceil((this.pauseUntil - this.clock()) / 1000)} 秒后重试。`);
    const address = new URL(url);
    if (address.protocol !== 'https:' || ![API, 'https://www.zotero.org'].includes(address.origin)
      || key && address.origin !== API) throw new ZoteroError('Zotero 请求地址无效。');
    const timeout = AbortSignal.timeout(30_000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetchImpl(url, {method, redirect: 'error', signal: combined, headers: {
        'Zotero-API-Version': '3', Accept: form ? 'application/x-www-form-urlencoded' : 'application/json',
        ...(key ? {'Zotero-API-Key': key} : {}), ...(body ? {'Content-Type': 'application/json'} : {}), ...headers,
      }, ...(body ? {body: JSON.stringify(body)} : {})});
      const backoff = Number(response.headers.get('Backoff') || response.headers.get('Retry-After') || (response.status === 429 ? 60 : 0));
      if (Number.isFinite(backoff) && backoff > 0) {
        this.pauseUntil = this.clock() + Math.min(backoff, 86400) * 1000;
        this.store?.set('zotero-backoff-until', this.pauseUntil);
      }
      if (missing && response.status === 404) { await response.body?.cancel(); return {status: 404, data: null}; }
      if (!response.ok) {
        await response.body?.cancel();
        const message = [401,403].includes(response.status) ? 'Zotero 授权无效或权限不足，请解除绑定后重新授权。'
          : response.status === 412 ? 'Zotero 文献同时被修改，请重新发送收藏指令以合并最新状态。'
          : response.status === 429 ? 'Zotero 暂时限制请求频率，请稍后重试。' : `Zotero 请求失败（HTTP ${response.status}），请稍后重试。`;
        throw new ZoteroError(message);
      }
      if (response.status === 204) return {status: 204, data: null};
      const parts = []; let size = 0;
      for await (const part of response.body || []) {
        size += part.length;
        if (size > 4_000_000) { throw new ZoteroError('Zotero 返回的数据过大，本次操作未继续。'); }
        parts.push(Buffer.from(part));
      }
      const text = Buffer.concat(parts).toString('utf8');
      const data = form ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text);
      return {status: response.status, data, total: Number(response.headers.get('Total-Results'))};
    } catch (error) {
      if (error instanceof ZoteroError) throw error;
      if (combined.aborted || signal?.aborted) throw new ZoteroError('Zotero 请求已中断或超时；请查看状态后重试。');
      throw new ZoteroError('Zotero 网络请求或返回格式异常；请查看状态后重试。');
    }
  }
  async temporary(signal) {
    const url = 'https://www.zotero.org/oauth/request';
    const {data} = await this.request(url, {method:'POST', signal, form:true,
      headers: {Authorization: oauthHeader('POST', url, this.app, {now:this.clock(), extra:{oauth_callback:this.app.callbackUrl}})}});
    if (!data.oauth_token || !data.oauth_token_secret || data.oauth_callback_confirmed !== 'true') throw new ZoteroError('Zotero 未确认回调地址，请管理员检查 OAuth 应用配置。');
    return {token:data.oauth_token, secret:data.oauth_token_secret};
  }
  authorizeUrl(token) {
    const url = new URL('https://www.zotero.org/oauth/authorize');
    for (const [key, value] of Object.entries({oauth_token:token, name:'arXiv Daily', library_access:'1', notes_access:'1', write_access:'1', all_groups:'none'})) url.searchParams.set(key, value);
    return url.href;
  }
  async exchange(temporary, verifier, signal) {
    const url = 'https://www.zotero.org/oauth/access';
    const {data} = await this.request(url, {method:'POST', signal, form:true,
      headers: {Authorization:oauthHeader('POST', url, this.app, {now:this.clock(), token:temporary.token,
        tokenSecret:temporary.secret, extra:{oauth_verifier:verifier}})}});
    if (!data.oauth_token || !data.oauth_token_secret || !/^\d+$/.test(data.userID || '')) throw new ZoteroError('Zotero 没有返回有效的个人账号，请重新授权。');
    return {apiKey:data.oauth_token_secret, userId:data.userID, username:data.username || data.userID, sourceToken:temporary.token};
  }
  async verify(grant, signal) {
    const {data} = await this.request(`${API}/keys/current`, {key:grant.apiKey, signal});
    const access = data?.access?.user;
    if (String(data?.userID) !== String(grant.userId) || !access?.library || !access?.write || !access?.notes) {
      throw new ZoteroError('请授权同一个 Zotero 个人库的读取、笔记及写入权限；本功能不使用群组库。');
    }
    return data;
  }
  prefix(grant) {
    if (!/^\d+$/.test(String(grant.userId))) throw new ZoteroError('Zotero 个人账号无效。');
    return `${API}/users/${grant.userId}`;
  }
  async list(grant, path, signal, limit = 5000) {
    const rows = []; let expected;
    for (let start = 0; start < limit; start += 100) {
      const url = new URL(this.prefix(grant) + path); url.searchParams.set('limit','100'); url.searchParams.set('start',String(start));
      const r = await this.request(url.href, {key:grant.apiKey, signal});
      if (!Array.isArray(r.data)) throw new ZoteroError('Zotero 列表格式无效。');
      if (r.total > limit || expected !== undefined && r.total !== expected) throw new ZoteroError('Zotero 列表过大或正在变化，请稍后重试。');
      expected = r.total; rows.push(...r.data);
      if (r.data.length < 100 || expected > 0 && rows.length >= expected) return rows;
    }
    throw new ZoteroError('Zotero 列表未能完整读取，本次操作未继续。');
  }
  collections(grant, signal) { return this.list(grant, '/collections', signal); }
  async getItem(grant, key, signal) {
    if (!collectionKey(key)) throw new ZoteroError('Zotero 条目编号无效。');
    return (await this.request(`${this.prefix(grant)}/items/${key}`, {key:grant.apiKey, signal, missing:true})).data;
  }
  async ensureItem(grant, data, matches, guard, signal) {
    guard(); const existing = await this.getItem(grant, data.key, signal); guard();
    if (existing) {
      if (!matches(existing) || existing.data?.deleted) throw new ZoteroError('Zotero 条目冲突或已在回收站，请先在 Zotero 检查。');
      return existing;
    }
    // Version 0 means create-only. A retry or collision cannot overwrite an existing object.
    let failure;
    try {
      guard();
      const {data:reply} = await this.request(`${this.prefix(grant)}/items`, {method:'POST', key:grant.apiKey, body:[{...data,version:0}], signal});
      if (reply.failed?.['0'] || !(reply.successful?.['0'] || reply.success?.['0'] || reply.unchanged?.['0'])) failure = new ZoteroError('Zotero 未确认条目写入，请重试收藏指令。');
    } catch (error) { failure = error; }
    guard();
    // Reconcile successful, partially successful, and uncertain responses by object key.
    const saved = await this.getItem(grant, data.key, signal); guard();
    if (saved && matches(saved) && !saved.data?.deleted) return saved;
    throw failure || new ZoteroError('Zotero 写入后未能核对条目，请重试收藏指令。');
  }
  async findPaper(grant, paperId, signal) {
    const key = objectKey(grant.userId, paperId, 'paper');
    const deterministic = await this.getItem(grant, key, signal);
    if (deterministic) {
      if (itemArxivId(deterministic) !== paperId || deterministic.data?.deleted) throw new ZoteroError('Zotero 已有条目冲突或在回收站，请先检查。');
      return deterministic;
    }
    const results = await this.list(grant, `/items/top?q=${encodeURIComponent(paperId)}&qmode=everything`, signal, 2000);
    const matches = results.filter(item => itemArxivId(item) === paperId && !item.data?.deleted);
    if (matches.length > 1) throw new ZoteroError('你的 Zotero 已有多条同编号文献，请先合并重复条目后再收藏。');
    return matches[0];
  }
  async addCollection(grant, item, target, guard, signal) {
    if (!target?.key) return item;
    for (let attempt = 0; attempt < 3; attempt++) {
      guard();
      const current = attempt ? await this.getItem(grant, item.key || item.data.key, signal) : item; guard();
      if (!current || current.data?.deleted) throw new ZoteroError('Zotero 文献已删除，请先检查。');
      const collections = current.data.collections || [];
      if (collections.includes(target.key)) return current;
      try {
        guard();
        await this.request(`${this.prefix(grant)}/items/${current.key || current.data.key}`, {key:grant.apiKey, method:'PATCH',
          headers:{'If-Unmodified-Since-Version':String(current.version ?? current.data.version)},
          body:{collections:[...collections,target.key]}, signal});
        guard(); return current;
      } catch (error) { if (!/同时被修改/.test(error.message) || attempt === 2) throw error; }
    }
  }
  async template(type, signal) {
    return (await this.request(`${API}/items/new?itemType=${encodeURIComponent(type)}`, {signal})).data;
  }
}
