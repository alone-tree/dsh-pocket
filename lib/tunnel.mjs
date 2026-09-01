// Cloudflare 固定域名命名隧道。
// 安全模式不提供 Quick Tunnel，也不自动下载任何可执行文件。

import { spawn, execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';

function cloudflaredOnPath() {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const output = execFileSync(command, ['cloudflared'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return String(output).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  } catch { return null; }
}

export async function resolveCloudflared({ onPhase = () => {} } = {}) {
  const explicit = process.env.DSH_POCKET_CLOUDFLARED;
  if (explicit) {
    try {
      await access(explicit);
      return explicit;
    } catch {
      throw new Error(`DSH_POCKET_CLOUDFLARED 指向的路径不可执行：${explicit} | cloudflaredPath is set but not accessible: ${explicit}`);
    }
  }
  const installed = cloudflaredOnPath();
  if (installed) return installed;
  onPhase('error');
  throw new Error(
    '未找到 cloudflared。请通过 Cloudflare 官方渠道安装并加入 PATH，或在设置中指定官方二进制路径；安全模式不会从第三方镜像自动下载可执行文件 | '
    + 'cloudflared not found — install it from Cloudflare and add it to PATH, or configure an official binary path',
  );
}

export function firstMeaningfulErrorLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errors = lines.filter((line) => /(incorrect|error|failed|forbidden|invalid|unauthorized)/i.test(line));
  const meaningful = lines.filter((line) => !/^(INF|DBG|NAME:|USAGE:|cloudflared version)\b/i.test(line));
  return (errors.at(-1) ?? meaningful.at(-1) ?? lines.at(-1) ?? '').slice(0, 500);
}

export const NAMED_TUNNEL_ARGS = Object.freeze(['--no-autoupdate', 'tunnel', 'run', '--protocol', 'http2']);

export async function startNamedTunnel({ token, signal, onPhase = () => {}, readyTimeoutMs = 30_000 } = {}) {
  if (!String(token ?? '').trim()) throw new Error('缺少 Cloudflare Tunnel Token | missing Tunnel Token');
  const bin = await resolveCloudflared({ onPhase });
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
