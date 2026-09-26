import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const subscriberKey = (account, peer) => createHash('sha256').update(JSON.stringify([account, peer])).digest('hex');

export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscribers (
        key TEXT PRIMARY KEY, account TEXT NOT NULL, peer TEXT NOT NULL,
        topics TEXT NOT NULL, language TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, updated INTEGER NOT NULL,
        last_inbound INTEGER NOT NULL, last_complete INTEGER, last_manual INTEGER,
        UNIQUE(account,peer));
      CREATE TABLE IF NOT EXISTS papers (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, published INTEGER NOT NULL,
        data TEXT NOT NULL, first_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS summaries (
        key TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reading_snapshots (
        subscriber TEXT NOT NULL REFERENCES subscribers(key) ON DELETE CASCADE,
        paper TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL,
        PRIMARY KEY(subscriber,paper));
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, subscriber TEXT NOT NULL REFERENCES subscribers(key),
        kind TEXT NOT NULL, day TEXT, status TEXT NOT NULL, created INTEGER NOT NULL,
        updated INTEGER NOT NULL, error TEXT, sent INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS runs_queue ON runs(status,created);
      CREATE UNIQUE INDEX IF NOT EXISTS daily_once ON runs(subscriber,day) WHERE kind='daily';
      CREATE TABLE IF NOT EXISTS run_notices (
        run TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL, text TEXT NOT NULL, updated INTEGER NOT NULL,
        message_id TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS deliveries (
        subscriber TEXT NOT NULL REFERENCES subscribers(key), paper TEXT NOT NULL,
        status TEXT NOT NULL, language TEXT NOT NULL, parts TEXT NOT NULL,
        next_part INTEGER NOT NULL DEFAULT 0, message_ids TEXT NOT NULL DEFAULT '[]',
        updated INTEGER NOT NULL, error TEXT,
        PRIMARY KEY(subscriber,paper));
    `);
    const schema = this.get('schema');
    if (schema && schema !== 1) { this.db.close(); throw new Error('Unsupported arxiv-daily database version.'); }
    this.set('schema', 1);
    // An interrupted physical send cannot be assumed to have failed.
    this.db.prepare("UPDATE deliveries SET status='unknown',error='发送时进程中断，需核对后手动重试。' WHERE status='sending'").run();
    this.db.prepare("UPDATE run_notices SET status='unknown',error='无新论文通知发送时进程中断，结果不确定；请先核对微信，需要重新查询可用 /arxiv now。' WHERE status='sending'").run();
    this.db.prepare("UPDATE runs SET status='queued' WHERE status='running'").run();
  }
  close() { this.db.close(); }
  get(key) { const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return r ? JSON.parse(r.value) : undefined; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, JSON.stringify(value)); }
  sub(key) {
    const r = this.db.prepare('SELECT * FROM subscribers WHERE key=?').get(key);
    return r ? { ...r, topics: JSON.parse(r.topics), active: Boolean(r.active) } : undefined;
  }
  subs() { return this.db.prepare('SELECT key FROM subscribers ORDER BY created').all().map(r => this.sub(r.key)); }
  addSub({account, peer, topics, language}, now, max) {
    const key = subscriberKey(account, peer);
    const current = this.sub(key);
    if (!current) {
      if (Number(this.db.prepare('SELECT count(*) AS n FROM subscribers').get().n) >= max) throw new Error('订阅名额已满，请联系管理员。');
      this.db.prepare('INSERT INTO subscribers (key,account,peer,topics,language,created,updated,last_inbound) VALUES (?,?,?,?,?,?,?,?)')
        .run(key, account, peer, JSON.stringify(topics), language, now, now, now);
    } else this.patchSub(key, {topics, active: true}, now);
    return this.sub(key);
  }
  patchSub(key, patch, now) {
    const allowed = new Set(['topics', 'language', 'active', 'last_complete', 'last_manual', 'last_inbound']);
    for (const [field, value] of Object.entries(patch)) {
      if (!allowed.has(field)) throw new Error('Invalid subscription field');
      const converted = field === 'topics' ? JSON.stringify(value) : typeof value === 'boolean' ? Number(value) : value;
      this.db.prepare(`UPDATE subscribers SET ${field}=?,updated=? WHERE key=?`).run(converted, now, key);
    }
    if (['topics', 'language', 'active'].some(k => k in patch)) this.db.prepare('UPDATE subscribers SET revision=revision+1 WHERE key=?').run(key);
  }
  forget(key) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM deliveries WHERE subscriber=?').run(key);
      this.db.prepare('DELETE FROM runs WHERE subscriber=?').run(key);
      this.db.prepare('DELETE FROM subscribers WHERE key=?').run(key);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  putPapers(papers, now) {
    const q = this.db.prepare(`INSERT INTO papers VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      version=excluded.version,published=excluded.published,data=excluded.data WHERE excluded.version>=papers.version`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of papers) q.run(p.id, p.version, p.published, JSON.stringify(p), now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  papers(since, until = Number.MAX_SAFE_INTEGER) { return this.db.prepare('SELECT data FROM papers WHERE published>=? AND published<? ORDER BY published DESC,id').all(since, until).map(r => JSON.parse(r.data)); }
  paper(id) { const r = this.db.prepare('SELECT data FROM papers WHERE id=?').get(id); return r ? JSON.parse(r.data) : undefined; }
  summary(key) { const r = this.db.prepare('SELECT data FROM summaries WHERE key=?').get(key); return r ? JSON.parse(r.data) : undefined; }
  readingSnapshot(owner, paper) {
    const row = this.db.prepare('SELECT data FROM reading_snapshots WHERE subscriber=? AND paper=?').get(owner,paper);
    return row ? JSON.parse(row.data) : undefined;
  }
  putReadingSnapshot(owner, snapshot, now) {
    this.db.prepare('INSERT OR IGNORE INTO reading_snapshots VALUES (?,?,?,?)').run(owner,snapshot.paper.id,JSON.stringify(snapshot),now);
  }
  putSummary(key, data, now) { this.db.prepare('INSERT OR REPLACE INTO summaries VALUES (?,?,?)').run(key, JSON.stringify(data), now); }
  enqueue(key, kind, now, day = null) {
    // One outstanding job per subscriber; another daily tick will catch up.
    if (this.db.prepare("SELECT id FROM runs WHERE subscriber=? AND status IN ('queued','running')").get(key)) return false;
    const result = this.db.prepare("INSERT OR IGNORE INTO runs (id,subscriber,kind,day,status,created,updated) VALUES (?,?,?,?,'queued',?,?)")
      .run(randomUUID(), key, kind, day, now, now);
    return result.changes > 0;
  }
  nextRun(now = Date.now()) { return this.db.prepare("SELECT * FROM runs WHERE status='queued' AND next_attempt<=? ORDER BY created LIMIT 1").get(now); }
  reschedule(job, now, error, sent, total) {
    const attempts = job.attempts + 1;
    this.db.prepare("UPDATE runs SET status='queued',attempts=?,next_attempt=?,updated=?,error=?,sent=?,total=? WHERE id=?")
      .run(attempts, now + attempts * 15 * 60_000, now, error, sent, total, job.id);
  }
  runStatus(id, status, now, error = null, sent = 0, total = 0) {
    this.db.prepare('UPDATE runs SET status=?,updated=?,error=?,sent=?,total=? WHERE id=?').run(status, now, error, sent, total, id);
  }
  latestRun(key) { return this.db.prepare('SELECT * FROM runs WHERE subscriber=? ORDER BY created DESC,rowid DESC LIMIT 1').get(key); }
  runNotice(id) { return this.db.prepare('SELECT * FROM run_notices WHERE run=?').get(id); }
  startRunNotice(id, text, now) {
    return this.db.prepare("INSERT OR IGNORE INTO run_notices (run,status,text,updated) VALUES (?,'sending',?,?)").run(id,text,now).changes > 0;
  }
  finishRunNotice(id, status, now, error = null, messageId = null) {
    this.db.prepare('UPDATE run_notices SET status=?,updated=?,error=?,message_id=? WHERE run=?').run(status,now,error,messageId,id);
  }
  delivery(key, paper) {
    const r = this.db.prepare('SELECT * FROM deliveries WHERE subscriber=? AND paper=?').get(key, paper);
    return r ? { ...r, parts: JSON.parse(r.parts), message_ids: JSON.parse(r.message_ids) } : undefined;
  }
  prepareDelivery(key, paper, language, parts, now) {
    this.db.prepare("INSERT OR IGNORE INTO deliveries (subscriber,paper,status,language,parts,updated) VALUES (?,?,'pending',?,?,?)")
      .run(key, paper, language, JSON.stringify(parts), now);
    return this.delivery(key, paper);
  }
  deliveryStatus(key, paper, status, now, error = null) {
    this.db.prepare('UPDATE deliveries SET status=?,updated=?,error=? WHERE subscriber=? AND paper=?').run(status, now, error, key, paper);
  }
  acknowledgePart(key, paper, messageId, now) {
    const d = this.delivery(key, paper); const next = d.next_part + 1;
    this.db.prepare('UPDATE deliveries SET status=?,next_part=?,message_ids=?,updated=?,error=NULL WHERE subscriber=? AND paper=?')
      .run(next >= d.parts.length ? 'submitted' : 'pending', next, JSON.stringify([...d.message_ids, messageId]), now, key, paper);
  }
  retry(key, uncertain, now, window) {
    return this.db.prepare(`UPDATE deliveries SET status='pending',error=NULL,updated=? WHERE subscriber=? AND status IN (${uncertain ? "'failed','unknown'" : "'failed'"})
      AND paper IN (SELECT id FROM papers WHERE published>=? AND published<?)`)
      .run(now, key, window.since, window.until).changes;
  }
  deliveryCounts(key) { return this.db.prepare('SELECT status,count(*) AS n FROM deliveries WHERE subscriber=? GROUP BY status').all(key); }
  unsubmitted(key) { return this.db.prepare("SELECT * FROM deliveries WHERE subscriber=? AND status!='submitted' ORDER BY updated").all(key).map(r => this.delivery(key, r.paper)); }
}
