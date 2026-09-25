import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from './store.js';
import { initializePersonal, personalIdentity } from './personal.js';
import { ZoteroStore } from './zotero-store.js';
import { ZoteroApi } from './zotero-api.js';
import { CredentialVault, loadApp } from './zotero-auth.js';
import { protectedCredentialCount } from './zotero-setup-check.js';
import { collectionRows, selectCollection } from './zotero-library.js';
import { question, choose } from './setup-ui.js';

export function writePrivateJson(file, value, {platform = process.platform, run = spawnSync} = {}) {
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    closeSync(openSync(temporary,'wx',0o600));
    if (platform === 'win32') {
      const identity = run('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});
      const sid = identity.status === 0 && /S-1-5-(?:\d+-)*\d+/.exec(identity.stdout)?.[0];
      if (!sid) throw new Error('Cannot identify Windows user for private file permissions.');
      const result = run('icacls.exe',[temporary,'/inheritance:r','/grant:r',`*${sid}:(F)`,'*S-1-5-18:(F)'],{encoding:'utf8',windowsHide:true});
      if (result.status !== 0) throw new Error('Cannot restrict credentials file permissions.');
    }
    writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600});
    renameSync(temporary,file);
  } finally { rmSync(temporary,{force:true}); }
}

export function initializeState(stateDir, config) {
  const store = new Store(join(stateDir,'arxiv-daily','state.sqlite'));
  try { return initializePersonal(store,config); } finally { store.close(); }
}

// Validate access and select a collection before stopping the Gateway or changing
// local credentials. Setup never writes to the remote Zotero library.
export async function prepareZotero({stateDir,config,ask = question,select = choose,api = new ZoteroApi({})}) {
  personalIdentity(config);
  const file = config.zotero?.credentialsFile || join(stateDir,'arxiv-daily','zotero-app.json');
  let encryptionKey;
  if (existsSync(file)) encryptionKey = loadApp(file).encryptionKey;
  else {
    if (protectedCredentialCount(join(stateDir,'arxiv-daily','state.sqlite'))) throw new Error('Restore the original Zotero credentials file before replacing keys.');
    encryptionKey = randomBytes(32).toString('base64');
  }
  console.log('Create your personal key: https://www.zotero.org/settings/keys/new');
  console.log('Enable Personal Library, Notes and Write access. Paste only into this terminal.');
  const apiKey = await ask('Zotero personal API key','',{hidden:true});
  const grant = await api.identify(apiKey);
  console.log(`Zotero: ${grant.username} (personal library ${grant.userId})`);
  const rows = collectionRows(await api.collections(grant));
  const choices = [{id:'root',label:'My Library / 根目录'},...rows.map(row => ({id:row.key,label:row.label}))];
  const selected = await select('Save selected papers into / 收藏位置',choices,0,ask);
  return {file,encryptionKey,grant,target:selectCollection(rows,selected.id)};
}

// Caller must stop the Gateway first, preventing concurrent key rotation/workers.
export function commitZotero(prepared, stateDir, config, now = Date.now()) {
  const {file,encryptionKey,grant,target} = prepared, owner = personalIdentity(config);
  const app = {mode:'personal',encryptionKey};
  writePrivateJson(file,app);
  const store = new Store(join(stateDir,'arxiv-daily','state.sqlite'));
  try {
    initializePersonal(store,config,now);
    const db = new ZoteroStore(store), vault = new CredentialVault(encryptionKey), generation = randomUUID();
    store.db.exec('BEGIN IMMEDIATE');
    try {
      db.disconnect(owner.key,now);
      db.bind(owner.key,{...grant,generation,credential:vault.seal(owner.key,grant)},now);
      db.target(owner.key,generation,target,now);
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  } finally { store.close(); }
  return {enabled:true,credentialsFile:file};
}
