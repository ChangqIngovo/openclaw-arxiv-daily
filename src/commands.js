import { parseTopics, normalize } from './topics.js';
import { subscriberKey } from './store.js';

export const CHANNEL = 'openclaw-weixin';
export const HELP = [
  'arXiv 日报指令（只影响你自己的订阅）',
  '/arxiv subscribe 21cm, EoR, high redshift — 订阅/替换方向',
  '/arxiv add JWST — 增加方向',
  '/arxiv remove high redshift — 移除方向',
  '/arxiv topics — 当前方向',
  '/arxiv lang zh — 中文概括；en 英文；none 只发英文 abstract',
  '/arxiv test — 取最近 7 天内尚未发过的 1 篇试发',
  '/arxiv now — 现在补发最近 7 天内尚未发过的论文',
  '/arxiv status — 订阅、运行与发送状态',
  '/arxiv retry — 重试明确被微信拒绝的消息',
  '/arxiv retry uncertain — 核对手机后重试不确定的消息，可能重复',
  '/arxiv pause /arxiv resume — 暂停/恢复',
  '/arxiv unsubscribe — 删除本人的订阅和发送记录',
  '默认北京时间 08:00 开始，逐篇发送。普通聊天不会调用模型。',
].join('\n');

export class UserError extends Error {}

// The official Weixin 2.4.8 adapter sets From=To=from_user_id, but omits SenderId.
// Its trusted direct-chat conversationId is therefore the fallback identity.
// Never derive a recipient from message text, quoted content, or a model answer.
export function identity(event, context, config) {
  const account = context.accountId;
  const peer = context.senderId || event.senderId || context.conversationId;
  if (event.isGroup || !account || !peer || !/^[^\s\x00-\x1f]{1,240}@im\.wechat$/u.test(peer)) throw new UserError('无法确认微信收件人，请联系管理员检查通道版本。');
  if (!config.allowedAccountIds.includes(account)) throw new UserError('此微信连接尚未开通日报，请联系管理员加入账号。');
  if (context.senderId && context.conversationId && context.senderId !== context.conversationId) throw new UserError('收件人信息不一致，本次未更改订阅。');
  return {account, peer, key: subscriberKey(account, peer)};
}

export function runCommand(content, who, service) {
  const {store, config} = service;
  const now = service.clock();
  const match = /^\/arxiv(?:\s+(\S+)(?:\s+([\s\S]*))?)?\s*$/i.exec(content.trim());
  if (!match) return null;
  const command = (match[1] || 'help').toLowerCase(), args = (match[2] || '').trim();
  if (command === 'help') return HELP;
  let sub = store.sub(who.key);
  if (command === 'subscribe') {
    const topics = parseTopics(args || config.defaultTopics);
    sub = store.addSub({...who, topics, language: config.defaultLanguage}, now, config.maxSubscribers);
    return `已${sub.created === now ? '建立' : '更新'}你的订阅。\n方向：${sub.topics.join('、')}\n概括：${sub.language}\n每日 ${config.sendTime}（${config.timeZone}）开始。\n先发 /arxiv test 测试一篇；/arxiv help 查看指令。`;
  }
  if (!sub) return '你还没有订阅。发送：\n/arxiv subscribe 21cm, EoR, high redshift';
  store.patchSub(who.key, {last_inbound: now}, now);
  if (command === 'topics') return `你的方向：${sub.topics.join('、')}`;
  if (command === 'add' || command === 'remove') {
    const requested = parseTopics(args);
    const topics = command === 'add' ? parseTopics([...sub.topics, ...requested])
      : sub.topics.filter(t => !requested.some(r => normalize(r) === normalize(t)));
    if (!topics.length) return '不能移除最后一个方向；暂停推送请发送 /arxiv pause。';
    store.patchSub(who.key, {topics}, now);
    return `已更新你的方向：${topics.join('、')}。未来的推送使用新方向；正在发送的一条可能已经提交。`;
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
    store.forget(who.key);
    return '已删除你的日报订阅与本程序的个人发送记录。微信聊天记录和 OpenClaw 通道日志仍由原系统保存。';
  }
  if (command === 'status') {
    const run = store.latestRun(who.key);
    const names = {queued: '等待处理', running: '处理中', done: '完成', failed: '失败', cancelled: '已取消'};
    const counts = Object.fromEntries(store.deliveryCounts(who.key).map(r => [r.status, r.n]));
    return [
      `订阅：${sub.active ? '启用' : '暂停'}；${sub.topics.join('、')}`,
      `概括：${sub.language}；每日 ${config.sendTime} ${config.timeZone}`,
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
      const changed = store.retry(who.key, args === 'uncertain', now);
      if (!changed) return '没有可重试的消息。抓取或概括失败请使用 /arxiv now。';
    }
    const queued = store.enqueue(who.key, command, now);
    if (!queued) return '你的任务已经在队列中，用 /arxiv status 查看进度。';
    store.patchSub(who.key, {last_manual: now}, now);
    // The service's own timer picks this up within 30 seconds. Do not create
    // background model work inside a short-lived inbound hook/permission scope.
    return command === 'test' ? '已加入试发队列：取最近 7 天内尚未发过的 1 篇；这篇之后不会重复日报推送。'
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
      if (error instanceof UserError || /方向|订阅名额/.test(error.message)) return {handled: true, text: error.message};
      logger.error('[arxiv-daily] Subscription command failed; agent dispatch suppressed.');
      return {handled: true, text: '日报指令处理失败，请稍后重试或联系管理员；没有开启 AI 聊天。'};
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
