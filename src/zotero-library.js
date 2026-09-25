import { ZoteroError, objectKey, itemArxivId, collectionKey } from './zotero-api.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function readingNote(snapshot) {
  const {paper, summary, language, legacyMessage} = snapshot;
  const start = `<h2>${escape(paper.title)}</h2><p>arXiv Daily · 自动生成的阅读笔记 · arXiv:${escape(paper.id)}v${paper.version}</p>`;
  if (legacyMessage) return `${start}<pre>${escape(legacyMessage)}</pre>`;
  if (!summary || language === 'none') return null;
  if (summary.status !== 'ready') return `${start}<p>未生成正文概括：正文未能完整读取。</p>`;
  const labels = language === 'en' ? ['Gap','Work','Method','Conclusion'] : ['研究空白','做了什么','怎么做的','结论'];
  return start + ['gap','work','method','conclusion'].map((field, i) => `<p><strong>${labels[i]}</strong>：${escape(summary[field])}</p>`).join('')
    + `<p>正文来源：${escape(summary.source?.format)} · ${escape(summary.source?.url)}</p>`;
}

export function collectionRows(items) {
  const map = new Map(items.map(item => [item.key || item.data?.key, item.data]));
  const path = (key, seen = new Set()) => {
    const row = map.get(key);
    if (!row || seen.has(key) || seen.size > 30) throw new ZoteroError('Zotero 文件夹结构正在变化，请稍后重试。');
    seen.add(key);
    return row.parentCollection ? `${path(row.parentCollection, seen)}/${row.name}` : row.name;
  };
  return [...map].map(([key, row]) => {
    if (!collectionKey(key) || typeof row?.name !== 'string') throw new ZoteroError('Zotero 文件夹数据无效。');
    return {key, name:row.name, label:path(key)};
  }).sort((a, b) => a.label.localeCompare(b.label));
}

export function selectCollection(rows, choice) {
  if (choice === 'root') return {key:null,label:'我的文献库根目录'};
  const exactKey = rows.find(row => row.key === choice);
  const candidates = exactKey ? [exactKey] : rows.filter(row => row.label === choice || row.name === choice);
  if (candidates.length !== 1) throw new ZoteroError(candidates.length
    ? '有多个同名文件夹，请用 /arxiv zotero folders 查看并填写八位文件夹编号。'
    : '未找到这个文件夹，请用 /arxiv zotero folders 查看；文件夹需先在 Zotero 中创建并同步。');
  return {key:candidates[0].key, label:candidates[0].label};
}

export function deliverySnapshot(store, owner, id) {
  const delivery = store.delivery(owner, id);
  if (!delivery || delivery.next_part < 1) throw new ZoteroError('只能收藏已经发给你的日报论文，请使用消息中的 arXiv 编号。');
  const snapshot = store.readingSnapshot(owner, id);
  if (snapshot) return snapshot;
  // Upgrades can still save an old delivery, using its actual version and original message.
  const paper = store.paper(id);
  const message = delivery.parts.map(part => part.replace(/^\[同一篇论文 \d+\/\d+\]\n/, '')).join('');
  const match = /arXiv:([^\s]+)v(\d+)\s*·/.exec(message);
  if (!paper || match?.[1] !== id || Number(match?.[2]) !== paper.version) {
    throw new ZoteroError('这篇旧日报缺少对应版本的元数据，请通过原文链接导入 Zotero。');
  }
  return {paper, language:delivery.language, legacyMessage:message, matched:[]};
}

export async function saveToLibrary(api, grant, snapshot, target, guard, signal) {
  const {paper} = snapshot;
  guard();
  if (!target || target.key && !collectionKey(target.key)) throw new ZoteroError('请先用 /arxiv zotero folder 选择默认文件夹。');
  if (target.key) {
    const result = await api.request(`${api.prefix(grant)}/collections/${target.key}`, {key:grant.apiKey,signal,missing:true}); guard();
    if (!result.data) throw new ZoteroError('所选 Zotero 文件夹已删除，请重新选择。');
  }
  let parent = await api.findPaper(grant, paper.id, signal); guard();
  if (!parent) {
    const template = await api.template('preprint', signal); guard();
    const data = {...template, key:objectKey(grant.userId,paper.id,'paper'), itemType:'preprint',
      title:paper.title, creators:paper.authors.map(name => ({creatorType:'author',name})),
      abstractNote:paper.abstract, repository:'arXiv', archiveID:paper.id,
      date:new Date(paper.published).toISOString(), url:`https://arxiv.org/abs/${paper.id}v${paper.version}`,
      extra:`arXiv: ${paper.id}v${paper.version}`, language:'en', libraryCatalog:'arXiv',
      tags:[...new Set(['arxiv-daily',...(snapshot.matched || [])])].map(tag => ({tag})),
      collections:target.key ? [target.key] : [], relations:{}};
    parent = await api.ensureItem(grant, data, item => itemArxivId(item) === paper.id, guard, signal);
  }
  const parentKey = parent.key || parent.data.key;
  await api.addCollection(grant, parent, target, guard, signal); guard();
  const note = readingNote(snapshot);
  if (note) {
    if (note.length > 200_000) throw new ZoteroError('阅读笔记过长；文献可能已经保存，请在 Zotero 检查。');
    await api.ensureItem(grant, {key:objectKey(grant.userId,paper.id,'note'), itemType:'note',parentItem:parentKey,
      note,tags:[{tag:'arxiv-daily'}],collections:[],relations:{}},
    item => item.data?.itemType === 'note' && item.data.parentItem === parentKey, guard, signal);
  }
  await api.ensureItem(grant, {key:objectKey(grant.userId,paper.id,'pdf-link'),itemType:'attachment',parentItem:parentKey,
    linkMode:'linked_url',title:`arXiv PDF · ${paper.id}v${paper.version}`,url:`https://arxiv.org/pdf/${paper.id}v${paper.version}`,
    contentType:'application/pdf',tags:[],collections:[],relations:{}},
  item => item.data?.itemType === 'attachment' && item.data.parentItem === parentKey, guard, signal);
  guard(); return {key:parentKey,target:target.label};
}
