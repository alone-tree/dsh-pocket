import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createPocketProxy } from '../lib/proxy.mjs';

async function fakeUpstream() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': req.headers.accept?.includes('text/html') ? 'text/html' : 'application/json' });
    res.end(req.headers.accept?.includes('text/html') ? '<html><head></head><body>DSH</body></html>' : '{"ok":true}');
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (message) => ws.send(message)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, seen };
}

function mockDeviceAuth() {
  return {
    status: () => ({ credentialCount: 1 }),
    consumeEntryTicket: (req) => new URL(req.url, 'https://example.invalid').searchParams.get('pocket-entry') === 'valid',
    authorizeRequest: (req) => String(req.headers.cookie ?? '').includes('approved=yes') ? { credentialId: 'device-1' } : null,
    handleHttp: async () => false,
  };
}

test('安全代理默认只监听 loopback，顶层页面必须消费单次入口票据', async () => {
  const upstream = await fakeUpstream();
  const proxy = await createPocketProxy({ port: 0, upstream: { host: '127.0.0.1', port: upstream.port }, deviceAuth: mockDeviceAuth() });
  try {
    assert.equal(proxy.server.address().address, '127.0.0.1');

    const login = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { accept: 'text/html' } });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(login.headers.get('x-frame-options'), 'DENY');
    assert.match(await login.text(), /使用本机身份确认/);
    assert.equal(upstream.seen.length, 0, '未登录导航不得到达 DSH');

    const entered = await fetch(`http://127.0.0.1:${proxy.port}/?pocket-entry=valid`, { headers: { accept: 'text/html' } });
    assert.equal(entered.status, 200);
    assert.match(await entered.text(), /data-dsh-pocket-session-guard/);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0], '/', '单次入口票据不得进入 DSH 上游或其日志');
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.server.close(resolve));
  }
});

test('未认证 API 和 WebSocket 均被拒绝，批准会话才能透传', async () => {
  const upstream = await fakeUpstream();
  const proxy = await createPocketProxy({ port: 0, upstream: { host: '127.0.0.1', port: upstream.port }, deviceAuth: mockDeviceAuth() });
  try {
    const denied = await fetch(`http://127.0.0.1:${proxy.port}/api/test`, { headers: { accept: 'application/json' } });
    assert.equal(denied.status, 401);
    assert.equal(upstream.seen.length, 0);

    const allowed = await fetch(`http://127.0.0.1:${proxy.port}/api/test`, { headers: { accept: 'application/json', cookie: 'approved=yes' } });
    assert.equal(allowed.status, 200);
    assert.equal(upstream.seen.length, 1);

    const status = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/events`);
      ws.once('unexpected-response', (_req, response) => resolve(response.statusCode));
      ws.once('open', () => reject(new Error('unauthenticated WebSocket unexpectedly opened')));
      ws.once('error', () => {});
    });
    assert.equal(status, 401);

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/events`, { headers: { cookie: 'approved=yes' } });
      ws.once('open', () => { ws.close(); resolve(); });
      ws.once('error', reject);
    });
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.server.close(resolve));
  }
});

test('配对页面可公开打开，但不会直接授予 DSH 访问权', async () => {
  const upstream = await fakeUpstream();
  const proxy = await createPocketProxy({ port: 0, upstream: { host: '127.0.0.1', port: upstream.port }, deviceAuth: mockDeviceAuth() });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/pocket-pair#pair=test`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /二维码不能单独授予访问权限/);
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.server.close(resolve));
  }
});
