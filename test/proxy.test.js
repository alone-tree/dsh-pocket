import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createPocketProxy,
  RANDOM_UUID_POLYFILL,
  stripDesktopMarkers,
  upstreamPathWithLaunchToken,
} from '../lib/proxy.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function fakeUpstream(handler = null) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin });
    if (handler) return handler(req, res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head></head><body>upstream</body></html>');
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin, ws: true });
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (message) => ws.send(`echo:${message}`)));
  });
  return { server, port: await listen(server), seen };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('HTTP 转发会把 Host 和 Origin 改写为 loopback 权威', async () => {
  const upstream = await fakeUpstream();
  const proxy = await createPocketProxy({ port: 0, upstream: { host: '127.0.0.1', port: upstream.port } });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/hello`, { headers: { origin: 'https://pocket.example.com' } });
    assert.equal(response.status, 200);
    assert.equal(upstream.seen[0].host, `127.0.0.1:${upstream.port}`);
    assert.equal(upstream.seen[0].origin, `http://127.0.0.1:${upstream.port}`);
  } finally { await proxy.close(); await close(upstream.server); }
});

test('HTML 注入兼容 polyfill，非 HTML 资源不修改', async () => {
  const upstream = await fakeUpstream((req, res) => {
    const html = req.url === '/';
    res.writeHead(200, { 'content-type': html ? 'text/html' : 'application/javascript' });
    res.end(html ? '<html><head></head><body>x</body></html>' : 'console.log("x")');
  });
  const proxy = await createPocketProxy({ port: 0, upstream: { host: '127.0.0.1', port: upstream.port } });
  try {
    assert.match(await (await fetch(`http://127.0.0.1:${proxy.port}/`)).text(), /data-dsh-pocket-polyfill/);
    assert.doesNotMatch(await (await fetch(`http://127.0.0.1:${proxy.port}/app.js`)).text(), /data-dsh-pocket-polyfill/);
    assert.match(RANDOM_UUID_POLYFILL, /AbortSignal\.any/);
  } finally { await proxy.close(); await close(upstream.server); }
});

test('已压缩 HTML 不做文本注入，避免破坏字节流', async () => {
  const payload = '<html><head></head><body>compressed</body></html>';
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(gzipSync(payload));
  });
  const proxy = await createPocketProxy({ port: 0, upstream: { host: '127.0.0.1', port: upstream.port } });
  try {
    const text = await (await fetch(`http://127.0.0.1:${proxy.port}/`)).text();
    assert.equal(text, payload);
    assert.doesNotMatch(text, /data-dsh-pocket/);
  } finally { await proxy.close(); await close(upstream.server); }
});

test('WebSocket 双向透传并改写权威', async () => {
  const upstream = await fakeUpstream();
  const proxy = await createPocketProxy({ port: 0, upstream: { host: '127.0.0.1', port: upstream.port } });
  try {
    const echoed = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/events`, { headers: { origin: 'https://pocket.example.com' } });
      ws.once('open', () => ws.send('hello'));
      ws.once('message', (message) => { resolve(String(message)); ws.close(); });
      ws.once('error', reject);
    });
    assert.equal(echoed, 'echo:hello');
    const seen = upstream.seen.find((row) => row.ws);
    assert.equal(seen.host, `127.0.0.1:${upstream.port}`);
    assert.equal(seen.origin, `http://127.0.0.1:${upstream.port}`);
  } finally { await proxy.close(); await close(upstream.server); }
});

test('上游不可用时返回 502，而不是挂起或崩溃', async () => {
  const unused = createServer();
  const port = await listen(unused);
  await close(unused);
  const proxy = await createPocketProxy({ port: 0, upstream: { host: '127.0.0.1', port } });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/`);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /无法连接.*dsh web/);
  } finally { await proxy.close(); }
});

test('DSH Desktop 浏览器门禁 403 仅对导航改写为说明页', async () => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
  });
  const proxy = await createPocketProxy({ port: 0, upstream: { host: '127.0.0.1', port: upstream.port } });
  try {
    const navigation = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { accept: 'text/html' } });
    assert.equal(navigation.status, 403);
    assert.equal(navigation.headers.get('x-dsh-pocket-gate'), 'desktop-browser-access');
    assert.match(await navigation.text(), /开启「浏览器访问」/);
    const api = await fetch(`http://127.0.0.1:${proxy.port}/api/test`, { headers: { accept: 'application/json' } });
    assert.equal(await api.text(), 'forbidden');
  } finally { await proxy.close(); await close(upstream.server); }
});

test('启动 token 只补到首次根导航，避免 303 循环', () => {
  assert.equal(upstreamPathWithLaunchToken('/', 'GET', '', 'secret'), '/?token=secret');
  assert.equal(upstreamPathWithLaunchToken('/', 'GET', 'dsh-auth-x=y', 'secret'), '/');
  assert.equal(upstreamPathWithLaunchToken('/api', 'GET', '', 'secret'), '/api');
  assert.equal(upstreamPathWithLaunchToken('/', 'POST', '', 'secret'), '/');
});

test('清除历史 dsh-desktop-* 参数，保留其余参数', () => {
  assert.equal(stripDesktopMarkers('/?dsh-desktop-mode=compatibility&x=1&dsh-desktop-platform=win32'), '/?x=1');
  assert.equal(stripDesktopMarkers('/api?x=1'), '/api?x=1');
});
