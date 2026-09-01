import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createDeviceAuth,
  DEVICE_CREDENTIAL_COOKIE,
  DEVICE_SESSION_COOKIE,
  GENERIC_LOGIN_ERROR,
  normalizePublicOrigin,
} from '../lib/device-auth.mjs';

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pocket-device-auth-'));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

function fakePasswordHash(password) {
  return `test$${createHash('sha256').update(String(password)).digest('hex')}`;
}

const fakePasswords = {
  async hash(password) {
    return fakePasswordHash(password);
  },
  async verify(hash, password) {
    return hash === fakePasswordHash(password);
  },
};

function authOptions(home, now = () => Date.now()) {
  return {
    home,
    getPublicOrigin: () => 'https://work.example.com',
    now,
    passwords: fakePasswords,
    log: { warn() {} },
  };
}

function pairingToken(pairing) {
  return decodeURIComponent(new URL(pairing.url).hash.slice('#pair='.length));
}

function deviceRequest(token) {
  return { headers: { cookie: `${DEVICE_CREDENTIAL_COOKIE}=${token}` } };
}

function sessionRequest(id) {
  return { headers: { cookie: `${DEVICE_SESSION_COOKIE}=${id}` } };
}

async function pairAndApprove(auth, { name = '荣耀 50 Chrome', password = '123abc' } = {}) {
  const pairing = auth.beginPairing();
  const submitted = await auth.submitPairing({ token: pairingToken(pairing), name, password });
  assert.equal(auth.status().deviceCount, 0, '手机提交不能自动进入白名单');
  await auth.approvePending(submitted.pendingId);
  return { ...submitted, password };
}

test('normalizePublicOrigin 只接受无路径的 HTTPS 固定网址', () => {
  assert.equal(normalizePublicOrigin('https://work.example.com/'), 'https://work.example.com');
  assert.throws(() => normalizePublicOrigin('http://work.example.com'), /HTTPS/);
  assert.throws(() => normalizePublicOrigin('https://work.example.com/path'), /协议和域名/);
});

test('设备凭据与密码必须同时成立，登录轮换 token，空闲和撤销立即失效', () => withTempHome(async (home) => {
  let now = 1_000_000;
  const auth = await createDeviceAuth(authOptions(home, () => now));
  const paired = await pairAndApprove(auth);

  await assert.rejects(
    () => auth.login({ req: deviceRequest('unpaired-token'), password: paired.password }),
    new RegExp(GENERIC_LOGIN_ERROR.split(' | ')[0]),
    '未配对浏览器即使知道密码也不能登录',
  );

  const login = await auth.login({ req: deviceRequest(paired.deviceToken), password: paired.password });
  assert.notEqual(login.deviceToken, paired.deviceToken, '完整登录后必须轮换设备 token');
  assert.equal(auth.authorizeRequest(sessionRequest(login.sessionId)).deviceId, login.device.id);

  const stateText = await readFile(auth.statePath, 'utf8');
  assert.doesNotMatch(stateText, new RegExp(paired.password));
  assert.doesNotMatch(stateText, new RegExp(paired.deviceToken));
  assert.doesNotMatch(stateText, new RegExp(login.deviceToken));
  assert.match(stateText, /"passwordHash"/);
  assert.match(stateText, /"tokenHash"/);

  await assert.rejects(
    () => auth.login({ req: deviceRequest(paired.deviceToken), password: paired.password }),
    /无法登录/,
    '轮换后的旧 token 必须失效',
  );

  now += 10 * 60_000 + 1;
  assert.equal(auth.authorizeRequest(sessionRequest(login.sessionId)), null, '连续无前台活动满 10 分钟后会话失效');

  const login2 = await auth.login({ req: deviceRequest(login.deviceToken), password: paired.password });
  await auth.revokeDevice(login2.device.id);
  assert.equal(auth.authorizeRequest(sessionRequest(login2.sessionId)), null, '撤销设备应立即清除活跃会话');

  const reloaded = await createDeviceAuth(authOptions(home));
  assert.equal(reloaded.status().deviceCount, 0);
}));

test('配对二维码一次性，已有待批准申请时拒绝新申请并保留原申请', () => withTempHome(async (home) => {
  const auth = await createDeviceAuth(authOptions(home));
  const first = auth.beginPairing();
  const submitted = await auth.submitPairing({ token: pairingToken(first), name: '手机', password: 'abc123' });
  await assert.rejects(
    () => auth.submitPairing({ token: pairingToken(first), name: '重复', password: 'abc123' }),
    /失效/,
  );
  assert.equal(auth.status().pending[0].id, submitted.pendingId);
  assert.throws(() => auth.beginPairing(), /等待批准/);
  assert.equal(auth.status().pending[0].id, submitted.pendingId, '新申请不能冲掉原申请');
}));

test('密码至少 6 个字符且数字、字母、符号都可使用', () => withTempHome(async (home) => {
  const auth = await createDeviceAuth(authOptions(home));
  const tooShort = auth.beginPairing();
  await assert.rejects(
    () => auth.submitPairing({ token: pairingToken(tooShort), name: '手机', password: '12345' }),
    /6-256/,
  );

  const valid = auth.beginPairing();
  const submitted = await auth.submitPairing({ token: pairingToken(valid), name: '手机', password: '中A!234' });
  assert.equal(submitted.name, '手机');
}));

test('失败次数和第 5/10/15/20 次等待规则持久化，正确密码后清零', () => withTempHome(async (home) => {
  let now = 10_000;
  let auth = await createDeviceAuth(authOptions(home, () => now));
  const paired = await pairAndApprove(auth, { password: 'right-password' });
  let token = paired.deviceToken;

  for (let attempt = 1; attempt <= 20; attempt++) {
    await assert.rejects(() => auth.login({ req: deviceRequest(token), password: 'wrong-password' }), /无法登录/);
    const state = JSON.parse(await readFile(auth.statePath, 'utf8'));
    assert.equal(state.devices[0].failedAttempts, attempt);
    const expectedWait = attempt === 5 ? 5 * 60_000
      : attempt === 10 ? 15 * 60_000
        : attempt === 15 ? 45 * 60_000
          : attempt === 20 ? 24 * 60 * 60_000
            : 0;
    if (expectedWait) {
      assert.equal(state.devices[0].lockedUntil, now + expectedWait);
      await assert.rejects(() => auth.login({ req: deviceRequest(token), password: 'right-password' }), /无法登录/);
      const stillLocked = JSON.parse(await readFile(auth.statePath, 'utf8'));
      assert.equal(stillLocked.devices[0].failedAttempts, attempt, '等待期间尝试不能继续累计');
      if (attempt < 20) now += expectedWait + 1;
    } else {
      assert.equal(state.devices[0].lockedUntil, null);
    }
  }

  auth = await createDeviceAuth(authOptions(home, () => now));
  await assert.rejects(() => auth.login({ req: deviceRequest(token), password: 'right-password' }), /无法登录/, '重启不能绕过 24 小时等待');
  now += 24 * 60 * 60_000 + 1;
  const login = await auth.login({ req: deviceRequest(token), password: 'right-password' });
  token = login.deviceToken;
  const state = JSON.parse(await readFile(auth.statePath, 'utf8'));
  assert.equal(state.devices[0].failedAttempts, 0);
  assert.equal(state.devices[0].lockedUntil, null);
  assert.ok(token);
}));

test('旧版 Passkey 状态不自动迁移并保持失败关闭', () => withTempHome(async (home) => {
  const path = join(home, 'dsh-pocket', 'device-credentials.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, credentials: [{ id: 'old-passkey' }] }), 'utf8');
  const auth = await createDeviceAuth(authOptions(home));
  assert.equal(auth.status().legacyStateDetected, true);
  assert.equal(auth.status().deviceCount, 0);
  assert.equal(auth.hasApprovedDevice(deviceRequest('anything')), false);
}));

test('真实 argon2 依赖可按生产参数完成配对与登录', () => withTempHome(async (home) => {
  const auth = await createDeviceAuth({
    home,
    getPublicOrigin: () => 'https://work.example.com',
    log: { warn() {} },
  });
  const paired = await pairAndApprove(auth, { password: '真实密码123' });
  const login = await auth.login({ req: deviceRequest(paired.deviceToken), password: paired.password });
  assert.ok(login.sessionId);
  const state = JSON.parse(await readFile(auth.statePath, 'utf8'));
  assert.match(state.devices[0].passwordHash, /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
}));

test('HTTP 配对与登录设置安全 Cookie，公开认证端点按来源限速', () => withTempHome(async (home) => {
  const auth = await createDeviceAuth({
    ...authOptions(home),
    rateLimits: {
      login: { limit: 1, windowMs: 60_000 },
      pairing: { limit: 10, windowMs: 60_000 },
    },
  });
  const server = createServer((req, res) => { void auth.handleHttp(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pairing = auth.beginPairing();
    const paired = await fetch(`${base}/pocket-pair/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
      body: JSON.stringify({ token: pairingToken(pairing), name: '手机', password: 'abc123' }),
    });
    assert.equal(paired.status, 200);
    const pairedBody = await paired.json();
    const deviceSetCookie = paired.headers.getSetCookie()[0];
    assert.match(deviceSetCookie, new RegExp(`^${DEVICE_CREDENTIAL_COOKIE}=`));
    assert.match(deviceSetCookie, /Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=/);
    const deviceCookieHeader = deviceSetCookie.split(';')[0];
    await auth.approvePending(pairedBody.request.pendingId);

    const login = await fetch(`${base}/pocket-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: deviceCookieHeader, 'cf-connecting-ip': '203.0.113.10' },
      body: JSON.stringify({ password: 'abc123' }),
    });
    assert.equal(login.status, 200);
    const cookies = login.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.match(cookies[0], new RegExp(`^${DEVICE_CREDENTIAL_COOKIE}=`));
    assert.match(cookies[1], new RegExp(`^${DEVICE_SESSION_COOKIE}=`));
    assert.doesNotMatch(cookies[1], /Max-Age/);

    const limited = await fetch(`${base}/pocket-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: deviceCookieHeader, 'cf-connecting-ip': '203.0.113.10' },
      body: JSON.stringify({ password: 'abc123' }),
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error, GENERIC_LOGIN_ERROR);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}));
