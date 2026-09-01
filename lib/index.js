// dsh-pocket 安全模式入口：固定 HTTPS 命名隧道 + 本机批准的浏览器设备凭据与独立密码。

import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { createPocketService } from './service.mjs';
import { createDeviceAuth } from './device-auth.mjs';
import { installPocketRpc } from './web-rpc.js';
import { restartHost } from './restart.js';
import { advancedNoticeScript, DEFAULT_INJECT } from './proxy.mjs';
import {
  cloudflaredPath,
  proxyPort,
  resetSettings,
  setTunnelHostname,
  setTunnelToken,
  tunnelHostname,
  tunnelToken,
} from './settings.mjs';

const name = 'dsh-pocket';
const inject = ['connection', 'webServer'];
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));

function currentVersion() {
  try { return JSON.parse(readFileSync(pkgPath, 'utf8')).version; }
  catch { return '0.0.0'; }
}
const loadedVersion = currentVersion();

const restartNoticeRel = join('dsh-pocket', 'restarted.json');
function restartNoticePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), restartNoticeRel);
}
async function readRestartNotice() {
  try {
    const raw = JSON.parse(await readFile(restartNoticePath(), 'utf8'));
    if (!raw?.at || Date.now() - raw.at > 30 * 60 * 1000) return null;
    return raw;
  } catch { return null; }
}
function writeRestartNotice() {
  return mkdir(dirname(restartNoticePath()), { recursive: true })
    .then(() => writeFile(restartNoticePath(), JSON.stringify({ at: Date.now(), pid: process.pid }), 'utf8'));
}
async function consumeRestartNotice() {
  const notice = await readRestartNotice();
  if (notice) await rm(restartNoticePath(), { force: true }).catch(() => {});
  return notice;
}

function pocketRestart(service) {
  const result = restartHost();
  if (!result || result.helperPid == null) return result;
  // 插件重启不是用户关闭公网入口：保留「应开启」标记，DSH 起来后自动恢复隧道。
  try { service?.stopTunnel({ keepAutoState: true }); } catch { /* 忽略 */ }
  writeRestartNotice().catch(() => {});
  return result;
}

function performUpdate(profile, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('dsh', ['plugin', '--profile', profile, 'update', 'dsh-pocket', '--latest', '-w'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let out = '';
    const onData = (chunk) => { out += String(chunk); if (out.length > 4000) out = out.slice(-4000); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out.slice(-800) });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
  });
}

export async function apply(ctx, config = {}, internals = {}) {
  const logger = ctx.logger?.(name) ?? console;
  const dshPort = internals.dshPort ?? ctx.webServer?.port;
  if (!dshPort) {
    logger.error('dsh-pocket: webServer port unavailable — cannot start proxy | 拿不到 dsh web 端口，无法启动代理');
    return () => {};
  }

  const cfPath = cloudflaredPath();
  if (cfPath) {
    process.env.DSH_POCKET_CLOUDFLARED = cfPath;
    logger.info(`dsh-pocket: using configured cloudflared: ${cfPath}`);
  }

  const isDesktop = internals.isDesktop !== undefined
    ? internals.isDesktop === true
    : ctx.get?.('desktopProfiles') !== undefined || ctx.get?.('desktopPnpm') !== undefined;
  const desktopAdvanced = isDesktop && (() => {
    try {
      const path = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'settings.yaml');
      return /dsh-plugin-desktop\s*:\s*[\s\S]{0,300}?mode\s*:\s*advanced/i.test(readFileSync(path, 'utf8'));
    } catch { return false; }
  })();

  const home = internals.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const deviceAuth = internals.deviceAuth ?? await createDeviceAuth({
    home,
    getPublicOrigin: () => `https://${tunnelHostname()}`,
    log: logger,
  });

  const service = internals.service ?? createPocketService({
    dshPort,
    port: internals.port ?? config.port ?? (proxyPort() || 3081),
    home,
    internals,
    injectHtml: isDesktop
      ? DEFAULT_INJECT + (desktopAdvanced ? advancedNoticeScript() : '')
      : undefined,
    deviceAuth,
    launchToken: () => {
      try {
        const fn = ctx.connection?.authenticatedUrl;
        if (typeof fn !== 'function') return '';
        const url = new URL(fn.call(ctx.connection, `http://127.0.0.1:${dshPort}`));
        return url.searchParams.get('token') ?? '';
      } catch { return ''; }
    },
    getTunnelConfig: () => ({ mode: 'named', token: tunnelToken(), hostname: tunnelHostname() }),
    onTunnelReady: () => logger.info('dsh-pocket: secure named tunnel ready | 安全固定入口已就绪'),
  });

  const disposers = [];
  const disposeRpc = installPocketRpc(ctx, {
    service,
    deviceAuth,
    desktop: isDesktop,
    getTunnelConfig: () => ({ mode: 'named', hostname: tunnelHostname(), tokenSet: tunnelToken().length > 0 }),
    setTunnelConfig: ({ hostname, token } = {}) => {
      if (hostname !== undefined) setTunnelHostname(hostname);
      if (token !== undefined) setTunnelToken(token);
      return { mode: 'named', hostname: tunnelHostname(), tokenSet: tunnelToken().length > 0 };
    },
    resetPocket: async () => {
      resetSettings();
      await deviceAuth.reset();
      return true;
    },
    runUpdate: internals.runUpdate ?? { currentVersion, perform: performUpdate, loadedVersion: () => loadedVersion },
    restart: internals.restart ?? (() => pocketRestart(service)),
    restartNotice: internals.restartNotice ?? consumeRestartNotice,
    log: logger,
  });
  disposers.push(disposeRpc);

  void service.startProxy().then((proxy) => {
    logger.info('dsh-pocket: loopback proxy ready on 127.0.0.1:%d | 本机安全代理已就绪', proxy.port);
    void service.restoreTunnelIfNeeded?.().catch(() => {});
  }).catch((error) => {
    logger.error('dsh-pocket: proxy start failed | 代理启动失败: %s', error?.message ?? error);
  });

  ctx.effect(() => async () => {
    for (const dispose of disposers.reverse()) { try { dispose(); } catch { /* 忽略 */ } }
    await service.dispose();
  }, 'dsh-pocket: stop secure proxy and tunnel');
}

export { name, inject, readRestartNotice, consumeRestartNotice };
