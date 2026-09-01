import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NAMED_TUNNEL_ARGS, firstMeaningfulErrorLine, startNamedTunnel } from '../lib/tunnel.mjs';

test('命名隧道参数固定，不包含 Quick Tunnel 的 --url', () => {
  assert.equal(NAMED_TUNNEL_ARGS[0], '--no-autoupdate');
  assert.deepEqual(NAMED_TUNNEL_ARGS.slice(1, 3), ['tunnel', 'run']);
  assert.equal(NAMED_TUNNEL_ARGS.includes('--url'), false);
  assert.deepEqual(NAMED_TUNNEL_ARGS.slice(-2), ['--protocol', 'http2']);
});

test('Tunnel Token 缺失时在启动进程前失败', async () => {
  await assert.rejects(() => startNamedTunnel({ token: '' }), /缺少.*Token|missing Tunnel Token/);
});

test('源码不再导出 Quick Tunnel 或包含 trycloudflare.com', async () => {
  const source = await readFile(new URL('../lib/tunnel.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /startQuickTunnel|trycloudflare\.com|ghproxy|gh\.ddlc|gh-proxy/);
});

test('firstMeaningfulErrorLine 提取参数或运行错误', () => {
  const usage = 'cloudflared version 2026.4.0\nIncorrect Usage: flag provided but not defined: -no-autoupdate\nNAME:\ncloudflared tunnel run';
  assert.equal(firstMeaningfulErrorLine(usage), 'Incorrect Usage: flag provided but not defined: -no-autoupdate');
  const runtime = 'INF Starting tunnel\nERR Failed to connect to origin: 403 Forbidden\nERR retrying';
  assert.match(firstMeaningfulErrorLine(runtime), /403 Forbidden/);
});
