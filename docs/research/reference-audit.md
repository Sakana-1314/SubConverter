# 参考实现审计：`dianbanjiu/subconverter`

> **审计对象**：<https://github.com/dianbanjiu/subconverter>
> **审计 commit**：`01fbd67633c34f9924a9c7488e1a1cc02ef69610`（`main`，2026-05-24 21:40:16 +0800）
> **对比对象**：tindy 原版 <https://github.com/tindy2013/subconverter>，浅克隆 commit `a0d4eab28cb8b6c782d4ce5c3a918de4829b4a72`（2026-07-08）
> **审计日期**：2026-11-09
>
> **引用约定**：本文所有 `dianbanjiu` 代码/文档引用均相对于
> `https://github.com/dianbanjiu/subconverter/blob/01fbd67633c34f9924a9c7488e1a1cc02ef69610/`；
> 所有 tindy 引用均相对于
> `https://github.com/tindy2013/subconverter/blob/a0d4eab28cb8b6c782d4ce5c3a918de4829b4a72/`。
> 因此 `src/index.ts:14-23` 这类写法同时给出了文件、行号与可访问的 URL 基址。

## 结论摘要

**它是不是壳？** 不是纯壳。基础链路是真实实现：URI/Clash YAML 解析 → 统一节点 IR → Clash YAML / sing-box JSON / URI/Base64 输出，Worker 路由、KV/env 鉴权、5MB 流式上限、默认 HTTPS、错误码都有实际代码。我在本地 `wrangler dev --local`（Miniflare/workerd）用本地订阅源做过端到端验证：静态页 18,578 字节、Clash 输出 1,429 字节且 `X-Node-Count: 2`、sing-box 输出 2,173 字节且为合法 JSON、URI 输出 388 字节；401/400/405/413/422/502 也都按 README 返回。

**它可信吗？** 作为“能跑的最小实现”可以参考；作为“安全参考实现”或“tindy 兼容替代”不可直接信任。主要问题：

1. **SSRF 防护只是字面量黑名单**：不解析 DNS、不逐跳校验重定向；`localhost.`、`127.0.0.1.nip.io`、`localtest.me` 等可绕过。实测在本地 workerd 中，Worker 成功抓取了 `localtest.me`（解析到回环）以及一个 302 到 `127.0.0.1` 的地址并返回节点。生产 Cloudflare 出站策略是否在网层兜底未验证，但代码层防护已被绕过。
2. **没有应用层超时**：`fetch` 未传 `AbortSignal`；对一个永不响应的本地服务，2 秒后仍处于 pending。5MB 上限是真实有效的（6MB 返回 413，恰好 5MB 通过）。
3. **锁定的 `js-yaml@4.1.1` 有 4 个已公开的二次复杂度 DoS 公告**（OSV，2026-11-09 查询）；实测 162KB 的 merge-chain 在真实解析路径 `parseClashYaml` 中耗时 1,585ms，升级到 4.3.2 后同一输入 4ms。README 声称的“5MB 上限防 YAML 锚点炸弹”并不能防止这类小体积高 CPU 输入。
4. **会生成语义非法/客户端不可用的配置**：NaN 端口输出 `port: .nan`（YAML 合法、Clash 非法）；重复节点名去重算法自身会产生重复名；`PROXY`/`AUTO`/`DIRECT`/`direct`/`block`/`dns-out` 等保留名会与内置组/出站冲突；sing-box 的 Hysteria2 端口跳跃/SS 插件会被静默丢弃（SSR 是 README 明确说明的跳过，不算静默丢失）。
5. **`clash` 与 `clash-meta` 输出完全相同**，且 `target=clash` 会把 VLESS/Reality、Hysteria2、TUIC 等原版 Clash 不支持的节点直接写进配置；没有 tindy 的 `fdn` 之类“按目标能力过滤节点”。
6. **文档与代码多处矛盾**：README 说 `wrangler.toml` 只放占位符，实际第 17 行是真实 KV namespace id；commit `5f27400` 标题说“替换 KV ID 为占位符”，diff 只改了注释；README 说“最小输入长度校验”，代码只拒绝空串，1 字符密钥可通过；“其它协议都有覆盖”也不成立，Clash YAML 里 Snell/WireGuard/SOCKS5/HTTP/Hysteria v1 会被静默丢弃。
7. **无测试、无 CI、无运行时 schema 校验**：仅 8 个提交，`package.json` 只有 `dev/deploy/typecheck`，没有 test 脚本；18 处显式 `any`，所有输入字段几乎未做枚举/范围校验。

**它会不会产出 `DOMA` 这类非法规则？** **当前代码不会。** 唯一的规则生成路径是 `src/converters/clash.ts:217-225` 的硬编码字面量数组，规则类型全部是 `DOMAIN-SUFFIX`/`IP-CIDR`/`GEOIP`/`MATCH`；没有动态拼接规则类型的代码，也不解析输入 YAML 的 `rules:`。实测在输入里塞 `DOMA,example.com,DIRECT` 会被完全丢弃，输出仍是固定 7 条规则。详见第 4 节。

**对“规则很多、要避免 DOMA”的迁移场景**：dianbanjiu 不产出 DOMA 的原因不是它修好了规则类型，而是它**根本不读/不写规则**——输入 `rules:` 全丢，输出固定 7 条。对需要保留 20k+ 条规则的迁移，它不能作为规则管线的参考/替代；一旦你补上规则功能，DOMA 风险就会重新出现，必须自己做白名单 + 行级校验 + 截断检测（见 4.4）。

**一句话**：它是一个真实但非常轻量、缺少测试和安全打磨的 Worker 实现；基础转换可用，安全声明和兼容性声明不可信，`DOMA` 不是它当前能产生的问题。

---

## 0. 仓库事实与审计方法

### 0.1 GitHub 元数据（2026-11-09 查询）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 存在/可见 | 是，公开仓库 | `curl https://api.github.com/repos/dianbanjiu/subconverter` |
| 是否 fork | `false`（不是 tindy 的 GitHub fork） | 同上 |
| 描述 | 支持在 Cloudflare Worker 部署的订阅转换工具 | 同上 |
| 主语言 | TypeScript | 同上 |
| License | MIT | `LICENSE:1`；API `license.spdx_id=MIT` |
| 大小 | 54 KB（API `size`） | 同上 |
| 创建/最后 push | 2026-05-21T16:32:33Z / 2026-05-24T13:40:16Z | 同上 |
| 提交数 | 8 | `git rev-list --count HEAD` |
| star / fork / open issues | 1 / 6 / 0 | API |
| 测试/CI | 无 | `git ls-files` 无 `test`/`spec`/`.github`；`package.json:7-10` 无 test 脚本 |

8 个提交（`git log --format='%h | %ad | %an | %s' --date=iso`）：

| commit | 时间 | 作者 | 标题 |
| --- | --- | --- | --- |
| `01fbd67` | 2026-05-24 21:40 +0800 | dianbanjiu | Add MIT License to the project |
| `237f522` | 2026-05-24 21:35 +0800 | dianbanjiu | Merge PR #1 from `update_worker_name_to_subconverter` |
| `93af781` | 2026-05-23 15:44 UTC | cloudflare-workers-and-pages[bot] | Update wrangler config name to subconverter |
| `5f27400` | 2026-05-23 23:43 +0800 | dianbanjiu | docs: 替换 KV ID 为占位符并补充一键部署说明 |
| `ad8eab0` | 2026-05-22 00:47 +0800 | dianbanjiu | chore(wrangler): 配置 AUTH_KV 命名空间 id |
| `16b8440` | 2026-05-22 00:12 +0800 | dianbanjiu | feat(web): 默认 Header 鉴权、密钥不再写入 localStorage、文档主推安全用法 |
| `2657611` | 2026-05-22 00:06 +0800 | dianbanjiu | feat(security): SSRF 防护、HTTPS 强制、响应大小上限与错误信息脱敏 |
| `3720442` | 2026-05-21 23:46 +0800 | dianbanjiu | feat: 初始化基于 Cloudflare Worker 的订阅转换工具 |

PR #1 是 Cloudflare bot 自动生成的改 Worker 名称 PR，正文说明“Wrangler 配置中的 Worker 名称与 Dashboard 中部署的名称不一致”；从 PR 正文和 1 行改动看只是改名，未见安全评审内容。

### 0.2 审计方法

- 阅读了全部 13 个 `src/**/*.ts`、`public/index.html`（537 行）、`README.md`（236 行）、`package.json`、`package-lock.json`、`tsconfig.json`、`wrangler.toml`，以及 8 个提交的 diff。
- 在隔离目录 `npm ci --ignore-scripts`（未执行依赖安装脚本），`npm run typecheck` 通过；`npx wrangler deploy --dry-run` 通过。
- 把 `src/` 复制到隔离测试目录（`sha256sum` 与原文件一致），用 Node 24 的 TypeScript 类型剥离 + 一个只补 `.ts` 扩展名的自定义 loader 直接调用仓库代码；测试脚本在仓库外，未修改被审仓库。
- 用本地 HTTP 服务与 `wrangler dev --local`（Miniflare/workerd）做端到端；本地订阅源通过 `localtest.me`/`127.0.0.1` 提供。
- 用 OSV API 查询 `js-yaml` 的已知漏洞；用 tindy 源码/README 做逐项对比。
- 未运行真实 Cloudflare 部署、未使用真实机场订阅、未用 mihomo/sing-box 二进制做最终客户端校验（下载超时，见第 7 节）。

---

## 1. 它是否真的能完成订阅转换？

### 1.1 真实实现的部分

| 能力 | 实现位置 | 证据 |
| --- | --- | --- |
| Worker 路由（`/api/sub`、`/api/health`、静态资源 fallback） | `src/index.ts:14-26` | 本地 workerd：`/api/health` 返回 `ok`；`/` 返回 18,578 字节 HTML；`/api/sub` 返回配置 |
| KV / env 鉴权、Bearer/Token、常量时间列表比较 | `src/auth.ts:14-98` | 单测：KV 单键、KV 列表、`STATIC_KEYS` 均通过；裸 token 被拒 |
| 订阅抓取、Content-Length 预检、5MB 流式上限 | `src/fetcher.ts:23-91` | 6MB 响应返回 413；恰好 5MB 通过；Content-Length >5MB 预检返回 413 |
| 输入自动识别（Clash YAML / Base64 / URI 列表） | `src/parsers/index.ts:7-39` | Base64 订阅解析 7/7；明文 URI 7/7；垃圾输入 0 |
| 7 种协议解析：vmess/vless(Reality)/trojan/ss/ssr/hysteria2/tuic | `src/parsers/uri.ts:17-278` | 7 条混合 URI 全部解析成功（类型/名称/端口正确） |
| Clash YAML `proxies` 解析（7 种类型） | `src/parsers/clash.ts:5-170` | 7 个 proxy 全部转换成功；不支持类型被丢弃（见 2.4） |
| Clash YAML 生成（代理、两个组、7 条规则、DNS） | `src/converters/clash.ts:5-226` | 输出可被 `js-yaml.load` 解析；7 proxies / 2 groups / 7 rules |
| sing-box JSON 生成（selector/urltest/节点/direct/block/dns） | `src/converters/singbox.ts:4-205` | 输出合法 JSON；7 个节点出站 |
| URI / Base64 订阅输出 | `src/converters/uri.ts:24-130` | 7 条 URI 可再次解析为 7 个节点；v2ray 输出是 Base64 的 URI 列表 |
| 前端 URL 拼接、Header 鉴权、复制、Clash 一键导入 | `public/index.html:319-533` | 静态审查；页面由 Worker 正常返回（18,578 字节） |

### 1.2 端到端验证（本地 workerd）

本地起 Python 静态服务（`127.0.0.1:8801`，内容为 2 个节点的 Base64 订阅）和 `wrangler dev --local --port 8899 --var STATIC_KEYS:testkey --var ALLOW_HTTP_SUBSCRIPTION:true`：

| 请求 | 结果 |
| --- | --- |
| `GET /` | 200，18,578 字节，`<title>订阅转换 · Subconverter Web</title>` |
| `GET /api/health` | 200，`ok`（2 字节） |
| `GET /api/sub?...&target=clash`，`Authorization: Bearer testkey` | 200，`Content-Type: text/yaml`，`X-Node-Count: 2`，1,429 字节；含 `Local-VMess`/`Local-Trojan` |
| 同上 `target=singbox` | 200，2,173 字节，合法 JSON；outbounds 含 selector/urltest/vmess/trojan/direct/block/dns |
| 同上 `target=uri` | 200，388 字节，2 条 URI |
| 无 `Authorization` | 401 `Unauthorized` + `WWW-Authenticate` |
| `target=surge` | 400，`不支持的 target（支持: clash, clash-meta, singbox, v2ray, uri）` |
| 上游返回垃圾 | 422 `未从订阅源解析出任何节点...` |
| 上游 403 | 502 `订阅源返回 403` |
| 上游不可达 | 502 `无法连接订阅源` |
| POST | 405 `方法不允许` |

结论：**基础订阅转换是真的能跑通的**，不是“只做 UI”的壳。

### 1.3 哪些是壳、占位或只做 UI

1. **`clash-meta` 是 `clash` 的别名**：`src/converters/index.ts:15-21` 两个 case 走同一分支，输出逐字节相同（实测 `convert("clash") === convert("clash-meta")` 为 `true`）。没有 Meta 专属配置/字段处理。
2. **`v2ray` 目标不是 V2Ray JSON 配置**：`src/converters/index.ts:28-33` 只是 `nodesToBase64Sub(nodes)`，即 Base64 的 URI 列表。作为 v2rayN 订阅格式这是正常的，但它不是“生成 V2Ray 配置文件”，README 的“v2ray”容易让人误解。
3. **没有规则/模板/外部配置引擎**：Clash 输出完全由 `buildBaseConfig` 硬编码（`src/converters/clash.ts:183-226`）；sing-box 路由也硬编码（`src/converters/singbox.ts:11-57`）。输入 Clash YAML 的 `rules:`、`proxy-groups:` 被忽略（parser 只取 `proxies`，`src/parsers/clash.ts:13`）。实测输入 `EVIL` 组和 `example.org` 规则都不会出现在输出。
4. **前端只负责拼 URL**：这符合 README 的“纯浏览器拼接”设计，不是缺陷；页面没有本地转换逻辑，真正转换在 Worker 端。
5. **`/api/health` 只返回 `ok`**：刻意最小化指纹，算实现选择，不是占位。
6. **没有测试/CI**：`package.json:7-10` 只有 dev/deploy/typecheck；`git ls-files` 无 test/spec/.github。所谓“工程质量”只能靠类型检查，不能靠测试证明。

### 1.4 能力边界（一句话）

它支持 **7 种协议 × 5 个目标名**，能把“URI 列表/Clash proxies/Base64 订阅”转成“Clash YAML/sing-box JSON/URI/Base64”；不支持 tindy 的外部配置、规则集、模板、重命名/过滤、合并订阅、Surge/Quantumult/Loon 等目标。属于“最小可用转换器”，不是“subconverter 兼容实现”。

---
## 2. 与 tindy 原版相比：缺失、篡改或明显错误

### 2.1 先定性：不是 fork，是另一种实现

- GitHub API `fork=false`，仓库里没有任何 tindy 的 C++/CMake 文件；tindy 是 C++ 服务端（`CMakeLists.txt`、`src/**/*.cpp`），dianbanjiu 是 TypeScript Cloudflare Worker（`src/**/*.ts`、`wrangler.toml`）。
- License 不同：tindy 是 **GPL-3.0**（`LICENSE:1-2`），dianbanjiu 是 **MIT**（`LICENSE:1`）。目前未发现逐行复制证据；但如果后续把 tindy 的 `base/` 配置、规则集或模板搬过来，GPL-3.0 与 MIT 的分发义务需要单独评估。
- 因此“篡改”应理解为**同名能力的行为差异/错误**，不是“改了原版代码”。tindy 的功能面大得多：508 个受版本控制文件、`base/config` 规则集、`base/base` 模板、`src/generator/config/subexport.cpp` 等；dianbanjiu 只有 13 个 TS 文件。

### 2.2 功能矩阵

| 维度 | tindy 原版 | dianbanjiu | 证据 |
| --- | --- | --- | --- |
| 输入源 | Clash/ClashR/Quantumult/QuanX/Loon/SS/SSD/SSR/Surfboard/Surge/V2Ray；支持 URL、文件路径、data URI、`\|` 合并多订阅 | 只支持单个 `url`；解析 Base64/URI 列表、Clash YAML 的 `proxies` | tindy `README.md:24-40`、`README.md:67-91`；dianbanjiu `src/index.ts:36-38`、`src/parsers/index.ts:7-39` |
| 输出目标 | `clash`、`clashr`、`quan`、`quanx`、`loon`、`ss`、`sssub`、`ssd`、`ssr`、`surfboard`、`surge&ver=2/3/4`、`v2ray`，以及 `mixed`/`auto`；代码还有 `singbox` | 仅 `clash`、`clash-meta`、`singbox`、`v2ray`、`uri` | tindy `README.md:24-40`、`README-cn.md:120-140`、`src/handler/interfaces.cpp:320`、`:938`；dianbanjiu `src/converters/index.ts:43-53` |
| 协议节点 | SS/SSR/VMess/Trojan/Snell/HTTP/HTTPS/SOCKS5/WireGuard/Hysteria/Hysteria2/AnyTLS | VMess/VLESS(Reality)/Trojan/SS/SSR/Hysteria2/TUIC | tindy `src/parser/config/proxy.h:12-27`；dianbanjiu `src/types.ts:4-11` |
| 外部配置/规则集/模板 | 支持 `config=` 外部配置、`proxy_group`、`ruleset`、模板、规则转换 `/getruleset` | 全部硬编码；无 `config`/`ruleset`/模板参数，无 `/getruleset` | tindy `README-cn.md:316`、`:871-990`、`:1056`、`:1427-1445`；dianbanjiu `src/index.ts:36-38`、`src/converters/clash.ts:183-226` |
| 节点处理 | `include`/`exclude` 正则、`rename`、emoji、`sort`、`tfo`/`udp`/`scv`/`fdn` 等 | 无；`udp` 在 Clash 输出里默认 `true`，不可配 | tindy `README-cn.md:313-342`；dianbanjiu `src/converters/clash.ts:31` 等 |
| 多订阅合并 | `url` 用 `\|` 连接 | 单 URL | tindy `README.md:73-91`；dianbanjiu `src/index.ts:36` |
| 规则类型校验 | 有显式白名单，规则转换前校验 | 不解析规则、不生成动态规则 | tindy `src/generator/config/ruleconvert.cpp:12-18`、`:173`、`:244`、`:509` |
| sing-box 细节 | SS `plugin_opts`、Hysteria2 `server_ports`、WireGuard/AnyTLS 等 | SS 插件丢失、Hysteria2 端口跳跃丢失、kcp/quic 无 transport | tindy `src/generator/config/subexport.cpp:2368`、`:2471`；dianbanjiu `src/converters/singbox.ts:133-139`、`:143-157`、`:176-205` |
| 测试/CI | 有 GitHub Actions 构建/发布工作流（`README.md:5-8` badge；`.github/workflows/build.yml`），但不是测试套件 | 无 test 脚本、无 `.github` | `package.json:7-10`；`git ls-files` |

### 2.3 缺失清单（逐条给证据）

1. **输入格式与合并能力缺失**：tindy 明确支持多订阅用 `|` 合并（`README.md:73-91`），并能读文件路径/data URI（`README.md:67-71`）；dianbanjiu 只读取一个 `url` 查询参数（`src/index.ts:36`），不支持合并、文件、data URI。
2. **目标格式缺失**：tindy 支持 ClashR、Quantumult/QuanX、Loon、Surge 2/3/4、Surfboard、SS/SSD/SSR、mixed/auto（`README.md:24-40`；`README-cn.md:120-140`），dianbanjiu 只有 5 个 target（`src/converters/index.ts:43-53`）。`target` 白名单同样只有 5 个（`src/converters/index.ts:43-45`）。
3. **外部配置/规则集/模板缺失**：tindy 的 `config=` 指向外部配置，包含 `proxy_group`、`ruleset`、模板（`README-cn.md:316`、`:871-990`、`:1056`）；dianbanjiu 的 `handleSub` 只读 `url`/`target`/`pass`（`src/index.ts:36-38`），Clash 的组和规则写死在 `src/converters/clash.ts:183-226`，sing-box 的 DNS/route 写死在 `src/converters/singbox.ts:11-57`。实测输入 Clash YAML 的 `rules:` 和 `proxy-groups:` 不会出现在输出（见 4.1）。
4. **节点筛选/重命名/排序/参数覆盖缺失**：tindy 有 `include`/`exclude`/`rename`/`emoji`/`sort`/`tfo`/`udp`/`scv`/`fdn` 等（`README-cn.md:313-342`）；dianbanjiu 没有这些参数（`src/index.ts:36-38`），Clash 输出中 `udp` 默认 `true`、`tfo` 不输出、`skip-cert-verify` 只在解析到 `skipCertVerify` 时输出（`src/converters/clash.ts:31`、`:38`、`:58` 等）。
5. **协议覆盖缺失（同时有一处新增）**：tindy 的 `ProxyType` 包含 Snell/HTTP/HTTPS/SOCKS5/WireGuard/Hysteria/Hysteria2/AnyTLS（`src/parser/config/proxy.h:12-27`）；dianbanjiu 的 IR 只有 7 种（`src/types.ts:4-11`），Clash YAML 解析器的 `default` 直接 `return null`（`src/parsers/clash.ts:168-169`）。实测一个含 VMess+Snell+WireGuard+SOCKS5+HTTP+Hysteria(v1)+Trojan 的 Clash YAML 只解析出 VMess+Trojan（7→2），其余静默丢弃。反过来，dianbanjiu 支持 VLESS/Reality 与 TUIC，而 tindy 当前 master 的 `ProxyType` 枚举里没有这两类（`proxy.h:12-27`；`grep -ri vless/tuic src` 无命中），这是 dianbanjiu 的真实增量。
6. **规则转换接口缺失**：tindy 有 `/getruleset?type=&url=&group=`，并在 `ruleconvert.cpp:12-18` 定义 Clash/Surge/QuanX/SingBox 的规则类型白名单，生成前用 `none_of` 过滤（`:173`、`:244`、`:424`、`:434`、`:509`）；dianbanjiu 没有 `/getruleset` 路由（`src/index.ts:14-23`），也没有任何规则转换/校验代码。
7. **sing-box 输出细节缺失**：tindy 在 sing-box 输出中保留 SS `plugin_opts`（`subexport.cpp:2368`）、Hysteria2 `server_ports`（`:2471`）、WireGuard/AnyTLS 等（`:2405`、`:2506`）；dianbanjiu 的 SS 分支完全不输出 `plugin`/`plugin_opts`（`src/converters/singbox.ts:133-139`），Hysteria2 分支不输出 `server_ports`（`:143-157`），`transportSingbox` 对 kcp/quic 直接返回 `{}`（`:176-205`）。实测 SS 插件节点转 sing-box 后只剩 `type/method/password`；HY2 的 `mport=20000-30000` 在 sing-box 输出中为 `MISSING`。
8. **SSR IPv6 解析缺失（共同限制，不作为相对 tindy 的优势）**：`parseSSR` 用 `main.split(":")` 取 6 段（`src/parsers/uri.ts:214-216`），IPv6 服务器地址会被冒号切碎，导致解析失败或字段错位；tindy 的 `explodeSSR` 同样用冒号正则 `(\S+):(\d+?):...`（`src/parser/subparser.cpp:702`），因此这更像两边的共同限制，不算 dianbanjiu 相对 tindy 的独有缺失。未构造 IPv6 SSR 端到端用例。

### 2.4 明显错误/行为差异（与 tindy 对比）

1. **`clash` 与 `clash-meta` 完全同物，且 `clash` 会写入原版 Clash 不支持的协议。** `src/converters/index.ts:15-21` 两个 target 共用 `toClash`；实测两个 target 的输出逐字节相同。`toClash` 无条件支持 vless/reality、hysteria2、tuic（`src/converters/clash.ts:43-68`、`:116-133`、`:134-149`），而原版 Clash 不支持这些类型。README 却把 `clash` 标为“Clash / Clash Verge / Clash Verge Rev / Mihomo”（`README.md:37`）。tindy 用 `fdn` 默认过滤目标不支持的节点（`README-cn.md:336`），dianbanjiu 没有对应逻辑。
2. **SSRF 防护被实测绕过。** `url-guard.ts:2` 自述“只校验 URL 字面量中的 host”；`fetcher.ts:30` 使用 `redirect: "follow"` 且不逐跳复检。实测：`https://localhost./`、`https://foo.local./`、`https://127.0.0.1.nip.io/`、`https://localtest.me/` 均通过校验；在本地 workerd 中，Worker 抓取 `localtest.me:8801` 和“302 → 127.0.0.1:8801”均成功返回订阅内容。详见 3.1。
3. **README 的 KV 占位符声明与仓库内容矛盾。** `README.md:76` 让用户替换 `REPLACE_WITH_YOUR_KV_ID`，`README.md:84` 说“仓库自带的 `wrangler.toml` 故意只放占位符”；实际 `wrangler.toml:17` 是 `id = "e56bd26ac5cc4e09a54d78982b68d96e"`。commit `5f27400` 的标题是“替换 KV ID 为占位符”，但 `git show 5f27400 -- wrangler.toml` 显示只改了注释，ID 未变。KV ID 不是密钥，但这使“fork 后自动填充”的说明不可信，手动部署还会尝试绑定作者的 namespace。
4. **“最小输入长度校验”不成立。** `README.md:193` 声称有最小输入长度校验；`src/auth.ts:18-19` 实际只拒绝空串（`candidate.length < 1`），1 字符密钥 `a` 在 `STATIC_KEYS="a,k4"` 下实测返回 `true`。README `:88` 只是建议 ≥24 字符，没有强制。
5. **“其它协议都有覆盖”不成立。** `README.md:229` 说 sing-box 除 SSR 外“其它协议都有覆盖”；但输入 Clash YAML 中的 Snell/WireGuard/SOCKS5/HTTP/Hysteria(v1) 在 `src/parsers/clash.ts:168-169` 被 `default: return null` 静默丢弃。实测 7 个 proxy 只保留 2 个，无任何警告。
6. **“YAML 锚点炸弹 DoS”缓解措施与锁定依赖不匹配。** `README.md:197` 声称用 Content-Length + 5MB 流式上限防 YAML 锚点炸弹；锁定的 `js-yaml@4.1.1`（`package-lock.json:1237-1244`）有 4 个二次复杂度 DoS 公告，且 `parseClashYaml` 直接 `yaml.load(text)`（`src/parsers/clash.ts:8`），没有传 `maxTotalMergeKeys` 等限制。实测 162KB merge-chain 在真实解析路径耗时 1,585ms；5MB 上限不能阻止小体积高 CPU。详见 3.6。
7. **“错误信息脱敏”只对客户端成立，Worker 日志会记录完整订阅 URL。** `src/fetcher.ts:40` 在非 2xx 时 `console.warn(..., url.toString())`，订阅 URL 通常自带 token；`src/parsers/uri.ts:31` 在单条解析失败时打印 `uri.slice(0, 60)`，会带出 `trojan://password@...`、vless UUID 等。README `:198` 说“详细信息仅 console.warn 到 Worker 日志”，但未说明日志本身含敏感 URL。
8. **数据丢失**：Hysteria2 的 `mport` 只在 Clash 输出保留；sing-box 输出无 `server_ports`，URI 输出丢 `mport`（`src/parsers/uri.ts:251`、`src/converters/singbox.ts:143-157`、`src/converters/uri.ts:112-120`；实测 `hysteria2://...&mport=20000-30000` 转 URI 后只剩 `?`）。VLESS 的 `allowInsecure=1`/`insecure=1` 从未被读取（`src/parsers/uri.ts:82-107` 没有 `skipCertVerify` 赋值），所以即使客户端链接要求跳过证书校验，输出也不会带 `skip-cert-verify`（实测 I4/I5）。SS 的 SIP003 plugin 在 sing-box 输出中完全丢失（`src/converters/singbox.ts:133-139`；实测 N3）。VMess 的 `type`（HTTP header 混淆）从未读取（`src/parsers/uri.ts:49-78`）。
9. **重复名/保留名会生成歧义配置。** `dedupNames` 对 `["a","a #2","a"]` 输出 `["a","a #2","a #2"]`（`src/converters/clash.ts:173-181`；实测 C1），仍重复；sing-box 完全不去重（`src/converters/singbox.ts:5-9`、`:63`；实测 C2）。节点名为 `PROXY`/`AUTO` 时 Clash 组出现自引用/重复成员（`src/converters/clash.ts:202-215`；实测 C3）；sing-box 节点名为 `direct`/`block`/`dns-out` 时与内置出站 tag 重复（`src/converters/singbox.ts:44-46`；实测 N4）。
10. **端口不校验。** vmess JSON `port:"abc"` 得到 `NaN`，Clash 输出 `port: .nan`、sing-box 输出 `server_port: null`（`src/parsers/uri.ts:64`、`src/converters/clash.ts:27`、`src/converters/singbox.ts:63`；实测 D1-D4）；vless 端口 0/70000、Clash YAML 端口 -1、ss 端口 0 都能通过（`src/parsers/uri.ts:90`、`:166`、`:175`、`:223`、`:308`；`src/parsers/clash.ts:27`；实测 D5-D8）。
11. **没有应用层超时、没有输出/节点数上限。** `src/fetcher.ts:28-32` 的 `fetch` 没有 `AbortSignal`；实测对永不响应的本地服务 2 秒后仍 pending。上游 5MB 上限是输入侧；输出侧没有大小/节点数限制，5MB URI 列表可生成更大的 Base64/Clash 输出，CPU 也没有上限。README 没有声称有超时，但作为公开服务这是明显工程缺口。
12. **`clash` 目标名与实际客户端能力不匹配（重复第 1 条，但值得单列）**：README 的 target 表把 `clash` 与 `clash-meta` 分成两行（`README.md:37-38`），代码却完全相同；对原版 Clash 用户，这会产生“能生成但客户端不认”的配置。

## 3. 工程质量与安全问题

### 3.1 SSRF：字面量黑名单 + 自动跟随重定向，防护不完整

**代码证据**

- `src/utils/url-guard.ts:2` 自述：“只校验 URL 字面量中的 host；CF Workers 的 fetch 通常不可达内网，但作为深度防御保留这层校验。”
- `src/utils/url-guard.ts:57-62` 只精确匹配 `localhost` 等主机名，或用 `endsWith(".local"/".internal"/".localhost")` 判断；没有解析 DNS。
- `src/utils/url-guard.ts:101-119` 的 IPv6 判断只做字符串前缀匹配：`::1`/`::`、`::ffff:`、`fe8`–`feb`、`fc`/`fd`、`ff`；没有完整的 IPv6 地址解析。
- `src/fetcher.ts:28-32` 使用 `redirect: "follow"`，重定向目标不会再次经过 `validateSubscriptionUrl`。

**实测：黑名单挡住的（`validateSubscriptionUrl`，默认 `allowHttp=false`）**

| 输入 | 结果 |
| --- | --- |
| `https://127.0.0.1/x` | 拒绝：禁止访问内网/特殊 IPv4 |
| `https://[::1]/x`、`https://[0:0:0:0:0:0:0:1]/x` | 拒绝（URL 归一化为 `::1`） |
| `https://[::ffff:127.0.0.1]/x`、`https://[0:0:0:0:0:ffff:7f00:1]/x` | 拒绝（归一化为 `::ffff:7f00:1`） |
| `https://2130706433/x`、`https://0x7f000001/x`、`https://127.1/x`、`https://0177.0.0.1/x` | 拒绝（URL 归一化为 `127.0.0.1`） |
| `https://example.com@127.0.0.1/x`、`https://127.0.0.1#@example.com/x` | 拒绝（host 是 `127.0.0.1`） |
| `http://127.0.0.1/x`（`allowHttp=false`） | 拒绝：默认仅允许 https |
| `ftp://example.com/x` | 拒绝：仅支持 http(s) |

**实测：绕过的**

| 输入 | 结果 | 原因 |
| --- | --- | --- |
| `https://localhost./x` | **接受**（hostname `localhost.`） | 精确集合只有 `localhost`；`endsWith(".local")` 不匹配 `localhost.` |
| `https://foo.local./x` | **接受** | 末尾点使 `.local` 后缀判断失效 |
| `https://127.0.0.1.nip.io/x` | **接受** | 域名不在黑名单；DNS 解析到 127.0.0.1 |
| `https://localtest.me/x` | **接受** | 公开 DNS 名称，解析到 `::1`/`127.0.0.1` |
| `https://[fec0::1]/x` | **接受** | `fec0::/10`（已废弃的 site-local）不在前缀列表 |
| `https://[64:ff9b::7f00:1]/x` | **接受** | NAT64 well-known prefix 未覆盖 |
| `https://[2002:7f00:1::]/x` | **接受** | 6to4 未覆盖 |
| `https://[2001:db8::1]/x` | **接受** | 文档地址段，不是内网；仅说明“特殊段”覆盖不全 |

**动态验证（本地 workerd，不是生产 Cloudflare）**

1. 直接 DNS 绕过：本地 Python 服务在 `127.0.0.1:8801` 提供 2 节点订阅；请求
   `GET /api/sub?url=http%3A%2F%2Flocaltest.me%3A8801%2Fsub.txt&target=clash`
   经 `wrangler dev --local` 的 Worker 返回 **200 + `X-Node-Count: 2` + 1,429 字节 Clash YAML**。说明 `localtest.me`（解析到回环）通过了校验，Worker 实际抓到了回环服务。
2. 重定向绕过：本地 Node 服务在 `127.0.0.1:8802` 对 `/redir` 返回 `302 Location: http://127.0.0.1:8801/sub.txt`；请求
   `GET /api/sub?url=http%3A%2F%2Flocaltest.me%3A8802%2Fredir&target=uri`
   返回 **200 + `X-Node-Count: 2` + 388 字节 URI 列表**。说明初始 URL 的 host 是 `localtest.me`（通过校验），重定向后的 `127.0.0.1` 没有被复检。
3. 同样的行为在 Node 24 的 `fetch` 下也复现：`validateSubscriptionUrl("http://localtest.me:PORT/secret", {allowHttp:true})` 返回 `ok:true`，`fetchSubscription` 直接返回 `TOP-SECRET`；302 版本同样返回 `TOP-SECRET`。

**影响与边界**

- 在**本地 workerd/Miniflare**中，SSRF 绕过是已实测的。生产 Cloudflare 的 egress 是否在网层阻断回环/私网，我**没有验证**；`url-guard.ts:2` 的作者也承认“CF Workers 的 fetch 通常不可达内网”。但即使平台兜底，代码层“拒绝内网/回环”的安全声明也不成立，且任何云厂商 egress 策略变化或自建 workerd/兼容运行时都会把风险暴露出来。
- 正确做法（只借鉴思路）：解析 DNS 后检查所有 A/AAAA；禁止或限制重定向，逐跳复检；对最终连接 IP 做 CIDR 校验；用 URL 解析器的规范化结果而不是字符串前缀；对主机名做 IDNA/末尾点归一化；维护完整的 IPv4/IPv6 特殊段表。
- 相关测试：`tests-core.mjs` 的 E1、`tests-ipv6.mjs`、`tests-network.mjs` 的 L2-L5、本地 `wrangler dev` 的 live 请求。

### 3.2 超时与大小限制

**大小限制：真实有效。** `src/fetcher.ts:5-6` 定义 5MB；`:44-53` 先看 `Content-Length`；`:55-56` 调 `readWithLimit`；`:65-91` 流式累加，超过 `max` 就 `reader.cancel()` 并抛 413。

- 6MB 响应：`fetchSubscription` 抛 `FetchUpstreamError status=413 "订阅响应过大"`；HTTP 层返回 413。
- 恰好 5MB：通过，`text.length = 5242880`。
- `Content-Length: 5242881`：在读取 body 前返回 413。
- 这是实现得比较好的部分。

**超时：没有。** `src/fetcher.ts:28-32`：

```ts
resp = await fetch(url.toString(), {
  headers: { "User-Agent": ua, Accept: "*/*" },
  redirect: "follow",
  cf: { cacheTtl: 60, cacheEverything: false },
});
```

没有 `signal`、没有 `AbortSignal.timeout()`、没有 `cf` 的连接超时选项。实测：本地服务对 `/hang` 永不响应，`fetchSubscription` 在 2 秒后仍是 `STILL-PENDING-AFTER-2s`；只有关闭 socket 才变成 `fetch failed`。生产上 Workerd/Cloudflare 可能有平台级超时，但应用层没有，无法给用户稳定的 504/502 语义。

**输出/节点数没有上限。** 5MB 输入最多可解析出大量节点；Clash YAML/sing-box JSON/Base64 输出没有大小上限，也没有 `X-Node-Count` 之外的保护。一个 5MB 的 URI 列表可以放大成更大的 Base64（约 6.7MB）或带完整 DNS/组/规则的 YAML/JSON；CPU 消耗也没有上限（`dedupNames` O(n)、`yaml.dump` O(n)）。这不是最严重的问题，但公开服务应加上节点数/输出字节上限。

### 3.3 鉴权、密钥与常量时间比较

**做得好的**

- 支持 KV 单键、KV `keys` 列表、`STATIC_KEYS` 环境变量三种来源（`src/auth.ts:21-46`），任一命中即放行。
- 只接受 `Authorization: Bearer <token>` / `Token <token>`，裸 token 拒绝（`src/auth.ts:51-57`）；实测裸 token 返回 false。
- 列表/env 路径使用常量时间比较（`src/auth.ts:77-98`），始终遍历整张表；实测通过。
- 鉴权在参数校验之前（`src/index.ts:40-50`），未授权不泄露 target 列表等指纹。
- `WWW-Authenticate: Bearer realm="subconverter"` 设置正确。

**问题**

1. **1 字符密钥可通过。** `src/auth.ts:18-19` 的注释说“拒绝过短/过长的输入”，但条件是 `candidate.length < 1`，只拒绝空串；`STATIC_KEYS="a,k4"` + `Bearer a` 实测返回 `true`。README `:193` 的“最小输入长度校验”不成立。
2. **KV 单键路径把密钥明文放在 key 名里。** `src/auth.ts:24` 查询 `key:${candidate}`；部署者按 README `:93` 执行 `wrangler kv key put --binding=AUTH_KV "key:<your-key>" "1"`，密钥会以明文出现在 KV key 名、Dashboard、KV 导出/备份中。任何有 KV 读权限的人都能看到全部密钥。更好的做法是存 `key:<SHA-256(candidate)>` 或只存哈希列表，并支持按 key id 撤销。
3. **KV 直接按 key 查不是常量时间**（代码注释 `src/auth.ts:8-9` 已承认）；`key:` 路径的命中/未命中延迟可能被用来做存在性探测，实际风险取决于 KV 延迟噪声，不应把它当作常量时间。
4. **查询参数 `pass` 优先于 Header。** `src/auth.ts:16` 用 `(providedPass || headerPass || "")`，URL 里有 `?pass=` 时忽略 Authorization；实测“正确 header + 错误 pass”返回 false，“正确 pass + 错误 header”返回 true。不是越权漏洞，但会让“Header 优先”的客户端配置在 URL 被污染时失效。
5. **没有内置速率限制。** README `:123-131` 让用户自己在 Cloudflare WAF 配；代码没有按密钥/IP 限速。每个未授权请求还要做最多 2 次 KV 读（`key:<candidate>` + `keys`），可被用来放大 KV 读取成本。README 的“推荐 WAF”是运维建议，不是代码保证。
6. **没有密钥轮换/撤销接口**；只能手工删 KV key。`STATIC_KEYS` 需要重新 `wrangler secret put` 并重新部署。
7. **KV namespace 缺失时静默降级**：`env.AUTH_KV` 为 undefined 时直接跳过 KV，只靠 `STATIC_KEYS`；如果两者都未配置，所有请求 401（安全默认，但部署排障不友好）。
8. **硬编码密钥检查（明确结论）**：对源码和 8 个提交执行 `git grep -iE "(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY-----)"`，**没有命中**；没有 `.dev.vars` 历史。`wrangler.toml:17` 的 KV namespace id 不是密钥，但它是真实 id 而非 README 声称的占位符（见 R7）。`DEFAULT_UA`（`src/fetcher.ts:24`）是普通常量，不是密钥。也就是说：**没有发现“硬编码密钥”，但发现了“明文 key 名存密钥”的设计问题**（第 2 条）。

### 3.4 规则类型校验：当前没有“规则输入”，所以不是校验缺失，而是功能缺失

- **没有规则输入路径。** `handleSub` 只读 `url`/`target`/`pass`（`src/index.ts:36-38`）；`parseClashYaml` 只取 `doc.proxies || doc.Proxy`（`src/parsers/clash.ts:13`），不读 `rules:`、`Rule:`、`proxy-groups:`、`proxy-providers:`；没有 `/getruleset` 路由（`src/index.ts:14-23`）。
- **没有动态规则类型拼接。** 唯一的规则生成是 `buildBaseConfig` 里的 7 条字面量（`src/converters/clash.ts:217-225`）。因此不存在“把用户输入的类型字符串写进规则”的注入面，也不存在“DOMA 截断”路径。
- **输入规则会被完全丢弃。** 实测输入：

```yaml
proxies: [{name: p, type: vmess, ...}]
rules:
  - DOMA,example.com,DIRECT
  - DOMAIN-SUFFIX,example.org,PROXY
proxy-groups:
  - {name: EVIL, type: select, proxies: [p]}
```

输出仍然只有固定的 7 条规则，`DOMA,`、`example.org`、`EVIL` 都不存在。这既说明“不会产出 DOMA”，也说明**用户自定义规则/组全部丢失**。

- **目标能力校验缺失。** 虽然没有规则校验，但有“目标支持哪些协议”的校验缺失：`target=clash` 会把 vless/hysteria2/tuic 写进 Clash YAML。tindy 用 `fdn` 默认过滤（`README-cn.md:336`），dianbanjiu 的 `convert` 只按 target 分支，不按协议过滤（`src/converters/index.ts:13-41`）。
- **如果以后加规则功能，建议直接采用白名单校验**：tindy 的 `ruleconvert.cpp:12-18` 定义了 Clash/Surge/QuanX/SingBox 的类型集合，生成前用 `none_of` 过滤（`:173`、`:244`、`:424`、`:434`、`:509`）。这是值得借鉴的思路，但不要复制其 GPL 代码。

### 3.5 “生成非法 YAML”：语法 vs 语义

**结论：没有发现能让 `js-yaml.dump` 输出语法错误 YAML 的输入；但能生成 Clash/sing-box 语义非法或不可用的配置。**

`toClash` 使用 `yaml.dump(config, { indent: 2, lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false })`（`src/converters/clash.ts:11-17`）。实测：

- 名称 `on`/`null`/`123` 会被引号包成字符串（`name: "on"` 等），不会变成布尔/数字（N5/N6）。
- 名称含 `#`、`:`、`"`、`\`、emoji、换行、Tab、NUL 时 `yaml.dump` 不抛异常，输出仍可被 `js-yaml.load` 解析（`tests-weird.mjs`）。
- 因此“YAML 语法非法”不是主要问题；问题是**语义非法**。

| 语义非法/不可用配置 | 代码证据 | 实测 |
| --- | --- | --- |
| `port: .nan`（YAML 合法，Clash 端口非法） | `src/parsers/uri.ts:64`（`parseInt` 不校验）、`src/converters/clash.ts:27` | vmess `port:"abc"` → Clash `port: .nan`；`js-yaml.load` 得到 `NaN`（D1-D3） |
| `server_port: null`（sing-box 要求整数） | `src/converters/singbox.ts:63` | 同上 → `server_port: null`（D4） |
| 端口 0、70000、-1 | `src/parsers/uri.ts:90`/`:166`/`:175`/`:223`/`:308`；`src/parsers/clash.ts:27` | vless 70000、vless 0、ss 0、Clash YAML -1 全部原样输出（D5-D8） |
| 重复 proxy 名 | `src/converters/clash.ts:173-181` | 输入 `["a","a #2","a"]` → 输出 `["a","a #2","a #2"]`（C1） |
| 重复 sing-box tag | `src/converters/singbox.ts:5-9`、`:63` | 同名节点不去重（C2）；`direct`/`block`/`dns-out` 与内置 tag 冲突（N4） |
| Clash 组自引用/重复成员 | `src/converters/clash.ts:202-215` | 节点名 `PROXY`/`AUTO`/`DIRECT` → 组内出现自身/重复（C3） |
| `network: kcp` 但无 `kcp-opts`；sing-box 无 transport | `src/parsers/uri.ts:314-322`（允许 kcp/quic）、`src/converters/clash.ts:153-171`、`src/converters/singbox.ts:176-205` | vmess `net=kcp` → Clash `network: kcp`；sing-box `transport` MISSING（N7-N9） |
| 非法 cipher/method/protocol/obfs 原样透传 | `src/parsers/clash.ts:40`、`:118`、`:130-135`；`src/parsers/uri.ts:161`、`:183`、`:216`、`:224-228` | `ss` cipher `not-a-cipher` → Clash `cipher: not-a-cipher`（N10） |
| 不支持的输入节点被静默丢弃 | `src/parsers/clash.ts:168-169` | 7 个 proxy 只保留 2 个（2.3 第 5 条） |
| 输入规则/组被静默丢弃 | `src/parsers/clash.ts:13` | 见 3.4 实测 |

**未做客户端最终校验**：我没有用 mihomo/sing-box 二进制跑 `-t`/`check`（下载超时，见第 7 节），所以“mihomo 一定会拒绝 `port: .nan`/重复名”没有在本会话中执行验证；上述“语义非法”是基于 YAML/JSON 解析结果、字段类型和客户端 schema 常识。严格的结论是：**这些输出至少是可疑/不可移植的，且与生成器的类型契约不符**；其中 `port: .nan`、`server_port: null` 明确不是整数端口。

### 3.6 依赖风险：锁定的 `js-yaml@4.1.1` 有 4 个 DoS 公告

- `package.json:12-14` 声明 `"js-yaml": "^4.1.0"`；`package-lock.json:1237-1244` 锁定 **4.1.1**。`npm ci` 会安装 4.1.1。
- OSV 查询（2026-11-09，`POST https://api.osv.dev/v1/query`，package `js-yaml`，version `4.1.1`）返回 4 条：

| ID | 摘要 | 修复版本 |
| --- | --- | --- |
| `GHSA-2883-xcg3-v3hh` / CVE-2026-84375 | `maxTotalMergeKeys` 不限制空 merge source 的 CPU | 4.3.2 |
| `GHSA-52cp-r559-cp3m` / CVE-2026-59869 | merge-key 链导致二次 CPU | 4.3.0 |
| `GHSA-5p4m-2wfm-xmqj` / CVE-2026-59870 | `!!omap` 解析二次 CPU | 4.3.1 |
| `GHSA-h67p-54hq-rp68` / CVE-2026-53550 | 重复 alias 的 merge 二次复杂度 DoS | 4.2.0 |

  另外，4.1.0 还有 `GHSA-mh29-5h37-fv8m` / CVE-2025-64718（merge `<<` 原型污染，4.1.1 已修）。4.1.1 下我实测 `__proto__` 不污染全局原型、`!!js/function` 被拒绝（J1/J2），所以原型污染不是当前锁定的主要问题；**主要问题是 DoS**。

- 真实路径复现：`parseClashYaml` 直接 `yaml.load(text)`（`src/parsers/clash.ts:8`），没有传限制选项。构造 merge-chain（每层 `{ <<: *a{i-1}, k{i}: i }`，约 162KB、4000 层）：

| js-yaml 版本 | n=500 | n=1000 | n=2000 | n=4000 |
| --- | --- | --- | --- | --- |
| 4.1.1（锁定） | 37ms | 120ms | 385ms | **1,585ms** |
| 4.3.2 | 6ms | 4ms | 3ms | 4ms |

  5MB 上限允许约 12 万个类似层级，按二次增长会远超 Worker CPU 限制；攻击者只需要让订阅源返回一个带 `proxies:` 行的小 YAML（`parseAny` 的检测在 `src/parsers/index.ts:12`），就能消耗大量 CPU。`README.md:197` 声称的“5MB 防 YAML 锚点炸弹”没有覆盖这个向量。注意：我构造的纯 anchor 炸弹（非 merge，8 层×10 引用，442 字节）在 4.1.1 下 0ms、0MB，因为 js-yaml 的 alias 是共享引用而不是深拷贝；所以“anchor 炸弹”本身没有被复现，真正可复现的是 merge-key/`!!omap` 的二次复杂度。

- 修复建议：把 `js-yaml` 升到 **>=4.3.2**（或 5.x，但需回归 `yaml.load` API/行为），并重新生成 lockfile；同时给 `yaml.load` 加 `maxTotalMergeKeys`（如果版本支持）和输入节点数上限。`^4.1.0` 的范围本身允许 4.3.2，但 `npm ci` 会忠实安装锁定的 4.1.1，所以**必须改 lockfile**。
- 其他依赖：`wrangler@3.114.17` 已过时，`wrangler deploy --dry-run` 明确警告“update available 4.158.0”“out-of-date”；`compatibility_date = "2025-01-15"`（`wrangler.toml:3`）也比仓库创建时间早一年多。`@cloudflare/workers-types@4.20260521.1`、`typescript@5.9.3` 是 devDependencies，不进入 Worker bundle。
- 供应链：`package-lock.json` 的 109 个包全部 `resolved` 到 `https://registry.npmjs.org/`，且都有 `integrity`（`grep -c '"integrity"'` = 109）。这一点做得比很多小项目好。
- `npm audit` **没有跑成功**：当前 npm registry 是 `registry.npmmirror.com`，其 `/-/npm/v1/security/advisories/bulk` 返回 404 `[NOT_IMPLEMENTED]`，`npm audit` 退出 1。因此我改用 OSV API；这是替代检查，不是 `npm audit` 本身。

### 3.7 测试、类型与构建

- **没有测试**：`git ls-files` 无 `test`/`spec`/`.github`；`package.json:7-10` 只有 `dev`/`deploy`/`typecheck`，没有 `test`。所以“安全模型”里的每一条都没有回归测试保护。
- **类型检查通过**：`npm ci --ignore-scripts` 后 `npm run typecheck`（`tsc --noEmit`）退出 0。`tsconfig.json:8-10` 开了 `strict`/`noImplicitAny`/`strictNullChecks`。
- **构建通过**：`npx wrangler deploy --dry-run --outdir /tmp/audit-tools/wrangler-dist` 退出 0，输出 `Total Upload: 155.13 KiB / gzip: 34.96 KiB`，并显示 `AUTH_KV: e56bd26ac5cc4e09a54d78982b68d96e`。
- **但类型安全被 `any` 架空**：`grep -rn ": any\|<any>\|as any" src` 有 18 处，集中在所有 parser 的输入（`src/parsers/clash.ts:6`、`:13`、`:23`；`src/parsers/uri.ts:53`）和 transport/URI 输出（`src/converters/*.ts`）。`parseClashYaml` 把 YAML 文档当 `any`，`clashProxyToNode` 逐字段 `String()/parseInt()`，没有 schema。
- **没有 lint/format 配置**，没有 `noUnusedLocals`/`noUncheckedIndexedAccess`，没有 fuzz/property 测试。
- **没有 CI**：没有 `.github/workflows`，没有依赖更新/安全扫描；PR #1 只是 Cloudflare bot 改名。

### 3.8 日志与隐私

- **客户端错误信息是脱敏的**：`src/index.ts:71-73`、`src/fetcher.ts:33-36`、`:39-42` 只返回“订阅源不可用/订阅源返回 403”等；实测 K13/K14 没有内部细节。README `:198` 这一点基本成立。
- **但 Worker 日志不脱敏**：`src/fetcher.ts:40` 打印 `url.toString()`，订阅 URL 通常包含机场 token；`src/parsers/uri.ts:31` 打印 `uri.slice(0, 60)`，会包含 `trojan://password@...`、vless UUID 等。`console.warn` 进入 Workers 日志后，任何有日志查看权限的人都能看到订阅凭据。这是“客户端脱敏、服务端反而记录”的典型问题。
- `cf: { cacheTtl: 60, cacheEverything: false }`（`src/fetcher.ts:31`）可能让上游订阅内容在 Cloudflare 边缘缓存 60 秒；对同一 token URL 的重复请求可能命中缓存。`cacheEverything: false` 会尊重源站缓存头，但 `cacheTtl` 仍可能生效。订阅内容含节点凭据，边缘缓存的隐私影响需要部署者确认。
- `Subscription-Userinfo` 原样转发（`src/index.ts:91`），这是兼容 v2rayN/Clash 的正常做法；没有校验/截断，但 HTTP 头本身有大小限制。
- `X-Node-Count` 会暴露节点数量（`src/index.ts:87`），属于轻微指纹；README 只对 `/api/health` 做了最小化，没有提到这个头。

### 3.9 前端（`public/index.html`）

**做得好的**

- 537 行真实逻辑：target 选择、密钥显示/隐藏、生成 URL、复制、Clash 一键导入、toast、prefs 持久化（`public/index.html:319-533`）。
- 默认勾选 Header 鉴权（`:248-251`），生成 URL 不含 `pass`，另给 `Authorization` 文本（`:472-480`）。
- 密钥默认只写 `sessionStorage`（`:395-400`）；只有勾选“记住密钥”才写 `localStorage`（`:403-410`），与 README `:194`/`:206` 基本一致。
- 使用 `textContent` 而不是 `innerHTML` 写 URL/Header（`:475-477`、`:282`），未发现 DOM XSS 路径。
- `reset` 会清空 URL、密钥、endpoint、session/local storage（`:413-423`）。
- `copy-clash` 在 Header 模式下会提示并降级到 `?pass=`（`:434-445`），风险提示明确。

**问题**

1. **订阅 URL（含 token）会被持久化到 `localStorage`。** `prefs.url` 在每次输入时保存（`:377-379`、`:526-528`），而 `prefs` 存在 `subconverter:prefs:v1`（`:334-338`）。这与“密钥不写 localStorage”不矛盾，但 README 的安全模型只讨论了密钥和客户端日志（`:205-207`），没有提示**原始订阅 URL（通常自带机场 token）会被长期保存在浏览器 localStorage**。共用设备上这是实质隐私风险。
2. **UI 文案可能误导。** `:229` 说“本页所有操作均在浏览器本地完成，链接不会发往任何服务器”。页面本身确实不上传，但用户点击“在新窗口打开”或把生成的链接交给客户端后，订阅 URL 会作为 `url=` 参数发到 Worker（这是功能必需）。建议改成“本页不会上传；实际转换在 Worker 端完成”。
3. **`sessionStorage` 访问未包 try/catch。** `:339` 直接 `sessionStorage.getItem(KEY_STORAGE)`；某些隐私模式/禁用 storage 的浏览器会抛 `SecurityError`，导致整个脚本中断。`localStorage` 的 `loadPrefs` 有 try/catch（`:516-525`），sessionStorage 没有。
4. **`endpoint` 没有强制 HTTPS。** `:457-466` 只做 `new URL(endpoint)`；用户填 `http://...` 会生成 http 订阅链接（明文传输密钥/订阅 URL）。服务端默认只允许 https 上游，但客户端到 Worker 的链接可以是 http。
5. **没有 CSP**，脚本内联；当前没有外部资源/XSS 注入点，风险低，但作为安全向项目可以加 `Content-Security-Policy`（注意内联脚本需 nonce/hash）。
6. **`loadPrefs` 接受任意 `target` 字符串**；服务端会 400，不会造成注入，但 UI 状态可能不一致。

### 3.10 工程质量小结

**优点**：代码量小、结构清晰（IR + parsers + converters + utils）；错误码映射完整；鉴权在参数校验前；`/api/health` 最小化；5MB 流式上限和 `Content-Length` 预检做得实在；没有 CORS 过度开放；依赖少且 lockfile 有 integrity。

**缺点**：没有测试/CI；大量 `any` 和缺失的运行时校验；`clash`/`clash-meta`/`v2ray` 的语义名不副实；文档的安全/兼容性声明超前于实现；日志泄露订阅凭据；依赖锁定在已知 DoS 版本；生成配置不保证客户端可用。

## 4. 它是否可能产出 `DOMA` 这类非法规则？

### 4.1 明确结论：当前代码不可能产出 `DOMA` 规则类型

`DOMA` 通常指把 `DOMAIN` 截断/拼错后的非法 Clash 规则类型。对 dianbanjiu：

1. **唯一的规则生成路径是硬编码字面量。** `src/converters/clash.ts:217-225`：

```ts
rules: [
  "DOMAIN-SUFFIX,local,DIRECT",
  "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve",
  "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
  "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
  "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
  "GEOIP,CN,DIRECT",
  "MATCH,PROXY",
],
```

没有变量、没有 `split`/`slice`/模板字符串参与规则类型生成。`grep -rn "DOMAIN\|GEOIP\|IP-CIDR\|MATCH\|RULE-SET" src` 只命中这一段和注释。

2. **全历史 grep 只找到 `DOMAIN-SUFFIX` 字符串。** `git grep -n '"DOMA' $(git rev-list --all)` 在 8 个提交中都只返回 `src/converters/clash.ts:218` 的 `"DOMAIN-SUFFIX,local,DIRECT"`；没有 `"DOMA,"`，也没有动态规则类型。

3. **输入里的 `DOMA` 规则会被丢弃。** 实测（`tests-doma.mjs`）：输入 Clash YAML 同时含 `rules: [DOMA,example.com,DIRECT, DOMAIN-SUFFIX,example.org,PROXY]` 和 `proxy-groups: [EVIL]`，`parseAny` 只取 `proxies`（`src/parsers/clash.ts:13`），输出仍是上面的固定 7 条；`output contains DOMA,: false`、`output contains input group EVIL: false`、`output contains input rule example.org: false`。即使攻击者想注入 `DOMA`，也没有进入输出的通道。

4. **精确规则类型检查通过。** 对输出做 `yaml.load`，规则类型为 `["DOMAIN-SUFFIX","IP-CIDR","IP-CIDR","IP-CIDR","IP-CIDR","GEOIP","MATCH"]`；`ruleTypes.includes("DOMA") === false`，没有任何 `/^DOMA,/` 行（I1/I2/I3）。

### 4.2 一个容易误判的点

直接对输出做 `body.includes("DOMA")` 会得到 `true`，因为 `DOMAIN-SUFFIX` 包含子串 `DOMA`。这是**子串误报**，不是规则类型 `DOMA`。正确检查应是：解析 YAML 后取每条规则的第一段，或匹配 `/^DOMA,/m`。本报告用后两者，结论为 false。

### 4.3 什么情况下这个结论会改变

- 如果以后增加 `/getruleset`、外部 `ruleset=`、模板或用户自定义规则，并且把用户输入的规则类型直接拼进输出，就可能出现 `DOMA`。当前没有这些功能（`src/index.ts:14-23`、`:36-38`）。
- 如果增加规则功能，建议像 tindy 一样先做类型白名单（`ruleconvert.cpp:12-18`、`:173`、`:244`、`:509`），并对生成结果做 schema 校验 + 客户端 `-t` 测试。
- 节点**名称**叫 `DOMA` 是可能的：它会出现在 `proxies`/`proxy-groups` 里，但那是节点名，不是规则类型；YAML 引号会保证它是字符串。它不会进入 `rules:`。

**结论：`DOMA` 不在当前实现的可能输出集合中；当前更现实的“非法”问题是端口 NaN、重复名/保留名、目标不支持的协议，而不是规则类型截断。**

### 4.4 对“规则很多、要避免 DOMA”的迁移任务意味着什么

- **不能把 dianbanjiu 当成规则场景的可用替代。** 它的 `parseClashYaml` 只取 `proxies`（`src/parsers/clash.ts:13`），输出规则永远是 `src/converters/clash.ts:217-225` 的 7 条。用户配置里 `rules[20674]` 这种规模的规则会被整体丢弃；转换结果看似“没有 DOMA”，但业务规则也全没了。
- **它“不会产出 DOMA”是“没有规则输出能力”的副产品，不是“修好了规则类型”。** 一旦迁移实现补上规则管线（`config=`、`ruleset=`、`/getruleset`、模板透传等），`DOMA` 这类问题就会重新成为风险点。tindy 至少有规则类型白名单（`ruleconvert.cpp:12-18`、`:173`、`:244`、`:509`）；dianbanjiu 没有任何对应代码。
- **建议的验收方式**（比“参考实现不产出 DOMA”更贴近真实需求）：构造 20,000+ 条规则的输入，在第 20674 条（0 基）注入 `DOMA,example.com` 和一条截断的 `DOMA`；断言非法规则被拦截/告警且其余合法规则保留；再用 YAML 解析回读 + 规则类型白名单 + mihomo `-t` 三重校验。这个测试在 dianbanjiu 上会直接失败，因为它根本不保留输入规则。
- **规则集下载/截断风险**：即使类型白名单正确，如果规则集下载被截断、HTML 错误页被当规则、行被截断成 `DOMA`，仍可能产生非法规则。迁移实现应在规则入口做“响应类型/大小/行完整性/类型白名单/空行/注释”校验，而不是只修类型枚举。这一点是 tindy 规则转换路径的教训，不是 dianbanjiu 已解决的问题。

---

## 5. 值得借鉴的设计思路（只借鉴思路，不复制代码）

> 下面只列“可以学什么”，不复制 dianbanjiu 或 tindy 的代码；tindy 是 GPL-3.0，若复制其实现需遵守 GPL。

1. **统一节点 IR（中间表示）**：`src/types.ts:4-111` 把 7 种协议抽象成 `ProxyNode`，parser 只负责“输入 → IR”，converter 只负责“IR → 输出”。这是整个项目最值得借鉴的结构；扩展新协议/新目标时不会互相污染。建议补上 `zod`/`valibot` 之类的运行时 schema，把 `any` 换成解析后的窄类型。
2. **转换器适配器 + target 白名单**：`src/converters/index.ts:13-53` 用 `switch` + `isValidTarget` 做分发。思路正确；建议把“target 支持哪些协议”也做成能力矩阵（类似 tindy 的 `fdn`，`README-cn.md:336`），在转换前过滤/报错，而不是把不支持的类型写进配置。
3. **鉴权来源分层**：KV 单键（O(1) 查询）→ KV 列表 → env 兜底（`src/auth.ts:21-46`），并统一支持 `Bearer`/`Token`。这个“快路径 + 兜底”的分层值得借鉴；但要改成存哈希、强制最小长度、加 per-key 元数据/撤销。
4. **抓取层的双层大小限制**：先看 `Content-Length`，再用流式读取硬上限（`src/fetcher.ts:44-91`）。这个模式很适合 Worker/边缘函数；建议再加 `AbortSignal.timeout()`、重定向逐跳校验、`Content-Type` 允许列表和输出大小上限。
5. **CIDR 表驱动的 URL guard**：`src/utils/url-guard.ts:12-25` 用 CIDR 表而不是零散正则，思路比“字符串黑名单”好。应保留“表驱动”，但必须用真正的 IP 解析库（IPv4/IPv6）、DNS 解析后的地址、重定向逐跳复检、IDNA/末尾点归一化。
6. **Header 优先的前端交互**：默认勾选 `Authorization`、生成 URL 不含密钥、单独给出 Header 文本（`public/index.html:248-251`、`:472-480`），比把密钥放 `?pass=` 安全得多。这个 UX 思路值得借鉴；同时要避免把原始订阅 URL 持久化到 localStorage，或在 UI 明确告知。
7. **状态码语义化**：400（参数/URL 非法）、401（鉴权）、405（方法）、413（上游过大）、422（无节点）、502（上游失败）分工清楚（`README.md:43-52`、`src/index.ts:30-96`）。这是小而清晰 API 的好例子；建议补 504（超时）和 429（限流）。
8. **最小化健康检查**：`/api/health` 只返回 `ok`，不泄露 target/版本（`src/index.ts:17-23`），减少指纹。这个思路可以保留；但 `X-Node-Count` 等头也会泄露信息，需要一起评估。
9. **外部配置/规则集/模板的思路**（来自 tindy，不是 dianbanjiu）：把“节点转换”和“配置生成”分开，允许 `config=`、`proxy_group`、`ruleset`、模板（`README-cn.md:316`、`:871-990`、`:1056`）。这是 subconverter 真正有用的部分；dianbanjiu 目前完全缺失。可以借鉴“配置与转换解耦”的架构，但不要直接复制 GPL 代码/规则文件。
10. **规则类型白名单**（来自 tindy）：生成前用显式集合校验规则类型（`ruleconvert.cpp:12-18`、`:173`、`:244`、`:509`），是防止 `DOMA` 这类问题的正确方法。dianbanjiu 若加规则功能，应直接采用“白名单 + schema + golden test”。
11. **测试策略**：建议建立三类测试——(a) 真实订阅样本 golden test（7 协议 × 5 target）；(b) 属性/往返测试（URI → IR → URI 字段保持，已知丢失项显式标注）；(c) 安全测试（SSRF 主机矩阵、重定向、超时、5MB 边界、YAML/JSON schema、重复名/保留名/端口边界）。用 mihomo/sing-box 二进制做 CI 中的 `-t`/`check`，比只做类型检查可靠得多。

## 6. 风险清单与优先级

| ID | 风险 | 等级 | 关键证据 | 建议 |
| --- | --- | --- | --- | --- |
| R1 | SSRF guard 可被 DNS/末尾点/重定向绕过，Worker 可被用作访问回环/内网的跳板 | **高**（在本地 workerd 已实测；生产 Cloudflare egress 未验证） | `url-guard.ts:2`、`:57-62`、`:106-119`；`fetcher.ts:30`；tests-network L2-L5；live workerd | 解析 DNS 后校验 IP；禁止或逐跳复检重定向；补全 IPv4/IPv6 特殊段；用 IP 字面量做最终连接校验 |
| R2 | 无应用层超时，慢上游可长期占用请求 | 中高 | `fetcher.ts:28-32`；L6 `STILL-PENDING-AFTER-2s` | `AbortSignal.timeout(10-15s)`；上游超时映射 504 |
| R3 | `js-yaml@4.1.1` 的 merge/omap 二次复杂度 DoS | **高**（公开服务） | `package-lock.json:1237-1244`；`parsers/clash.ts:8`；OSV 4 条；merge-chain 1,585ms@162KB | 升级到 >=4.3.2；限制 merge keys/节点数；输入 CPU 预算 |
| R4 | 生成语义非法/客户端不可用配置（NaN 端口、重复名、保留名冲突、kcp 无 transport） | 中 | `parsers/uri.ts:64`、`converters/clash.ts:27`、`:173-181`、`:202-215`；`singbox.ts:5-9`、`:44-46`；D1-D8/C1-C4/N4/N8 | 运行时 schema + 端口 1-65535 + 名称去重含保留名 + 目标能力过滤 |
| R5 | Worker 日志记录完整订阅 URL/URI（含 token/密码） | 中 | `fetcher.ts:40`；`parsers/uri.ts:31` | 日志脱敏（只留 host/路径 hash）；禁止打印原始 URL/URI |
| R6 | 1 字符密钥可用；KV 以明文 key 名存密钥 | 中 | `auth.ts:18-19`、`:24`；G1；`README.md:93` | 强制最小长度/熵；存 SHA-256 哈希；按 key id 撤销；限速 |
| R7 | README 说 KV 占位符，实际是真实 namespace id；commit 标题与 diff 不符 | 低（KV ID 非密钥） | `wrangler.toml:17`；`README.md:76`、`:84`；`git show 5f27400 -- wrangler.toml` | 真正改成占位符；或明确写“示例 id，部署前替换” |
| R8 | 无测试/CI/安全回归 | 中 | `package.json:7-10`；`git ls-files` 无 test/.github | 建 golden/属性/安全测试；CI 跑 typecheck + 客户端 check |
| R9 | 前端把原始订阅 URL（含 token）持久化到 localStorage | 中（共用设备/隐私） | `public/index.html:334-338`、`:377-379`、`:526-528` | 不持久化 `url`，或明确告知/提供清除；默认 session 级 |
| R10 | `target=clash` 写入原版 Clash 不支持的 vless/hysteria2/tuic/reality | 中 | `converters/index.ts:15-21`；`converters/clash.ts:43-68`、`:116-149`；M1/M3 | 按 target 能力过滤；拆分 `clash`/`clash-meta`；或文档明确“仅 Mihomo” |
| R11 | 无内置速率限制，KV 读放大 | 中 | `auth.ts:21-46`；`README.md:123-131` | WAF + 代码级按 key/IP 限速；缓存密钥列表 |
| R12 | 上游订阅内容可能被边缘缓存 60s；`Subscription-Userinfo`/`X-Node-Count` 暴露元数据 | 低 | `fetcher.ts:31`；`index.ts:87`、`:91` | 明确缓存策略；敏感头按需关闭 |
| R13 | 输入 5MB 但输出/节点数无上限 | 中 | `fetcher.ts:5-6`；`converters/*` 无 cap | 节点数/输出字节上限；超限 413/422 |
| R14 | 若复制 tindy 的 GPL 代码/规则/模板，MIT 分发会冲突 | 低/法律 | tindy `LICENSE:1-2`；dianbanjiu `LICENSE:1` | 只借鉴思路；如移植 GPL 内容，整体按 GPL 分发或取得许可 |
| R15 | 运行时校验缺失（18 处 `any`；字段无枚举/范围） | 中 | `grep -rn ": any..." src`；`parsers/clash.ts:6`、`:13`、`:23`；`parsers/uri.ts:53` | zod/valibot schema；所有协议字段枚举/范围校验 |

**如果只修三件事**：R3（升级 js-yaml + 输入限制）、R1（DNS/重定向 SSRF）、R4（端口/名称/目标能力校验）。这三项直接决定“能不能安全地公开跑”和“生成的配置能不能用”。

---

## 7. 未验证、无法验证或未运行的事项

以下事项**没有**在本会话中完成，不应被报告为“通过”：

1. **没有部署到真实 Cloudflare 账户**，没有测试一键部署按钮、真实 KV namespace 创建、真实 workers.dev 路由。`wrangler deploy --dry-run` 只验证了打包，不验证账户权限/绑定。
2. **没有验证生产 Cloudflare 的 egress 是否会阻断回环/私网**。本地 `wrangler dev --local`（Miniflare/workerd）已实测 SSRF 绕过；生产网层可能有额外保护。`url-guard.ts:2` 作者也承认“通常不可达内网”。因此 R1 的生产影响应标注为“取决于平台兜底，代码层防护不成立”。
3. **没有使用真实机场/公网订阅**，所有上游都是本地 HTTP 服务（`127.0.0.1:8801`、`localtest.me`、`127.0.0.1:8802` 重定向器）。真实订阅的反爬、TLS、重定向链未覆盖。
4. **没有用 mihomo/sing-box 二进制做客户端校验**。我尝试下载 mihomo Windows amd64 包，`curl` 在 120 秒时超时：`curl: (28) Operation timed out after 120000 milliseconds with 6367511 out of 22543546 bytes received`。因此 `port: .nan`、重复 proxy 名、`network: kcp` 等是否被具体客户端拒绝，只有 schema/语义推断，没有 `mihomo -t`/`sing-box check` 输出。sing-box 包没有下载。
5. **没有在真实浏览器中执行前端 JS**。前端结论来自静态审查 + Worker 返回的 18,578 字节 HTML；没有用 Playwright/浏览器验证 localStorage 行为、复制按钮、Clash 一键导入。`public/index.html:339` 的 `sessionStorage` 异常路径也未在禁用 storage 的浏览器中复现。
6. **没有构建/运行 tindy**。tindy 对比只基于浅克隆源码和 README，没有编译 C++、没有跑它的 `/sub` 输出做逐字节对比。tindy 的 `ProxyType`/规则白名单行号来自 `a0d4eab` 快照。
7. **`npm audit` 没有成功运行**。当前 registry `registry.npmmirror.com` 不支持 audit bulk endpoint，返回 404 `[NOT_IMPLEMENTED]`，退出 1。我改用 OSV API 查询 `js-yaml`；这不是 `npm audit` 的等价结果，其他依赖的漏洞没有用 npm audit 覆盖。
8. **没有测试套件可跑**。仓库没有 test 脚本/测试文件；我只跑了 `npm run typecheck` 和 `wrangler deploy --dry-run`。因此“测试缺失”本身是审计结论，不是“测试失败”。
9. **没有做完整的 secret 熵扫描/二进制历史扫描**。我用 `git grep` 查了常见 token 模式（`sk-`、`ghp_`、`AKIA`、`BEGIN PRIVATE KEY` 等）在 8 个提交中均无命中；这不等于“绝对没有密钥”，只是没有发现匹配模式。
10. **没有做 fuzzing/覆盖率**。解析器对畸形 IPv6、超长 URI、极端 YAML/JSON 的鲁棒性只做了少量手工用例（控制字符、surrogate、深嵌套、alias/merge 炸弹），没有系统 fuzz。
11. **GitHub API 元数据是 2026-11-09 的快照**；star/fork/issue 数会变化，commit `01fbd67` 是审计时的 HEAD。

---

## 附录 A：复现命令与关键输出

> 测试脚本放在仓库外的 `/tmp/audit-tools/`（Windows 路径 `C:\Users\admin\AppData\Local\Temp\audit-tools\`），没有写入被审仓库；被审仓库 `git status --short` 为空。

### A.1 克隆与仓库事实

```bash
git clone https://github.com/dianbanjiu/subconverter.git /tmp/audit-subconverter/repo
cd /tmp/audit-subconverter/repo
git rev-parse HEAD
# 01fbd67633c34f9924a9c7488e1a1cc02ef69610
git rev-list --count HEAD
# 8
git log --format='%h | %ad | %an | %s' --date=iso
# 01fbd67 | 2026-05-24 21:40:16 +0800 | dianbanjiu | Add MIT License to the project
# ...（见 0.1 表）
git ls-files | wc -l
# 21（含 LICENSE/.gitignore/README/package-lock/public/index.html/13 个 src TS/wrangler.toml 等）
```

### A.2 依赖、类型检查、构建

```bash
cd /tmp/audit-subconverter/repo
npm ci --ignore-scripts --no-audit --no-fund
# added 63 packages
npm run typecheck
# > tsc --noEmit
# TYPECHECK_EXIT=0
npx wrangler deploy --dry-run --outdir /tmp/audit-tools/wrangler-dist
# Total Upload: 155.13 KiB / gzip: 34.96 KiB
# - KV Namespaces: AUTH_KV: e56bd26ac5cc4e09a54d78982b68d96e
# - Vars: DEFAULT_UA: "ClashforWindows/0.20.39"
# --dry-run: exiting now.
# WRANGLER_EXIT=0
```

### A.3 解析/转换/鉴权/SSRF/大小测试

测试 harness 复制源码后校验一致：

```bash
cp -r /tmp/audit-subconverter/repo/src /tmp/audit-tools/src
sha256sum /tmp/audit-tools/src/parsers/uri.ts /tmp/audit-subconverter/repo/src/parsers/uri.ts
# 两个哈希相同：a6e91042be43064a20308246792de0d71a337ad247b367ff6fe90e5f44199096
cd /tmp/audit-tools
node --experimental-strip-types --loader ./loader.mjs tests-core.mjs
node --experimental-strip-types --loader ./loader.mjs tests-extra.mjs
node --experimental-strip-types --loader ./loader.mjs tests-network.mjs
node --experimental-strip-types --loader ./loader.mjs tests-dos.mjs
node --experimental-strip-types --loader ./loader.mjs tests-e2e.mjs
node --experimental-strip-types --loader ./loader.mjs tests-e2e2.mjs
node --experimental-strip-types --loader ./loader.mjs tests-more.mjs
node --experimental-strip-types --loader ./loader.mjs tests-drop.mjs
node --experimental-strip-types --loader ./loader.mjs tests-targets.mjs
node --experimental-strip-types --loader ./loader.mjs tests-doma.mjs
node --experimental-strip-types --loader ./loader.mjs tests-ipv6.mjs
node --experimental-strip-types --loader ./loader.mjs tests-weird.mjs
```

关键输出（详见正文）：7/7 协议解析；7/7 条 URI 能重新解析（**不等于字段无损**，`mport`/`allowInsecure`/SS plugin 等见 2.4）；`port: .nan` / `server_port: null`；`dedupNames` 输出 `["a","a #2","a #2"]`；`PROXY`/`AUTO`/`direct` 冲突；6MB→413、5MB 通过；`localtest.me` 接受；`localhost.`/`foo.local.`/`127.0.0.1.nip.io` 接受；`STILL-PENDING-AFTER-2s`；DOMA 输入被丢弃；`ruleTypes.includes("DOMA")===false`。

### A.4 本地 workerd 端到端

```bash
# 终端 1：本地订阅（2 节点，Base64）
cd /tmp/audit-tools/www && python -m http.server 8801 --bind 127.0.0.1
# 终端 2：302 重定向器
cd /tmp/audit-tools && node -e "...listen(8802,'127.0.0.1')..."
# 终端 3：Worker
cd /tmp/audit-subconverter/repo
npx wrangler dev --local --port 8899 --var STATIC_KEYS:testkey --var ALLOW_HTTP_SUBSCRIPTION:true
# Ready on http://127.0.0.1:8899
# 终端 4：
curl -sS --noproxy '*' http://127.0.0.1:8899/api/health
# ok
curl -sS --noproxy '*' -H "Authorization: Bearer testkey" \
  "http://127.0.0.1:8899/api/sub?url=http%3A%2F%2Flocaltest.me%3A8801%2Fsub.txt&target=clash"
# 200; Content-Type: text/yaml; X-Node-Count: 2; 1,429 bytes
curl -sS --noproxy '*' -H "Authorization: Bearer testkey" \
  "http://127.0.0.1:8899/api/sub?url=http%3A%2F%2Flocaltest.me%3A8802%2Fredir&target=uri"
# 200; X-Node-Count: 2; 388 bytes（302 -> 127.0.0.1:8801）
```

### A.5 依赖漏洞查询

```bash
curl -sS -X POST https://api.osv.dev/v1/query -H 'Content-Type: application/json' \
  -d '{"package":{"name":"js-yaml","ecosystem":"npm"},"version":"4.1.1"}'
# vulns 4：
# GHSA-2883-xcg3-v3hh, GHSA-52cp-r559-cp3m,
# GHSA-5p4m-2wfm-xmqj, GHSA-h67p-54hq-rp68
```

`npm audit` 失败原文：

```
npm warn audit 404 Not Found - POST https://registry.npmmirror.com/-/npm/v1/security/advisories/bulk
[NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet
npm error audit endpoint returned an error
AUDIT_EXIT=1
```

### A.6 mihomo 客户端校验尝试（未完成）

```bash
curl -sS -L -m 120 -o mihomo.zip \
  https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33/mihomo-windows-amd64-compatible-v1.19.33.zip
# curl: (28) Operation timed out after 120000 milliseconds with 6367511 out of 22543546 bytes received
```

因此没有 `mihomo -t -f config.yaml` 的结果；这是第 7 节列出的未验证项，不是通过项。

---

## 附录 B：关键证据索引

| 结论 | 主要证据 |
| --- | --- |
| 基础转换真实可用 | `src/index.ts:14-96`、`src/parsers/uri.ts:17-278`、`src/converters/*`；本地 workerd 200/1,429 字节/2 节点 |
| `clash` 与 `clash-meta` 同物 | `src/converters/index.ts:15-21`；M1 `true` |
| `target=clash` 写入不支持协议 | `src/converters/clash.ts:43-68`、`:116-149`；M3 |
| SSRF 字面量校验/重定向 | `src/utils/url-guard.ts:2`、`:57-62`、`:106-119`；`src/fetcher.ts:30`；L2-L5；live workerd |
| 无超时 | `src/fetcher.ts:28-32`；L6 `STILL-PENDING-AFTER-2s` |
| 5MB 上限有效 | `src/fetcher.ts:44-91`；L7 413 / L8 5MB 通过 |
| js-yaml DoS | `package-lock.json:1237-1244`；`src/parsers/clash.ts:8`；OSV 4 条；merge-chain 1,585ms@162KB |
| 非法端口/配置 | `src/parsers/uri.ts:64`、`src/converters/clash.ts:27`、`src/converters/singbox.ts:63`；D1-D8 |
| 重复名/保留名 | `src/converters/clash.ts:173-181`、`:202-215`；`src/converters/singbox.ts:5-9`、`:44-46`；C1-C4/N4 |
| 规则输入被丢弃 | `src/parsers/clash.ts:13`；tests-doma |
| DOMA 不可产出 | `src/converters/clash.ts:217-225`；`git grep '"DOMA'`；I1/I2 |
| KV 占位符矛盾 | `wrangler.toml:17`；`README.md:76`、`:84`；`git show 5f27400 -- wrangler.toml` |
| 最小长度校验不成立 | `src/auth.ts:18-19`；G1 |
| “其它协议都有覆盖”不成立 | `README.md:229`；`src/parsers/clash.ts:168-169`；7→2 实测 |
| 日志泄露订阅 URL | `src/fetcher.ts:40`；`src/parsers/uri.ts:31` |
| 前端持久化订阅 URL | `public/index.html:334-338`、`:377-379`、`:526-528` |
| tindy 功能面/GPL | `tindy/README.md:24-40`、`README-cn.md:120-140`、`:313-342`、`:871-990`、`:1427-1445`；`LICENSE:1-2`；`proxy.h:12-27` |
