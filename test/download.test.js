import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCloudflared } from '../lib/tunnel.mjs';

async function withEnvironment(fn) {
  const explicit = process.env.DSH_POCKET_CLOUDFLARED;
  const path = process.env.PATH;
  try { await fn(); }
  finally {
    if (explicit === undefined) delete process.env.DSH_POCKET_CLOUDFLARED; else process.env.DSH_POCKET_CLOUDFLARED = explicit;
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
  }
}

test('只接受用户明确指定且存在的 cloudflared', () => withEnvironment(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pocket-cloudflared-'));
  const binary = join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  await writeFile(binary, 'official-binary-placeholder');
  process.env.DSH_POCKET_CLOUDFLARED = binary;
  try { assert.equal(await resolveCloudflared(), binary); }
  finally { await rm(dir, { recursive: true, force: true }); }
}));

test('明确路径不存在时失败关闭，不回退下载', () => withEnvironment(async () => {
  process.env.DSH_POCKET_CLOUDFLARED = join(tmpdir(), 'missing-cloudflared');
  const phases = [];
  await assert.rejects(() => resolveCloudflared({ onPhase: (phase) => phases.push(phase) }), /不可执行|not accessible/);
  assert.equal(phases.includes('downloading'), false);
}));

test('PATH 和明确路径都没有时提示从 Cloudflare 官方安装，不触发第三方镜像', () => withEnvironment(async () => {
  delete process.env.DSH_POCKET_CLOUDFLARED;
  process.env.PATH = '';
  const phases = [];
  await assert.rejects(
    () => resolveCloudflared({ onPhase: (phase) => phases.push(phase) }),
    /Cloudflare 官方渠道安装|install it from Cloudflare/,
  );
  assert.deepEqual(phases, ['error']);
}));
