# 安全模型

## 保护对象

- DSH 的完整网页、HTTP API 和 WebSocket；
- 主机上的文件、命令执行能力和已登录服务；
- Cloudflare Tunnel Token；
- 已批准浏览器的设备 token、密码验证值和设备名单。

## 假设的攻击者

- 知道或枚举到固定公网域名的互联网攻击者；
- 拿到配对二维码截图但不能操作电脑本机的人；
- 能持续请求公开登录、配对端点的扫描器；
- 获得旧浏览器 Cookie、旧配对链接或已撤销设备的人。

不尝试防御已经控制 DSH 主机、Cloudflare 账号、手机/浏览器操作系统或完整浏览器 profile 的攻击者。

## 核心控制

1. 代理默认并强制监听 `127.0.0.1`，不开放 LAN socket。
2. 只运行固定域名 Cloudflare Named Tunnel；配置不完整时失败关闭。
3. 不提供旧 PIN、URL Token、Passkey、Quick Tunnel 或无认证 CLI。
4. `cloudflared` 只来自用户显式路径、PATH 现有安装或 Cloudflare 官方 GitHub Releases；自动下载使用官方 API SHA-256 摘要校验。
5. 每个浏览器实例持有至少 256 位随机设备 token；Cookie 使用 `__Host-` 前缀及 `Secure; HttpOnly; SameSite=Strict; Path=/`，服务端只保存 SHA-256 哈希，完整登录后轮换。
6. 设备密码使用 `argon2@0.45.1` 的 Argon2id，参数为 `m=19456 KiB, t=2, p=1`，每次哈希自动生成独立随机盐；未知设备也执行等价 dummy 验证。
7. 注册前必须持有 5 分钟一次性配对 secret；手机提交后仍需电脑本机批准。已有待批准申请时拒绝新申请并保留原申请。
8. 密码失败次数和等待截止时间按设备持久化；第 5/10/15/20 次触发 5 分钟/15 分钟/45 分钟/24 小时等待，之后每累计 5 次等待 24 小时。
9. 公开登录端点按来源限制为 30 次/分钟，公开配对提交端点限制为 10 次/5 分钟；设备自身等待规则独立生效。
10. 登录会话 Cookie 同样使用 `__Host-`、`Secure`、`HttpOnly`、`SameSite=Strict`，但不设置长期 `Max-Age`；会话只保存在内存中。
11. 页面可见时每 30 秒续期；连续没有前台活动满 10 分钟后 HTTP、API 和 WebSocket 会话失效。正常刷新复用有效短会话。
12. 撤销设备会删除其全部内存会话；旧版 Passkey 凭据不自动迁移。
13. 认证响应使用 `Cache-Control: no-store`，认证页面设置 HSTS、禁止 iframe、外部脚本白名单 CSP，并关闭摄像头、麦克风和定位权限。

## 公开端点

无需有效登录会话即可访问：

- `GET /pocket-pair`
- `POST /pocket-pair/submit`
- `POST /pocket-auth/login`
- `GET /pocket-auth/auth-v2.js`

配对提交仍需有效的一次性 fragment secret；密码登录仍需浏览器持有已批准的设备 token。以下端点要求有效短会话：

- `POST /pocket-auth/keepalive`
- `POST /pocket-auth/logout`
- DSH 的所有页面、资源、HTTP API 和 WebSocket。

## 密码残余风险

产品允许至少 6 个字符，并允许纯数字。NIST 对多因子认证秘密建议至少 8 位；如果服务器凭据文件泄露，6 位纯数字密码可能被离线穷举。Argon2id 可以提高破解成本，但不能消除短密码的信息熵不足。浏览器设备 token 是另一项独立登录条件，单独知道密码无法在线登录未配对浏览器。

## 已知限制

### “安全设置仅本机管理”不是密码学边界

设置页在公网入口隐藏设备与 Tunnel 管理，但 DSH 当前 RPC 的 `authority: loopback` 会把代理转发的远程请求也视为 loopback。已认证手机又拥有完整 DSH 权限，可以间接修改主机文件或调用宿主能力。

因此，本分支只能做到界面隔离和防误操作。彻底解决需要 DSH 提供不可被反向代理伪造的本地调用身份或独立权限域。

### 浏览器与终端边界

- 浏览器可能无视 `autocomplete="off"` 并保存或自动填充密码；网页只能明确不建议并尽量抑制，无法绝对禁止。
- 网页无法可靠区分关闭标签、切后台、浏览器冻结和系统恢复，因此会话统一按服务端最后一次前台活动计时，不能承诺“关闭浏览器立即失效”。
- `HttpOnly` 阻止普通脚本读取 token，但不能防御同源 XSS 直接代表用户操作，也不能防御 root、恶意软件或完整浏览器 profile 复制。
- 设备 token 泄露后，密码和失败等待仍是第二层保护；密码与 token 同时泄露时，应在电脑本机撤销设备。

### Cloudflare 与可用性

- Cloudflare 账号或 Tunnel Token 泄露后，应在 Cloudflare 后台撤销并重建 Token。
- 固定公网端点可被扫描；应用限速降低请求成本，但公网可用性仍依赖 Cloudflare 边缘防护。
- 当前验收目标是用户本人的荣耀 50、公司电脑和家里电脑，不对所有中国大陆网络与国产 ROM 作普适性承诺。

## 失去访问后的恢复

没有远程恢复、备用码、改密或重置原设备密码。忘记密码、清除浏览器数据或更换浏览器后，只能在电脑本机删除旧设备并重新配对。
