import { randomUUID } from 'node:crypto';

const decode = row => row ? {...row, target: row.target ? JSON.parse(row.target) : null} : undefined;

export class ZoteroStore {
  constructor(store) {
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS zotero_accounts (
        subscriber TEXT PRIMARY KEY REFERENCES subscribers(key) ON DELETE CASCADE,
        user_id TEXT NOT NULL, username TEXT NOT NULL, credential TEXT NOT NULL,
        generation TEXT NOT NULL, target TEXT, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS zotero_auth (
        subscriber TEXT PRIMARY KEY REFERENCES subscribers(key) ON DELETE CASCADE,
        generation TEXT NOT NULL, phase TEXT NOT NULL, credential TEXT, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS zotero_jobs (
        id TEXT PRIMARY KEY, subscriber TEXT NOT NULL REFERENCES subscribers(key) ON DELETE CASCADE,
        kind TEXT NOT NULL, generation TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL, result TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS zotero_one_pending ON zotero_jobs(subscriber) WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS zotero_queue ON zotero_jobs(status,created);
    `);
    // Reconciliation reads deterministic item keys before retrying any library write.
    this.db.prepare("UPDATE zotero_jobs SET status='queued' WHERE status='running'").run();
  }
  account(owner) { return decode(this.db.prepare('SELECT * FROM zotero_accounts WHERE subscriber=?').get(owner)); }
  bind(owner, account, now) {
    this.db.prepare('INSERT INTO zotero_accounts VALUES (?,?,?,?,?,?,?)').run(owner, account.userId, account.username,
      account.credential, account.generation, null, now);
    this.db.prepare('DELETE FROM zotero_auth WHERE subscriber=?').run(owner);
  }
  target(owner, generation, target, now) {
    return this.db.prepare('UPDATE zotero_accounts SET target=?,updated=? WHERE subscriber=? AND generation=?')
      .run(JSON.stringify(target), now, owner, generation).changes === 1;
  }
  auth(owner) { return this.db.prepare('SELECT * FROM zotero_auth WHERE subscriber=?').get(owner); }
  beginAuth(owner, now) {
    const generation = randomUUID();
    this.db.prepare("INSERT OR REPLACE INTO zotero_auth VALUES (?,?,'new',NULL,?)").run(owner, generation, now + 15 * 60_000);
    return generation;
  }
  authData(owner, generation, phase, credential) {
    return this.db.prepare('UPDATE zotero_auth SET phase=?,credential=? WHERE subscriber=? AND generation=?')
      .run(phase, credential, owner, generation).changes === 1;
  }
  enqueue(owner, kind, generation, payload, now) {
    const id = randomUUID();
    const r = this.db.prepare("INSERT OR IGNORE INTO zotero_jobs VALUES (?,?,?,?,?,'queued',NULL,?,?)")
      .run(id, owner, kind, generation, payload, now, now);
    return r.changes ? id : null;
  }
  busy(owner) { return this.db.prepare("SELECT id FROM zotero_jobs WHERE subscriber=? AND status IN ('queued','running')").get(owner); }
  next() { return this.db.prepare("SELECT * FROM zotero_jobs WHERE status='queued' ORDER BY created,rowid LIMIT 1").get(); }
  latest(owner) { return this.db.prepare('SELECT * FROM zotero_jobs WHERE subscriber=? ORDER BY created DESC,rowid DESC LIMIT 1').get(owner); }
  state(id, status, result, now) {
    // A disconnect during an in-flight request must not revive the cancelled job.
    this.db.prepare("UPDATE zotero_jobs SET status=?,result=?,updated=?,payload=CASE WHEN ? IN ('done','failed','cancelled') THEN '{}' ELSE payload END WHERE id=? AND status IN ('queued','running')")
      .run(status, result, now, status, id);
  }
  disconnect(owner, now) {
    this.db.prepare('DELETE FROM zotero_accounts WHERE subscriber=?').run(owner);
    this.db.prepare('DELETE FROM zotero_auth WHERE subscriber=?').run(owner);
    this.db.prepare("UPDATE zotero_jobs SET status='cancelled',result='已解除绑定。',payload='{}',updated=? WHERE subscriber=? AND status IN ('queued','running')").run(now, owner);
  }
}
