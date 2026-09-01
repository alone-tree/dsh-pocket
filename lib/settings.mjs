// dsh-pocket 安全模式设置（$DSH_HOME/dsh-pocket/settings.json）。
// 只保留固定 Cloudflare Tunnel、loopback 代理端口和用户安装的 cloudflared 路径。

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const settingsRel = join('dsh-pocket', 'settings.json');
export function settingsPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), settingsRel);
}

function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function writeSettings(settings) {
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return settings;
}

export function resetSettings() {
  try { rmSync(settingsPath(), { force: true }); return true; }
  catch { return false; }
}

export function tunnelToken() {
  const value = readSettings().tunnelToken;
  return typeof value === 'string' ? value : '';
}

export function setTunnelToken(value) {
  const token = String(value ?? '').trim();
  if (token && (token.length < 20 || !/^[A-Za-z0-9+/_=-]+$/.test(token))) {
    throw new Error('Tunnel Token 格式不对，请粘贴 Cloudflare 提供的完整 Token | invalid tunnel token');
  }
  const settings = readSettings();
  if (token) settings.tunnelToken = token;
  else delete settings.tunnelToken;
  writeSettings(settings);
  return token;
}

export function tunnelHostname() {
  const value = readSettings().tunnelHostname;
  return typeof value === 'string' ? value : '';
}

export function setTunnelHostname(value) {
  let hostname = String(value ?? '').trim().toLowerCase();
  hostname = hostname.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#\s]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (hostname) {
    const valid = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || !valid.test(hostname)) {
      throw new Error('固定域名格式不对（如 pocket.example.com） | invalid tunnel hostname');
    }
  }
  const settings = readSettings();
  if (hostname) settings.tunnelHostname = hostname;
  else delete settings.tunnelHostname;
  writeSettings(settings);
  return hostname;
}

export function proxyPort() {
  const value = Number(readSettings().proxyPort);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : 0;
}

export function setProxyPort(value) {
  const port = Number(value);
  const settings = readSettings();
  if (Number.isInteger(port) && port >= 1 && port <= 65535) settings.proxyPort = port;
  else delete settings.proxyPort;
  writeSettings(settings);
  return proxyPort();
}

export function cloudflaredPath() {
  const value = readSettings().cloudflaredPath;
  return typeof value === 'string' ? value : '';
}

export function setCloudflaredPath(value) {
  const path = String(value ?? '').trim();
  const settings = readSettings();
  if (path) settings.cloudflaredPath = path;
  else delete settings.cloudflaredPath;
  writeSettings(settings);
  return path;
}
