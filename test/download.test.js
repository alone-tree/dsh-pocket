import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveCloudflared, managedCloudflaredPath } from '../lib/tunnel.mjs';

const API_URL = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const DOWNLOAD_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

/** 与 tunnel.mjs platformAsset() 相同的平台资产名映射（测试用）。 */
function assetName() {
  const { platform, arch } = process;
  if (platform === 'win32') return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
  if (platform === 'darwin') return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  if (platform === 'linux') {
    return { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', ia32: 'cloudflared-linux-386', arm: 'cloudflared-linux-arm' }[arch]
      ?? 'cloudflared-linux-amd64';
  }
  throw new Error(`unsupported test platform ${platform}`);
}

/**
 * 构造 mock fetch：官方 API 返回指定 digest，官方下载地址返回指定内容。
 * digest 为 null 表示 API 不提供摘要；apiStatus / downloadStatus 模拟网络失败。
 */
function fakeFetch({ content = Buffer.from('fake-official-cloudflared-binary'), digest, apiStatus = 200, downloadStatus = 200 } = {}) {
  // digest === null 表示官方资产不带 digest 字段；undefined 则默认计算真实摘要
  const sha = digest === undefined ? createHash('sha256').update(content).digest('hex') : digest;
  return async (url) => {
    if (url === API_URL) {
      const assets = [{ name: assetName(), size: content.length }];
      if (sha !== null) assets[0].digest = `sha256:${sha}`;
      return new Response(JSON.stringify({ tag_name: '2026.8.3', assets }), { status: apiStatus });
    }
    if (url === `${DOWNLOAD_URL}/${assetName()}`) return new Response(content, { status: downloadStatus });
    return new Response('not found', { status: 404 });
  };
}

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

test('明确路径不存在时失败关闭，不静默回退下载', () => withEnvironment(async () => {
  process.env.DSH_POCKET_CLOUDFLARED = join(tmpdir(), 'missing-cloudflared');
  const phases = [];
  await assert.rejects(() => resolveCloudflared({ onPhase: (phase) => phases.push(phase) }), /不可执行|not accessible/);
  assert.equal(phases.includes('downloading'), false);
}));

test('PATH 中已有 cloudflared 时直接使用，不触发下载', () => withEnvironment(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pocket-cloudflared-path-'));
  const binary = join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  await writeFile(binary, 'on-path-binary');
  // 前置假目录：where.exe 自身仍可解析，且假二进制优先于真实 PATH 命中
  process.env.DSH_POCKET_CLOUDFLARED = '';
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
  const phases = [];
  try {
    assert.equal(await resolveCloudflared({ onPhase: (phase) => phases.push(phase) }), binary);
    assert.equal(phases.includes('downloading'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

test('没有任何本地 cloudflared 时从官方源下载并通过校验', () => withEnvironment(async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pocket-cloudflared-home-'));
  delete process.env.DSH_POCKET_CLOUDFLARED;
  process.env.PATH = '';
  const content = Buffer.from('official-cloudflared-content');
  const phases = [];
  try {
    const resolved = await resolveCloudflared({ home, onPhase: (phase) => phases.push(phase), fetchImpl: fakeFetch({ content }) });
    assert.equal(resolved, managedCloudflaredPath(home));
    assert.equal(await readFile(resolved, 'utf8'), content.toString('utf8'));
    assert.ok(phases.includes('downloading'));
    // 无残留临时文件
    assert.deepEqual(await readdir(join(home, 'dsh-pocket', 'bin')), [process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared']);
  } finally { await rm(home, { recursive: true, force: true }); }
}));

test('已有受管下载的 cloudflared 时复用，不重新下载', () => withEnvironment(async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pocket-cloudflared-home-'));
  delete process.env.DSH_POCKET_CLOUDFLARED;
  process.env.PATH = '';
  const managed = managedCloudflaredPath(home);
  await mkdir(join(home, 'dsh-pocket', 'bin'), { recursive: true });
  await writeFile(managed, 'managed-binary');
  const phases = [];
  let called = 0;
  try {
    assert.equal(await resolveCloudflared({ home, onPhase: (phase) => phases.push(phase), fetchImpl: () => { called += 1; return Promise.reject(new Error('should not fetch')); } }), managed);
    assert.equal(called, 0);
    assert.equal(phases.includes('downloading'), false);
  } finally { await rm(home, { recursive: true, force: true }); }
}));

test('SHA-256 不匹配时拒绝并清理临时文件', () => withEnvironment(async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pocket-cloudflared-home-'));
  delete process.env.DSH_POCKET_CLOUDFLARED;
  process.env.PATH = '';
  try {
    const phases = [];
    await assert.rejects(
      () => resolveCloudflared({ home, onPhase: (phase) => phases.push(phase), fetchImpl: fakeFetch({ digest: '0'.repeat(64) }) }),
      /SHA-256 不匹配|sha256 mismatch/,
    );
    assert.ok(phases.includes('error'));
    await assert.rejects(() => access(managedCloudflaredPath(home)));
    assert.deepEqual(await readdir(join(home, 'dsh-pocket', 'bin')), []);
  } finally { await rm(home, { recursive: true, force: true }); }
}));

test('官方发布未提供摘要时拒绝下载', () => withEnvironment(async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pocket-cloudflared-home-'));
  delete process.env.DSH_POCKET_CLOUDFLARED;
  process.env.PATH = '';
  try {
    await assert.rejects(
      () => resolveCloudflared({ home, fetchImpl: fakeFetch({ digest: null }) }),
      /摘要|digest/,
    );
    await assert.rejects(() => access(managedCloudflaredPath(home)));
  } finally { await rm(home, { recursive: true, force: true }); }
}));

test('官方 API 不可用时失败并提示手动安装', () => withEnvironment(async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pocket-cloudflared-home-'));
  delete process.env.DSH_POCKET_CLOUDFLARED;
  process.env.PATH = '';
  try {
    await assert.rejects(
      () => resolveCloudflared({ home, fetchImpl: fakeFetch({ apiStatus: 500 }) }),
      /查询 cloudflared 官方最新版本失败|failed to query official cloudflared release/,
    );
    await assert.rejects(() => access(managedCloudflaredPath(home)));
  } finally { await rm(home, { recursive: true, force: true }); }
}));

test('下载地址不可用时失败并清理', () => withEnvironment(async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pocket-cloudflared-home-'));
  delete process.env.DSH_POCKET_CLOUDFLARED;
  process.env.PATH = '';
  try {
    await assert.rejects(
      () => resolveCloudflared({ home, fetchImpl: fakeFetch({ downloadStatus: 500 }) }),
      /下载 cloudflared 失败|cloudflared download failed/,
    );
    assert.deepEqual(await readdir(join(home, 'dsh-pocket', 'bin')), []);
  } finally { await rm(home, { recursive: true, force: true }); }
}));
