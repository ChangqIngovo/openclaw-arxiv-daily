const groups = [
  { name: '21cm', aliases: ['21cm', '21 cm', '21-cm', '21 centimeter', '21 centimetre', '21 centimeter line', '21 centimetre line'], search: ['21cm', '21 cm', '21-cm', '21 centimeter', '21 centimetre'] },
  { name: 'EoR', aliases: ['eor', 'epoch of reionization', 'epoch of reionisation', 'reionization', 'reionisation'], search: ['EoR', 'reionization', 'reionisation'] },
  { name: 'high redshift', aliases: ['high redshift', 'high-redshift', 'high z', 'high-z', 'highredshift'], search: ['high redshift', 'high-redshift', 'high z', 'high-z'] },
];

export const normalize = value => String(value).normalize('NFKC').toLowerCase()
  .replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim();

export function parseTopics(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[,，;；\n]/u);
  const result = [];
  for (const part of parts) {
    const text = String(part).normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    if (text.length > 70 || !/^[\p{L}\p{N}\s.\-+/#]+$/u.test(text)) {
      throw new Error('方向请用普通关键词，最多 70 字；多个方向用逗号分隔，不要输入查询语法。');
    }
    const group = groups.find(g => g.aliases.includes(normalize(text)));
    const canonical = group ? group.name : text;
    if (!result.some(t => normalize(t) === normalize(canonical))) result.push(canonical);
  }
  if (!result.length || result.length > 12) throw new Error('请提供 1–12 个方向，用逗号分隔。');
  return result;
}

export function searchTerms(topic) {
  return groups.find(g => normalize(g.name) === normalize(topic))?.search ?? [topic];
}

function escapeRegex(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function matchesTopic(paper, topic) {
  const source = normalize(`${paper.title} ${paper.abstract}`)
    .replace(/\\(?:mathrm|textrm|text|operatorname)\{([^}]+)\}/g, '$1')
    .replace(/\$|[{}]/g, '').replace(/\\[,;!]|~/g, ' ');
  return searchTerms(topic).some(term => {
    const pattern = escapeRegex(normalize(term)).replace(/[ -]+/g, '[\\s-]*');
    return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'u').test(source);
  });
}

export function matchingTopics(paper, topics) { return topics.filter(t => matchesTopic(paper, t)); }

export function buildQuery(topics, since, until) {
  const terms = [...new Set(topics.flatMap(searchTerms))];
  const fields = terms.map(t => `(ti:"${t}" OR abs:"${t}")`).join(' OR ');
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
  return topics.filter(t => { const key = normalize(t); if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => normalize(a).localeCompare(normalize(b)));
}
