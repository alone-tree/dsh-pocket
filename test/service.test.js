import test from 'node:test';
import assert from 'node:assert/strict';
import { createPocketService } from '../lib/service.mjs';
import { installPocketRpc } from '../lib/web-rpc.js';
import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS } from '../client/api.js';

function fakeConnection() {
  let handler = null;
  return {
    rpc: {
      handle(channel, fn, options) {
        assert.equal(channel, POCKET_RPC_CHANNEL);
        assert.deepEqual(options, { authority: 'loopback' });
        handler = fn;
        return () => { handler = null; };
      },
    },
    get handler() { return handler; },
  };
}

function baseInternals(overrides = {}) {
  return {
    encodeQr: async (text) => `data:qr;${text}`,
    createProxy: async (options) => ({ server: { address: () => ({ address: options.host }) }, port: options.port, close: async () => {} }),
    startNamedTunnel: async () => ({ kill() {}, onExit() {} }),
    ...overrides,
  };
}

test('service 只创建 loopback 代理并传入设备白名单', async () => {
  let captured = null;
  const deviceAuth = { status: () => ({ credentialCount: 0 }) };
  const service = createPocketService({
    dshPort: 3080,
    port: 3081,
    deviceAuth,
    internals: baseInternals({ createProxy: async (options) => { captured = options; return { port: options.port, close: async () => {} }; } }),
  });
  await service.startProxy();
  assert.equal(captured.host, '127.0.0.1');
  assert.equal(captured.deviceAuth, deviceAuth);
  const status = await service.status();
  assert.equal(status.proxyPort, 3081);
  assert.equal(status.deviceAuth.credentialCount, 0);
  assert.equal('lanUrl' in status, false);
  await service.dispose();
});

test('固定域名或 Token 缺失时拒绝开放公网，错误状态不触发竞态异常', async () => {
  const service = createPocketService({
    dshPort: 3080,
    port: 3081,
    getTunnelConfig: () => ({ hostname: '', token: '' }),
    internals: baseInternals(),
  });
  await assert.rejects(() => service.startTunnel(), /固定公网入口未配置完整/);
  const status = await service.status();
  assert.equal(status.tunnelRunning, false);
  assert.equal(status.tunnelState.phase, 'error');
  assert.doesNotMatch(status.tunnelState.detail, /before initialization/);
  await service.dispose();
});

test('只启动命名 Tunnel，并返回固定 HTTPS 地址', async () => {
  const calls = [];
  let killed = false;
  const service = createPocketService({
    dshPort: 3080,
    port: 3081,
    getTunnelConfig: () => ({ hostname: 'work.example.com', token: 'T'.repeat(40) }),
    internals: baseInternals({
      startNamedTunnel: async (options) => { calls.push(options); return { kill: () => { killed = true; }, onExit() {} }; },
    }),
  });
  assert.equal(await service.startTunnel(), 'https://work.example.com');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].token, 'T'.repeat(40));
  const status = await service.status();
  assert.equal(status.tunnelRunning, true);
  assert.equal(status.tunnelUrl, 'https://work.example.com');
  assert.equal(status.tunnelConfig.mode, 'named');
  service.stopTunnel();
  assert.equal(killed, true);
  await service.dispose();
});

test('端口冲突时仅在 loopback 上尝试下一个端口', async () => {
  const seen = [];
  const service = createPocketService({
    dshPort: 3080,
    port: 3081,
    internals: baseInternals({
      createProxy: async (options) => {
        seen.push(options);
        if (options.port === 3081) throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
        return { port: options.port, close: async () => {} };
      },
    }),
  });
  const proxy = await service.startProxy();
  assert.equal(proxy.port, 3082);
  assert.deepEqual(seen.map((row) => row.host), ['127.0.0.1', '127.0.0.1']);
  await service.dispose();
});

test('RPC 支持生成配对、批准、拒绝和撤销设备', async () => {
  const connection = fakeConnection();
  const actions = [];
  const deviceAuth = {
    status: () => ({ credentialCount: 1, credentials: [], pending: [] }),
    beginPairing: () => ({ id: 'pair-1', url: 'https://work.example.com/pocket-pair#pair=x', expiresAt: Date.now() + 1000 }),
    approvePending: async (id) => actions.push(`approve:${id}`),
    rejectPending: (id) => actions.push(`reject:${id}`),
    revokeCredential: async (id) => actions.push(`revoke:${id}`),
  };
  const service = {
    status: async () => ({ proxyRunning: true, tunnelConfig: { mode: 'named', hostname: 'work.example.com', tokenSet: true }, deviceAuth: deviceAuth.status() }),
  };
  installPocketRpc({ connection }, { service, deviceAuth, getTunnelConfig: () => ({ mode: 'named', hostname: 'work.example.com', tokenSet: true }), log: { error() {} } });
  const call = (endpoint, payload = {}) => connection.handler(endpoint, payload);

  const pairing = await call(POCKET_ENDPOINTS.devicePairingStart);
  assert.equal(pairing.ok, true);
  assert.match(pairing.value.qr, /^data:image\/png/);
  assert.equal((await call(POCKET_ENDPOINTS.deviceApprove, { id: 'p' })).ok, true);
  assert.equal((await call(POCKET_ENDPOINTS.deviceReject, { id: 'q' })).ok, true);
  assert.equal((await call(POCKET_ENDPOINTS.deviceRevoke, { id: 'r' })).ok, true);
  assert.deepEqual(actions, ['approve:p', 'reject:q', 'revoke:r']);
});
