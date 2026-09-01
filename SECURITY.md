# 安全模型

## 保护对象

- DSH 的完整网页、HTTP API 和 WebSocket；
- 主机上的文件、命令执行能力和已登录服务；
- Cloudflare Tunnel Token；
- 已批准的 WebAuthn 公钥凭据和设备名单。

## 假设的攻击者

- 知道或枚举到固定公网域名的互联网攻击者；
- 拿到配对二维码截图但不能操作电脑本机的人；
- 能持续请求公开登录、配对端点的扫描器；
- 获得旧浏览器 Cookie、旧配对链接或已撤销设备的人。

不尝试防御已经控制 DSH 主机、Cloudflare 账号、浏览器操作系统或已批准 Passkey 账户的攻击者。

## 核心控制

1. 代理默认并强制监听 `127.0.0.1`，不开放 LAN socket。
2. 只运行固定域名 Cloudflare Named Tunnel；配置不完整时失败关闭。
3. 不提供 PIN、密码、URL Token、Quick Tunnel 或无认证 CLI。
4. `cloudflared` 只来自三类可信来源：用户显式路径、PATH 中的现有安装，或两者都缺失时从 Cloudflare 官方 GitHub Releases 自动下载（以官方 API 提供的 SHA-256 摘要校验，不匹配即丢弃；不使用任何第三方镜像）。
5. WebAuthn 要求固定 HTTPS Origin、固定 RP ID 和 `userVerification: required`。
6. 注册前必须持有 5 分钟一次性配对秘密；注册后仍需电脑本机批准。
7. 认证挑战使用一次后删除，2 分钟过期，内存表最多保留 256 条；配对秘密使用一次后删除。
8. 会话 Cookie 使用 `Secure; HttpOnly; SameSite=Strict; Path=/`，不设置长期 `Max-Age`。
9. 每次顶层导航必须消费一个一次性入口票据；刷新或重开页面会重新认证。
10. 前台页面定期续期；10 分钟没有前台续期后 HTTP、API 和 WebSocket 会失效。
11. 撤销设备会删除该凭据关联的全部内存会话。
12. 持久化文件只保存公开凭据、签名计数器和设备显示信息。

## 公开端点

无需登录即可访问：

- `GET /pocket-auth/options`
- `POST /pocket-auth/verify`
- `GET /pocket-pair`
- `POST /pocket-pair/options`
- `POST /pocket-pair/verify`
- `GET /pocket-auth/client.js`

配对接口仍需一次性秘密；验证接口仍需有效 WebAuthn 挑战和白名单凭据。其他页面、资源、API 和 WebSocket 均需有效短会话；顶层 HTML 还需一次性入口票据。

## 已知限制

### “安全设置仅本机管理”不是密码学边界

设置页在公网入口隐藏设备与 Tunnel 管理，但 DSH 当前 RPC 的 `authority: loopback` 会把代理转发的远程请求也视为 loopback。已认证手机又拥有完整 DSH 权限，可以间接修改主机文件或调用宿主能力。

因此，本分支能做到界面隔离和防误操作，不能在现有 DSH 权限模型下证明远程用户绝对无法更改 Pocket 安全设置。彻底解决需要 DSH 提供不可被反向代理伪造的本地调用身份或独立权限域。

### Cloudflare 与终端安全

- Cloudflare 账号或 Tunnel Token 泄露后，攻击者可能修改入口或接管 Tunnel；应在 Cloudflare 后台撤销并重建 Token。
- Apple/Google 账号同步的 Passkey 可能出现在用户自己的其他设备上，这是当前设计接受的行为。
- 主机、手机或浏览器系统被攻破后，WebAuthn 不能保护已解锁环境。
- 公网可用性和请求洪泛仍依赖 Cloudflare 的边缘防护；建议为固定 Hostname 配置基础速率限制。

## 失去访问后的恢复

没有远程恢复、备用码或主密码。只能在电脑本机重置设备凭据并重新配对。
