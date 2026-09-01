// Cloudflare 固定域名命名隧道。
// 安全模式不提供 Quick Tunnel。cloudflared 解析顺序：显式路径（DSH_POCKET_CLOUDFLARED）
// → PATH 中的现有安装 → 官方 GitHub Releases 自动下载（以官方 API 的 SHA-256 摘要校验，
// 不匹配即丢弃；不使用任何第三方镜像）。

import { spawn, execFileSync, execFile } from 'node:child_process';
import { access, chmod, mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

const RELEASES_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const RELEASES_DOWNLOAD = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

function cloudflaredOnPath() {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const output = execFileSync(command, ['cloudflared'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return String(output).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  } catch { return null; }
}

/** 受管下载的 cloudflared 安装路径（$DSH_HOME/dsh-pocket/bin/）。 */
export function managedCloudflaredPath(home) {
  return join(String(home ?? ''), 'dsh-pocket', 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

/** 当前平台对应的官方发布资产；tgz 表示下载后需要解压。 */
function platformAsset() {
  const { platform, arch } = process;
  if (platform === 'win32') {
    return { name: arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe' };
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? { name: 'cloudflared-darwin-arm64.tgz', tgz: true } : { name: 'cloudflared-darwin-amd64.tgz', tgz: true };
  }
  if (platform === 'linux') {
    const map = { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', ia32: 'cloudflared-linux-386', arm: 'cloudflared-linux-arm' };
    if (map[arch]) return { name: map[arch] };
  }
  return null;
}

function officialDigestOf(assetInfo) {
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(String(assetInfo?.digest ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/**
 * 从 Cloudflare 官方 GitHub Releases 下载 cloudflared 并校验 SHA-256。
 * 摘要来自 api.github.com 官方资产 digest 字段；两者都是官方通道，
 * 不提供任何第三方镜像回退——官方源不可达时报错走手动安装。
 */
export async function downloadOfficialCloudflared(home, { fetchImpl = fetch, onPhase = () => {} } = {}) {
  const asset = platformAsset();
  if (!asset) {
    throw new Error(`不支持的平台 ${process.platform}/${process.arch}，请手动安装官方 cloudflared | unsupported platform, install cloudflared manually`);
  }
  onPhase('downloading');

  let release;
  try {
    const res = await fetchImpl(RELEASES_API, {
      headers: { 'User-Agent': 'dsh-pocket', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    release = await res.json();
  } catch (err) {
    onPhase('error');
    throw new Error(`查询 cloudflared 官方最新版本失败：${err?.message ?? err}。请检查网络后重试，或手动安装官方版 | failed to query official cloudflared release`);
  }

  const assetInfo = (Array.isArray(release?.assets) ? release.assets : []).find((a) => a?.name === asset.name);
  const expected = officialDigestOf(assetInfo);
  if (!expected) {
    onPhase('error');
    throw new Error('官方发布未提供该平台二进制的 SHA-256 摘要，拒绝下载 | official release has no sha256 digest for this platform, refusing to download');
  }

  const binDir = join(String(home), 'dsh-pocket', 'bin');
  await mkdir(binDir, { recursive: true });
  const tmpPath = join(binDir, `${asset.name}.download`);
  const hash = createHash('sha256');
  try {
    const res = await fetchImpl(`${RELEASES_DOWNLOAD}/${asset.name}`, {
      headers: { 'User-Agent': 'dsh-pocket' },
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) { hash.update(chunk); yield chunk; }
      },
      createWriteStream(tmpPath),
    );
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    onPhase('error');
    throw new Error(`下载 cloudflared 失败：${err?.message ?? err}。请检查网络后重试，或手动安装官方版 | cloudflared download failed`);
  }

  if (hash.digest('hex') !== expected) {
    await rm(tmpPath, { force: true }).catch(() => {});
    onPhase('error');
    throw new Error('cloudflared 下载校验失败（SHA-256 不匹配），已丢弃下载内容 | cloudflared sha256 mismatch, download discarded');
  }

  if (asset.tgz) {
    await new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', tmpPath, '-C', binDir], { timeout: 120_000 }, (err) => (err ? reject(err) : resolve()));
    }).catch((err) => {
      onPhase('error');
      throw new Error(`解压 cloudflared 失败：${err?.message ?? err} | failed to extract cloudflared`);
    });
    await rm(tmpPath, { force: true }).catch(() => {});
    const installed = join(binDir, 'cloudflared');
    await chmod(installed, 0o755);
    return installed;
  }

  const installed = managedCloudflaredPath(home);
  await rm(installed, { force: true }).catch(() => {});
  await rename(tmpPath, installed);
  if (process.platform !== 'win32') await chmod(installed, 0o755);
  return installed;
}

export async function resolveCloudflared({ onPhase = () => {}, home, fetchImpl } = {}) {
  const explicit = process.env.DSH_POCKET_CLOUDFLARED;
  if (explicit) {
    try {
      await access(explicit);
      return explicit;
    } catch {
      // 显式路径代表用户意志：缺失时失败关闭，不静默改用其他来源。
      throw new Error(`DSH_POCKET_CLOUDFLARED 指向的路径不可执行：${explicit} | cloudflaredPath is set but not accessible: ${explicit}`);
    }
  }
  const installed = cloudflaredOnPath();
  if (installed) return installed;
  if (home) {
    const managed = managedCloudflaredPath(home);
    try {
      await access(managed);
      return managed;
    } catch { /* 尚未下载过 */ }
  } else {
    onPhase('error');
    throw new Error('未找到 cloudflared，也无法自动下载（缺少数据目录）。请手动安装官方版并加入 PATH，或在设置中指定路径 | cloudflared not found and cannot auto-download without data dir');
  }
  return downloadOfficialCloudflared(home, { fetchImpl, onPhase });
}

export function firstMeaningfulErrorLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errors = lines.filter((line) => /(incorrect|error|failed|forbidden|invalid|unauthorized)/i.test(line));
  const meaningful = lines.filter((line) => !/^(INF|DBG|NAME:|USAGE:|cloudflared version)\b/i.test(line));
  return (errors.at(-1) ?? meaningful.at(-1) ?? lines.at(-1) ?? '').slice(0, 500);
}

export const NAMED_TUNNEL_ARGS = Object.freeze(['--no-autoupdate', 'tunnel', 'run', '--protocol', 'http2']);

export async function startNamedTunnel({ token, signal, onPhase = () => {}, readyTimeoutMs = 30_000, home } = {}) {
  if (!String(token ?? '').trim()) throw new Error('缺少 Cloudflare Tunnel Token | missing Tunnel Token');
  const bin = await resolveCloudflared({ onPhase, home });
  onPhase('starting');

  // Token 只走环境变量，不进入进程命令行；只运行固定命名 Tunnel。
  const child = spawn(bin, NAMED_TUNNEL_ARGS, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TUNNEL_TOKEN: String(token) },
  });
  onPhase('registering');

  await new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('error', onError);
      child.off('exit', onEarlyExit);
      signal?.removeEventListener('abort', onAbort);
      child.stdout?.resume();
      child.stderr?.resume();
      if (error) reject(error); else resolve();
    };
    const onData = (chunk) => {
      output = (output + String(chunk)).slice(-16_000);
      if (/Registered tunnel connection/i.test(output)) {
        onPhase('ready');
        finish();
      }
    };
    const onError = (error) => {
      onPhase('error');
      finish(new Error(`cloudflared 启动失败：${error?.message ?? error} | cloudflared failed to start`));
    };
    const onEarlyExit = (code) => {
      const detail = firstMeaningfulErrorLine(output);
      onPhase('error');
      finish(new Error(
        `cloudflared 退出（code=${code}）${detail ? `：${detail}` : ''}——请检查 Tunnel Token 和 Cloudflare ingress 配置 | `
        + `tunnel exited (code=${code})${detail ? `: ${detail}` : ''}`,
      ));
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* 忽略 */ }
      finish(new Error('已取消 | cancelled'));
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      onPhase('error');
      finish(new Error('cloudflared 启动超时：请检查 Tunnel Token、固定域名 ingress 与网络 | cloudflared startup timeout'));
    }, readyTimeoutMs);
    timer.unref?.();

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onEarlyExit);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  const exitListeners = new Set();
  child.on('exit', (code) => {
    for (const listener of exitListeners) listener(code);
  });
  return {
    url: null,
    kill: () => { try { child.kill(); } catch { /* 忽略 */ } },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
}
