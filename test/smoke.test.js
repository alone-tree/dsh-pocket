import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createPocketService } from '../lib/service.mjs';

async function fakeUpstream() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>dsh</title></head><body>real-dsh</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

const deviceAuth = {
  status: () => ({ deviceCount: 1, devices: [], pending: [] }),
  hasApprovedDevice: (req) => String(req.headers.cookie ?? '').includes('device=yes'),
  authorizeRequest: (req) => String(req.headers.cookie ?? '').includes('approved=yes') ? { deviceId: 'device-1' } : null,
  handleHttp: async () => false,
};

test('真实链路：安全代理只监听 loopback，未认证导航不进入 DSH', async () => {
  const upstream = await fakeUpstream();
  const service = createPocketService({ dshPort: upstream.address().port, port: 0, deviceAuth });
  try {
    const proxy = await service.startProxy();
    assert.equal(proxy.server.address().address, '127.0.0.1');
    const login = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { accept: 'text/html' } });
    assert.match(await login.text(), /此浏览器尚未配对/);
    const entered = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { accept: 'text/html', cookie: 'approved=yes' } });
    const html = await entered.text();
    assert.match(html, /real-dsh/);
    assert.match(html, /data-dsh-pocket-session-guard/);
  } finally {
    await service.dispose();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('浏览器产物包含设备配对与密码认证，不依赖 WebAuthn，并保留移动端适配', async () => {
  const client = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');
  const auth = await readFile(new URL('../client/auth.js', import.meta.url), 'utf8');
  assert.match(client, /device\.pairingStart/);
  assert.match(client, /device\.revoke/);
  assert.match(client, /var React = require\("react"\)/);
  assert.match(client, /data-mobile-nav/);
  assert.match(auth, /pocket-auth\/login/);
  assert.match(auth, /pocket-pair\/submit/);
  assert.doesNotMatch(auth, /navigator\.credentials|PublicKeyCredential|WebAuthn/);
});

test('发布包不再提供无认证 CLI、LAN、PIN 或 Quick Tunnel 入口', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.bin, undefined);
  assert.equal(pkg.files.includes('bin'), false);
  const api = await readFile(new URL('../client/api.js', import.meta.url), 'utf8');
  const service = await readFile(new URL('../lib/service.mjs', import.meta.url), 'utf8');
  const tunnel = await readFile(new URL('../lib/tunnel.mjs', import.meta.url), 'utf8');
  const combined = `${api}\n${service}\n${tunnel}`;
  assert.doesNotMatch(combined, /token\.lanRefresh|pin\.setCustom|startQuickTunnel|trycloudflare\.com/);
});

test('插件入口模块可加载且 apply 为异步函数', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(mod.name, 'dsh-pocket');
  assert.equal(typeof mod.apply, 'function');
  assert.equal(mod.apply.constructor.name, 'AsyncFunction');
});
