// dsh-pocket 安全设置页 + 移动端适配。
// 公网只保留固定 HTTPS 命名隧道；访问身份由本机批准的浏览器设备凭据和独立密码共同确认。

import { createElement as h, useEffect, useMemo, useRef, useState } from 'react';
import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS, redactStatus } from './api.js';
import { mobileApply } from './mobile/mobile-apply.tsx';
import { NS as POCKET_NS, zh as POCKET_ZH, en as POCKET_EN } from './pocket-locales.js';

const name = 'dsh-pocket';
const inject = ['slots', 'connection', 'layout', 'locale', 'sessionLogDownload'];

const styles = {
  page: { display: 'grid', gap: 16, maxWidth: 620 },
  card: { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#dfe5e8)', borderRadius: 12, padding: 18 },
  title: { fontSize: 15, fontWeight: 650, marginBottom: 6 },
  muted: { color: 'var(--dsw-alias-label-secondary,#667784)', fontSize: 12, lineHeight: 1.6 },
  row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  stack: { display: 'grid', gap: 10 },
  input: { width: '100%', minWidth: 0, border: '1px solid var(--dsw-alias-border-l2,#d5dde2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'inherit', padding: '9px 11px', font: 'inherit', fontSize: 13 },
  primary: { border: 0, borderRadius: 999, background: 'var(--dsw-alias-brand-primary,#315efb)', color: '#fff', minHeight: 34, padding: '0 15px', font: 'inherit', fontSize: 13, cursor: 'pointer' },
  button: { border: '1px solid var(--dsw-alias-border-l2,#d5dde2)', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'inherit', minHeight: 34, padding: '0 14px', font: 'inherit', fontSize: 13, cursor: 'pointer' },
  danger: { border: '1px solid rgba(185,54,72,.35)', borderRadius: 999, background: 'transparent', color: '#b93648', minHeight: 30, padding: '0 12px', font: 'inherit', fontSize: 12, cursor: 'pointer' },
  item: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '11px 0', borderTop: '1px solid var(--dsw-alias-border-l2,#e5eaed)' },
  qr: { width: 210, height: 210, border: '1px solid var(--dsw-alias-border-l2,#dfe5e8)', borderRadius: 10, background: '#fff' },
  error: { color: 'var(--dsw-alias-state-error-primary,#b93648)', fontSize: 12, lineHeight: 1.5 },
  ok: { color: '#08775a', fontSize: 12, lineHeight: 1.5 },
};

function formatTime(value) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString(); } catch { return '—'; }
}

function PocketSettingsTab({ rpcCall }) {
  const [status, setStatus] = useState(null);
  const [hostname, setHostname] = useState('');
  const [token, setToken] = useState('');
  const [pairing, setPairing] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const hostnameInitialized = useRef(false);

  const call = async (endpoint, payload = {}) => {
    const response = await rpcCall(endpoint, payload);
    if (!response?.ok) throw new Error(response?.error?.message || '操作失败');
    return response.value;
  };

  const load = async () => {
    try {
      const value = await call(POCKET_ENDPOINTS.status);
      setStatus(value);
      if (!hostnameInitialized.current) {
        hostnameInitialized.current = true;
        setHostname(value?.tunnelConfig?.hostname || '');
      }
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  const run = async (key, fn) => {
    setBusy(key); setError(''); setMessage('');
    try { await fn(); } catch (err) { setError(err?.message || String(err)); }
    finally { setBusy(''); }
  };

  const deviceState = status?.deviceAuth || { devices: [], pending: [], deviceCount: 0 };
  const configured = Boolean(status?.tunnelConfig?.hostname && status?.tunnelConfig?.tokenSet);
  const isRemote = useMemo(() => {
    try { return Boolean(deviceState.publicOrigin && location.origin === deviceState.publicOrigin); }
    catch { return false; }
  }, [deviceState.publicOrigin]);

  if (!status) return h('div', { style: styles.muted }, error || '正在读取 DSH Pocket 状态…');
  if (isRemote) {
    return h('div', { style: styles.card },
      h('div', { style: styles.title }, '安全设置只能在电脑本机管理'),
      h('div', { style: styles.muted }, '手机验证通过后可以完整使用 DSH，但不能从公网入口新增设备、撤销设备或修改 Cloudflare 入口。'),
    );
  }

  const saveTunnel = () => run('save', async () => {
    const next = await call(POCKET_ENDPOINTS.tunnelSetConfig, { hostname, token: token || undefined });
    setStatus(next); setToken(''); setMessage('固定入口已保存');
  });
  const startTunnel = () => run('start', async () => {
    const next = await call(POCKET_ENDPOINTS.tunnelStart);
    setStatus(next); setMessage('固定公网入口已开启');
  });
  const stopTunnel = () => run('stop', async () => {
    const next = await call(POCKET_ENDPOINTS.tunnelStop);
    setStatus(next); setMessage('固定公网入口已关闭');
  });
  const startPairing = () => run('pair', async () => {
    const value = await call(POCKET_ENDPOINTS.devicePairingStart);
    setPairing(value); setMessage('请用目标手机浏览器扫码并设置设备密码，然后回到这里批准');
  });
  const approve = (id) => run(`approve:${id}`, async () => {
    setStatus(await call(POCKET_ENDPOINTS.deviceApprove, { id }));
    setPairing(null); setMessage('设备已允许访问');
  });
  const reject = (id) => run(`reject:${id}`, async () => {
    setStatus(await call(POCKET_ENDPOINTS.deviceReject, { id }));
    setMessage('设备申请已拒绝');
  });
  const revoke = (id, deviceName) => {
    if (!confirm(`移除“${deviceName}”？该设备当前登录会立即失效。`)) return;
    run(`revoke:${id}`, async () => {
      setStatus(await call(POCKET_ENDPOINTS.deviceRevoke, { id }));
      setMessage('设备已移除');
    });
  };

  return h('div', { style: styles.page },
    h('section', { style: styles.card },
      h('div', { style: styles.title }, '固定公网入口'),
      h('p', { style: styles.muted }, '在 Cloudflare 建好命名隧道与固定网址后，只需在这里填写一次。插件不会获取 Cloudflare 账号密码。'),
      h('div', { style: { ...styles.stack, marginTop: 14 } },
        h('input', { style: styles.input, value: hostname, onChange: (e) => setHostname(e.target.value), placeholder: 'pocket.example.com', 'aria-label': '固定网址' }),
        h('input', { style: styles.input, value: token, onChange: (e) => setToken(e.target.value), type: 'password', placeholder: status.tunnelConfig?.tokenSet ? 'Tunnel Token 已保存；留空表示不修改' : '粘贴 Tunnel Token', 'aria-label': 'Tunnel Token' }),
        h('div', { style: styles.row },
          h('button', { style: styles.button, onClick: saveTunnel, disabled: Boolean(busy) }, busy === 'save' ? '保存中…' : '保存设置'),
          status.tunnelRunning
            ? h('button', { style: styles.danger, onClick: stopTunnel, disabled: Boolean(busy) }, busy === 'stop' ? '关闭中…' : '关闭公网入口')
            : h('button', { style: styles.primary, onClick: startTunnel, disabled: Boolean(busy) || !configured }, busy === 'start' ? '开启中…' : '开启公网入口'),
        ),
        h('div', { style: status.tunnelRunning ? styles.ok : styles.muted }, status.tunnelRunning ? `运行中：${status.tunnelUrl}` : configured ? '配置完整，当前未开启' : '请先保存固定网址和 Tunnel Token'),
      ),
    ),

    h('section', { style: styles.card },
      h('div', { style: styles.title }, '允许访问的设备'),
      h('p', { style: styles.muted }, '点击“添加设备”生成二维码，用目标手机浏览器扫码并设置设备名称和密码。手机提交后，回到电脑点击“允许”。批准完成后，在手机配对页点击“电脑已批准，进入 DSH”，再输入刚设置的密码。'),
      h('div', { style: { ...styles.row, marginTop: 14 } },
        h('button', { style: styles.primary, onClick: startPairing, disabled: Boolean(busy) || !status.tunnelRunning }, busy === 'pair' ? '生成中…' : '添加设备'),
        !status.tunnelRunning ? h('span', { style: styles.muted }, '请先开启固定公网入口') : null,
      ),
      pairing ? h('div', { style: { ...styles.stack, marginTop: 16, alignItems: 'start' } },
        h('img', { src: pairing.qr, alt: '手机配对二维码', style: styles.qr }),
        h('div', { style: styles.muted }, `二维码将在 ${formatTime(pairing.expiresAt)} 失效`),
      ) : null,
      deviceState.pending?.length ? h('div', { style: { marginTop: 16 } },
        h('div', { style: { ...styles.title, fontSize: 13 } }, '等待电脑批准'),
        ...deviceState.pending.map((device) => h('div', { key: device.id, style: styles.item },
          h('div', null,
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, device.name),
            h('div', { style: styles.muted }, `申请时间：${formatTime(device.requestedAt)}`),
          ),
          h('div', { style: styles.row },
            h('button', { style: styles.primary, onClick: () => approve(device.id), disabled: Boolean(busy) }, '允许'),
            h('button', { style: styles.button, onClick: () => reject(device.id), disabled: Boolean(busy) }, '拒绝'),
          ),
        )),
      ) : null,
      h('div', { style: { marginTop: 12 } },
        deviceState.devices?.length
          ? deviceState.devices.map((device) => h('div', { key: device.id, style: styles.item },
              h('div', null,
                h('div', { style: { fontSize: 13, fontWeight: 600 } }, device.name),
                h('div', { style: styles.muted }, `最近使用：${formatTime(device.lastUsedAt)}`),
              ),
              h('button', { style: styles.danger, onClick: () => revoke(device.id, device.name), disabled: Boolean(busy) }, '移除'),
            ))
          : h('div', { style: styles.muted }, '尚未批准任何设备。公网入口不会暴露 DSH。'),
      ),
    ),

    error ? h('div', { style: styles.error }, error) : null,
    message ? h('div', { style: styles.ok }, message) : null,
  );
}

export function apply(ctx) {
  mobileApply(ctx);
  const rpcCall = (endpoint, payload, signal) => ctx.connection.rpc.call(POCKET_RPC_CHANNEL, endpoint, payload, signal);
  const translate = ctx.locale.bind(POCKET_NS);
  ctx.effect(() => ctx.locale.register(POCKET_NS, { zh: POCKET_ZH, en: POCKET_EN }), 'dsh-pocket: pocket locale dictionaries');
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'pocket', order: 1, label: () => translate('section'), inject: () => ({ rpcCall }),
  }, PocketSettingsTab));
}

export { name, inject, redactStatus };
