# 未发布：安全架构改造

- 公网入口改为固定 HTTPS Cloudflare Named Tunnel，代理只监听 `127.0.0.1`。
- 新增 Passkey/WebAuthn 设备白名单、一次性配对二维码和电脑本机批准流程。
- 每次顶层页面打开或刷新重新验证；前台续期，后台 10 分钟失效。
- 新增设备命名、撤销和内存会话失效。
- 删除 LAN、PIN、`?token=`、Quick Tunnel、无认证 CLI 和第三方镜像自动下载。
- cloudflared 缺失时自动从 Cloudflare 官方 GitHub Releases 下载，并以官方 SHA-256 摘要校验（无第三方镜像回退）。
- 新增安全模型、真实设备验收清单及对应自动测试。

# [2.10.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.9.1...v2.10.0) (2026-08-30)


### Features

* **security:** 移除会话指纹防钓鱼机制（issue [#82](https://github.com/shaobeichen/dsh-pocket/issues/82)/[#83](https://github.com/shaobeichen/dsh-pocket/issues/83) 后续） ([8f91960](https://github.com/shaobeichen/dsh-pocket/commit/8f91960a8379ac7ec16a7c3577ff0134cb2f6204))

## [2.9.1](https://github.com/shaobeichen/dsh-pocket/compare/v2.9.0...v2.9.1) (2026-08-30)


### Bug Fixes

* **security:** 防钓鱼校验只在公网启用，局域网不再误报（issue [#83](https://github.com/shaobeichen/dsh-pocket/issues/83)） ([059163e](https://github.com/shaobeichen/dsh-pocket/commit/059163e26457a15a9f9ce1b21aea539db9ecb803))

# [2.9.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.8.0...v2.9.0) (2026-08-30)


### Bug Fixes

* **auth:** Tailscale/CGNAT(100.64/10) 与手动局域网地址覆盖走局域网密码（issue [#79](https://github.com/shaobeichen/dsh-pocket/issues/79)） ([e3c2e7b](https://github.com/shaobeichen/dsh-pocket/commit/e3c2e7b97700b375bdc17a68ed3523588796ba21)), closes [#66](https://github.com/shaobeichen/dsh-pocket/issues/66)
* **tunnel:** 把 --no-autoupdate 移到全局位置，兼容 cloudflared 2026.x（issue [#78](https://github.com/shaobeichen/dsh-pocket/issues/78)） ([4abc6b9](https://github.com/shaobeichen/dsh-pocket/commit/4abc6b9f9400443bc691d52e7e13c2f7b93aee58))


### Features

* **proxy:** 上游桌面门禁 403 forbidden 对导航请求返回可操作提示页（issue [#81](https://github.com/shaobeichen/dsh-pocket/issues/81)） ([ff003b6](https://github.com/shaobeichen/dsh-pocket/commit/ff003b66a63f55eebc10b4b96f06b2b1984fdc8c))
* **security:** 公网会话指纹 + 链接 ephemeral 提示，防快速隧道子域复用跳陌生站点（issue [#82](https://github.com/shaobeichen/dsh-pocket/issues/82)） ([5bfc039](https://github.com/shaobeichen/dsh-pocket/commit/5bfc0399a1c4d6765fdc815043b6861b08ad5267))

# [2.8.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.7.1...v2.8.0) (2026-08-29)


### Bug Fixes

* **mobile:** 去掉 isInsidePocket 误杀，让对话文件链接在手机上弹提示并注入复制按钮（issue [#17](https://github.com/shaobeichen/dsh-pocket/issues/17)） ([5fca020](https://github.com/shaobeichen/dsh-pocket/commit/5fca0202623df513e11b4654868210f287ea6ffd))


### Features

* **mobile:** 文件链接旁「复制」按钮经主机 RPC 读取正文（issue [#17](https://github.com/shaobeichen/dsh-pocket/issues/17) 内容复制） ([06f69fd](https://github.com/shaobeichen/dsh-pocket/commit/06f69fdef5fd1706846d433ece8bc10944549563))

## [2.7.1](https://github.com/shaobeichen/dsh-pocket/compare/v2.7.0...v2.7.1) (2026-08-29)


### Bug Fixes

* **mobile:** 移动端拦截文件链接点击改提示、隐藏添加工作区，移除冗余复制按钮（issue [#17](https://github.com/shaobeichen/dsh-pocket/issues/17)） ([96ed896](https://github.com/shaobeichen/dsh-pocket/commit/96ed896201045b009068b198e6f5f444a43cfb23))

# [2.7.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.6.3...v2.7.0) (2026-08-29)


### Features

* **mobile:** 文件块支持「复制内容」按钮（issue [#17](https://github.com/shaobeichen/dsh-pocket/issues/17)），移除放大输入 ([c7351ac](https://github.com/shaobeichen/dsh-pocket/commit/c7351acefb8f78b2c26218d812d59a648cd22c7d))

## [2.6.3](https://github.com/shaobeichen/dsh-pocket/compare/v2.6.2...v2.6.3) (2026-08-29)


### Bug Fixes

* 移除临时访问 PIN 功能并修复撤销时的崩溃 ([238864c](https://github.com/shaobeichen/dsh-pocket/commit/238864c92999f73b2a42c103163180053fd10c49)), closes [#69](https://github.com/shaobeichen/dsh-pocket/issues/69)

## [2.6.2](https://github.com/shaobeichen/dsh-pocket/compare/v2.6.1...v2.6.2) (2026-08-29)


### Bug Fixes

* **client:** 补上 MobileComposerFullscreen 缺的 import（P0） ([a71319d](https://github.com/shaobeichen/dsh-pocket/commit/a71319dd66f6b3e70a8f904ce3dca236e6615dbd))

## [2.6.1](https://github.com/shaobeichen/dsh-pocket/compare/v2.6.0...v2.6.1) (2026-08-29)


### Bug Fixes

* **tunnel:** linux 改用裸二进制，不再下载上游已下架的 .tgz (issue [#45](https://github.com/shaobeichen/dsh-pocket/issues/45)) ([26bdb69](https://github.com/shaobeichen/dsh-pocket/commit/26bdb69a9dc8480c67d99bc4dba76fcdc79052e0))

# [2.6.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.5.1...v2.6.0) (2026-08-29)


### Features

* **mobile:** 'expand composer' button on phone (issue [#23](https://github.com/shaobeichen/dsh-pocket/issues/23)) ([ec6f115](https://github.com/shaobeichen/dsh-pocket/commit/ec6f115655964fca882df1e99171cbb5fc59efab))

## [2.5.1](https://github.com/shaobeichen/dsh-pocket/compare/v2.5.0...v2.5.1) (2026-08-29)


### Bug Fixes

* **proxy:** support `?token=<raw pin>` and seed the auth cookie (issue [#35](https://github.com/shaobeichen/dsh-pocket/issues/35)) ([734afbd](https://github.com/shaobeichen/dsh-pocket/commit/734afbdb800ed4b2a1d4dff085cdf2ef074917db))

# [2.5.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.4.0...v2.5.0) (2026-08-29)


### Bug Fixes

* **proxy:** 转发前清掉历史遗留的 dsh-desktop-* 参数 (issue [#75](https://github.com/shaobeichen/dsh-pocket/issues/75)) ([8979594](https://github.com/shaobeichen/dsh-pocket/commit/89795940e2aeb28675b79a1541862331fe3aef5f))


### Features

* **tunnel:** honor a custom cloudflared path (issue [#45](https://github.com/shaobeichen/dsh-pocket/issues/45)) ([b9c0c9f](https://github.com/shaobeichen/dsh-pocket/commit/b9c0c9f0ea37aecdcf004fccfb9e0f5bfc1fd381)), closes [#proxy](https://github.com/shaobeichen/dsh-pocket/issues/proxy)

# [2.4.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.3.0...v2.4.0) (2026-08-29)


### Features

* **auth:** temporary access PINs with auto-expiry (issue [#69](https://github.com/shaobeichen/dsh-pocket/issues/69)) ([965195e](https://github.com/shaobeichen/dsh-pocket/commit/965195e21841e3cfba719e6d6bf6424036e149ad))

# [2.3.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.2.0...v2.3.0) (2026-08-29)


### Features

* **proxy:** make the proxy port configurable from settings.json (issue [#70](https://github.com/shaobeichen/dsh-pocket/issues/70)) ([20bb1b5](https://github.com/shaobeichen/dsh-pocket/commit/20bb1b50eaa06a0d7070e97f516cc44d3cdc475b))

# [2.2.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.1.4...v2.2.0) (2026-08-29)


### Features

* **mobile:** add layout mode switch for wide-screen phones (issue [#74](https://github.com/shaobeichen/dsh-pocket/issues/74)) ([018aef0](https://github.com/shaobeichen/dsh-pocket/commit/018aef0db644093a13d6cb1db427655138c86799))

## [2.1.4](https://github.com/shaobeichen/dsh-pocket/compare/v2.1.3...v2.1.4) (2026-08-29)


### Bug Fixes

* **mobile:** 抽屉层级压过 dsh-web-ui-all 的全屏遮罩 (issue [#67](https://github.com/shaobeichen/dsh-pocket/issues/67)) ([88605d9](https://github.com/shaobeichen/dsh-pocket/commit/88605d93a145af61e345f91b96db2850bb8f1e56))

## [2.1.3](https://github.com/shaobeichen/dsh-pocket/compare/v2.1.2...v2.1.3) (2026-08-29)


### Bug Fixes

* **mobile:** 抽屉里的工作区菜单点不动，并给 iOS 触摸加自愈 (issue [#72](https://github.com/shaobeichen/dsh-pocket/issues/72)) ([9f7c427](https://github.com/shaobeichen/dsh-pocket/commit/9f7c4279049c499f2f33b6ded45f2bd92625b476))

## [2.1.2](https://github.com/shaobeichen/dsh-pocket/compare/v2.1.1...v2.1.2) (2026-08-29)


### Bug Fixes

* **desktop:** stop injecting dsh-desktop-* markers into proxied pages ([17c2d97](https://github.com/shaobeichen/dsh-pocket/commit/17c2d97e6c2da5951a11e171efdd1e436184b04c)), closes [3/#4](https://github.com/shaobeichen/dsh-pocket/issues/4)

## [2.1.1](https://github.com/shaobeichen/dsh-pocket/compare/v2.1.0...v2.1.1) (2026-08-29)


### Bug Fixes

* **proxy:** complete the dsh web browser-session handshake (issue [#77](https://github.com/shaobeichen/dsh-pocket/issues/77)) ([ffc12dd](https://github.com/shaobeichen/dsh-pocket/commit/ffc12ddfcd2113ee4ba80424b2346efee85c0c0f))

# [2.1.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.0.0...v2.1.0) (2026-08-29)


### Bug Fixes

* **ui:** center the toast and narrow it to 280px ([2bcaff0](https://github.com/shaobeichen/dsh-pocket/commit/2bcaff0a3db7847f4cc9941293026ab78b1398c4))
* **ui:** show only the current language half of backend error messages ([bd79283](https://github.com/shaobeichen/dsh-pocket/commit/bd79283d5bad1888933a9fceda886204f59d450c))


### Features

* **pocket:** factory reset entry at the bottom of the settings page ([672b31b](https://github.com/shaobeichen/dsh-pocket/commit/672b31ba04083e4223c15ef1f326fab9a6e5faf7))
* **ui:** toast feedback after factory reset ([074744d](https://github.com/shaobeichen/dsh-pocket/commit/074744d2524584e48de19fdc1b301e85cbd7623e))

# [2.0.0](https://github.com/shaobeichen/dsh-pocket/compare/v1.16.1...v2.0.0) (2026-08-29)


* feat!: redesign settings page layout into structured cards ([1b7d494](https://github.com/shaobeichen/dsh-pocket/commit/1b7d494554ed80eadd701c1e2574760ff130580c))


### BREAKING CHANGES

* the settings page DOM structure and locale keys changed
(lanAddressHint removed; wanAccess/pinLabel/modeLabel/advAddress/
wanOffHint added). Custom styles or scripts targeting the old settings
DOM/keys need updating.

## [1.16.1](https://github.com/shaobeichen/dsh-pocket/compare/v1.16.0...v1.16.1) (2026-08-29)


### Bug Fixes

* **ui:** mode selector only after public access enabled; selected-state highlight; drop lan address hint ([cf6abc0](https://github.com/shaobeichen/dsh-pocket/commit/cf6abc091ac398158e9e8213d9bddcf554b8f87a)), closes [#66](https://github.com/shaobeichen/dsh-pocket/issues/66)

# [1.16.0](https://github.com/shaobeichen/dsh-pocket/compare/v1.15.0...v1.16.0) (2026-08-29)


### Features

* **tunnel:** named tunnel mode (fixed public hostname) + fail-closed host trust boundary ([a7bf98e](https://github.com/shaobeichen/dsh-pocket/commit/a7bf98e54b25e59d03c6dc03c08bc2b4a74d84f5))

# [1.15.0](https://github.com/shaobeichen/dsh-pocket/compare/v1.14.5...v1.15.0) (2026-08-29)


### Bug Fixes

* **ci:** drop setup-node registry-url to avoid .npmrc conflict with semantic-release ([bb41482](https://github.com/shaobeichen/dsh-pocket/commit/bb41482cf499533741cd22a28b5004be253d4f4f))


### Features

* **pin:** allow 8-char alphanumeric custom PINs (letters + digits) ([527abba](https://github.com/shaobeichen/dsh-pocket/commit/527abbac7097a4b7748180ec093f6d5f48a8ce39)), closes [#33](https://github.com/shaobeichen/dsh-pocket/issues/33)
