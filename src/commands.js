import { parseTopics, topicKey } from './topics.js';
import { subscriberKey } from './store.js';
import { previousDayWindow } from './dates.js';
import { isOwner } from './personal.js';
import { effectiveTimeZone, timeZoneLabel } from './timezone.js';

export const CHANNEL = 'openclaw-weixin';
export const HELP = [
  'arXiv 日报指令（只影响你自己的订阅）',
  '/arxiv subscribe 21cm cosmology, EoR, high redshift, JWST — 按优先级订阅/替换方向',
  '/arxiv subscribe 21cm cosmology, astro-ph.CO, cs.AI — 关键词和分类代码可混排，也支持 cat:astro-ph.CO',
  '/arxiv priority 1 21cm cosmology — 把已有方向移到第 1 位，其余顺移',
  '/arxiv add JWST — 在优先级末尾增加方向',
  '/arxiv remove high redshift — 移除方向',
  '/arxiv topics — 查看方向及 P1、P2…优先级；/arxiv priority 也可查看',
  '/arxiv lang zh — 读正文后中文概括；en 英文；none 只发英文 abstract',
  '/arxiv test — 按优先级试发前一个自然日新提交且尚未发过的 1 篇',
  '/arxiv now — 现在处理前一个自然日新提交且尚未发过的论文',
  '/arxiv status — 订阅、运行与发送状态',
  '/arxiv zotero — 绑定自己的 Zotero、选择文件夹及查看收藏状态',
  '/arxiv save arXiv编号 — 收藏已经收到的论文（需先绑定 Zotero）',
  '/arxiv retry — 重试明确被微信拒绝的消息',
  '/arxiv retry uncertain — 核对手机后重试不确定的消息，可能重复',
  '/arxiv pause /arxiv resume — 暂停/恢复',
  '/arxiv unsubscribe — 删除本人的订阅和发送记录',
  '默认跟随运行 OpenClaw 的电脑时区，每日当地时间 08:00 开始，逐篇发送。普通聊天不会调用模型。',
  '严格按首次提交日期筛选，不补发更早论文；读取不到正文时不生成概括。',
  '关键词或分类代码从左到右为 P1、P2…；P1 最高。分类含交叉分类，方向之间是“或”；同一篇只发一次，同级按日期从新到旧。',
].join('\n');

export class UserError extends Error {}
const priorityList = topics => topics.map((topic, i) => `P${i + 1}：${topic}`).join('\n');

// The official Weixin 2.4.8 adapter sets From=To=from_user_id, but omits SenderId.
// Its trusted direct-chat conversationId is therefore the fallback identity.
// Never derive a recipient from message text, quoted content, or a model answer.
export function identity(event, context, config) {
  const account = context.accountId;
  const peer = context.senderId || event.senderId || context.conversationId;
  if (event.isGroup || !account || !peer || !/^[^\s\x00-\x1f]{1,240}@im\.wechat$/u.test(peer)) throw new UserError('无法确认微信收件人，请在电脑检查微信连接。');
  if (!config.allowedAccountIds.includes(account)) throw new UserError('此微信连接尚未开通本机个人日报。请在自己的电脑安装个人版。');
  if (context.senderId && context.conversationId && context.senderId !== context.conversationId) throw new UserError('收件人信息不一致，本次未更改订阅。');
  return {account, peer, key: subscriberKey(account, peer)};
}

export function runCommand(content, who, service) {
  const {store, config} = service;
  const now = service.clock();
  if (!isOwner(config, who)) return '这个个人日报只接受本机绑定的微信账号指令。请在自己的电脑安装个人版。';
  const match = /^\/arxiv(?:\s+(\S+)(?:\s+([\s\S]*))?)?\s*$/i.exec(content.trim());
  if (!match) return null;
  const command = (match[1] || 'help').toLowerCase(), args = (match[2] || '').trim();
  if (command === 'help') return HELP;
  const needsTime = ['subscribe', 'status', 'retry', 'test', 'now'].includes(command);
  const zone = needsTime ? effectiveTimeZone(config.timeZone) : null;
  const zoneLabel = needsTime ? timeZoneLabel(config.timeZone) : null;
  let sub = store.sub(who.key);
  if (command === 'subscribe') {
    const topics = parseTopics(args || config.defaultTopics);
    sub = store.addSub({...who, topics, language: config.defaultLanguage}, now, config.personal ? Number.MAX_SAFE_INTEGER : config.maxSubscribers);
    return `已${sub.created === now ? '建立' : '更新'}你的订阅。\n优先级（P1 最高）：\n${priorityList(sub.topics)}\n概括：${sub.language}\n每日 ${config.sendTime} ${zoneLabel} 开始。\n先发 /arxiv test 测试一篇；/arxiv help 查看指令。`;
  }
  if (!sub) return '你还没有订阅。发送：\n/arxiv subscribe 21cm, EoR, high redshift';
  store.patchSub(who.key, {last_inbound: now}, now);
  if (command === 'zotero' || command === 'save') return service.zotero?.ready
    ? service.zotero.command(who.key,command,args)
    : '还未配置 Zotero。请在电脑终端运行：node install-arxiv-daily.cjs --configure-zotero，然后在本机填写自己的个人 API key。';
  if (command === 'topics' || command === 'priority' && !args) return `你的方向优先级（P1 最高）：\n${priorityList(sub.topics)}`;
  if (command === 'priority') {
    const move = /^([1-9]\d*)\s+(.+)$/.exec(args);
    if (!move) return '用法：/arxiv priority 1 21cm cosmology（序号 + 已有方向）；/arxiv topics 查看当前顺序。';
    const position = Number(move[1]);
    if (!Number.isSafeInteger(position) || position > sub.topics.length) return `优先级序号须为 1–${sub.topics.length}；本次未更改。`;
    const requested = parseTopics(move[2]);
    if (requested.length !== 1) return '每次只移动一个方向，例如 /arxiv priority 1 21cm cosmology。';
    const index = sub.topics.findIndex(t => topicKey(t) === topicKey(requested[0]));
    if (index < 0) return '该方向尚未订阅，请先用 /arxiv add 添加，再调整优先级。';
    if (index === position - 1) return `顺序无需改变：\n${priorityList(sub.topics)}`;
    const topics = [...sub.topics];
    const [topic] = topics.splice(index, 1);
    topics.splice(position - 1, 0, topic);
    store.patchSub(who.key, {topics}, now);
    return `已更新你的方向优先级（P1 最高）：\n${priorityList(topics)}\n下次处理按新顺序排列；已经开始发送的消息保留原格式。`;
  }
  if (command === 'add' || command === 'remove') {
    const requested = parseTopics(args);
    const topics = command === 'add' ? parseTopics([...sub.topics, ...requested])
      : sub.topics.filter(t => !requested.some(r => topicKey(r) === topicKey(t)));
    if (!topics.length) return '不能移除最后一个方向；暂停推送请发送 /arxiv pause。';
    store.patchSub(who.key, {topics}, now);
    return `已更新你的方向优先级（P1 最高）：\n${priorityList(topics)}\n未来的推送使用新顺序；正在发送的一条可能已经提交。`;
  }
  if (command === 'lang') {
    if (!['zh', 'en', 'none'].includes(args)) return '可选：/arxiv lang zh 或 en 或 none';
    store.patchSub(who.key, {language: args}, now);
    return `已设置概括：${args}。每篇仍附英文原始 abstract 和链接；已经开始发送的论文保留原格式。`;
  }
  if (command === 'pause' || command === 'resume') {
    store.patchSub(who.key, {active: command === 'resume'}, now);
    return command === 'pause' ? '已暂停你的日报；正在发送的一条可能已经提交。' : '已恢复你的日报。';
  }
  if (command === 'unsubscribe') {
    service.zotero?.cancelSubscriber(who.key);
    store.forget(who.key);
    return '已删除你的日报订阅与本程序的个人发送记录。微信聊天记录和 OpenClaw 通道日志仍由原系统保存。';
  }
  if (command === 'status') {
    const run = store.latestRun(who.key);
    const names = {queued: '等待处理', running: '处理中', done: '完成', failed: '失败', cancelled: '已取消'};
    const counts = Object.fromEntries(store.deliveryCounts(who.key).map(r => [r.status, r.n]));
    return [
      `订阅：${sub.active ? '启用' : '暂停'}\n方向优先级（P1 最高）：\n${priorityList(sub.topics)}`,
      `概括：${sub.language}；每日 ${config.sendTime} ${zoneLabel}`,
      `本次范围：${previousDayWindow(now, zone).day} 00:00–24:00（${zone}）首次提交的论文；不补历史。`,
      `最近任务：${run ? names[run.status] || run.status : '未运行'}${run ? `；已提交 ${run.sent}/${run.total} 篇` : ''}`,
      `累计：已提交 ${counts.submitted || 0}，失败 ${counts.failed || 0}，不确定 ${counts.unknown || 0}`,
      run?.error ? `原因：${run.error}` : '',
      '“已提交”只表示微信接口接受，是否收到请以手机为准。',
    ].filter(Boolean).join('\n');
  }
  if (['now', 'test', 'retry'].includes(command)) {
    if (!sub.active) return '订阅已暂停，请先发送 /arxiv resume。';
    if (sub.last_manual && now - sub.last_manual < 60_000) return '请等 1 分钟再请求，避免重复抓取和生成。';
    if (command === 'retry') {
      if (args && args !== 'uncertain') return '用 /arxiv retry；结果不确定的消息请先核对手机，再用 /arxiv retry uncertain。';
      if (store.latestRun(who.key)?.status === 'running') return '任务仍在运行，请稍后再重试。';
      const changed = store.retry(who.key, args === 'uncertain', now, previousDayWindow(now, zone));
      if (!changed) return '当前前一日范围内没有可重试的消息；更早消息不会补发。抓取或概括失败请使用 /arxiv now。';
    }
    const queued = store.enqueue(who.key, command, now);
    if (!queued) return '你的任务已经在队列中，用 /arxiv status 查看进度。';
    store.patchSub(who.key, {last_manual: now}, now);
    // The service's own timer picks this up within 30 seconds. Do not create
    // background model work inside a short-lived inbound hook/permission scope.
    return command === 'test' ? `已加入试发队列：按你的优先级取 ${previousDayWindow(now, zone).day}（${zoneLabel}）首次提交且尚未发过的 1 篇；这篇之后不会重复日报推送。`
      : '已加入处理队列。需要几分钟；/arxiv status 可查看结果。';
  }
  return '未识别的日报指令。发送 /arxiv help 查看用法。';
}

export function createInboundHandler(getService, config, logger = console) {
  return (event, context) => {
    if ((context.channelId || event.channel)?.toLowerCase() !== CHANNEL) return undefined;
    const content = typeof event.content === 'string' ? event.content.trim() : '';
    // Claim every Weixin message, even before startup or on errors. No LLM fallthrough.
    if (!/^\/arxiv(?:\s|$)/i.test(content)) return {handled: true};
    try {
      if (content.length > 1500) return {handled: true, text: '指令太长，请缩短到 1500 字以内。'};
      const who = identity(event, context, config);
      const service = getService();
      if (!service?.ready) return {handled: true, text: '日报服务还没有就绪，请稍后重试。'};
      return {handled: true, text: runCommand(content, who, service) || HELP};
    } catch (error) {
      if (error instanceof UserError || /方向|分类代码|订阅名额|电脑时区/.test(error.message)) return {handled: true, text: error.message};
      logger.error('[arxiv-daily] Subscription command failed; agent dispatch suppressed.');
      return {handled: true, text: '日报指令处理失败，请稍后重试或在电脑检查服务状态；没有开启 AI 聊天。'};
    }
  };
}

export function agentGate(event, context) {
  if ([context.channel, context.channelId, context.messageProvider, event.channelId].includes(CHANNEL)
      || (typeof context.sessionKey === 'string' && context.sessionKey.includes(`:${CHANNEL}:`))) {
    return {outcome: 'block', reason: 'arxiv-daily deterministic Weixin channel', category: 'subscription-only', message: '此微信助手仅处理 /arxiv 日报指令。'};
  }
  return undefined;
}
