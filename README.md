# DSH Pocket（安全改造分支）

这是 [`shaobeichen/dsh-pocket`](https://github.com/shaobeichen/dsh-pocket) 的安全优先改造分支。目标是让本人手机通过固定 HTTPS 地址访问电脑上的 DeepSeek Harness，同时缩小公网暴露面，并兼容无法使用网页 Passkey 的中国 Android/国产 ROM。

> 当前状态：设备凭据＋独立密码认证已经完成，自动测试 79/79 通过，生产依赖审计 0 漏洞；尚未重新部署到 DSH Desktop，也未在荣耀 50 上完成新版真实端到端验收，未发布 npm 包。

## 安全模型

- 每台 DSH 主机只有一个固定 HTTPS 地址。
- 公网入口只支持 Cloudflare **Named Tunnel**，代理只监听 `127.0.0.1`。
- 登录同时要求当前浏览器持有电脑批准过的随机设备凭据，并输入该设备的 Pocket 密码。
- 新设备必须完成两步：手机浏览器提交申请，电脑本机手动批准。
- 每个浏览器实例单独配对；更换浏览器或清除浏览数据后需要重新配对。
- 页面连续没有前台活动满 10 分钟后会话失效；正常刷新和持续前台使用不重复输入密码。
- 已批准设备可在电脑上撤销；撤销会让其 HTTP、API 和 WebSocket 会话失效。
- 不提供远程找回或改密；忘记密码只能在电脑删除设备并重新配对。
- 每台主机独立保存设备、密码验证值和会话。

凭据文件位于：

```text
$DSH_HOME/dsh-pocket/device-credentials.json
```

只持久化设备名称、随机设备 token 的 SHA-256 哈希、Argon2id 密码哈希、失败次数、等待截止时间及使用时间。明文密码、原始设备 token 和登录会话不会写入文件。旧版 Passkey 数据不会自动迁移，升级后需要重新配对。

## 密码与失败等待

设备密码允许数字、字母和符号，长度为 6–256 个字符。浏览器页面明确不建议保存密码，并尽量抑制自动填充，但无法保证所有浏览器遵守。

失败次数按设备持久化累计，正确登录后清零：

- 第 1–4 次：立即允许重试；
- 第 5 次：等待 5 分钟；
- 第 10 次：等待 15 分钟；
- 第 15 次：等待 45 分钟；
- 第 20 次及以后每累计 5 次：等待 24 小时。

## 已删除的旧模式

此分支不兼容以下便利或旧认证模式：

- 局域网监听、局域网二维码和局域网免密访问；
- 旧版 8 位 PIN、自定义 PIN、临时 PIN 和 `?token=` 直达；
- Passkey/WebAuthn；
- 30 天持久登录 Cookie；
- Quick Tunnel 和随机 `trycloudflare.com` 地址；
- `dsh-pocket --public` 无认证 CLI；
- 第三方 `cloudflared` 镜像。

## 使用前准备

1. 拥有 Cloudflare 账号和一个由 Cloudflare 管理的域名。
2. `cloudflared` 可以手动安装，也可以由插件首次从 Cloudflare 官方 GitHub Releases 下载，并用官方 API 提供的 SHA-256 摘要校验后保存到 `$DSH_HOME/dsh-pocket/bin/`。
3. 在 Cloudflare Zero Trust 创建 Named Tunnel，并配置固定 Public Hostname。
4. 把 Hostname 的 Service 指向本机代理端口，默认是 `http://127.0.0.1:3081`。
5. 复制 Tunnel Token。插件只接收 Token，不收集 Cloudflare 账号密码。
6. DSH Desktop 开启「浏览器访问」并使用 `compatibility` 模式。

## 首次配对

1. 在电脑本机打开 DSH 设置 →「手机访问」。
2. 填写固定域名和 Tunnel Token，保存并开启公网入口。
3. 点击「添加设备」，用目标手机浏览器扫描 5 分钟有效的一次性二维码。
4. 填写设备名称、至少 6 个字符的设备密码，并再次确认密码。
5. 手机提交后仍不能访问 DSH；保留配对页或稍后重新打开该页均可。
6. 回到电脑本机，在「等待电脑批准」中点击「允许」。
7. 返回手机配对页，点击「电脑已批准，进入 DSH」，再输入设备密码。

同一时间只允许一个待批准申请；已有申请时，新申请会被拒绝并保留原申请。

## 重要边界

通过验证的手机拥有完整 DSH 能力。DSH 本身可以读写主机文件和执行代码，因此被允许的设备应视为拥有该电脑上的 DSH 操作权限。

设置页会在公网入口隐藏设备管理和 Tunnel 配置，但这只是界面防误操作，不是真正的权限边界：当前 DSH RPC 会把经代理的请求视为 loopback，而远程用户又拥有完整 DSH 权限。若必须从机制上保证“Pocket 安全设置只能本机修改”，需要 DSH 宿主提供不可被代理伪造的本地调用身份或独立权限域。

纯浏览器方案也无法防御同源 XSS、已被 root/恶意软件控制的手机、完整浏览器 profile 复制、已失陷的电脑或 Cloudflare 账号。

## 开发与验证

```sh
npm install
npm run build:client
npm test
npm audit --omit=dev
npm pack --dry-run --json
```

主要模块：

| 文件 | 作用 |
|---|---|
| `lib/device-auth.mjs` | 设备 token、Argon2id 密码、配对、批准、失败等待、短会话和撤销 |
| `lib/auth-pages.mjs` | 手机登录页、配对页和前台会话守卫 |
| `client/auth-entry.js` | 未登录页面的密码登录与配对逻辑 |
| `client/auth.js` | `auth-entry.js` 的生成产物 |
| `lib/proxy.mjs` | loopback HTTP/WS 反向代理与统一会话保护 |
| `lib/tunnel.mjs` | 只启动官方 `cloudflared` Named Tunnel |
| `lib/service.mjs` | 代理和 Tunnel 生命周期 |
| `lib/web-rpc.js` | 本机设置页的设备与 Tunnel 管理接口 |
| `client/index.jsx` | 电脑本机设置页与移动端适配入口 |

## 许可证与来源

本项目继续遵循 [GPL-2.0](LICENSE)。移动端适配来源及 MIT 许可见 `client/mobile/LICENSE.dsh-web-mobile`。原项目及贡献历史归原作者和贡献者所有。
