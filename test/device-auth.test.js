import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDeviceAuth,
  DEVICE_SESSION_COOKIE,
  MAX_PENDING_AUTH_CHALLENGES,
  normalizePublicOrigin,
} from '../lib/device-auth.mjs';

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pocket-device-auth-'));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

function mockWebAuthn() {
  return {
    async generateRegistrationOptions(options) {
      return { challenge: 'reg-challenge', rp: { id: options.rpID }, user: { name: options.userName } };
    },
    async verifyRegistrationResponse(options) {
      assert.equal(options.expectedChallenge, 'reg-challenge');
      assert.equal(options.expectedOrigin, 'https://work.example.com');
      assert.equal(options.expectedRPID, 'work.example.com');
      return {
        verified: true,
        registrationInfo: {
          credential: { id: 'credential-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
          origin: 'https://work.example.com',
          rpID: 'work.example.com',
        },
      };
    },
    async generateAuthenticationOptions(options) {
      assert.equal(options.rpID, 'work.example.com');
      assert.deepEqual(options.allowCredentials.map((row) => row.id), ['credential-1']);
      return { challenge: 'auth-challenge', allowCredentials: options.allowCredentials };
    },
    async verifyAuthenticationResponse(options) {
      assert.equal(options.expectedChallenge, 'auth-challenge');
      assert.equal(options.credential.id, 'credential-1');
      assert.deepEqual([...options.credential.publicKey], [1, 2, 3]);
      return {
        verified: true,
        authenticationInfo: {
          newCounter: 1,
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
        },
      };
    },
  };
}

test('normalizePublicOrigin 只接受无路径的 HTTPS 固定网址', () => {
  assert.equal(normalizePublicOrigin('https://work.example.com/'), 'https://work.example.com');
  assert.throws(() => normalizePublicOrigin('http://work.example.com'), /HTTPS/);
  assert.throws(() => normalizePublicOrigin('https://work.example.com/path'), /协议和域名/);
});

test('设备配对必须本机批准，登录会话可撤销且凭据可持久化', () => withTempHome(async (home) => {
  let now = 1_000_000;
  const auth = await createDeviceAuth({
    home,
    getPublicOrigin: () => 'https://work.example.com',
    now: () => now,
    webauthn: mockWebAuthn(),
    log: { warn() {} },
  });

  const pairing = auth.beginPairing();
  const token = decodeURIComponent(new URL(pairing.url).hash.slice('#pair='.length));
  const options = await auth.registrationOptions({ token, name: '我的工作手机' });
  assert.equal(options.challenge, 'reg-challenge');

  const request = await auth.finishRegistration({ token, response: { id: 'credential-1', response: { transports: ['internal'] } } });
  assert.equal(auth.status().credentialCount, 0, '手机申请不能自动加入白名单');
  assert.equal(auth.status().pending.length, 1);
  await assert.rejects(() => auth.authenticationOptions(), /尚未批准/);

  await auth.approvePending(request.pendingId);
  assert.equal(auth.status().credentialCount, 1);
  assert.equal(auth.status().credentials[0].name, '我的工作手机');

  const oldestLogin = await auth.authenticationOptions();
  for (let i = 0; i < MAX_PENDING_AUTH_CHALLENGES; i++) await auth.authenticationOptions();
  await assert.rejects(
    () => auth.finishAuthentication({ requestId: oldestLogin.requestId, response: { id: 'credential-1' } }),
    /登录请求已过期/,
    '匿名请求不能让挑战内存无界增长；最旧挑战应被淘汰',
  );

  const login = await auth.authenticationOptions();
  const verified = await auth.finishAuthentication({ requestId: login.requestId, response: { id: 'credential-1' } });
  const req = { headers: { cookie: `${DEVICE_SESSION_COOKIE}=${verified.sessionId}` } };
  assert.equal(auth.authorizeRequest(req).credentialId, 'credential-1');

  now += 10 * 60_000 + 1;
  assert.equal(auth.authorizeRequest(req), null, '后台超过 10 分钟后会话失效');

  const login2 = await auth.authenticationOptions();
  const verified2 = await auth.finishAuthentication({ requestId: login2.requestId, response: { id: 'credential-1' } });
  const req2 = { headers: { cookie: `${DEVICE_SESSION_COOKIE}=${verified2.sessionId}` } };
  await auth.revokeCredential('credential-1');
  assert.equal(auth.authorizeRequest(req2), null, '撤销设备应立即清除活跃会话');

  const reloaded = await createDeviceAuth({
    home,
    getPublicOrigin: () => 'https://work.example.com',
    webauthn: mockWebAuthn(),
    log: { warn() {} },
  });
  assert.equal(reloaded.status().credentialCount, 0);
}));

test('配对二维码短时一次性，完成申请后不能重复使用', () => withTempHome(async (home) => {
  const auth = await createDeviceAuth({
    home,
    getPublicOrigin: () => 'https://work.example.com',
    webauthn: mockWebAuthn(),
    log: { warn() {} },
  });
  const pairing = auth.beginPairing();
  const token = decodeURIComponent(new URL(pairing.url).hash.slice('#pair='.length));
  await auth.registrationOptions({ token, name: '手机' });
  await auth.finishRegistration({ token, response: { id: 'credential-1' } });
  await assert.rejects(() => auth.registrationOptions({ token, name: '重复' }), /失效/);
}));
