import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

export const DEVICE_SESSION_COOKIE = '__Host-dsh_pocket_device_session';
export const PAIRING_TTL_MS = 5 * 60_000;
export const CHALLENGE_TTL_MS = 2 * 60_000;
export const DEFAULT_SESSION_IDLE_MS = 10 * 60_000;
export const MAX_PENDING_AUTH_CHALLENGES = 256;
export const MAX_ACTIVE_SESSIONS = 256;
export const MAX_SESSIONS_PER_CREDENTIAL = 16;

function cleanDeviceName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80) throw new Error('设备名称应为 1-80 个字符 | device name must be 1-80 characters');
  return name;
}

export function normalizePublicOrigin(value) {
  const url = new URL(String(value ?? '').trim());
  if (url.protocol !== 'https:') throw new Error('固定网址必须使用 HTTPS | public origin must use HTTPS');
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('固定网址只能包含协议和域名 | public origin must contain only scheme and hostname');
  }
  return url.origin;
}

function cookieMap(header) {
  const out = new Map();
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

function secureEqual(a, b) {
  const aa = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function publicCredential(record) {
  return {
    id: record.id,
    publicKey: new Uint8Array(Buffer.from(record.publicKey, 'base64url')),
    counter: Number(record.counter) || 0,
    transports: Array.isArray(record.transports) ? record.transports : undefined,
  };
}

function publicView(record) {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt ?? null,
    deviceType: record.deviceType ?? 'unknown',
    backedUp: record.backedUp === true,
  };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('请求内容过大 | request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function noContent(res, headers = {}) {
  res.writeHead(204, { 'cache-control': 'no-store', ...headers });
  res.end();
}

/**
 * Passkey/WebAuthn 设备白名单。
 * - 持久化内容只有公开凭据和计数器；配对秘密、挑战、会话只在内存。
 * - 配对必须先生成一次性二维码，再由宿主本机批准。
 * - 登录会话是 Secure/HttpOnly 的浏览器会话 cookie，无长期 Max-Age。
 */
export async function createDeviceAuth({
  home,
  getPublicOrigin,
  rpName = 'DSH Pocket',
  sessionIdleMs = DEFAULT_SESSION_IDLE_MS,
  now = () => Date.now(),
  random = (bytes) => randomBytes(bytes),
  webauthn = {},
  log = console,
} = {}) {
  if (!home) throw new Error('device auth requires DSH home');
  if (typeof getPublicOrigin !== 'function') throw new Error('device auth requires getPublicOrigin');

  const statePath = join(home, 'dsh-pocket', 'device-credentials.json');
  const state = await readJson(statePath, { version: 1, credentials: [] });
  if (!Array.isArray(state.credentials)) state.credentials = [];

  const pairings = new Map();
  const pending = new Map();
  const authChallenges = new Map();
  const sessions = new Map();

  const makeRegistrationOptions = webauthn.generateRegistrationOptions ?? generateRegistrationOptions;
  const checkRegistration = webauthn.verifyRegistrationResponse ?? verifyRegistrationResponse;
  const makeAuthenticationOptions = webauthn.generateAuthenticationOptions ?? generateAuthenticationOptions;
  const checkAuthentication = webauthn.verifyAuthenticationResponse ?? verifyAuthenticationResponse;
  const randomId = (bytes = 24) => random(bytes).toString('base64url');
  const origin = () => normalizePublicOrigin(getPublicOrigin());
  const rpID = () => new URL(origin()).hostname;
  const save = () => writeJsonAtomic(statePath, state);

  function cleanup() {
    const t = now();
    for (const [id, row] of pairings) if (row.expiresAt <= t || row.used) pairings.delete(id);
    for (const [id, row] of pending) if (row.expiresAt <= t) pending.delete(id);
    for (const [id, row] of authChallenges) if (row.expiresAt <= t) authChallenges.delete(id);
    for (const [id, row] of sessions) if (t - row.lastForegroundAt > sessionIdleMs) sessions.delete(id);
  }

  function trimOldest(map, limit) {
    while (map.size >= limit) map.delete(map.keys().next().value);
  }

  function pairingByToken(token) {
    cleanup();
    const [id, secret, extra] = String(token ?? '').split('.');
    if (!id || !secret || extra) throw new Error('配对链接无效 | invalid pairing link');
    const row = pairings.get(id);
    if (!row || row.used || row.expiresAt <= now() || !secureEqual(row.secret, secret)) {
      throw new Error('配对链接已失效 | pairing link has expired');
    }
    return row;
  }

  function sessionFromRequest(req) {
    cleanup();
    const id = cookieMap(req.headers.cookie).get(DEVICE_SESSION_COOKIE);
    if (!id) return null;
    const row = sessions.get(id);
    if (!row || now() - row.lastForegroundAt > sessionIdleMs) {
      if (row) sessions.delete(id);
      return null;
    }
    return { id, ...row };
  }

  const api = {
    statePath,
    sessionIdleMs,

    status() {
      cleanup();
      let publicOrigin = null;
      try { publicOrigin = origin(); } catch { /* 尚未配置 */ }
      return {
        configured: Boolean(publicOrigin),
        publicOrigin,
        credentialCount: state.credentials.length,
        credentials: state.credentials.map(publicView),
        pending: [...pending.values()].map((row) => ({
          id: row.id,
          name: row.name,
          requestedAt: row.requestedAt,
          expiresAt: row.expiresAt,
          deviceType: row.credential.deviceType,
          backedUp: row.credential.backedUp,
        })),
      };
    },

    beginPairing() {
      cleanup();
      const publicOrigin = origin();
      const id = randomId(18);
      const secret = randomId(32);
      const row = { id, secret, createdAt: now(), expiresAt: now() + PAIRING_TTL_MS, used: false };
      pairings.set(id, row);
      return {
        id,
        url: `${publicOrigin}/pocket-pair#pair=${encodeURIComponent(`${id}.${secret}`)}`,
        expiresAt: row.expiresAt,
      };
    },

    async registrationOptions({ token, name }) {
      const row = pairingByToken(token);
      row.name = cleanDeviceName(name);
      row.options = await makeRegistrationOptions({
        rpName,
        rpID: rpID(),
        userName: `device-${row.id}`,
        userDisplayName: row.name,
        userID: new Uint8Array(random(32)),
        timeout: 60_000,
        attestationType: 'none',
        excludeCredentials: state.credentials.map((credential) => ({
          id: credential.id,
          transports: credential.transports,
        })),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'required',
        },
      });
      return row.options;
    },

    async finishRegistration({ token, response }) {
      const row = pairingByToken(token);
      if (!row.options?.challenge || !row.name) throw new Error('请重新开始手机配对 | restart device pairing');
      const verification = await checkRegistration({
        response,
        expectedChallenge: row.options.challenge,
        expectedOrigin: origin(),
        expectedRPID: rpID(),
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) throw new Error('手机身份验证失败 | device verification failed');

      const info = verification.registrationInfo;
      const credential = {
        id: info.credential.id,
        name: row.name,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        counter: info.credential.counter,
        transports: info.credential.transports ?? response?.response?.transports ?? [],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        origin: info.origin,
        rpID: info.rpID ?? rpID(),
        createdAt: now(),
        lastUsedAt: null,
      };
      if (state.credentials.some((item) => item.id === credential.id)) throw new Error('这份手机凭据已经注册 | credential already registered');

      row.used = true;
      pairings.delete(row.id);
      const id = randomId(18);
      const request = { id, name: row.name, credential, requestedAt: now(), expiresAt: now() + PAIRING_TTL_MS };
      pending.set(id, request);
      return { pendingId: id, name: request.name, expiresAt: request.expiresAt };
    },

    async approvePending(id) {
      cleanup();
      const request = pending.get(String(id ?? ''));
      if (!request) throw new Error('设备申请不存在或已过期 | device request not found or expired');
      state.credentials.push(request.credential);
      pending.delete(request.id);
      await save();
      return publicView(request.credential);
    },

    rejectPending(id) {
      const found = pending.delete(String(id ?? ''));
      if (!found) throw new Error('设备申请不存在或已过期 | device request not found or expired');
      return true;
    },

    async revokeCredential(id) {
      const credentialId = String(id ?? '');
      const before = state.credentials.length;
      state.credentials = state.credentials.filter((item) => item.id !== credentialId);
      if (state.credentials.length === before) throw new Error('设备凭据不存在 | credential not found');
      for (const [sessionId, row] of sessions) if (row.credentialId === credentialId) sessions.delete(sessionId);
      await save();
      return true;
    },

    async authenticationOptions() {
      cleanup();
      if (!state.credentials.length) throw new Error('尚未批准任何设备，请先在电脑本机配对 | no approved device');
      const options = await makeAuthenticationOptions({
        rpID: rpID(),
        timeout: 60_000,
        userVerification: 'required',
        allowCredentials: state.credentials.map((credential) => ({
          id: credential.id,
          transports: credential.transports,
        })),
      });
      const requestId = randomId(18);
      // 公开登录端点可能被扫描；挑战表必须有硬上限，避免匿名请求造成内存无界增长。
      trimOldest(authChallenges, MAX_PENDING_AUTH_CHALLENGES);
      authChallenges.set(requestId, { challenge: options.challenge, expiresAt: now() + CHALLENGE_TTL_MS });
      return { requestId, options };
    },

    async finishAuthentication({ requestId, response }) {
      cleanup();
      const challenge = authChallenges.get(String(requestId ?? ''));
      authChallenges.delete(String(requestId ?? ''));
      if (!challenge || challenge.expiresAt <= now()) throw new Error('登录请求已过期，请重试 | login request expired');
      const credential = state.credentials.find((item) => item.id === response?.id);
      if (!credential) throw new Error('此设备不在允许名单中 | device is not approved');

      const verification = await checkAuthentication({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin(),
        expectedRPID: rpID(),
        credential: publicCredential(credential),
        requireUserVerification: true,
      });
      if (!verification.verified) throw new Error('手机身份验证失败 | device verification failed');

      credential.counter = verification.authenticationInfo.newCounter;
      credential.lastUsedAt = now();
      credential.deviceType = verification.authenticationInfo.credentialDeviceType;
      credential.backedUp = verification.authenticationInfo.credentialBackedUp;
      await save();

      const sessionId = randomId(32);
      const entryTicket = randomId(18);
      const sameCredential = [...sessions].filter(([, row]) => row.credentialId === credential.id);
      for (let i = 0; i <= sameCredential.length - MAX_SESSIONS_PER_CREDENTIAL; i++) {
        sessions.delete(sameCredential[i][0]);
      }
      trimOldest(sessions, MAX_ACTIVE_SESSIONS);
      sessions.set(sessionId, {
        credentialId: credential.id,
        createdAt: now(),
        lastForegroundAt: now(),
        entryTicket,
      });
      return { sessionId, entryTicket, credential: publicView(credential) };
    },

    authorizeRequest(req) {
      return sessionFromRequest(req);
    },

    consumeEntryTicket(req) {
      const session = sessionFromRequest(req);
      if (!session) return false;
      const ticket = new URL(req.url ?? '/', 'https://dsh-pocket.invalid').searchParams.get('pocket-entry');
      const row = sessions.get(session.id);
      if (!ticket || !row?.entryTicket || !secureEqual(ticket, row.entryTicket)) return false;
      row.entryTicket = null;
      return true;
    },

    touchRequest(req) {
      const session = sessionFromRequest(req);
      if (!session) return false;
      const row = sessions.get(session.id);
      if (!row) return false;
      row.lastForegroundAt = now();
      return true;
    },

    logoutRequest(req) {
      const id = cookieMap(req.headers.cookie).get(DEVICE_SESSION_COOKIE);
      if (id) sessions.delete(id);
    },

    async reset() {
      state.credentials = [];
      pairings.clear();
      pending.clear();
      authChallenges.clear();
      sessions.clear();
      await save();
    },

    async handleHttp(req, res) {
      const path = new URL(req.url ?? '/', 'https://dsh-pocket.invalid').pathname;
      try {
        if (req.method === 'GET' && path === '/pocket-auth/options') {
          return json(res, 200, await api.authenticationOptions());
        }
        if (req.method === 'POST' && path === '/pocket-auth/verify') {
          const result = await api.finishAuthentication(await readJsonBody(req));
          return json(res, 200, {
            ok: true,
            credential: result.credential,
            redirect: `/?pocket-entry=${encodeURIComponent(result.entryTicket)}`,
          }, {
            'set-cookie': `${DEVICE_SESSION_COOKIE}=${result.sessionId}; Secure; HttpOnly; SameSite=Strict; Path=/`,
          });
        }
        if (req.method === 'POST' && path === '/pocket-auth/keepalive') {
          if (!api.touchRequest(req)) return json(res, 401, { error: 'unauthorized' });
          return noContent(res);
        }
        if (req.method === 'POST' && path === '/pocket-auth/logout') {
          api.logoutRequest(req);
          return noContent(res, {
            'set-cookie': `${DEVICE_SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
          });
        }
        if (req.method === 'POST' && path === '/pocket-pair/options') {
          return json(res, 200, { options: await api.registrationOptions(await readJsonBody(req)) });
        }
        if (req.method === 'POST' && path === '/pocket-pair/verify') {
          return json(res, 200, { ok: true, request: await api.finishRegistration(await readJsonBody(req)) });
        }
        return false;
      } catch (error) {
        log.warn?.(`dsh-pocket: device auth request failed: ${error?.message ?? error}`);
        json(res, 400, { error: error?.message ?? String(error) });
        return true;
      }
    },
  };

  return api;
}
