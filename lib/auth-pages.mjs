function shell({ title, eyebrow, body, action, foot = '' }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light"><meta name="robots" content="noindex,nofollow">
<title>${title} · DSH Pocket</title>
<style>
:root{--navy:#0b1f33;--ink:#132735;--muted:#657985;--paper:#f4f7f9;--line:#d7e1e6;--mint:#21b889;--mint-dark:#08775a;--danger:#b93648}
*{box-sizing:border-box}body{margin:0;min-height:100svh;background:linear-gradient(145deg,#e7eff3 0,#f7fafb 48%,#edf4f1 100%);color:var(--ink);font-family:"Segoe UI Variable","PingFang SC","Microsoft YaHei",system-ui,sans-serif;display:grid;place-items:center;padding:24px}
main{width:min(440px,100%);background:rgba(255,255,255,.94);border:1px solid rgba(11,31,51,.14);box-shadow:0 24px 70px rgba(11,31,51,.12);display:grid;grid-template-columns:9px 1fr;overflow:hidden}
.rail{background:var(--navy);position:relative}.rail:after{content:"";position:absolute;width:9px;height:72px;top:40px;left:0;background:var(--mint)}
.content{padding:34px 30px 28px}.eyebrow{font:700 11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--mint-dark);margin-bottom:18px}
h1{font-size:26px;line-height:1.18;letter-spacing:-.025em;margin:0 0 12px;color:var(--navy)}p{font-size:14px;line-height:1.7;margin:0;color:var(--muted)}
.action{margin-top:26px}.stack{display:grid;gap:12px}label{font-size:12px;font-weight:650;color:var(--ink)}input{width:100%;border:1px solid var(--line);background:#fff;padding:13px 14px;font:inherit;color:var(--ink);outline:none}input:focus{border-color:var(--mint-dark);box-shadow:0 0 0 3px rgba(33,184,137,.14)}
button{width:100%;border:0;background:var(--navy);color:#fff;padding:13px 16px;font:700 14px/1.2 inherit;cursor:pointer;transition:transform .15s ease,background .15s ease}button:hover{background:#123653}button:active{transform:translateY(1px)}button:focus-visible{outline:3px solid rgba(33,184,137,.45);outline-offset:3px}button:disabled{opacity:.58;cursor:wait}
.error{margin-top:14px;color:var(--danger);font-size:13px;line-height:1.5;border-left:3px solid var(--danger);padding-left:10px}.complete{border-top:1px solid var(--line);padding-top:18px}.complete strong{display:block;color:var(--navy);margin-bottom:6px}.foot{margin-top:24px;padding-top:16px;border-top:1px solid var(--line);font-size:11px;line-height:1.6;color:#7c8c95}
@media(max-width:480px){body{padding:0;place-items:stretch}main{width:100%;min-height:100svh;border:0;box-shadow:none}.content{padding:calc(28px + env(safe-area-inset-top)) 24px calc(24px + env(safe-area-inset-bottom))}}
@media(prefers-reduced-motion:reduce){button{transition:none}}
</style></head><body><main><div class="rail" aria-hidden="true"></div><section class="content"><div class="eyebrow">${eyebrow}</div>${body}<div class="action">${action}</div><div id="error" class="error" hidden role="alert"></div>${foot ? `<div class="foot">${foot}</div>` : ''}</section></main><script src="/pocket-auth/client.js" defer></script></body></html>`;
}

export function deviceLoginPage({ credentialCount = 0 } = {}) {
  const ready = credentialCount > 0;
  return shell({
    title: '确认身份',
    eyebrow: 'Approved device only',
    body: `<h1>${ready ? '确认后进入这台电脑' : '这台电脑尚未批准设备'}</h1><p>${ready ? '使用手机的指纹、面容或锁屏密码确认。DSH Pocket 不会读取或保存你的生物信息。' : '请先回到电脑本机，在 DSH Pocket 设置中添加并批准一台设备。'}</p>`,
    action: `<button id="login-button" type="button"${ready ? '' : ' disabled'}>${ready ? '使用本机身份确认' : '等待电脑批准设备'}</button>`,
    foot: '每次重新打开或刷新页面都需要确认；页面退到后台超过 10 分钟后，本次登录自动结束。',
  });
}

export function devicePairPage() {
  return shell({
    title: '绑定设备',
    eyebrow: 'One-time pairing',
    body: '<h1>申请绑定这台设备</h1><p>手机确认后，还需要回到电脑本机点击“允许”。二维码不能单独授予访问权限。</p>',
    action: `<form id="pair-form" class="stack"><label for="device-name">设备名称</label><input id="device-name" name="device-name" maxlength="80" autocomplete="off" placeholder="例如：我的工作手机" required><button id="pair-button" type="submit">确认手机身份</button></form><div id="pair-complete" class="complete" hidden><strong>手机确认完成</strong><p>请回到电脑本机批准这次申请。批准前，此设备仍无法访问 DSH。</p></div>`,
    foot: '配对申请 5 分钟后自动失效。如页面提示失效，请回电脑重新生成二维码。',
  });
}

export const SESSION_GUARD_SCRIPT = `<script data-dsh-pocket-session-guard="1">!function(){
  try{
    var u=new URL(location.href);if(u.searchParams.has('pocket-entry')){u.searchParams.delete('pocket-entry');history.replaceState(null,'',u.pathname+(u.search?'?'+u.searchParams.toString():'')+u.hash)}
    function ping(){if(document.visibilityState!=='visible')return;fetch('/pocket-auth/keepalive',{method:'POST',credentials:'same-origin',cache:'no-store'}).then(function(r){if(r.status===401)location.replace('/')}).catch(function(){})}
    ping();setInterval(ping,30000);document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')ping()});
  }catch(e){}
}();</script>`;
