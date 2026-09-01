import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';

const $ = (id) => document.getElementById(id);

async function request(path, init = {}) {
  const response = await fetch(path, {
    ...init,
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

function setBusy(button, busy, text) {
  if (!button) return;
  if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? text : button.dataset.idleText;
}

async function login() {
  const button = $('login-button');
  try {
    setBusy(button, true, '等待手机确认…');
    const { requestId, options } = await request('/pocket-auth/options');
    const response = await startAuthentication({ optionsJSON: options });
    const result = await request('/pocket-auth/verify', {
      method: 'POST',
      body: JSON.stringify({ requestId, response }),
    });
    location.replace(result.redirect || '/');
  } catch (error) {
    showError(error);
    setBusy(button, false, '');
  }
}

async function pair(event) {
  event.preventDefault();
  const button = $('pair-button');
  const name = String($('device-name')?.value ?? '').trim();
  const token = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (!token) return showError(new Error('配对链接无效或已经失效'));
  if (!name) return showError(new Error('请填写设备名称'));

  try {
    setBusy(button, true, '等待手机确认…');
    const { options } = await request('/pocket-pair/options', {
      method: 'POST',
      body: JSON.stringify({ token, name }),
    });
    const response = await startRegistration({ optionsJSON: options });
    await request('/pocket-pair/verify', {
      method: 'POST',
      body: JSON.stringify({ token, response }),
    });
    $('pair-form').hidden = true;
    $('pair-complete').hidden = false;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  } catch (error) {
    showError(error);
    setBusy(button, false, '');
  }
}

function boot() {
  if (!browserSupportsWebAuthn()) {
    showError(new Error('当前浏览器不支持手机身份验证，请使用最新版 Safari、Chrome 或 Edge'));
    document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    return;
  }
  $('login-button')?.addEventListener('click', login);
  $('pair-form')?.addEventListener('submit', pair);
}

document.addEventListener('DOMContentLoaded', boot, { once: true });
