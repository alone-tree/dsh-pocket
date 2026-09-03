const $ = (id) => document.getElementById(id);

async function request(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    cache: 'no-store',
  });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `请求失败（${response.status}）`);
  return body;
}
function showError(error) {
  const box = $('error');
  if (!box) return;
  box.textContent = error?.message || String(error);
  box.hidden = false;
}
function clearError() { const box = $('error'); if (box) box.hidden = true; }
function setBusy(button, busy, text) {
  if (!button) return;
  if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? text : button.dataset.idleText;
}
async function login(event) {
  event.preventDefault();
  const button = $('login-button');
  const password = String($('login-password')?.value ?? '');
  if (password.length < 6) return showError(new Error('请输入至少 6 个字符的设备密码'));
  try {
    clearError(); setBusy(button, true, '正在验证…');
    const result = await request('/pocket-auth/login', { method: 'POST', body: JSON.stringify({ password }) });
    location.replace(result.redirect || '/');
  } catch (error) {
    showError(error); setBusy(button, false, '');
    const input = $('login-password');
    if (input) { input.value = ''; input.focus(); }
  }
}
async function pair(event) {
  event.preventDefault();
  const button = $('pair-button');
  const name = String($('device-name')?.value ?? '').trim();
  const password = String($('device-password')?.value ?? '');
  const confirmation = String($('device-password-confirm')?.value ?? '');
  const token = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (!token) return showError(new Error('配对链接无效或已经失效'));
  if (!name) return showError(new Error('请填写设备名称'));
  if (password.length < 6) return showError(new Error('设备密码至少需要 6 个字符'));
  if (password !== confirmation) return showError(new Error('两次输入的设备密码不一致'));
  try {
    clearError(); setBusy(button, true, '正在提交…');
    await request('/pocket-pair/submit', { method: 'POST', body: JSON.stringify({ token, name, password }) });
    $('pair-form').hidden = true;
    $('pair-complete').hidden = false;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  } catch (error) { showError(error); setBusy(button, false, ''); }
}
function boot() {
  $('login-form')?.addEventListener('submit', login);
  $('pair-form')?.addEventListener('submit', pair);
}
document.addEventListener('DOMContentLoaded', boot, { once: true });
