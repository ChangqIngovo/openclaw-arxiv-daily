export function callbackCommand(address) {
  const url = new URL(address), token = url.searchParams.get('oauth_token'), verifier = url.searchParams.get('oauth_verifier');
  const valid = value => /^[A-Za-z0-9._~-]{1,256}$/.test(value || '');
  if (url.searchParams.has('oauth_problem') || url.searchParams.getAll('oauth_token').length !== 1
    || url.searchParams.getAll('oauth_verifier').length !== 1 || !valid(token) || !valid(verifier)) {
    throw new Error('没有收到有效授权结果。请回微信发送 /arxiv zotero connect 重新开始。');
  }
  return `/arxiv zotero finish ${token} ${verifier}`;
}

if (typeof document !== 'undefined') {
  const address = window.location.href;
  window.history.replaceState(null,'',window.location.pathname);
  const box = document.querySelector('#command'), status = document.querySelector('#status'), button = document.querySelector('#copy');
  try {
    box.value = callbackCommand(address); box.hidden = false; button.hidden = false;
    status.textContent = '复制下面的指令，发回刚才申请绑定的那个微信会话，完成个人文献库绑定。';
    button.addEventListener('click',async () => {
      try { await navigator.clipboard.writeText(box.value); button.textContent = '已复制，返回微信发送'; }
      catch { box.focus(); box.select(); status.textContent = '请长按或按 Ctrl+C 复制指令，再发回微信。'; }
    });
  } catch (error) { status.textContent = error.message; }
}
