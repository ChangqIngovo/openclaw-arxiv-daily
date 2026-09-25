import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function protectedCredentialCount(file) {
  if (!existsSync(file)) return 0;
  const db = new DatabaseSync(file,{readOnly:true});
  try {
    let count = 0;
    for (const table of ['zotero_accounts','zotero_auth','zotero_jobs']) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        const suffix = table === 'zotero_jobs' ? " WHERE status IN ('queued','running')" : '';
        count += Number(db.prepare(`SELECT count(*) AS n FROM ${table}${suffix}`).get().n);
      }
    }
    return count;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) process.exitCode = 1;
  else try { process.exitCode = protectedCredentialCount(process.argv[2]) ? 2 : 0; }
  catch { process.stderr.write('Cannot inspect existing Zotero credentials.\n'); process.exitCode = 1; }
}
