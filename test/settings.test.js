import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloudflaredPath,
  proxyPort,
  resetSettings,
  setCloudflaredPath,
  setProxyPort,
  setTunnelHostname,
  setTunnelToken,
  tunnelHostname,
  tunnelToken,
} from '../lib/settings.mjs';

async function withHome(fn) {
  const previous = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'dsh-pocket-settings-'));
  process.env.DSH_HOME = home;
  try { await fn(home); }
  finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test('安全设置只保存固定域名和命名 Tunnel Token', () => withHome(async () => {
  assert.equal(tunnelHostname(), '');
  assert.equal(tunnelToken(), '');
  assert.equal(setTunnelHostname('https://Pocket.Example.com/'), 'pocket.example.com');
  const token = 'A'.repeat(40);
  assert.equal(setTunnelToken(token), token);
  assert.equal(tunnelHostname(), 'pocket.example.com');
  assert.equal(tunnelToken(), token);
  assert.throws(() => setTunnelHostname('127.0.0.1'), /格式不对/);
  assert.throws(() => setTunnelToken('short'), /格式不对/);
}));

test('代理端口和用户安装的 cloudflared 路径可持久化并重置', () => withHome(async () => {
  assert.equal(setProxyPort(3081), 3081);
  assert.equal(proxyPort(), 3081);
  assert.equal(setCloudflaredPath('C:\\Tools\\cloudflared.exe'), 'C:\\Tools\\cloudflared.exe');
  assert.equal(cloudflaredPath(), 'C:\\Tools\\cloudflared.exe');
  assert.equal(resetSettings(), true);
  assert.equal(proxyPort(), 0);
  assert.equal(cloudflaredPath(), '');
}));
