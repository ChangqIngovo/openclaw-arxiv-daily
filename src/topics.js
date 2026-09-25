import { categoryCode } from './categories.js';

const groups = [
  { name: '21cm', aliases: ['21cm', '21 cm', '21-cm', '21 centimeter', '21 centimetre', '21 centimeter line', '21 centimetre line', '21cm cosmology', '21 cm cosmology', '21-cm cosmology'], search: ['21cm', '21 cm', '21-cm', '21 centimeter', '21 centimetre'] },
  { name: 'EoR', aliases: ['eor', 'epoch of reionization', 'epoch of reionisation', 'reionization', 'reionisation'], search: ['EoR', 'reionization', 'reionisation'] },
  { name: 'high redshift', aliases: ['high redshift', 'high-redshift', 'high z', 'high-z', 'highredshift'], search: ['high redshift', 'high-redshift', 'high z', 'high-z'] },
];

export const normalize = value => String(value).normalize('NFKC').toLowerCase()
  .replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim();

// Used for new subscriptions and older stored spellings, including category aliases.
const categoryForTopic = topic => categoryCode(normalize(topic).replace(/^cat\s*:\s*/i, ''));
export const topicKey = topic => normalize(categoryForTopic(topic) || topic);

function parseTopic(part) {
  const text = String(part).normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  if (text.length > 70) throw new Error('方向最多 70 字；多个关键词或分类代码用逗号分隔。');
  const category = categoryForTopic(text);
  if (category) return category;
  // Reject misspelled category selectors instead of silently searching them as text.
  if (/^cat\s*:/i.test(text) || /^(?:astro-ph|cond-mat|cs|econ|eess|math|nlin|physics|q-bio|q-fin|stat)\./i.test(normalize(text))
      || /^(?:hep|nucl)-[a-z-]+$/i.test(text)) {
    throw new Error('未识别的 arXiv 分类代码。请使用具体分类，如 astro-ph.CO、cs.AI、quant-ph；分类表：https://arxiv.org/category_taxonomy');
  }
  if (!/^[\p{L}\p{N}\s.\-+/#]+$/u.test(text)) {
    throw new Error('方向请用普通关键词或 arXiv 分类代码，最多 70 字；多个方向用逗号分隔，不支持通配符或布尔查询语法。');
  }
  const group = groups.find(g => g.aliases.includes(normalize(text)));
  return group ? group.name : text;
}

export function parseTopics(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[,，;；\n]/u);
  const result = [];
  for (const part of parts) {
    const canonical = parseTopic(part);
    if (canonical && !result.some(t => topicKey(t) === topicKey(canonical))) result.push(canonical);
  }
  if (!result.length || result.length > 12) throw new Error('请提供 1–12 个方向，用逗号分隔。');
  return result;
}

export function searchTerms(topic) {
  return groups.find(g => normalize(g.name) === normalize(topic))?.search ?? [topic];
}

function escapeRegex(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function matchesTopic(paper, topic) {
  const category = categoryForTopic(topic);
  if (category) {
    const listed = Array.isArray(paper.categories) ? paper.categories : [];
    return [...listed, paper.primaryCategory].some(value => categoryCode(value) === category);
  }
  const source = normalize(`${paper.title} ${paper.abstract}`)
    .replace(/\\(?:mathrm|textrm|text|operatorname)\{([^}]+)\}/g, '$1')
    .replace(/\$|[{}]/g, '').replace(/\\[,;!]|~/g, ' ');
  return searchTerms(topic).some(term => {
    const pattern = escapeRegex(normalize(term)).replace(/[ -]+/g, '[\\s-]*');
    return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'u').test(source);
  });
}

export function matchingTopics(paper, topics) { return topics.filter(t => matchesTopic(paper, t)); }

// Ranking belongs to each subscriber, never to the shared paper/query cache.
// A paper matching several topics appears once, at its best (lowest) rank.
export function rankPapers(papers, topics) {
  return papers.map(paper => {
    const matched = matchingTopics(paper, topics);
    return {paper, matched, priority: topics.indexOf(matched[0]) + 1};
  }).filter(item => item.priority > 0).sort((a, b) =>
    a.priority - b.priority || b.paper.published - a.paper.published ||
    (a.paper.id < b.paper.id ? -1 : a.paper.id > b.paper.id ? 1 : 0));
}

export function buildQuery(topics, since, until) {
  const clauses = parseTopicsUnion(topics).flatMap(topic => {
    const category = categoryForTopic(topic);
    return category ? [`cat:${category}`] : searchTerms(topic).map(term => `(ti:"${term}" OR abs:"${term}")`);
  });
  const fields = [...new Set(clauses)].join(' OR ');
  const stamp = ms => new Date(ms).toISOString().slice(0, 16).replace(/[-T:]/g, '');
  return `(${fields}) AND submittedDate:[${stamp(since)} TO ${stamp(until)}]`;
}

export function topicBatches(topics) {
  const result = []; let group = [], count = 0;
  for (const topic of parseTopicsUnion(topics)) {
    const size = searchTerms(topic).length;
    if (count + size > 15 && group.length) { result.push(group); group = []; count = 0; }
    group.push(topic); count += size;
  }
  if (group.length) result.push(group);
  return result;
}

function parseTopicsUnion(topics) {
  const seen = new Set();
  return topics.map(parseTopic).filter(Boolean)
    .filter(t => { const key = topicKey(t); if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => normalize(a).localeCompare(normalize(b)));
}
