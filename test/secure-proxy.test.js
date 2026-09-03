import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createPocketProxy } from '../lib/proxy.mjs';

async function listen(server) { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function close(server) { await new Promise((resolve) => server.close(resolve)); }
function get(port, host, path = '/') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host, accept: 'text/html' } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
function channel(host) {
  const name = String(host).replace(/:\d+$/, '').toLowerCase();
  if (name === 'work.example.com') return 'named';
  if (name.endsWith('.trycloudflare.com')) return 'quick';
  return 'reject';
}
function mockDeviceAuth(authorized = false) {
  return {
    status: () => ({ deviceCount: 1 }),
    hasApprovedDevice: () => false,
    authorizeRequest: () => authorized ? { deviceId: 'd1' } : null,
    handleHttp: async () => false,
  };
}

test('Named 只在精确 hostname 使用设备认证，Quick 保留 PIN，陌生公网 Host 拒绝', async () => {
  const upstream = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<html><head></head><body>UPSTREAM</body></html>'); });
  const upstreamPort = await listen(upstream);
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: upstreamPort },
    deviceAuth: mockDeviceAuth(false), publicChannelForHost: channel,
    auth: { sessionKey: 'session', isProtected: () => true, getToken: () => '12345678' },
  });
  try {
    const named = await get(proxy.port, 'work.example.com');
    assert.equal(named.status, 200);
    assert.match(named.body, /此浏览器尚未配对/);
    const quick = await get(proxy.port, 'x.trycloudflare.com');
    assert.equal(quick.status, 200);
    assert.match(quick.body, /访问密码|PIN/);
    const unknown = await get(proxy.port, 'evil.example.com');
    assert.equal(unknown.status, 403);
  } finally { await proxy.close(); await close(upstream); }
});

test('Named 已认证页面注入真实活动监听器，普通通道不注入', async () => {
  const upstream = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<html><head></head><body>OK</body></html>'); });
  const upstreamPort = await listen(upstream);
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: upstreamPort },
    deviceAuth: mockDeviceAuth(true), publicChannelForHost: channel, launchToken: () => '',
    auth: { sessionKey: 'session', isProtected: () => false, getToken: () => null },
  });
  try {
    const named = await get(proxy.port, 'work.example.com');
    assert.equal(named.status, 200);
    assert.match(named.body, /data-dsh-pocket-session-activity/);
    const local = await get(proxy.port, '127.0.0.1');
    assert.equal(local.status, 200);
    assert.doesNotMatch(local.body, /data-dsh-pocket-session-activity/);
  } finally { await proxy.close(); await close(upstream); }
});

test('管理 RPC 在 Host 改写前拒绝所有非本机通道', async () => {
  const upstream = createServer((_req, res) => res.end('SHOULD_NOT_REACH'));
  const upstreamPort = await listen(upstream);
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: upstreamPort }, publicChannelForHost: channel });
  try {
    assert.equal((await get(proxy.port, '192.168.1.9', '/dsh-pocket-admin/device.status')).status, 403);
    assert.equal((await get(proxy.port, 'work.example.com', '/dsh-pocket-admin/device.status')).status, 403);
    assert.equal((await get(proxy.port, '127.0.0.1', '/dsh-pocket-admin/device.status')).status, 200);
  } finally { await proxy.close(); await close(upstream); }
});
