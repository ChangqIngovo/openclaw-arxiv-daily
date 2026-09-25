import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const oauthEncode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// RFC 5849: sort encoded keys and values bytewise, including duplicate parameters.
export function oauthSignature(method, address, pairs, clientSecret, tokenSecret = '') {
  const url = new URL(address);
  const parameters = [...url.searchParams, ...pairs].filter(([key]) => key !== 'oauth_signature' && key !== 'realm')
    .map(([key, value]) => [oauthEncode(key), oauthEncode(value)])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('&');
  const base = [method.toUpperCase(), `${url.origin}${url.pathname || '/'}`, parameters].map(oauthEncode).join('&');
  return createHmac('sha1', `${oauthEncode(clientSecret)}&${oauthEncode(tokenSecret)}`).update(base).digest('base64');
}

export function oauthHeader(method, url, app, {token = '', tokenSecret = '', extra = {}, now = Date.now(), nonce = randomBytes(18).toString('hex')} = {}) {
  const fields = {oauth_consumer_key: app.clientKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(now / 1000)), oauth_version: '1.0', ...extra, ...(token ? {oauth_token: token} : {})};
  fields.oauth_signature = oauthSignature(method, url, Object.entries(fields), app.clientSecret, tokenSecret);
  return 'OAuth ' + Object.entries(fields).map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`).join(', ');
}

export function validateApp(app) {
  if (!app || !/^[A-Za-z0-9_-]{8,256}$/.test(app.clientKey || '') || !/^[A-Za-z0-9._~-]{8,256}$/.test(app.clientSecret || '')) {
    throw new Error('Invalid Zotero application credentials.');
  }
  const callback = new URL(app.callbackUrl);
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash) throw new Error('Zotero callback must be a public HTTPS page without query parameters.');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(app.encryptionKey || '') || Buffer.from(app.encryptionKey, 'base64').length !== 32) throw new Error('Invalid Zotero encryption key.');
  return {...app, callbackUrl: callback.href};
}

export const loadApp = file => validateApp(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));

export class CredentialVault {
  constructor(key) { this.key = Buffer.from(key, 'base64'); if (this.key.length !== 32) throw new Error('Invalid vault key.'); }
  seal(owner, value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`arxiv-daily:zotero:${owner}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(x => x.toString('base64')).join('.');
  }
  open(owner, value) {
    const [iv, tag, data, extra] = String(value).split('.').map(x => Buffer.from(x, 'base64'));
    if (extra || !iv || iv.length !== 12 || !tag || tag.length !== 16 || !data) throw new Error('Invalid encrypted credential.');
    const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`arxiv-daily:zotero:${owner}`)); cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
  }
}
