// dsh-pocket 核心：Host/Origin 改写反向代理
//
// 为什么需要它：DSH 的 /api 浏览器信任栅栏只认 loopback（127.0.0.1）或
// `--trusted-host` 白名单（且官方禁了 0.0.0.0 绑定，防止把远程执行代码暴露给网络）。
// 本代理把入站请求的 Host / Origin 统一改写成 loopback 权威（127.0.0.1:3080），
// 转发给本机 dsh web。代理本身只监听 127.0.0.1，唯一外部入口是固定域名
// Cloudflare Named Tunnel；所有页面、API 和 WebSocket 都先经过浏览器设备凭据与密码认证。
//
// 同步保证：普通请求与 WebSocket upgrade（/api/events.host 流式推送）都原样透传，
// 手机看到的界面与电脑完全一致、实时。

import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createGzip, createBrotliCompress, constants as zlibConstants } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { deviceLoginPage, devicePairPage, SESSION_GUARD_SCRIPT } from './auth-pages.mjs';

const DEFAULT_UPSTREAM = { host: '127.0.0.1', port: 3080 };
const AUTH_CLIENT = readFileSync(new URL('../client/auth.js', import.meta.url), 'utf8');
const AUTH_PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/**
 * 非安全上下文（http://<LAN-IP>:端口）里浏览器缺两个 API，由代理注入 polyfill
 * （只在缺少时生效，不覆盖原生实现）：
 *   1. crypto.randomUUID——DSH 连接层 mint RPC id 用，缺失直接抛错；
 *   2. AbortSignal.any（issue #53）——Android 厂商浏览器/WebView（Chrome < 116）
 *      无原生实现，DSH 连接层发送消息会调 AbortSignal.any([...])，缺失则消息发不出。
 * 带 data-dsh-pocket-polyfill 标记：注入判重用它，而不是搜索 "crypto.randomUUID"
 * 字样（dsh 页面源码里可能恰好出现该字符串，导致误判为已注入而跳过）。
 */
export const RANDOM_UUID_POLYFILL = `<script data-dsh-pocket-polyfill="1">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();
!function(){try{if(self.AbortSignal&&!self.AbortSignal.any){self.AbortSignal.any=function(signals){var controller=new AbortController();var list=Array.from(signals||[]);var done=false;var handlers=list.map(function(signal){return function(){abort(signal);};});function cleanup(){for(var i=0;i<list.length;i++){try{list[i].removeEventListener('abort',handlers[i]);}catch(e){}}}function abort(signal){if(done)return;done=true;cleanup();try{controller.abort(signal.reason);}catch(e){controller.abort();}}for(var j=0;j<list.length;j++){var sig=list[j];if(sig.aborted){abort(sig);break;}sig.addEventListener('abort',handlers[j],{once:true});}return controller.signal;};}}catch(e){}}();
/* 注：曾用「全局 let location + Proxy」伪装 location.hostname 修 DSH isLoopback 判定
（issue #58：局域网访问模型设置页报 settings unavailable）——但 let location 全局
词法绑定会让任何恰好顶层声明 location 的脚本（DSH 插件经典 script）SyntaxError 崩溃，
导致会话列表不显示（实测 PAGEERROR: Identifier 'location' has already been declared）。
已回退；该问题属 DSH 客户端限制（location.hostname 是 unforgeable 属性）无法安全绕过。*/</script>`;

const INJECT_MARK = 'data-dsh-pocket-polyfill="1"';

/**
 * DSH Desktop（桌面版）渲染进程兼容补丁（issue #3/#4，已于 issue #76 停用）。
 *
 * 历史：旧版 dsh-plugin-desktop 的 client 在页面加载时从 URL query 读
 * `dsh-desktop-mode` 与 `dsh-desktop-platform`，缺失即抛
 * "invalid or missing dsh-desktop-mode null" → 页面崩（手机扫码访问桌面版时正是如此）。
 * 本脚本用 history.replaceState 补上这两个参数（无跳转、不重载），取最轻的
 * `compatibility` 模式——不激活桌面布局，避免与移动端适配叠加。
 *
 * @deprecated 不要再注入（issue #76，DSH Desktop 2.0.3 起）：
 *   ① mode 与 platform **同时缺失**时，parseDesktopClientEnvironment 直接返回 undefined
 *      （视作非桌面外壳，跳过全部桌面逻辑），正是手机/浏览器页面需要的效果；
 *   ② 只要 URL 上出现任一 dsh-desktop-* 标记，客户端就强制校验整组（material +
 *      semver version + mica），只补两个必然抛 "invalid or missing
 *      dsh-desktop-material" → 插件树加载失败 → 页面变成「打开恢复模式」；
 *   ③ 更糟：decideDesktopBrowserAccess 见到 dsh-desktop-* 前缀就把没有渲染器 token 的
 *      普通浏览器判为 denied（403），刷新后直接打不开。
 * lib/index.js 已不再注入本脚本；保留导出仅为兼容旧版本桌面端与既有测试。
 */
export function desktopEnvPatchScript(platform) {
  const p = ['darwin', 'win32', 'linux'].includes(platform) ? platform : 'linux';
  return `<script data-dsh-pocket-desktop-patch="1">!function(){try{var s=new URLSearchParams(location.search);if(!s.has('dsh-desktop-mode')||!s.has('dsh-desktop-platform')){s.set('dsh-desktop-mode','compatibility');s.set('dsh-desktop-platform','${p}');var u=new URL(location.href);u.search=s.toString();history.replaceState(null,'',u);}}catch(e){}}();</script>`;
}

/** 上游响应是否压缩过（压缩流不能做文本注入，会损坏页面）。 */
function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''));
}

/** 默认注入到经代理的 HTML 文档里：crypto.randomUUID polyfill（非安全上下文必需）。 */
export const DEFAULT_INJECT = RANDOM_UUID_POLYFILL;

/**
 * DSH Desktop advanced 模式不支持的提示覆盖层（issue #19）。
 * advanced 组合会禁用网页版 ui-layout，而桌面 layout 只在 advanced client 提供——
 * 手机页面被注入 compatibility 后无任何 layout 服务 → 启动白屏（Failed to load plugins）。
 * 该脚本在页面上叠加一个固定警告层，让用户明确知道原因（而不是无解白屏）。
 */
export function advancedNoticeScript() {
  return `<script data-dsh-pocket-advanced-notice="1">!function(){try{var d=document.createElement('div');d.style.cssText='position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:24px';d.textContent='DSH 桌面端处于 advanced 模式，手机访问暂不支持。请在桌面端设置中切回 compatibility 模式后重启。| DSH Desktop is in advanced mode — phone access is not supported yet. Switch back to compatibility in the desktop app and restart.';document.documentElement.appendChild(d);}catch(e){}}();</script>`;
}

/** 桌面端浏览器访问门禁提示页（issue #81）：DSH Desktop 未开启「浏览器访问」时，
 * 上游 desktop-browser-access 门禁对普通浏览器（含经本代理转发的手机）返回 403
 * `forbidden`，且本代理无法携带 Electron renderer secret 绕过。对符合该特征的
 * 浏览器导航请求返回此可操作提示页；API/WS 与其余 403 原样透传。 */
function desktopAccessBlockedPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket · 桌面端未开启浏览器访问</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:392px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 8px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 12px;line-height:1.6}
code{background:#f3f4f6;padding:2px 6px;border-radius:6px;font-size:12px;color:#374151}
.step{text-align:left;background:#f9fafb;border:1px solid #eef2f7;border-radius:10px;padding:12px 14px;margin-top:8px;font-size:12px;color:#4b5563;line-height:1.8}
</style></head><body><div class="card">
<h1>🖥️ DSH Pocket</h1>
<p>设备身份已确认，但页面仍被拦截。<br>因为本机 DSH Desktop 未开启「浏览器访问」，桌面门禁拒绝了普通浏览器（含手机）的页面请求。</p>
<div class="step">
<strong>解决方法（任选其一）：</strong><br>
1. DSH Desktop → 设置 → 窗口 / 模式 → 开启「浏览器访问」（自动切到 compatibility 模式）→ <strong>重启 DSH Desktop</strong>。<br>
2. 或在配置文件中设置：<br>
<code>dsh-desktop: { mode: compatibility, openBrowser: true }</code><br>
然后重启 DSH Desktop，再刷新本页。
</div>
<p style="margin-top:14px">注意：设备身份确认成功不等于已获得桌面 Web 访问授权。门禁由 DSH Desktop 控制，pocket 无法代为绕过。</p>
<p style="color:#9ca3af">The host DSH Desktop has "browser access" disabled. Enable it (Settings → window/mode → browser access → restart), or set <code>dsh-desktop.mode: compatibility, openBrowser: true</code>, then refresh.</p>
</div></body></html>`;
}

/** 请求是否期望 HTML（浏览器导航 → 返回登录页；API/WS → 401）。 */
function isHtmlRequest(req) {
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/html') || req.url === '/' || /\.html?$/i.test(String(req.url));
}

/** 把浏览器可见的权威改写成 loopback 权威（Host 和 Origin 都改）。 */
function loopbackAuthority(headers, upstream) {
  const authority = `${upstream.host}:${upstream.port}`;
  headers.Host = authority;
  if (headers.origin) headers.origin = `http://${authority}`;
  if (headers.Origin) headers.Origin = `http://${authority}`;
  return headers;
}

// ---------- dsh web 浏览器会话 token（issue #77） ----------
// 新版 dsh web（>= 0.1.2-alpha.1）给浏览器会话加了启动 token：根路径 `GET /` 必须带一次
// `?token=<启动 token>` 换一个绑定 authority 的 cookie，之后 /api 与 WebSocket 才放行；
// 否则一律 401（"dsh web authentication required"）。手机扫码进来的 URL 天然没有这个
// token，所以代理要在转发时补一次。
//
// 只在 `GET /` 且请求还没带 dsh-auth-* cookie 时注入：上游拿到 token 会 303 回干净的根
// 路径，若每次都注入就会 303 循环（浏览器很快报"重定向次数过多"）。
const DSH_AUTH_COOKIE = 'dsh-auth-';

/**
 * 去掉 URL 上所有 `dsh-desktop-*` query 参数（issue #75）。
 *
 * dsh-pocket 在 ≤ 2.1.1 会用 `history.replaceState` 往页面 URL 上写
 * `dsh-desktop-mode=compatibility` 和 `dsh-desktop-platform=<系统>`
 * （desktopEnvPatchScript，已在 2.1.2 删除）。副作用是：用户当时收藏/保存过
 * 的那个地址**一直带着这两个参数**。升级之后我们不再注入了，但用户打开旧
 * 收藏时 URL 里仍然有 —— 上游 `decideDesktopBrowserAccess` 只要见到
 * `dsh-desktop-` 前缀就认定是渲染器请求，普通浏览器没有渲染器 token，直接
 * 403 forbidden。表现就是「我已经升到最新版了，还是 forbidden」。
 *
 * 脏参数是我们写进去的，就得由我们清掉。所有方法、所有路径都清理（不只是
 * `GET /`）——API 与 WebSocket 握手带上这些参数同样会被拦。
 *
 * @param {string} reqUrl - 原始请求路径（含 query）。
 * @returns {string} 清理后的路径；无该前缀参数或解析失败时原样返回。
 */
export function stripDesktopMarkers(reqUrl) {
  let u;
  try {
    u = new URL(reqUrl ?? '/', 'http://dsh.invalid');
  } catch {
    return reqUrl;
  }
  const doomed = [...u.searchParams.keys()].filter((k) => k.startsWith('dsh-desktop-'));
  if (doomed.length === 0) return reqUrl;
  for (const key of doomed) u.searchParams.delete(key);
  return `${u.pathname}${u.search}`;
}

export function upstreamPathWithLaunchToken(reqUrl, method, cookieHeader, launchToken) {
  if (method !== 'GET') return reqUrl;
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://dsh.invalid'); } catch { return reqUrl; }
  if (u.pathname !== '/') return reqUrl;
  // 登录成功后跳回的 `/?dsh-pocket-auth=1`：强制重做一次握手（旧 cookie 可能已过期/被撤销）
  const force = u.searchParams.has('dsh-pocket-auth');
  if (!force && String(cookieHeader ?? '').includes(DSH_AUTH_COOKIE)) return reqUrl;
  if (!launchToken) return reqUrl;
  u.searchParams.set('token', launchToken);
  return `${u.pathname}${u.search}`;
}

// ---------- WebSocket 心跳注入（PR #41，issue #29） ----------
// DSH 客户端与宿主的 WebSocket downlink 都不发 ping/pong（客户端只读流、
// 宿主只推帧），空闲连接会被路由器 NAT 空闲超时或手机系统省电机制**静默**
// 丢弃：没有 FIN/RST，浏览器收不到 close 事件，dsh-client-connection 也就
// 永远不会重连——手机页面看起来还开着，实则实时通道已死（消息不同步、
// 点击会话卡在加载）。
//
// 代理在每个透传的 WS 连接上定期向浏览器侧发送协议层 Ping（0x89 0x00，
// server→client 不掩码）：
//   - 浏览器网络栈按 RFC 6455 自动回 Pong（不经过任何 JS），一来一回让
//     双向都有流量，NAT/防火墙空闲超时不再触发；
//   - 连续 missLimit 个周期没有任何入站字节（浏览器已死或链路被静默丢弃）
//     → 主动 destroy 连接：浏览器拿到 close 后 dsh-client-connection 会
//     按指数退避自动重连，实时通道随即恢复。
// 只 Ping 浏览器侧：上游是本机 loopback，不会过期；浏览器回的 Pong 原样
// 透传给上游 ws 服务（未请求的 Pong 对 ws 库无害，只触发无害的 pong 事件）。
const WS_PING_FRAME = Buffer.from([0x89, 0x00]); // FIN + opcode 9、长度 0、不掩码

/**
 * 在透传的浏览器侧 socket 上挂载心跳：定期 Ping 保活 + 静默断链检测。
 * 任一路由方向只要有字节流动（Pong 响应）就把静默计数归零；连续 missLimit
 * 个周期零入站流量则判定链路已死，销毁 socket 触发浏览器端重连。
 * @param {import('node:net').Socket} socket 浏览器侧的透传 socket
 * @param {{intervalMs?:number, missLimit?:number}} [opts] 心跳周期与容忍的静默周期数
 */
function attachWebSocketHeartbeat(socket, { intervalMs = 30_000, missLimit = 2 } = {}) {
  let misses = 0;
  let stopped = false;
  const onInbound = () => { misses = 0; };
  const timer = setInterval(() => {
    if (stopped) return;
    misses += 1;
    if (misses >= missLimit) {
      // 连续多个周期没有任何入站流量（连 Pong 都没有）→ 静默断链，断开让客户端重连
      socket.destroy();
      return;
    }
    // write 到已销毁的 socket 会抛错（destroy 竞态），写前检查并兜底
    if (!socket.destroyed) {
      try { socket.write(WS_PING_FRAME); } catch { /* 忽略 */ }
    }
  }, intervalMs);
  timer.unref?.();
  socket.on('data', onInbound);
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off('data', onInbound);
    socket.off('close', cleanup);
    socket.off('error', cleanup);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/**
 * 启动 dsh-pocket 代理。
 * @param {object} opts
 * @param {number} [opts.port]      监听端口（默认 3081；dsh web 保持 3080）
 * @param {string} [opts.host]      监听地址（默认 127.0.0.1：只允许本机 cloudflared 连接）
 * @param {{host:string,port:number}} [opts.upstream] 上游 dsh web（默认 127.0.0.1:3080）
 * @param {string} [opts.injectHtml] 注入 HTML 的内容（默认 polyfill + 移动端适配；传 '' 关闭）
 * @param {object} [opts.deviceAuth] 浏览器设备凭据、密码与短会话管理器
 * @param {object|false} [opts.heartbeat] WebSocket 心跳注入：{ intervalMs, missLimit }；false 关闭
 * @returns {Promise<{server:import('node:http').Server, close:()=>Promise<void>}>}
 */
export function createPocketProxy({ port = 3081, host = '127.0.0.1', upstream = DEFAULT_UPSTREAM, log = null, injectHtml = DEFAULT_INJECT, deviceAuth = null, heartbeat = {}, launchToken = () => '' } = {}) {
  const effectiveInjectHtml = deviceAuth ? `${injectHtml ?? ''}${SESSION_GUARD_SCRIPT}` : injectHtml;
  const server = createServer((req, res) => {
    const requestPath = new URL(req.url ?? '/', 'https://dsh-pocket.invalid').pathname;

    // 安全模式的公开页面和认证接口。处理函数自行返回响应；未知接口不向 DSH 透传。
    if (deviceAuth) {
      if (req.method === 'GET' && requestPath === '/pocket-auth/auth-v2.js') {
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(AUTH_CLIENT);
        return;
      }
      if (req.method === 'GET' && requestPath === '/pocket-pair') {
        res.writeHead(200, AUTH_PAGE_HEADERS);
        res.end(devicePairPage());
        return;
      }
      if (requestPath.startsWith('/pocket-auth/') || requestPath.startsWith('/pocket-pair/')) {
        void Promise.resolve(deviceAuth.handleHttp(req, res)).then((handled) => {
          if (!handled && !res.headersSent) {
            res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end('{"error":"not-found"}');
          }
        }).catch((error) => {
          log?.(`dsh-pocket: device auth failed: ${error?.message ?? error}`);
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          if (!res.writableEnded) res.end('{"error":"device-auth-failed"}');
        });
        return;
      }

      const session = deviceAuth.authorizeRequest(req);
      if (!session) {
        if (req.method === 'GET' && isHtmlRequest(req)) {
          const status = deviceAuth.status();
          res.writeHead(200, AUTH_PAGE_HEADERS);
          res.end(deviceLoginPage({
            deviceCount: status.deviceCount,
            paired: deviceAuth.hasApprovedDevice(req),
          }));
        } else {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end('{"error":"device-auth-required"}');
        }
        return;
      }
    }
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    // 顶层页面必须保持未压缩，才能可靠注入前台续期守卫。
    if (deviceAuth && isHtmlRequest(req)) delete headers['accept-encoding'];
    // dsh web 浏览器会话 token（issue #77）：首屏根路径补一次，换回绑定 authority 的 cookie
    const launchTok = (typeof launchToken === 'function' ? launchToken() : '') || '';
    // 先清掉历史遗留的 dsh-desktop-* 参数（issue #75），再补 launch token
    const upstreamPath = upstreamPathWithLaunchToken(
      stripDesktopMarkers(req.url),
      req.method,
      req.headers.cookie,
      launchTok,
    );
    const proxyReq = httpRequest(
      { host: upstream.host, port: upstream.port, method: req.method, path: upstreamPath, headers, agent: false },
      (proxyRes) => {
        log?.(`${req.method} ${req.url} -> ${proxyRes.statusCode}`);
        const contentType = String(proxyRes.headers['content-type'] ?? '');
        // issue #81：上游 desktop-browser-access 门禁（DSH Desktop 未开启「浏览器访问」时）
        // 对普通浏览器（含经本代理转发的手机）返回 403 text/plain "forbidden"，且本代理无法
        // 携带 Electron renderer secret 绕过。对符合该特征的**浏览器导航**请求改写为可操作
        // 提示页；API/WS 与其余 403 原样透传（不猜 secret、不把任意 403 都判为桌面门禁）。
        if (proxyRes.statusCode === 403 && contentType.includes('text/plain')) {
          const navReq = isHtmlRequest(req);
          const gateChunks = [];
          let gateOverflow = false;
          const passRaw403 = () => {
            if (res.headersSent) return;
            res.writeHead(403, { ...proxyRes.headers });
            if (gateChunks.length) res.write(Buffer.concat(gateChunks));
            proxyRes.pipe(res);
          };
          proxyRes.on('data', (c) => {
            if (gateOverflow) return;
            gateChunks.push(c);
            if (Buffer.concat(gateChunks).length > 65536) { gateOverflow = true; gateChunks.length = 0; passRaw403(); }
          });
          proxyRes.on('end', () => {
            if (gateOverflow || res.headersSent) return;
            const body = Buffer.concat(gateChunks).toString('utf8').trim();
            if (navReq && body === 'forbidden') {
              res.writeHead(403, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'x-dsh-pocket-gate': 'desktop-browser-access',
              });
              res.end(desktopAccessBlockedPageHtml());
            } else {
              res.writeHead(403, { ...proxyRes.headers });
              res.end(Buffer.concat(gateChunks));
            }
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }
        // 只给**未压缩**的 HTML 文档注入（SSE/WS/JS/CSS 原样透传；压缩流注入会损坏页面）；
        // 注入后修正 Content-Length
        if (effectiveInjectHtml && contentType.includes('text/html') && !isCompressed(proxyRes.headers)) {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            let html = Buffer.concat(chunks).toString('utf8');
            if (!html.includes(INJECT_MARK)) {
              html = html.replace(/<head[^>]*>/i, (m) => `${m}${effectiveInjectHtml}`);
            }
            const out = Buffer.from(html, 'utf8');
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-length'];
            delete outHeaders['transfer-encoding'];
            outHeaders['content-length'] = String(out.length);
            if (deviceAuth) outHeaders['referrer-policy'] = 'no-referrer';
            res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
            res.end(out);
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }
        // 大 JSON/text 响应**流式压缩**（issue #12）：长会话历史一次返回 17MB+，
        // 局域网直连与隧道段都吃满带宽；压缩到 ~1MB。跳过已压缩、SSE 流
        // （/api/events.* 原样透传）、HTML（走上面的注入分支）。
        // brotli 质量选 6（issue #25）：zlib 默认 q11 压 17MB 要 40s+，手机直接超时；
        // q6 实测 128ms（比 gzip 的 88ms 略慢但同档）且输出更小（1.00MB vs 1.20MB）。
        const acceptEncoding = String(req.headers['accept-encoding'] ?? '');
        const canGzip = /\bgzip\b/.test(acceptEncoding);
        const canBr = /\bbr\b/.test(acceptEncoding);
        const isEventStream = contentType.includes('text/event-stream');
        const knownLen = Number(proxyRes.headers['content-length'] || 0);
        const shouldCompress = (canGzip || canBr)
          && !isCompressed(proxyRes.headers)
          && !isEventStream
          && (contentType.includes('application/json') || contentType.startsWith('text/'))
          && (knownLen === 0 || knownLen >= 1024);
        if (shouldCompress) {
          const enc = canBr ? 'br' : 'gzip';
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders['content-length'];
          delete outHeaders['transfer-encoding'];
          outHeaders['content-encoding'] = enc;
          res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
          const z = enc === 'br'
            ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } })
            : createGzip();
          proxyRes.pipe(z).pipe(res);
          // 任一端断开都要清理（含压缩流）。注意：不能用 proxyRes 的 'close'
          // 来掐 res——正常结束后 close 也会触发，此时压缩流可能还没写完，
          // 会误杀连接；异常中止用 'aborted'。
          res.on('close', () => { proxyRes.destroy(); z.destroy(); });
          proxyRes.on('error', () => { z.destroy(); res.destroy(); });
          proxyRes.on('aborted', () => { z.destroy(); res.destroy(); });
          z.on('error', () => res.destroy());
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        // 任一端断开都要清理另一端：客户端断连销毁上游流（不留僵尸），
        // 上游流中途断开也要掐断客户端（否则响应头已发、体没发完 → 悬挂）
        res.on('close', () => proxyRes.destroy());
        proxyRes.on('error', () => res.destroy());
        proxyRes.on('close', () => { if (!res.writableEnded) res.destroy(); });
      },
    );
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`dsh-pocket: 无法连接上游 dsh web（${upstream.host}:${upstream.port}）——先启动 dsh web | ${err.message}`);
    });
    req.pipe(proxyReq);
  });

  // WebSocket upgrade（DSH 的 /api/events.mux + events.host 流式通道）原样透传
  server.on('upgrade', (req, socket, head) => {
    if (deviceAuth && !deviceAuth.authorizeRequest(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // 页面进入后台后不再发送 keepalive；短会话过期时主动关闭已经建立的 WS，
    // 防止旧连接绕过 10 分钟后台超时。
    const deviceSessionTimer = deviceAuth ? setInterval(() => {
      if (!deviceAuth.authorizeRequest(req)) socket.destroy();
    }, 30_000) : null;
    if (deviceSessionTimer) {
      deviceSessionTimer.unref?.();
      socket.once('close', () => clearInterval(deviceSessionTimer));
    }
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    const proxyReq = httpRequest({
      // 同样清掉历史遗留的 dsh-desktop-* 参数（issue #75）
      host: upstream.host, port: upstream.port, method: req.method, path: stripDesktopMarkers(req.url), headers, agent: false,
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      // 原样回传上游的 upgrade 头（Sec-WebSocket-Accept 等）
      const raw = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      socket.write(`${raw.join('\r\n')}\r\n\r\n`);
      if (proxyHead?.length) socket.write(proxyHead);
      // pipe 必须 end:false：默认 end:true 会在对端 FIN 时抢先 end() 对端 socket
      // （优雅 FIN），此时 teardown 的 destroy() 已无法强制关闭对方——上游只收
      // 到 FIN 进入 half-open 永不关闭（PR #56）。半关闭统一交给下面的 'end'
      // 监听 → teardown destroy（RST 强制关闭双方）。
      socket.pipe(proxySocket, { end: false });
      proxySocket.pipe(socket, { end: false });
      // 心跳注入（PR #41）：保活 + 静默断链检测（见 attachWebSocketHeartbeat）
      if (heartbeat !== false) attachWebSocketHeartbeat(socket, heartbeat ?? {});
      // 任一端断开都要清理另一端（避免上游残留僵尸连接占用 dsh 连接槽）。
      // 上游侧必须 resetAndDestroy（发 RST）：destroy() 只发干净 FIN，而上游
      // http server 默认 allowHalfOpen=true，收到 FIN 不自动关闭 → 上游仍悬挂
      // （PR #56 实测）。RST 强制对端立即关闭。
      const teardown = () => {
        try { proxySocket.resetAndDestroy?.() ?? proxySocket.destroy(); } catch { try { proxySocket.destroy(); } catch {} }
        try { socket.destroy(); } catch {}
      };
      // 上游侧透传 socket 的读错误（如 dsh web 重启/断开时的 ECONNRESET）必须
      // 吞掉并清理对端，否则未处理的 'error' 事件会让整个 dsh web 进程崩溃退出。
      proxySocket.on('error', () => { try { socket.destroy(); } catch {} });
      proxySocket.on('close', teardown);
      socket.on('close', teardown);
      // 半关闭（收到对端 FIN 的 'end'）对双向转发同样意味着这一端要走了：http server
      // 默认 allowHalfOpen=true，收到 FIN 只触发 'end' 不自动关——若不在 'end' 时销毁，
      // 浏览器/App 直接关页（不发 WS close 帧就 FIN）留下的连接会永久挂在 half-open
      // 状态，上游连接槽被占（且 server.close() 永远等不完）。双向流里半关闭无意义。
      socket.on('end', teardown);
      proxySocket.on('end', teardown);
    });
    // 上游返回普通 HTTP 响应（非 101）：把状态码/头回写后断开，别让客户端永久挂起
    proxyReq.on('response', (proxyRes) => {
      if (proxyRes.statusCode === 101) return; // 理论上 101 走 upgrade 事件
      try {
        const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ''}`.trim()];
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        }
        // end 会 flush 响应头再 FIN——不要紧跟 destroy()，否则排队的头会被丢弃
        socket.end(raw.join('\r\n') + '\r\n\r\n');
        proxyRes.resume(); // 消费掉上游响应体，释放连接
      } catch { socket.destroy(); }
    });
    proxyReq.on('error', () => socket.destroy());
    // 关键：浏览器在握手请求后可能立即发出首帧（如 mux 流的初始 RPC），
    // node 把它放在 upgrade 事件的 head 里。必须先于 end() 写入 proxyReq，
    // 让上游在 upgrade 事件里就拿到它（与直连行为一致）；等 101 之后再写
    // 会变成迟到的 socket 数据，DSH 的 mux 协议可能错过这个窗口。
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    socket.on('error', () => socket.destroy());
  });

  // 跟踪所有 TCP 连接（含 WebSocket upgrade 后的 socket——Node 的
  // closeAllConnections 不包含它们，不手动销毁 close() 会永远等）
  const clientSockets = new Set();
  server.on('connection', (sock) => {
    clientSockets.add(sock);
    sock.on('close', () => clientSockets.delete(sock));
    sock.on('error', () => {}); // 防未处理 error 崩进程
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        close: () => new Promise((r) => {
          for (const s of clientSockets) { try { s.destroy(); } catch { /* 忽略 */ } }
          server.close(() => r());
        }),
      });
    });
  });
}
