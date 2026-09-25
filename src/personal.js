import { subscriberKey } from './store.js';

export const validPeer = value => typeof value === 'string' && /^[^\s\x00-\x1f]{1,240}@im\.wechat$/u.test(value);
export function isOwner(config, sub) {
  return Boolean(sub && config.allowedAccountIds.includes(sub.account)
    && (!config.personal || config.allowedAccountIds.length === 1 && sub.peer === config.ownerPeerId));
}
export function personalIdentity(config) {
  if (!config.personal || config.allowedAccountIds?.length !== 1 || !validPeer(config.ownerPeerId)) throw new Error('Personal setup needs one logged-in Weixin account and its verified peer.');
  const account = config.allowedAccountIds[0], peer = config.ownerPeerId;
  return {account, peer, key:subscriberKey(account,peer)};
}
// Called locally by the installer with the Gateway stopped. Preserve existing
// preferences, paused state, reading snapshots and records for inactive old users.
export function initializePersonal(store, config, now = Date.now()) {
  const who = personalIdentity(config);
  return store.sub(who.key) || store.addSub({...who,topics:config.defaultTopics,language:config.defaultLanguage},now,Number.MAX_SAFE_INTEGER);
}
