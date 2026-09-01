# DSH Pocket（安全改造分支）

这是 [`shaobeichen/dsh-pocket`](https://github.com/shaobeichen/dsh-pocket) 的安全优先改造分支。目标是让本人手机通过一个固定 HTTPS 地址访问电脑上的 DeepSeek Harness，同时尽量缩小公网暴露面。

> 当前状态：开发完成、自动测试通过，尚未在真实 Cloudflare 域名和手机 Passkey 上做端到端验收，也未发布 npm 包。

## 安全模型

- 每台 DSH 主机只有一个固定 HTTPS 地址。
- 公网入口只支持 Cloudflare **Named Tunnel**，代理只监听 `127.0.0.1`。
- 浏览器身份只支持 Passkey/WebAuthn，不提供用户名、密码或 PIN。
- 新设备必须完成两步：手机确认身份，电脑本机手动批准。
- 已批准设备按名称显示，可在电脑上撤销；撤销会让该设备的活动会话失效。
- 每次重新打开或刷新顶层页面，都必须重新做人脸、指纹或设备 PIN 验证。
- 页面保持在前台时每 30 秒续期；转入后台超过 10 分钟，会话失效，WebSocket 随后关闭。
- 没有远程恢复、备用密码或绕过入口；丢失全部凭据后只能在电脑本机重新配对。
- 每台主机独立保存凭据，不共享设备名单或登录会话。

凭据文件位于：

```text
$DSH_HOME/dsh-pocket/device-credentials.json
```

只持久化 WebAuthn 公钥、计数器和设备名称。配对密钥、挑战、登录会话与单次入口票据只保存在内存中；重启后全部失效。

## 已删除的旧模式

此分支有意不兼容旧版的便利模式：

- 局域网监听、局域网二维码和局域网免密访问；
- 8 位 PIN、自定义 PIN、临时 PIN、`?token=` 直达；
- 30 天持久登录 Cookie；
- Quick Tunnel 和随机 `trycloudflare.com` 地址；
- `dsh-pocket --public` 无认证 CLI；
- 从第三方镜像自动下载 `cloudflared`。

## 使用前准备

1. 拥有 Cloudflare 账号和一个由 Cloudflare 管理的域名。
2. `cloudflared` 可以手动安装，也可以不装：首次开启隧道时，插件会自动从 Cloudflare 官方 GitHub Releases 下载当前平台的二进制，并用官方 API 提供的 SHA-256 摘要校验，通过后存入 `$DSH_HOME/dsh-pocket/bin/`（不使用任何第三方镜像）。手动安装仍是受支持的方式：从 [Cloudflare 官方渠道](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)安装并加入 `PATH`，也可在设置文件中填写官方二进制路径：

   ```json
   {
     "cloudflaredPath": "C:\\Tools\\cloudflared.exe"
   }
   ```

3. 在 Cloudflare Zero Trust 创建 Named Tunnel。
4. 为 Tunnel 配置固定 Public Hostname，例如 `pocket.example.com`。
5. 把该 Hostname 的 Service 指向本机代理端口，默认是：

   ```text
   http://127.0.0.1:3081
   ```

6. 复制 Tunnel Token。插件只接收 Token，不收集 Cloudflare 账号密码。
7. DSH Desktop 用户需开启「浏览器访问」并使用 `compatibility` 模式。

## 首次配对

1. 在电脑本机打开 DSH 设置 →「手机访问」。
2. 填写固定域名和 Tunnel Token，保存并开启公网入口。
3. 点击「添加设备」，用手机扫描一次性二维码。
4. 在手机上填写设备名称，使用人脸、指纹或设备 PIN 确认。
5. 回到电脑本机，在「等待电脑批准」中点击「允许」。
6. 手机重新打开固定地址，完成 Passkey 验证后进入 DSH。

配对二维码 5 分钟失效且只能使用一次；手机完成身份确认并不自动获得权限。

## 重要边界

通过验证的手机拥有完整 DSH 能力。DSH 本身可以读写主机文件和执行代码，因此被允许的设备应视为拥有该电脑上的 DSH 操作权限。

设置页会在公网入口隐藏设备管理和 Tunnel 配置，但这只是界面防误操作，不是真正的权限边界：当前 DSH RPC 会把经代理的请求视为 loopback，而远程用户又拥有完整 DSH 权限，最终可以通过 DSH 修改主机文件或调用相关能力。若必须从机制上保证“Pocket 安全设置只能本机修改”，需要 DSH 宿主提供不可被代理伪造的本地调用身份或独立权限域。

## 开发与验证

```sh
npm install
npm run build:client
npm test
npm audit --omit=dev
```

主要模块：

| 文件 | 作用 |
|---|---|
| `lib/device-auth.mjs` | Passkey 凭据、配对、批准、短会话和撤销 |
| `lib/proxy.mjs` | loopback HTTP/WS 反向代理与每次顶层导航认证 |
| `lib/tunnel.mjs` | 只启动官方 `cloudflared` Named Tunnel |
| `lib/service.mjs` | 代理和 Tunnel 生命周期 |
| `lib/web-rpc.js` | 本机设置页的设备与 Tunnel 管理接口 |
| `client/passkey-entry.js` | 登录和配对浏览器逻辑 |
| `client/index.jsx` | 固定入口与设备管理设置页 |

## 许可证与来源

本项目继续遵循 [GPL-2.0](LICENSE)。移动端适配来源及 MIT 许可见 `client/mobile/LICENSE.dsh-web-mobile`。原项目及贡献历史归原作者和贡献者所有。
