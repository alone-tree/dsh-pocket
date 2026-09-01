import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as argon2 from 'argon2';

export const DEVICE_CREDENTIAL_COOKIE = '__Host-dsh_pocket_device';
export const DEVICE_SESSION_COOKIE = '__Host-dsh_pocket_session';
export const PAIRING_TTL_MS = 5 * 60_000;
export const DEFAULT_SESSION_IDLE_MS = 10 * 60_000;
export const MAX_ACTIVE_SESSIONS = 256;
export const MAX_SESSIONS_PER_DEVICE = 16;
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
export const GENERIC_LOGIN_ERROR = '无法登录，请检查密码或稍后重试 | unable to sign in';

const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
});

function cleanDeviceName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80) throw new Error('设备名称应为 1-80 个字符 | device name must be 1-80 characters');
  return name;
}

function cleanPassword(value) {
  const password = String(value ?? '');
  if (password.length < 6 || password.length > 256) {
    throw new Error('设备密码应为 6-256 个字符 | device password must be 6-256 characters');
  }
  return password;
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

function tokenHash(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('base64url');
}

function publicView(record) {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt ?? null,
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

function deviceCookie(value, { clear = false } = {}) {
  const suffix = clear ? 'Max-Age=0' : `Max-Age=${DEVICE_COOKIE_MAX_AGE_SECONDS}`;
  return `${DEVICE_CREDENTIAL_COOKIE}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; ${suffix}`;
}

function sessionCookie(value, { clear = false } = {}) {
  return `${DEVICE_SESSION_COOKIE}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/${clear ? '; Max-Age=0' : ''}`;
}

function cooldownMs(failedAttempts) {
  if (failedAttempts === 5) return 5 * 60_000;
  if (failedAttempts === 10) return 15 * 60_000;
  if (failedAttempts === 15) return 45 * 60_000;
  if (failedAttempts >= 20 && failedAttempts % 5 === 0) return 24 * 60 * 60_000;
  return 0;
}

class RateLimitError extends Error {}

function requestSource(req) {
  const forwarded = String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

/**
 * 浏览器设备凭据 + 每设备独立密码认证。
 * - 浏览器长期持有随机 HttpOnly Cookie；服务端只保存其 SHA-256 哈希。
 * - 密码使用 Argon2id；配对必须由电脑本机批准。
 * - 登录会话仅在内存中，前台空闲超过 10 分钟后失效。
 */
export async function createDeviceAuth({
  home,
  getPublicOrigin,
  sessionIdleMs = DEFAULT_SESSION_IDLE_MS,
  now = () => Date.now(),
  random = (bytes) => randomBytes(bytes),
  passwords = null,
  rateLimits = {
    login: { limit: 30, windowMs: 60_000 },
    pairing: { limit: 10, windowMs: 5 * 60_000 },
  },
  log = console,
} = {}) {
  if (!home) throw new Error('device auth requires DSH home');
  if (typeof getPublicOrigin !== 'function') throw new Error('device auth requires getPublicOrigin');

  const statePath = join(home, 'dsh-pocket', 'device-credentials.json');
  const stored = await readJson(statePath, null);
  const state = stored?.version === 2 && Array.isArray(stored.devices)
    ? stored
    : { version: 2, devices: [] };
  const legacyStateDetected = Boolean(stored && stored.version !== 2);

  const hashPassword = passwords?.hash ?? ((password) => argon2.hash(password, ARGON2_OPTIONS));
  const verifyPassword = passwords?.verify ?? ((hash, password) => argon2.verify(hash, password));
  const dummyPasswordHash = await hashPassword(random(32).toString('base64url'));

  const pairings = new Map();
  const pending = new Map();
  const sessions = new Map();
  const loginRates = new Map();
  const pairingRates = new Map();
  let mutationQueue = Promise.resolve();

  const randomId = (bytes = 24) => random(bytes).toString('base64url');
  const origin = () => normalizePublicOrigin(getPublicOrigin());
  const save = () => writeJsonAtomic(statePath, state);

  function mutate(task) {
    const result = mutationQueue.then(task, task);
    mutationQueue = result.catch(() => {});
    return result;
  }

  function cleanup() {
    const t = now();
    for (const [id, row] of pairings) if (row.expiresAt <= t || row.used) pairings.delete(id);
    for (const [id, row] of pending) if (row.expiresAt <= t) pending.delete(id);
    for (const [id, row] of sessions) if (t - row.lastForegroundAt > sessionIdleMs) sessions.delete(id);
  }

  function trimOldest(map, limit) {
    while (map.size >= limit) map.delete(map.keys().next().value);
  }

  function consumeRateLimit(map, policy, req) {
    if (!policy?.limit || !policy?.windowMs) return;
    const t = now();
    for (const [key, row] of map) if (row.startedAt + policy.windowMs <= t) map.delete(key);
    const key = requestSource(req);
    let row = map.get(key);
    if (!row) {
      trimOldest(map, 1024);
      row = { startedAt: t, count: 0 };
      map.set(key, row);
    }
    row.count += 1;
    if (row.count > policy.limit) throw new RateLimitError('请求过于频繁，请稍后重试 | too many requests');
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

  function deviceFromRequest(req) {
    const token = cookieMap(req.headers.cookie).get(DEVICE_CREDENTIAL_COOKIE);
    if (!token) return null;
    const hash = tokenHash(token);
    return state.devices.find((row) => secureEqual(row.tokenHash, hash)) ?? null;
  }

  function sessionFromRequest(req) {
    cleanup();
    const id = cookieMap(req.headers.cookie).get(DEVICE_SESSION_COOKIE);
    if (!id) return null;
    const row = sessions.get(id);
    if (!row || now() - row.lastForegroundAt > sessionIdleMs || !state.devices.some((item) => item.id === row.deviceId)) {
      if (row) sessions.delete(id);
      return null;
    }
    return { id, ...row };
  }

  async function rejectLoginAttempt(device, password) {
    const hash = device?.passwordHash ?? dummyPasswordHash;
    let valid = false;
    try { valid = await verifyPassword(hash, password); } catch { valid = false; }
    const locked = Boolean(device?.lockedUntil && device.lockedUntil > now());
    if (!device || locked || !valid) {
      if (device && !locked) {
        device.failedAttempts = (Number(device.failedAttempts) || 0) + 1;
        const wait = cooldownMs(device.failedAttempts);
        device.lockedUntil = wait ? now() + wait : null;
        await save();
      }
      throw new Error(GENERIC_LOGIN_ERROR);
    }
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
        legacyStateDetected,
        deviceCount: state.devices.length,
        devices: state.devices.map(publicView),
        pending: [...pending.values()].map((row) => ({
          id: row.id,
          name: row.device.name,
          requestedAt: row.requestedAt,
          expiresAt: row.expiresAt,
        })),
      };
    },

    beginPairing() {
      cleanup();
      if (pending.size) throw new Error('已有设备等待批准，请先处理 | a device request is already pending');
      pairings.clear();
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

    submitPairing({ token, name, password }) {
      return mutate(async () => {
        const row = pairingByToken(token);
        row.used = true;
        pairings.delete(row.id);
        if (pending.size) throw new Error('已有设备等待批准，请先处理 | a device request is already pending');

        const deviceName = cleanDeviceName(name);
        const devicePassword = cleanPassword(password);
        const rawDeviceToken = randomId(32);
        const requestedAt = now();
        const device = {
          id: randomId(18),
          name: deviceName,
          tokenHash: tokenHash(rawDeviceToken),
          passwordHash: await hashPassword(devicePassword),
          createdAt: requestedAt,
          lastUsedAt: null,
          failedAttempts: 0,
          lockedUntil: null,
        };
        const request = {
          id: randomId(18),
          device,
          requestedAt,
          expiresAt: requestedAt + PAIRING_TTL_MS,
        };
        pending.set(request.id, request);
        return {
          pendingId: request.id,
          name: device.name,
          expiresAt: request.expiresAt,
          deviceToken: rawDeviceToken,
        };
      });
    },

    approvePending(id) {
      return mutate(async () => {
        cleanup();
        const request = pending.get(String(id ?? ''));
        if (!request) throw new Error('设备申请不存在或已过期 | device request not found or expired');
        state.devices.push(request.device);
        pending.delete(request.id);
        await save();
        return publicView(request.device);
      });
    },

    rejectPending(id) {
      const found = pending.delete(String(id ?? ''));
      if (!found) throw new Error('设备申请不存在或已过期 | device request not found or expired');
      return true;
    },

    revokeDevice(id) {
      return mutate(async () => {
        const deviceId = String(id ?? '');
        const before = state.devices.length;
        state.devices = state.devices.filter((item) => item.id !== deviceId);
        if (state.devices.length === before) throw new Error('设备不存在 | device not found');
        for (const [sessionId, row] of sessions) if (row.deviceId === deviceId) sessions.delete(sessionId);
        await save();
        return true;
      });
    },

    login({ req, password }) {
      return mutate(async () => {
        const suppliedPassword = String(password ?? '');
        const device = deviceFromRequest(req);
        await rejectLoginAttempt(device, suppliedPassword);

        device.failedAttempts = 0;
        device.lockedUntil = null;
        device.lastUsedAt = now();
        const rawDeviceToken = randomId(32);
        device.tokenHash = tokenHash(rawDeviceToken);
        await save();

        const sessionId = randomId(32);
        const sameDevice = [...sessions].filter(([, row]) => row.deviceId === device.id);
        for (let i = 0; i <= sameDevice.length - MAX_SESSIONS_PER_DEVICE; i++) sessions.delete(sameDevice[i][0]);
        trimOldest(sessions, MAX_ACTIVE_SESSIONS);
        sessions.set(sessionId, {
          deviceId: device.id,
          createdAt: now(),
          lastForegroundAt: now(),
        });
        return { sessionId, deviceToken: rawDeviceToken, device: publicView(device) };
      });
    },

    hasApprovedDevice(req) {
      return Boolean(deviceFromRequest(req));
    },

    authorizeRequest(req) {
      return sessionFromRequest(req);
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
      state.devices = [];
      pairings.clear();
      pending.clear();
      sessions.clear();
      await save();
    },

    async handleHttp(req, res) {
      const path = new URL(req.url ?? '/', 'https://dsh-pocket.invalid').pathname;
      try {
        if (req.method === 'POST' && path === '/pocket-auth/login') {
          consumeRateLimit(loginRates, rateLimits.login, req);
          const body = await readJsonBody(req);
          const result = await api.login({ req, password: body.password });
          json(res, 200, { ok: true, redirect: '/', device: result.device }, {
            'set-cookie': [
              deviceCookie(result.deviceToken),
              sessionCookie(result.sessionId),
            ],
          });
          return true;
        }
        if (req.method === 'POST' && path === '/pocket-auth/keepalive') {
          if (!api.touchRequest(req)) return json(res, 401, { error: 'unauthorized' });
          noContent(res);
          return true;
        }
        if (req.method === 'POST' && path === '/pocket-auth/logout') {
          api.logoutRequest(req);
          noContent(res, { 'set-cookie': sessionCookie('', { clear: true }) });
          return true;
        }
        if (req.method === 'POST' && path === '/pocket-pair/submit') {
          consumeRateLimit(pairingRates, rateLimits.pairing, req);
          const result = await api.submitPairing(await readJsonBody(req));
          json(res, 200, {
            ok: true,
            request: { pendingId: result.pendingId, name: result.name, expiresAt: result.expiresAt },
          }, { 'set-cookie': deviceCookie(result.deviceToken) });
          return true;
        }
        return false;
      } catch (error) {
        const loginFailure = req.method === 'POST' && path === '/pocket-auth/login';
        const rateLimited = error instanceof RateLimitError;
        log.warn?.(`dsh-pocket: device auth request failed: ${error?.message ?? error}`);
        json(res, rateLimited ? 429 : loginFailure ? 401 : 400, {
          error: loginFailure ? GENERIC_LOGIN_ERROR : (error?.message ?? String(error)),
        });
        return true;
      }
    },
  };

  return api;
}
