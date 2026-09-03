import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceAuth, DEVICE_CREDENTIAL_COOKIE, DEVICE_SESSION_COOKIE, GENERIC_LOGIN_ERROR, normalizePublicOrigin } from '../lib/device-auth.mjs';

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pocket-device-auth-'));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}
function fakeHash(password) { return `test$${createHash('sha256').update(String(password)).digest('hex')}`; }
const passwords = { hash: async (value) => fakeHash(value), verify: async (hash, value) => hash === fakeHash(value) };
function options(home, now) { return { home, getPublicOrigin: () => 'https://work.example.com', now, passwords, log: { warn() {} } }; }
function pairingToken(pairing) { return decodeURIComponent(new URL(pairing.url).hash.slice('#pair='.length)); }
function requestWith(name, value) { return { headers: { cookie: `${name}=${value}` }, socket: { remoteAddress: '127.0.0.1' } }; }
async function pairAndApprove(auth, password = 'abc123') {
  const pairing = auth.beginPairing();
  const submitted = await auth.submitPairing({ token: pairingToken(pairing), name: '荣耀 50 Chrome', password });
  await auth.approvePending(submitted.pendingId);
  return { ...submitted, password };
}

test('normalizePublicOrigin 只接受无路径 HTTPS 固定网址', () => {
  assert.equal(normalizePublicOrigin('https://work.example.com/'), 'https://work.example.com');
  assert.throws(() => normalizePublicOrigin('http://work.example.com'), /HTTPS/);
  assert.throws(() => normalizePublicOrigin('https://work.example.com/path'), /协议和域名/);
});

test('设备凭据与密码必须同时成立，登录轮换凭据，撤销立即失效', () => withTempHome(async (home) => {
  let clock = 1_000_000;
  const auth = await createDeviceAuth(options(home, () => clock));
  const paired = await pairAndApprove(auth);
  await assert.rejects(() => auth.login({ req: requestWith(DEVICE_CREDENTIAL_COOKIE, 'wrong'), password: paired.password }), new RegExp(GENERIC_LOGIN_ERROR.split(' | ')[0]));
  const login = await auth.login({ req: requestWith(DEVICE_CREDENTIAL_COOKIE, paired.deviceToken), password: paired.password });
  assert.notEqual(login.deviceToken, paired.deviceToken);
  assert.equal(auth.authorizeRequest(requestWith(DEVICE_SESSION_COOKIE, login.sessionId)).deviceId, login.device.id);
  const saved = await readFile(auth.statePath, 'utf8');
  assert.doesNotMatch(saved, new RegExp(paired.password));
  assert.doesNotMatch(saved, new RegExp(login.deviceToken));
  assert.match(saved, /"passwordHash"/);
  assert.match(saved, /"tokenHash"/);
  await auth.revokeDevice(login.device.id);
  assert.equal(auth.authorizeRequest(requestWith(DEVICE_SESSION_COOKIE, login.sessionId)), null);
}));

test('只有真实活动接口续期，普通请求和前台静置不会续期', () => withTempHome(async (home) => {
  let clock = 2_000_000;
  const auth = await createDeviceAuth(options(home, () => clock));
  const paired = await pairAndApprove(auth);
  const login = await auth.login({ req: requestWith(DEVICE_CREDENTIAL_COOKIE, paired.deviceToken), password: paired.password });
  const req = requestWith(DEVICE_SESSION_COOKIE, login.sessionId);
  clock += 9 * 60_000;
  assert.ok(auth.authorizeRequest(req), '普通认证检查不应自行续期');
  clock += 60_001;
  assert.equal(auth.authorizeRequest(req), null, '静置超过十分钟后失效');

  const login2 = await auth.login({ req: requestWith(DEVICE_CREDENTIAL_COOKIE, login.deviceToken), password: paired.password });
  const req2 = requestWith(DEVICE_SESSION_COOKIE, login2.sessionId);
  clock += 9 * 60_000;
  assert.equal(auth.recordUserActivity(req2), true);
  clock += 9 * 60_000;
  assert.ok(auth.authorizeRequest(req2), '真实用户活动应续期');
}));

test('配对 token 单次使用，同一时间拒绝第二个待批准申请', () => withTempHome(async (home) => {
  let clock = 3_000_000;
  const auth = await createDeviceAuth(options(home, () => clock));
  const first = auth.beginPairing();
  await auth.submitPairing({ token: pairingToken(first), name: '手机一', password: 'abc123' });
  assert.throws(() => auth.beginPairing(), /等待批准/);
  await assert.rejects(() => auth.submitPairing({ token: pairingToken(first), name: '手机二', password: 'abc123' }), /失效/);
}));

test('设备列表字段明确为 lastLoginAt', () => withTempHome(async (home) => {
  let clock = 4_000_000;
  const auth = await createDeviceAuth(options(home, () => clock));
  const paired = await pairAndApprove(auth);
  assert.equal(auth.status().devices[0].lastLoginAt, null);
  clock += 100;
  await auth.login({ req: requestWith(DEVICE_CREDENTIAL_COOKIE, paired.deviceToken), password: paired.password });
  assert.equal(auth.status().devices[0].lastLoginAt, clock);
  assert.equal('lastUsedAt' in auth.status().devices[0], false);
}));
