# tindy2013/subconverter 行为取证（用于 Cloudflare Worker 迁移）

> 取证对象：`tindy2013/subconverter` master
> commit：`a0d4eab28cb8b6c782d4ce5c3a918de4829b4a72`（2026-07-08，"chore: update build script…"）
> 版本号：`src/version.h:4` → `#define VERSION "v0.9.0"`
> 取证日期：2026-11-09

本文回答“原版到底怎么行为”，不设计新实现。每条结论尽量给出 `文件:行` 或 URL。
标注约定：

- **【证实】**：直接读到的源码 / 官方 README / issue 原文。
- **【推断】**：由源码推导、但本次未编译运行验证。
- **【未验证】**：本次无法执行或无法访问的材料。

**关于题目中给出的文件路径**：本仓库该版本**不存在** `src/interfaces.cpp`、`src/handler.cpp`、`src/parser.cpp`、`src/ruleset.cpp`、`docs/` 目录。实际对应关系为：

| 题目假设的路径 | 实际路径 |
| --- | --- |
| `src/interfaces.cpp` | `src/handler/interfaces.cpp`（1574 行） |
| `src/handler.cpp` | `src/handler/{webget,settings,multithread,upload}.cpp` |
| `src/parser.cpp` | `src/parser/subparser.cpp`（2665 行）+ `src/parser/infoparser.cpp` |
| `src/ruleset.cpp` | `src/generator/config/ruleconvert.cpp` + `src/config/ruleset.h` |
| `src/config/` | `src/config/*.h`（只有头文件） |
| `docs/` | 无；文档是根目录 `README-cn.md`（1445 行）与 `base/pref.example.*` |

---

## 0. 取证方法与可达性（重要）

| 项目 | 结果 |
| --- | --- |
| `https://github.com/` | `curl -o /dev/null -w '%{http_code}'` → `HTTP 200`（命令：`curl -sS -m 20 -o /dev/null -w "github.com HTTP %{http_code}\n" https://github.com/`） |
| `https://raw.githubusercontent.com/...master/README.md` | **超时**：`curl: (28) Operation timed out after 25011 milliseconds with 0 bytes received` |
| `https://codeload.github.com/...` | `HTTP 200` |
| 采取的替代方案 | 下载整包源码：`curl -sSL -m 180 -o subconverter.tar.gz https://codeload.github.com/tindy2013/subconverter/tar.gz/refs/heads/master` → 1,067,503 字节；`tar -xzf` 后 508 个文件 |
| GitHub API | 可用（`api.github.com/repos/tindy2013/subconverter/commits/master` 返回 commit sha 与日期） |
| 编译 / 运行二进制 | **未执行**。本机为 win32 + Git Bash，未安装 C++ 工具链；也未下载官方 release 二进制（避免运行未审计的可执行文件）。因此所有“运行时行为”均是静态阅读结论。 |
| Wiki | `https://github.com/tindy2013/subconverter/wiki` 返回 302；本次未跟进抓取内容（【未验证】）。README-cn.md 是唯一随仓库发布的规范文档。 |

> 下文所有 `src/...:行号` 均来自上述 commit 的源码快照。为便于复核，文末给出“……在 GitHub 上对应位置”的路径索引。
> 注意：`src/...:行号` 中的行号是本快照行号，GitHub 页面同 commit 行号应当一致。

---

## 1. HTTP API

### 1.1 真实路由表（先纠正一个前提）

题目假设存在 `/clash`、`/surge` 端点。**不成立**：路由在 `src/main.cpp:187-289` 注册，全集如下。

| 方法 | 路径 | 处理函数 | Content-Type | 代码 |
| --- | --- | --- | --- | --- |
| GET | `/version` | 匿名 lambda | `text/plain` | `src/main.cpp:187-190` |
| GET | `/refreshrules` | 匿名 lambda | `text/plain` | `src/main.cpp:192-205` |
| GET | `/readconf` | 匿名 lambda | `text/plain` | `src/main.cpp:207-222` |
| POST | `/updateconf` | 匿名 lambda | `text/plain` | `src/main.cpp:224-250` |
| GET | `/flushcache` | 匿名 lambda | `text/plain` | `src/main.cpp:252-261` |
| GET | `/sub` | `subconverter` | `text/plain;charset=utf-8` | `src/main.cpp:263` |
| HEAD | `/sub` | `subconverter` | `text/plain` | `src/main.cpp:265` |
| GET | `/sub2clashr` | `simpleToClashR` | `text/plain;charset=utf-8` | `src/main.cpp:267` |
| GET | `/surge2clash` | `surgeConfToClash` | `text/plain;charset=utf-8` | `src/main.cpp:269` |
| GET | `/getruleset` | `getRuleset` | `text/plain;charset=utf-8` | `src/main.cpp:271` |
| GET | `/getprofile` | `getProfile` | `text/plain;charset=utf-8` | `src/main.cpp:273` |
| GET | `/render` | `renderTemplate` | `text/plain;charset=utf-8` | `src/main.cpp:275` |
| GET | `/get` | 匿名 lambda（**仅非 API 模式**） | `text/plain;charset=utf-8` | `src/main.cpp:277-284` |
| GET | `/getlocal` | 匿名 lambda（**仅非 API 模式**） | `text/plain;charset=utf-8` | `src/main.cpp:285-288` |

补充事实：

- `/`（根路径）的路由**被注释掉了**（`src/main.cpp:180-185`），访问 `/` 返回 404。
- `/clash`、`/surge`、`/v`、`/ss`、`/ssr`… 全部是 **pref 里的别名（302 重定向）**，不是独立端点：
  `base/pref.example.ini:244-259` 定义 `/v=/version`、`/clash=/sub?target=clash`、`/clashr=/sub?target=clashr`、`/surge=/sub?target=surge`、`/quan`、`/quanx`、`/mellow`、`/surfboard`、`/loon`、`/singbox`、`/ss`、`/ssd`、`/sssub`、`/ssr`、`/v2ray`、`/trojan`。
  重定向实现：`src/server/webserver_httplib.cpp:176-193`，把请求的 query 逐项 `urlEncode` 后拼到目标 URL 上，然后 `set_redirect`（302）。
  【推断】因此 `/clash?url=x` 等价于 `/sub?target=clash&url=x`；别名只在配置了 `[aliases]` 时存在，**不是内置路由**。
- HTTP 后端：`CMakeLists.txt:49-50` 只编译 `src/server/webserver_httplib.cpp`（libevent 实现整段被注释），即 cpp-httplib。
- 参数来源：`req.argument = request.params`（`src/server/webserver_httplib.cpp:52`），即 query string；POST/PUT/PATCH 额外读 body 到 `req.postdata`（同文件 53-67；`application/x-www-form-urlencoded` 会先 `urlDecode`）。
- 请求头转发：除 `host`、`accept`、`accept-encoding` 与 `LOCAL_*`/`REMOTE_*` 外全部转发给上游（`src/server/webserver_httplib.cpp:15-27,42-51`）。

### 1.2 query 解析的三个硬性细节（影响兼容性）

1. **无值参数等于没传**：`?expand` 解析为 `("expand","")`；`tribool("")` 落到 `indeterminate`，随后 `define()` 回落到配置文件默认值（`src/utils/tribool.h:71-97`；httplib 解析见 `include/httplib.h` `parse_query_text`）。所以 `?emoji` 不会开启 emoji，必须 `?emoji=true`。
2. **`+` 在 query 里被解码成空格**：httplib `parse_query_text` 调 `decode_url(key, true)`，`+`→空格。因此标准 Base64（含 `+`/`/`）作为参数值必须二次 URL 编码；`urlSafeBase64`（`-`/`_`）才安全。
3. **完全相同的 `k=v` 去重**：`parse_query_text` 用 `std::set` 缓存原始 `k=v` 文本，重复的同一串只保留一次；不同值则都保留，`getUrlArg` 取 multimap 中第一个（`src/utils/string.cpp:296-303`）【推断：multimap 等价键的取用顺序依赖实现，libstdc++ 为最早插入】。

### 1.3 `/sub` 参数矩阵

`subconverter()` 入口 `src/handler/interfaces.cpp:302`。默认值一列的含义：`global.*` 是**配置文件**（pref）里的值，见 §4.1 的“编译期默认 vs 示例配置”差异表。

| 参数 | 类型 | 默认 | 语义 / 备注 | 代码 |
| --- | --- | --- | --- | --- |
| `target` | string | 无（必填） | 取值见 §1.4；`auto` 走 UA 匹配 | `:307-325` |
| `ver` | int | `3` | 仅 surge 用；同时写入模板变量 `request.ver` | `:307-309,:397` |
| `new_name` | tribool | `global.clashUseNewField` | Clash 新旧字段名 | `:308,:427` |
| `url` | string | `global.defaultUrls` | `\|` 分隔多条；每项可为 URL / data URI / 本地路径 / `tag:组名,链接` / `script:脚本` / `nullnode` | `:331,:366-367,:640` |
| `group` | string | `""` | 把本次**所有**节点 Group 强制改成该值 | `:332,:731-733` |
| `config` | url/path | `global.defaultExtConfig` | 外部配置（分组+规则） | `:334,:444-446` |
| `upload_path` | string | `""` | Gist 文件名 | `:332` |
| `upload` | tribool | `false`（只认显式 true） | 上传 Gist | `:339,:782` |
| `include` | regex | `global.includeRemarks` | 只保留匹配节点；可用 `` ` `` 分隔多条；逐条 `regValid` 校验，无效条目被丢弃（全无效则保留原配置） | `:333,:534-559` |
| `exclude` | regex | `global.excludeRemarks` | 排除匹配节点，同上 | `:333,:560-585` |
| `groups` | urlsafe-B64 | `""` | 解 base64 后按 `@` 拆成多行 `custom_proxy_group` 语法 | `:334,:495-497` |
| `ruleset` | urlsafe-B64 | `""` | 解 base64 后按 `@` 拆成多行 `ruleset=` 语法 | `:334,:502-504` |
| `rename` | string | `""` | 按 `` ` `` 拆多条，每条 `pattern@replacement` | `:336,:528-529` |
| `filter_script` | string | `global.filterScript` | JS 过滤；**仅 authorized 时生效**（APIMode 下必须带正确 token） | `:336,:686-688` |
| `sort` | tribool | `global.enableSort` | 按 remark 排序 | `:341,:422` |
| `sort_script` | tribool | 由 `global.sortScript` 非空决定 | 只是“是否启用配置里的排序脚本”的开关 | `:341,:423-425` |
| `list` | tribool | `false` | 输出节点清单（Clash provider / Surge 节点列表 / 解码后的 SIP002） | `:340,:435,:591-597` |
| `script` | tribool | `false` | 生成 Clash Script（Python 规则脚本） | `:342,:428` |
| `insert` | tribool | `global.enableInsert` | 是否插入 `insert_url` | `:342,:365` |
| `prepend` | tribool | `global.prependInsert` | 插入节点放在前面 | `:344,:674` |
| `scv` | tribool | `global.skipCertVerify` | skip-cert-verify | `:343,:419` |
| `tfo` / `udp` / `tls13` | tribool | `global.TFOFlag` / `UDPFlag` / `TLS13Flag` | 节点开关 | `:340-344,:417-420` |
| `fdn` | tribool | `global.filterDeprecated` | 过滤目标不支持的节点 | `:343,:426` |
| `expand` | tribool | **clash/clashr 时被强制 `true`** | 是否把规则全文展开；`false` 生成 rule-providers / RULE-SET 引用 | `:343,:410-411` |
| `append_type` | tribool | `global.appendType` | 节点名前加 `[SS]` 等 | `:340,:409` |
| `append_info` | tribool | `global.appendUserinfo` | 输出 `Subscription-UserInfo` 头 | `:343,:668-669` |
| `emoji` | tribool | — | 一次设置：add_emoji=true、remove_emoji=true | `:339,:519-523` |
| `add_emoji` / `remove_emoji` | tribool | `global.addEmoji` / `global.removeEmoji` | 前缀 emoji / 去旧 emoji | `:339,:524-525` |
| `dev_id` | string | `global.quanXDevID` | QuantumultX 设备 ID | `:335,:437` |
| `filename` | string | `""` | 设 `Content-Disposition` | `:335,:960-961` |
| `interval` | int | `global.updateInterval` | 秒；Clash 响应头与 Surge MANAGED-CONFIG 用 | `:335,:353` |
| `strict` | bool | `global.updateStrict` | `interval` 后强制更新（Surge 头） | `:335,:354` |
| `token` | string | `""` | APIMode 下等于 `global.accessToken` 才 authorized | `:354` |
| `profile_data` | base64 | `""` | 覆盖生成的 MANAGED-CONFIG 里的自身 URL | `:754-756` |

`tribool` 解析规则（`src/utils/tribool.h:71-97`）：`"true"`/`"1"` → true；`"false"`/`"0"` → false；**其他任何字符串 → indeterminate**（不报错，直接回落默认）。

黑名单：`include`/`exclude` 的原始值若**完全等于** `(.*)*` 直接返回 `Invalid request!`（`src/handler/interfaces.cpp:34,356-357`）。

### 1.4 `target` 各取值的含义

`src/handler/interfaces.cpp:313-325` 用 `hash_()` 分派，合法值只有 15 个（+ `auto`）：

| target | 是否“简单订阅” | 生成函数 | 输出形态 |
| --- | --- | --- | --- |
| `clash` | 否 | `proxyToClash` | Clash YAML |
| `clashr` | 否 | `proxyToClash(..., clashR=true)` | ClashR YAML（SSR 用 `protocolparam`/`obfsparam` 旧字段名） |
| `surge` | 否 | `proxyToSurge(ver)` | Surge INI |
| `surfboard` | 否 | `proxyToSurge(-3)` | Surfboard INI |
| `loon` | 否 | `proxyToLoon` | Loon INI |
| `quan` | 否 | `proxyToQuan` | Quantumult INI |
| `quanx` | 否 | `proxyToQuanX` | Quantumult X INI |
| `mellow` | 否 | `proxyToMellow` | Mellow INI |
| `singbox` | 否 | `proxyToSingBox` | sing-box JSON |
| `ss` | **是** | `proxyToSingle(nodes,1)` | 仅 SS 单链接，整体 Base64 |
| `ssr` | 是 | `proxyToSingle(nodes,2)` | 仅 SSR 单链接，Base64 |
| `v2ray` | 是 | `proxyToSingle(nodes,4)` | 仅 VMess 单链接，Base64 |
| `trojan` | 是 | `proxyToSingle(nodes,8)` | 仅 Trojan 单链接，Base64 |
| `mixed` | 是 | `proxyToSingle(nodes,15)` | SS+SSR+VMess+Trojan，Base64 |
| `ssd` | 是 | `proxyToSSD` | SSD JSON（`airport`/`servers`） |
| `sssub` | 是 | `proxyToSSSub` | SIP008 JSON（`{version,servers[]}`） |
| `auto` | — | 先按 UA 改写 target | 见下 |

- “简单订阅”= `lSimpleSubscription`（`:314-319`）：这类 target **不加载分组、不加载规则集**（`interfaces.cpp:456-474,490-517`），只做节点转换。`ssd` 与 `sssub` 在 hash 表里被归入简单订阅集合（`:317`）。
- 非法 target：`400 Invalid target!`（`:322-325`）。switch 末尾还有一个 `500 Unrecognized target`（`:954-957`），因前面已校验，实际不可达【推断】。
- `auto`：`matchUserAgent()`（`:111-134`）用 `startsWith(User-Agent, head)` 查表（`:58-85`），命中后改写 target、`clash_new_name`、`surge_ver`。**没有命中或没有 UA 头时 target 仍是 `auto` → 400 `Invalid target!`**。
  表里关键项：`ClashForAndroid/2.0`→clash+new_name、`ClashforWindows/0.11`→clash+new_name、`ClashX/0.13`→clash+new_name、`Surge/1419`→surge+ver4、`Surge/900`→surge+ver3、`Quantumult X`→quanx、`Surfboard`→surfboard、`Loon`→loon、`Shadowrocket`→mixed、`Kitsunebi`/`Qv2ray`/`V2rayU`/`V2RayX`→v2ray、`Potatso`/`Pharos`→mixed。
- `clash`/`clashr` 的 `expand` 默认被强制 true（`:410-411`），并且只要 `expand` 为 true 就**强制关掉** `script`（`:430-433`）；反之 `expand=false` 会**强制 `new_name=true`**（`:430-431`）。

### 1.5 响应、状态码与错误文本

| 场景 | 状态码 | Body（原文） | 代码 |
| --- | --- | --- | --- |
| `/sub` 成功 | 200 | 生成内容 | `:962` |
| target 非法 | 400 | `Invalid target!` | `:324` |
| url 为空且无 insert | 400 | `Invalid request!` | `:368-372` |
| include/exclude 命中黑名单 | 200（**未改状态码**） | `Invalid request!` | `:356-357` |
| 某条订阅解析失败且未开 skip_failed_links | 400 | `The following link doesn't contain any valid node info: <url>` | `:650-659` |
| 全部无节点 | 400 | `No nodes were found!` | `:662-667` |
| `/getruleset` 参数缺失/非法/结果为空 | 400 | `Invalid request!` | `:145-149,:164-168` |
| `/getprofile` 无 token 或无 name | 403 | `Forbidden` | `:1244-1248` |
| `/getprofile` token 不匹配 | 403 | `Forbidden` | `:1289-1302` |
| `/getprofile` 文件不存在 | 404 | `Profile not found` | `:1256-1264` |
| `/getprofile` 配置损坏 | 500 | `Broken profile!` | `:1268-1285` |
| `/render` 路径越界或不存在 | 404 | `Not found` | `:1542-1546` |
| `/render` 文件为空 | 400 | `File empty or out of scope` | `:1547-1552` |
| `/flushcache` token 错 | 403 | `Forbidden` | `src/main.cpp:254-258` |
| `/refreshrules`、`/readconf`、`/updateconf` token 错 | 403 | `Forbidden\n` | `src/main.cpp:194-201,209-216,226-233` |
| `/updateconf` type 非 form/direct | 501 | `Not Implemented\n` | `src/main.cpp:240-244` |
| 上游请求带 `SubConverter-Request` 头 | 500 | `Loop request detected!` | `src/server/webserver_httplib.cpp:149-154` |
| 未捕获异常 | 500 | `Internal server error while processing request '<target>'! ...` | `src/server/webserver_httplib.cpp:194-218` |

其它响应头：

- `Server: subconverter/<VERSION> cURL/<libcurl 版本>`（`src/server/webserver_httplib.cpp:155`）。
- `profile-update-interval: <interval/3600>`，仅 clash/clashr，整数除法（`src/handler/interfaces.cpp:765`）。
- `Subscription-UserInfo: <上游头原样>`，仅当有上游头/可推算 且 `append_info != false`（`:668-669`）。
- `Content-Disposition: attachment; filename="<filename>"; filename*=utf-8''<urlEncode(filename)>`（`:960-961`）。
- 鉴权失败时 `WWW-Authenticate: Basic realm=<realm>, charset="UTF-8"` + 401 `Unauthorized`（`src/server/webserver_httplib.cpp:162-166`，需 pref `[server]` 里的 basic auth）。
- CORS：`Access-Control-Allow-Origin: *` 恒定；`OPTIONS` 返回该路径已注册方法的逗号列表（`src/server/webserver_httplib.cpp:119-142,168-173`）。

**HEAD `/sub` 的语义**：先完整解析节点（可能触发全部上游下载），随后**无论是否需要**都在 `:671-672` 直接返回空串；若算出了 `Subscription-UserInfo`，该头会在返回前写入（`:668-669`）。因此 HEAD 与 GET 消耗相同的上游流量【证实于代码顺序】。

### 1.6 `/getruleset`（详见 §5）

签名：`GET /getruleset?type=<1..6>&url=<urlsafe-base64>&group=<urlsafe-base64，type=2 必填>`。
`url` 支持 `|` 分隔多个；每个都会被冠以 `ruleset,` 前缀交给 `INIBinding::from<RulesetConfig>`，于是 `Group` 恒为字面量 `ruleset`（`src/handler/interfaces.cpp:152-156`）。
`url` 也可以是 `clash-domain:...`、`surge:...` 等带类型前缀的地址（`src/handler/settings.cpp:22-23,270-275`）。

⚠ 因为拼出来的字符串要过 `Group,URL[,Interval]` 这个解析器（`src/config/binding.h:281-305`），**`url` 里若含逗号会被截断**（`rfind(',')` 之后的内容被当成 interval，且 interval 解析失败即 0）。Base64 后的 URL 通常不含逗号，但 `data:` URI 或手工传参会踩到【证实于解析代码】。

### 1.7 其它端点要点

- `/version`：返回 `subconverter v0.9.0 backend\n`（`src/main.cpp:189`）。Content-Type `text/plain`。
- `/getprofile`：`name` 可 `|` 分隔多个 profile，逐个读取并把 `url` 用 `|` 合并、`rename`/`exclude`/`include` 用 `` ` `` 合并；随后把 `token` 与 `profile_data`（= `base64(managedConfigPrefix + "/getprofile?" + 原 query)`）塞进参数，直接调用 `subconverter()`（`src/handler/interfaces.cpp:1306-1360`）。`[Profile]` 内若有 `profile_token` 且只有一个 profile，则用它校验（`:1286-1295`）。
- `/render`：`path` 必须 `startsWith(global.templatePath)` 且文件存在，否则 404；渲染失败 400 但**仍返回错误文本**（`output` 为 `Template render failed! Reason: ...`，`src/generator/template/templates.cpp:252-256`）。
- `/updateconf`：`type=form|direct` 时把 `postdata` 整体写入 `global.prefPath`，然后 `readConf()`（`src/main.cpp:235-248`）。**这是写配置的后门，Worker 不应保留**。
- `/flushcache`：注意 `if(getUrlArg(token) != global.accessToken)`——当 `accessToken` 为空且请求不带 token 时两边都是 `""`，**等于放行**（`src/main.cpp:254`）。
- `/get`、`/getlocal`：仅 `!global.APIMode` 注册；`/getlocal` 直接 `fileGet(urlDecode(path))`（无 `scope_limit`！）（`src/main.cpp:279-288`）。

---

## 2. 输入：支持的订阅格式与解析细节

### 2.1 判定链路

`addNodes()`（`src/generator/config/nodemanip.cpp:35`）先决定“这是一条链接还是一份订阅”：

```
link 去引号 → script: 处理 → tag: 组名 处理 → nullnode →
https://t.me/socks|tg://socks → SOCKS
https://t.me/http|tg://http   → HTTP
isLink()（http:// https:// data:）或 surge:///install-config → SUB
Netch:// → Netch
本地文件存在 → Local（仅 !APIMode）
否则 → 单链接，直接 explode()
```
（`src/generator/config/nodemanip.cpp:108-137,192-229`；`isLink` 定义见 `src/utils/network.h:15-18`）

订阅（SUB）分支：`webGet(link, proxy, global.cacheSubscription, &extra_headers, request_headers)`（`:145`）→ `explodeConfContent()`（`:163`）→ 失败即 `-1`。

`explodeConfContent()`（`src/parser/subparser.cpp:2530-2575`）用**特征子串**判定 JSON 类配置：

| 判定顺序 | 特征 | 类型 |
| --- | --- | --- |
| 1 | `"version"` | Shadowsocks 配置 |
| 2 | `"serverSubscribes"` | SSR 配置 |
| 3 | `"uiItem"` 或 `vnext` | v2rayN / v2ray 配置 |
| 4 | `"proxy_apps"` | Shadowsocks Android |
| 5 | `"idInUse"` | SSTap |
| 6 | `"local_address"` 且 `"local_port"` | SSR 配置（libev） |
| 7 | `"ModeFileNameType"` | Netch |
| 其它 | — | `explodeSub()` |

`explodeSub()`（`src/parser/subparser.cpp:2601-2665`）顺序：

1. `ssd://` → `explodeSSD`；
2. 正则命中 `"?(Proxy|proxies)"?:` → 用正则 `^(?:Proxy|proxies):$\s(?:(?:^ +?.*$| *?-.*$|)\s?)+` 截出 YAML 片段 → `Load()` → `explodeClash`；
   - 注意此处 `catch (std::exception &e) { throw; }`（`:2628-2633`）：**YAML 解析异常会被重新抛出**，最终由 HTTP 层兜成 500 `Internal server error`；
3. `explodeSurge(sub, nodes)`（原文直接尝试，不要求 `[Proxy]`）：
   - INI 解析选项：`store_isolated_line=true`、`set_isolated_items_section("Proxy")`、`add_direct_save_section("Proxy")`、`allow_dup_section_titles=true`（`:1673-1677`）；
   - 若文本含 `[Proxy]`，先把第一个 `[` 之前的内容整体删掉（`:1678-1679`）；
4. 否则整段 `urlSafeBase64Decode`，若解出 `(...)\s*?=` 形式（`vmess=`/`shadowsocks=`/`http=`/`trojan=`）再试一次 Surge 解析（`:2644-2649`）；
5. 按行切分：`'\n'` 存在则 `\n`，否则 `\r` 存在则 `\r`，否则**按空格切**（`:2651`）——这就是“单行空格分隔的 Base64 订阅”也能工作的原因；
6. 每行 `explode()`；`Type == Unknown` 的行静默丢弃（`:2657-2662`）。

`explode()` 的前缀分派（`src/parser/subparser.cpp:2577-2599`）：

| 前缀 | 解析器 |
| --- | --- |
| `ssr://` | `explodeSSR` |
| `vmess://`、`vmess1://` | `explodeVmess` |
| `ss://` | `explodeSS` |
| `socks://`、`https://t.me/socks`、`tg://socks` | `explodeSocks` |
| `https://t.me/http`、`tg://http` | `explodeHTTP` |
| `Netch://` | `explodeNetch` |
| `trojan://` | `explodeTrojan` |
| 含 `hysteria2://` 或 `hy2://`（`strFind`，**子串**匹配） | `explodeHysteria2` |
| `anytls://` | `explodeAnyTLS` |
| 其它 `isLink`（http/https/data） | `explodeHTTPSub`（把链接本身当“Base64 的 http 代理”） |

### 2.2 协议与格式矩阵

| 协议 / 格式 | 入口 | 关键实现 | 默认 Group | 备注 |
| --- | --- | --- | --- | --- |
| Shadowsocks | `ss://` | `explodeSS` `src/parser/subparser.cpp:492-534` | `SSProvider` | 支持 SIP002 `ss://b64(method:pass)@host:port`、旧式整段 `b64(method:pass@host:port)`、`?plugin=`（`plugin;opts`）、`?group=`（base64）、`#name`（urlDecode） |
| ShadowsocksR | `ssr://` | `explodeSSR` `:686-721` | `SSRProvider` | `b64(host:port:protocol:method:obfs:b64(pass)/?group=&remarks=&obfsparam=&protoparam=)`；若 cipher 属于 SS 且 `obfs∈{plain,空}` 且 `protocol∈{origin,空}`，**降级为 SS 节点**（`:713-716`） |
| VMess | `vmess://` | `explodeVmess` `:274-342` | `V2RayProvider` | 5 种：Base64 JSON（主流 v2）、Shadowrocket（`vmess://<b64>?…`）、标准 URI（`vmess://uuid@host:port?…`）、Kitsunebi（`vmess1://`）、Quantumult（`name = vmess,host,port,cipher,id,…`）；JSON v1 用 `host` 字段的 `host;path` 拆分，v2 用 `path` 字段（`:321-337`）；`port=="0"` 丢弃 |
| Trojan | `trojan://` | `explodeTrojan` `:892-944` | `TrojanProvider` | `password@host:port`；`sni`←`sni`/`peer`；`ws=1&wspath=` 或 `type=ws&path=`（`%2F` 开头才 urlDecode）；**强置 TLS** |
| Hysteria2 | `hysteria2://`、`hy2://` | `explodeHysteria2`→`explodeStdHysteria2` `:1535-1594` | `Hysteria2Provider` | 无 `@` 时要求 `?password=`；`insecure`/`up`/`down`/`alpn`/`obfs`/`obfs-password`/`sni`/`pinSHA256` |
| AnyTLS | `anytls://` | `explodeAnyTLS` `:1596-1625` | `AnyTLSProvider` | `pass@host:port`；`sni`/`udp`/`insecure` |
| SOCKS5 | `socks://`、`tg://socks`、`https://t.me/socks` | `explodeSocks` `:787-834` | `SocksProvider` | 两种：v2rayN base64、Telegram query 参数 |
| HTTP(S) 代理 | `tg://http`、`https://t.me/http` | `explodeHTTP` `:836-854` | `HTTPProvider` | `tls` 由链接里是否含 `/https` 决定（`:853`） |
| HTTP 代理（Base64 链接） | 任意 http(s) | `explodeHTTPSub` `:856-890` | `HTTPProvider` | 去掉 `://` 后整段 base64 解出 `user:pass@host:port` 或 `host:port` |
| SSD | `ssd://` | `explodeSSD` `:536-610` | 取 JSON `airport` | `servers` 可为数组或对象 |
| Clash / mihomo YAML | 订阅内含 `proxies:` | `explodeClash` `:1115-1407` | 按类型 | 详见 §2.3 |
| Surge conf | 订阅内含 `[Proxy]` 或 `k = v` | `explodeSurge` `:1662-2447` | 按类型 | 详见 §2.4 |
| Shadowsocks 配置 | JSON | `explodeSSConf` `:649-684` | JSON `remarks` 或 `SSProvider` | `version`+`servers` 或 `configs` |
| SSR 配置 | JSON | `explodeSSRConf` `:723-785` | `group` 字段/`SSRProvider` | 单实例（`local_address`+`local_port`）或 `configs[]` |
| v2rayN / v2ray | JSON | `explodeVmessConf` `:344-490` | `V2RayProvider` | `outbounds` 单配置，或 `vmess[]` + `subItem[]` 映射组名；`configType` 1=vmess、3=ss、4=socks，其它跳过 |
| Shadowsocks Android | JSON | `explodeSSAndroid` `:612-647` | `SSProvider` | 外包 `{"nodes":…}` |
| SSTap | JSON | `explodeSSTap` `:2449-2506` | 字段 `group` | `configs[]` |
| Netch | JSON | `explodeNetchConf`/`explodeNetch` `:1013-1114,2507-2528` | 字段 `Group` | 单实例由 `Netch://` 前缀承载 |
| SSD/SIP008 输出回读 | — | 同上 | — | `sssub` 输出是 SIP008，可被 `explodeSSConf` 读回（`servers`） |

**不支持的协议（重要）**：

- **VLESS 完全不支持**。`grep -rni "vless" src include README-cn.md` 在本快照中**零命中**。若目标 Worker 要支持 vless，那是新增能力，不是“保持原版行为”。
- Snell、WireGuard、Hysteria(v1) **没有 URI 解析器**，只能从 Clash YAML 或 Surge conf 进入（`ProxyType` 枚举见 `src/parser/config/proxy.h:14-27`）。
- `hysteria2` 的识别是 `strFind` 子串匹配（`src/parser/subparser.cpp:2593`），而不是 `startsWith`——任何包含该子串的链接（包括注释掉的）都会被尝试解析【证实：代码如此；后果为推断】。

### 2.3 Clash YAML 输入的细节

`explodeClash()`（`src/parser/subparser.cpp:1115-1407`）：

- 顶层键：`proxies` 优先，否则 `Proxy`（`:1129`）；**只读节点，不读 `proxy-groups`/`rules`**。
- `port` 为空或 `"0"` 的条目直接跳过（`:1139-1140`）。
- 支持 type：`vmess`、`ss`、`socks5`、`ssr`、`http`、`trojan`、`snell`、`wireguard`、`hysteria`、`hysteria2`、`anytls`；**其它 type 静默跳过**（`default: continue`，`:1399-1400`）。
- SS 插件：`plugin: obfs` → `obfs-local`；`plugin: v2ray-plugin` → `v2ray-plugin`（含 `tls`/`path`/`mux`）；`obfs: ...`+`obfs-host` 老写法也认（`:1195-1247`）。
- cipher 归一化：`AEAD_CHACHA20_POLY1305`→`chacha20-ietf-poly1305`；其它含 `AEAD` 的去掉 `AEAD_`、`_`→`-`、转小写（`:1250-1256`）。
- SSR：`cipher: dummy` → `none`（`:1272`）；兼容 `protocol-param`/`protocolparam` 两套键名。
- vmess network 支持 `tcp`/`ws`/`http`/`h2`/`grpc`；`ws-opts` 优先，回落 `ws-path`/`ws-headers`（`:1161-1184`）。
- hysteria 兼容 `auth_str`、`disable_mtu_discovery`；`alpn` 是序列时只取第 0 项（`:1354-1357`）。
- hysteria2 的 `password` 为空时回落到 `auth`（`:1374-1376`）。

### 2.4 Surge conf 输入的细节

`explodeSurge()`（`src/parser/subparser.cpp:1662-2447`）：

- 只读 `[Proxy]` 段与 `[WireGuard <section>]` 段；`[Proxy Group]`/`[Rule]` 不参与（`ini.enter_section("Proxy")`，`:1684-1685`）。
- 每条 `name = type, ...`；`configs.size() < 3` 跳过（`:1710-1711`）。
- `direct`/`reject`/`reject-tinygif` 跳过（`:1714-1717`）。
- 支持 type：`custom`（Surge 2 风格 SS）、`ss`、`socks5`、`vmess`、`http`、`https`、`trojan`、`snell`、`wireguard`、`hysteria2`、`anytls`（QuanX 风格）。
- **已知缺陷**【证实于代码，后果为推断】：`case "anytls"` 代码块结尾**没有 `break`**，直接落入 `default: continue`（`:2400-2437`），因此 Surge/QuanX 风格的 anytls 条目虽然被解析，**永远不会生成节点**。
- `explodeSurge` 返回值是 `index`（节点计数），`0` 视为“不是 Surge 配置”（`:2442-2446`）。

### 2.5 Base64 细节

`base64Decode(content, accept_urlsafe=true)`（`src/utils/base64/base64.cpp:59-129`）：

- 支持标准表 `A-Za-z0-9+/` 与 URL-safe 的 `-`/`_`；
- **遇到第一个 `=` 立即停止**（`:85`）；
- **非 Base64 字符原样复制到输出**（`:88-94`）——所以“半 base64”的文本不会被整段丢弃，而是被拼进结果；
- 编码侧：`base64Encode` 带 `=` 填充（标准表）；`urlSafeBase64Encode` = 标准表 → `+`→`-`、`/`→`_`、删 `=`（`:136-149`）。

推论：

- 【推断】**纯文本（非 base64）订阅体不可靠**。`explodeSub` 在步骤 4 无条件对整段做 base64 解码（`subparser.cpp:2644`），明文 `ss://…` 中的字母数字会被当成 base64 解码成乱码，冒号/斜杠虽被保留也无法恢复原链接。因此原版实际要求订阅体是 Base64 / SSD / Clash YAML / Surge conf / 上述 JSON 之一。
- 【推断】`?` 与 `#` 在 base64 里不是合法字符，会被原样复制并打断 4 字符分组，这也是“带查询串的明文链接偶尔能过”的原因，但不可依赖。

### 2.6 分组、命名、去重、排序

| 行为 | 规则 | 代码 |
| --- | --- | --- |
| 默认组名 | 每种协议固定 `*Provider` 前缀（`SSProvider`/`SSRProvider`/`V2RayProvider`/`SocksProvider`/`HTTPProvider`/`TrojanProvider`/`SnellProvider`/`WireGuardProvider`/`HysteriaProvider`/`Hysteria2Provider`/`AnyTLSProvider`） | `src/parser/config/proxy.h:135-145` |
| 组名来源 | 链接内 `?group=`（SS/SSR/tg 链接，base64 或 urlDecode）；Clash/Surge 输入取类型默认值；`tag:组名,链接` 覆盖整条订阅；`?group=` 请求参数覆盖全部节点 | `subparser.cpp:511-513,696`；`nodemanip.cpp:108-117,177-182`；`interfaces.cpp:731-733` |
| 空备注 | `server:port` | `subparser.cpp:530-531,938-939` 等 |
| `=` 处理 | **所有** remark 里的 `=` 替换成 `-`（避免 Surge 解析错误） | `src/generator/config/subexport.cpp:171-177` |
| 含逗号的 remark | INI 类输出（Surge / Quantumult / QuanX / Mellow / Loon）加双引号包裹；Clash 与 sing-box 不加（`processRemark` 的 `proc_comma` 参数） | `subexport.cpp:178-185,273,2349`（false）vs `:801,1267,1501,1862,2007`（true） |
| 重名 | 追加 `" 2"`、`" 3"`…（**有一个前导空格**），基于“本次已出现的 remark 列表”逐个检测 | `subexport.cpp:186-193` |
| 节点去重 | **没有**按 host/port/密码的节点去重逻辑（全仓库无 `std::unique` 用于节点） | `grep std::unique src` 仅命中注释掉的代码 |
| 排序 | `sort=true` 时 `std::stable_sort` 按 remark 字典序；有排序脚本且 authorized 时用脚本 | `src/generator/config/nodemanip.cpp:479-513` |
| 过滤脚本 | QuickJS，需 `authorized`；`path:` 前缀读本地文件 | `nodemanip.cpp:375-409,427-464`；`interfaces.cpp:684-728` |
| rename | 逐条正则 `regReplace`（默认 **全局** 替换、`multiline`） | `nodemanip.cpp:403-404`；`src/utils/regexp.h:8` |
| emoji 移除 | 只识别 **4 字节 emoji**（首两字节 `0xF0 0x9F`）并删 4 字节 | `nodemanip.cpp:411-425` |
| emoji 添加 | 命中规则则 `emoji + " " + remark`，取第一条命中 | `nodemanip.cpp:427-464` |

### 2.7 节点级联参数 `tag:` / `script:` / `nullnode` / `data:`

- `tag:<组名>,<链接>`：把该条订阅所有节点 Group 设为 `<组名>`（`nodemanip.cpp:108-117`）。README 亦说明可用于 `!!GROUP=XXX` 匹配（`README-cn.md:311`）。
- `script:<js路径>[,args]`：调用 JS 的 `parse()` 返回新链接；仅 `authorized` 时执行（`nodemanip.cpp:53-91`）。
- `nullnode`：插入一个占位节点（`nodemanip.cpp:119-125`）——它会进入输出，属于“看起来像节点”的空节点【推断：Type=Unknown，后续生成器 default 分支 `continue`，可能被丢弃】。
- `data:...`：`webGet` 直接解析 data URI，支持 `;base64`（`src/handler/webget.cpp:276-291,308-309`）。

### 2.8 上游流量/到期信息的两种来源

1. 优先从上游响应头抓 `Subscription-UserInfo:`（`src/parser/infoparser.cpp:71-84`，正则 `^(?i:Subscription-UserInfo): (.*?)\s*?$`）；
2. 否则从节点名用 `[userinfo] stream_rule` / `time_rule` 正则推算（`src/parser/infoparser.cpp:86+`；规则格式 `规则|替换`，见 `src/handler/settings.cpp:900-919`）。

输出到客户端时由 `append_info` 控制（默认 true）。

---

## 3. 输出

### 3.1 Clash / mihomo 配置结构

`proxyToClash()` 分两段：先改 YAML（`src/generator/config/subexport.cpp:232-691`），再把 rules **以字符串拼接**到 `YAML::Dump()` 之后（`:735-740`）。

#### 3.1.1 顶层字段名（新旧两套）

由 `ext.clash_new_field_name` 决定（`:599-602,677-690`）：

| 语义 | `new_name=true` | `new_name=false`（编译期默认） |
| --- | --- | --- |
| 节点数组 | `proxies` | `Proxy` |
| 策略组 | `proxy-groups` | `Proxy Group` |
| 规则 | `rules` | `Rule` |

`clashr` 只影响 SSR 的字段名：`protocolparam`/`obfsparam` vs `protocol-param`/`obfs-param`（`:391-400`），不改变上面三个键。

规则块的产生方式（`rulesetToClashStr`，`src/generator/config/ruleconvert.cpp:193-257`）：先把 base 模板里的 `rules`/`Rule` 键**移除**，把原有规则逐条转成 `  - <rule>` 文本，再按 `\n<rules>:\n  - …` 追加到 YAML 文本末尾。也就是说 **`rules` 是字符串拼接产生的，不经过 YAML 序列化器**——缩进固定两个空格、值不做 YAML 引号处理【证实于代码，后果为推断】。

#### 3.1.2 `proxies` 元素字段（按类型）

| 协议 | 必出字段 | 可选字段 | 代码 |
| --- | --- | --- | --- |
| ss | `type:ss`,`cipher`,`password`,`name`,`server`,`port` | `plugin`+`plugin-opts{mode,host,path,tls,mux,skip-cert-verify}`,`udp`,`tfo` | `:286-314` |
| vmess | `type`,`uuid`,`alterId`,`cipher`,`tls` | `servername`,`skip-cert-verify`,`network`+`ws-opts`/`http-opts`/`h2-opts`/`grpc-opts` | `:315-371` |
| ssr | `type`,`cipher`（`none`→`dummy`）,`password`,`protocol`,`obfs` | `protocol-param`,`obfs-param`；`clashr` 时改用**无连字符**的 `protocolparam`/`obfsparam` | `:372-401` |
| socks5 | `type`,`name`,`server`,`port` | `username`,`password`,`skip-cert-verify` | `:402-414` |
| http/https | `type:http`,`tls` | `username`,`password`,`skip-cert-verify` | `:415-429` |
| trojan | `type`,`password` | `sni`,`skip-cert-verify`,`network`(`ws`/`grpc`)+对应 opts | `:430-455` |
| snell | `type`,`psk`,`version`(非 0 时) | `obfs-opts{mode,host}`；**`SnellVersion>=4` 直接丢弃** | `:456-471` |
| wireguard | `type`,`public-key`,`private-key`,`ip` | `ipv6`,`preshared-key`,`dns`,`mtu` | `:472-485` |
| hysteria | `type` | `ports`,`protocol`,`obfs-protocol`,`up`,`up-speed`,`down`,`down-speed`,`auth-str`+`auth`(base64),`obfs`,`sni`,`skip-cert-verify`,`fingerprint`,`alpn`,`ca`,`ca-str`,`recv-window-conn`,`recv-window`,`disable-mtu-discovery`,`fast-open`,`hop-interval` | `:486-531` |
| hysteria2 | `type` | `ports`,`up`,`down`,`password`,`obfs`,`obfs-password`,`sni`,`skip-cert-verify`,`alpn`,`ca`,`ca-str`,`cwnd`,`hop-interval` | `:532-560` |
| anytls | `type`,`password` | `sni`,`skip-cert-verify` | `:561-568` |

通用收尾：

- `udp`：`ext.udp` 或节点自身，**但 Snell 永远不加**（`:573-576`）。
- `tfo`：`ext.tfo`，未定义则不出键（`:577-578`）。
- `port` 以整数写出（`:282`，`uint16_t`）。
- 纯数字密码会 `SetTag("str")` 强制加引号（避免 YAML 变整数）——ss/ssr/socks/http/trojan 有做；**snell 分支对不存在的 `password` 键做了 `SetTag`**（`:469-470`），yaml-cpp 的 `operator[]` 会插入空节点，因此 Snell 节点可能多出一个空 `password` 键【推断：未运行验证】。
- 输出风格：`clash_proxies_style` ∈ `flow`(默认)/`block`/`compact`；`clash_proxy_groups_style` 同理（`:239-262,579-589,655-658,674-675`）。

#### 3.1.3 `proxy-groups`

`src/generator/config/subexport.cpp:605-672`：

```yaml
- name: <Name>
  type: select | url-test | fallback | load-balance | relay | ssid | url-test(smart)
  url: <url>            # url-test/fallback/load-balance/smart
  interval: <int>       # >0 才输出
  tolerance: <int>      # >0 才输出
  lazy: <bool>          # 未定义不输出
  strategy: consistent-hashing | round-robin   # 仅 load-balance
  disable-udp: <bool>
  use: [provider…]      # 有 !!PROVIDER= 时
  proxies: [ … ]        # 无 provider 时
```

- **`smart` 类型在 Clash 里输出为 `url-test`**（`:611-614`）。
- 同名的原有策略组会被**替换**而不是追加（`:660-671`）。
- 组内节点通过 `groupGenerate()` 的正则匹配 remark 得到，顺序 = 规则顺序 × 节点顺序，且组内去重（`:196-230`）。
- 组里没有任何节点时补 `DIRECT`（`:650-652`）。
- 有 `use:` 时**不输出 `proxies:`**（两者互斥，`:646-654`）。
- 没有任何组时**删除** `proxy-groups` 键（`:677-690`）。
- 原版**从不生成 `proxy-providers`**（全仓库无该键的写入），`use:` 只能引用 base 模板里已有的 provider。

#### 3.1.4 `rules` 与 `rule-providers`

- 展开模式（默认，`expand=true`）：规则全文写进 `rules`，每条 `TYPE,VALUE,GROUP[,no-resolve]`，来源于 `rulesetToClashStr`（`src/generator/config/ruleconvert.cpp:193-257`）。
- 引用模式（`expand=false` 且 `managed_config_prefix` 非空，或 `script=true`）：走 `renderClashScript()`（`src/generator/template/templates.cpp:310-571`）：
  - `rule-providers.<name>.type = http`
  - `behavior` = `domain` / `ipcidr` / `classical`（按规则内容自动判断，`:489-531`）
  - `url` = `<managed_config_prefix>/getruleset?type=3|4|6&url=<urlsafe-base64>`；**若 `managed_config_prefix` 为空，则变成相对路径 `/getruleset?...`**（`:499,514,527`）
  - `path` = `./providers/<hash>_domain.yaml`；`<hash>` 是 `hash_()`（**自实现的 64 位 FNV-1a**，`basis=0xCBF29CE484222325`、`prime=0x100000001B3`，见 `src/utils/string_hash.h:9-27`）对 URL 求值后的十进制字符串 → **跨平台确定**，Worker 用 BigInt 即可复刻
  - `interval` = ruleset 的 `update_interval`（>0 时）
  - `rules` 侧使用 `RULE-SET,<name>,<group>`，并可能拆成 `<name> (Domain)` 与 `<name> (IP-CIDR)` 两个 provider（`:469-478`）
- 名字：`urlDecode(findFileName(rule_path))`，重名追加 `" 2"`（`:360-364,389-392`）；`findFileName` 去目录、去扩展名（`templates.cpp:295-308`）。
- `script=true`：生成 Clash 的 Python `script.code`，用 `ctx.rule_providers[...]` 匹配（模板见 `templates.cpp:261-293`）。

### 3.2 其它 target 的结构差异

| target | 顶层结构 | 关键差异 | 代码 |
| --- | --- | --- | --- |
| `surge`（ver=2/3/4） | INI：`[Proxy]`、`[Proxy Group]`、`[Rule]`，可选 `[WireGuard xxxxx]` | trojan / wireguard / anytls：`ver<4` 且 `ver != -3` 时丢弃；hysteria2：`ver<4` 时丢弃（surfboard 也不支持）；`load-balance`：`ver<1` 且 `ver != -3` 时丢弃；每行 `name = type, server, port, ...`；`select` 组只有一个成员且是 `DIRECT`/`REJECT` 时会被**压成 Proxy 行**（`subexport.cpp:1044-1055`） | `src/generator/config/subexport.cpp:765,922-983,1026,1044-1055` |
| `surfboard` | 同上，`surge_ver=-3` | SS 支持、HTTPS 用 `https,` 行；load-balance 可用 | `:813-828` ↔ `:904-910,1026` |
| `loon` | `[Proxy]`/`[Proxy Group]`/`Remote Rule`（`surge_ver=-4`） | 规则以 `Remote Rule` 段引用 | `src/generator/config/ruleconvert.cpp:351-356,385-390` |
| `quan` | `[SERVER]`/`[POLICY]`/`[TCP]` | 规则入 `TCP` 段（`surge_ver=-2`），`IP-CIDR6` 被丢弃 | `subexport.cpp:1257-1258,1386-1387`；`ruleconvert.cpp:266-279,419-426` |
| `quanx` | `[server_local]`/`[policy]`/`[filter_local]`/`[filter_remote]` | 规则入 `filter_local`；远程规则写成 `filter_remote` 行 | `subexport.cpp:1491-1492,1648-1650`；`ruleconvert.cpp:328-333,344-350` |
| `mellow` | `[Endpoint]`/`[EndpointGroup]`/`RoutingRule` | `surge_ver=0` | `subexport.cpp:1852,1926`；`ruleconvert.cpp:268-270` |
| `singbox` | JSON | 独立的 `rulesetToSingBox`，支持 `DOMAIN-REGEX`、`IP-VERSION`、`GEOSITE`、`PORT-RANGE` 等更多类型；可选注入 Clash 三模式 | `subexport.cpp:2326-2630`；`ruleconvert.cpp:18,520+`；`settings.h:50` |
| `ss`/`ssr`/`v2ray`/`trojan`/`mixed` | 每行一条 URI，整体标准 Base64（`list=true` 时不编码） | 位掩码 `1=SS,2=SSR,4=VMess,8=Trojan`；`mixed=15` | `subexport.cpp:1093-1172` |
| `sssub` | SIP008 JSON：`{version,servers:[{remarks,server,server_port,method,password,plugin,plugin_opts}]}` | 只输出 SS；SSR 仅当 `origin`+`plain` 且 cipher 属于 ss 表 | `subexport.cpp:1174-1225` |
| `ssd` | SSD JSON：`{airport,port,encryption,password,servers:[…]}` | 组名取 `?group=` | `subexport.cpp:1727+` |

单链接生成细节（`subexport.cpp:1107-1164`）：

- SS：`ss://<urlsafe-b64(method:password)>@host:port[/?plugin=<urlEncode(plugin;opts)>]#<urlEncode(remark)>`；`list=true` 时仍带 `#`。
- SSR：`ssr://<urlsafe-b64(host:port:proto:method:obfs:b64(password)/?group=&remarks=&obfsparam=&protoparam=)>`。
- VMess：`vmess://<base64(JSON v2)>`，JSON 由 `vmessLinkConstruct` 生成（`v,ps,add,port,type,id,aid,net,path,host,tls`，`:33-62`）。
- Trojan：`trojan://<password>@host:port?allowInsecure=<0|1>[&sni=][&ws=1&wspath=]#name`。
- **只有 SS/SSR/VMess/Trojan 能进单链接输出**：Hysteria2、AnyTLS、Snell、WireGuard、HTTP、SOCKS 在 `proxyToSingle` 里被 `default: continue` 丢弃（`:1162-1163`）——`target=mixed` 会静默少节点。

### 3.3 `?list=true`（nodelist）

- Clash：只输出 `proxies:` 一个键（`:591-597`），可直接作 proxy-provider 文件。
- Surge：只输出 `name = type, ...` 行（`:996-997`）。
- 单链接：不 Base64，直接明文多行（`:1168-1171`）。

---

## 4. 模板与 INI

### 4.1 三层配置与加载顺序

| 层 | 内容 | 加载 | 代码 |
| --- | --- | --- | --- |
| ① 进程配置 `pref.*` | 全局设置、默认 base 模板、rulesets、custom_proxy_group、emoji/rename、template 变量、aliases、tasks | 启动时 `readConf()`；`reload_conf_on_request` 时每次请求重读 | `src/main.cpp:122-140,165`；`src/handler/settings.cpp:786-830` |
| ② 外部配置 `config=` | `[custom]`：base 模板路径、分组、规则集、rename/emoji/include/exclude、`[template]` 局部变量 | 每次请求 `loadExternalConfig()` | `src/handler/interfaces.cpp:444-487`；`src/handler/settings.cpp:1204-1304` |
| ③ base 模板（`.tpl`/`.yml`/`.conf`） | 目标格式的骨架，用 inja 渲染 | 每次请求 `fetchFile()` + `render_template()` | `src/handler/interfaces.cpp:774-780` 等 |

`pref` 文件的挑选顺序：`pref.toml` > `pref.yml` > `pref.ini`；都不存在时从 `pref.example.*` 复制一份（`src/main.cpp:122-140`）。之后 `setcd(prefPath)`，**所有相对路径都相对 pref 文件所在目录**（`:142`）。

`pref` 支持 YAML / TOML / INI 三种（`src/handler/settings.cpp:796-830`：先看是否含 `common:` 按 YAML 读，再按 TOML `version` 读，最后 INI）。外部配置同理（`:1210-1236`：YAML 有 `custom` → TOML `version` → INI）。

#### 编译期默认值 vs 随包示例配置（**两者不同，必须明确采用哪一套**）

| 项 | 编译期默认（`src/handler/settings.h`） | `base/pref.example.ini` |
| --- | --- | --- |
| `api_mode` | `true`（`:28`） | `false`（`:3`） |
| 监听 | `127.0.0.1:25500`（`:25-26`） | `listen=0.0.0.0`、`port=25500`（`:268,271`） |
| 并发 | `maxPendingConns=10`、`maxConcurThreads=4`（`:26`） | `max_pending_connections=10240`、`max_concurrent_threads=2`（`:279-280`） |
| `script_clean_context` | `false`（`:67`） | `true`（`:288`） |
| `clash_use_new_field_name` | `false`（`:50`） | `true`（`:110`） |
| `max_allowed_download_size` | `1048576`（1 MB，`:33`） | `0`（不限制，`:283`） |
| `max_allowed_rulesets` | `64`（`:66`） | `0`（`:281`） |
| `max_allowed_rules` | `32768`（`:66`） | `0`（`:282`） |
| `enable_cache` | 无此开关，缓存 TTL 始终生效：`cache_subscription=60`、`cache_config=300`、`cache_ruleset=21600`（`:63`） | `enable_cache=false` → 三个 TTL 全置 0（`:284`；`settings.cpp:1055-1068`） |
| `write_managed_config` | `false`（`:28`） | `true`（`:136`） |
| `managed_config_prefix` | `""`（`:25`） | `http://127.0.0.1:25500`（`:140`） |
| `add_emoji` / `remove_old_emoji` | `false` / `false`（`:47`） | `true` / `true`（`:156-157`） |
| `overwrite_original_rules` | `true`（`:28`） | `false`（`:174`） |
| `update_interval` | `0`（`:53`） | `86400`（`:143`） |
| 默认 base | `""`（即不用模板，`lClashBase` 为空 → `fetchFile("")` → 空串 → `YAML::Load("")` → 空节点） | `clash_rule_base=base/all_base.tpl`（`:39`） |

> 迁移建议：以 `base/pref.example.ini`（用户实际会拿到的那份）作为“默认行为”基线，并在规格里显式写出上面这张表，否则“默认输出字段名”这类验收会打架。

### 4.2 INI 语法细节（`src/utils/ini_reader/ini_reader.h`）

| 规则 | 实现 |
| --- | --- |
| 行首尾空白 | 每行 `trimWhitespace`（`:251`） |
| 注释 | **仅整行**注释：`;`、`#`、`//`；**不支持行内注释**（`:253`） |
| 键值 | 以**第一个** `=` 分割；值去掉前导空格（`:252,297-305`） |
| 段 | `[name]`，名字取括号内原文（`:256-286`） |
| 重复段名 | 合并；`allow_dup_section_titles` 可关（`:262-273`） |
| 无键行 | `store_any_line` 时记为 `{NONAME}`；`store_isolated_line` 时无段的行归到 `set_isolated_items_section()` 指定的段（`:238-245,287-290`） |
| 键名前缀匹配 | `get_all("ruleset")` 会取出**所有以 `ruleset` 开头**的键（`item_prefix_exists`：`x.first.find(itemName)==0`，`:417-434`） |
| 转义 | 每行先 `processEscapeChar`：`\n`→换行、`\r`、`\t`（`src/utils/string.cpp` 中 `processEscapeChar`） |
| 顺序 | `string_multimap`，等价键保持插入顺序【推断：C++11 标准语义】 |

注意 `processEscapeChar` 的副作用：**正则里的 `\n` 会被变成真实换行**，写 `\t` 也会变制表符。Worker 实现若直接复用配置，必须复刻这一行为，否则老配置的正则会变义。

### 4.3 外部配置键表（`[custom]`）

`loadExternalConfig()` 的 INI 分支（`src/handler/settings.cpp:1228-1301`），键名与用途：

| 键 | 形态 | 作用 |
| --- | --- | --- |
| `custom_proxy_group` | 多行，`` name`type`rules… `` | 策略组 |
| `ruleset`（或旧名 `surge_ruleset`） | 多行，`group,[type:]url[,interval]` | 规则集 |
| `clash_rule_base` / `surge_rule_base` / `surfboard_rule_base` / `mellow_rule_base` / `quan_rule_base` / `quanx_rule_base` / `loon_rule_base` / `sssub_rule_base` / `singbox_rule_base` | 路径或 URL | 目标 base 模板 |
| `overwrite_original_rules` | bool | 覆盖 base 里的原有规则 |
| `enable_rule_generator` | bool | 是否生成规则 |
| `rename` | 多行 `pattern@replace` | 重命名 |
| `emoji` | 多行 `pattern,emoji` | 加 emoji |
| `add_emoji` / `remove_old_emoji` | bool | 开关 |
| `include_remarks` / `exclude_remarks` | 多行正则 | 节点过滤 |
| `[template]` 段 | 任意 `key=value` | 渲染模板的 `local` 变量（`:1294-1301`） |

示例见 `base/config/example_external_config.ini:1-66`。

**关键行为**：

- 外部配置文件在解析前会**先当 inja 模板渲染一遍**（`settings.cpp:1206-1208`），失败则用原文。这就是为什么 `config.ini` 里可以写 `{% if %}`（issue #646 的配置即如此）。渲染变量来自 `global.templateVars`（pref `[template]`）+ 本次请求的全部 query 参数（`interfaces.cpp:389-402`）。
- **`config=` 存在时，`groups=`/`ruleset=` 查询参数被忽略**（`interfaces.cpp:488-506` 的 else 分支才处理它们）。
- `enable_rule_generator` 与 `overwrite_original_rules` **总是**被外部配置里的解析结果覆盖（`interfaces.cpp:472-473`），而 `ExternalConfig` 结构体默认 `overwrite_original_rules=false`（`settings.h:93`）。因此：**只要用了 `config=` 而没写 `overwrite_original_rules`，它就等于 false（保留 base 模板里的原规则）**，即使 pref 里写的是 true。【证实于代码】
- 路径安全：`fileGet(path, scope_limit)` 只拦 `..` 与绝对路径（`src/utils/file.cpp:7-17`）；`base_path` 用于 base 模板的归属判断（`checkExternalBase`：`isLink(path) || (startsWith(path, global.basePath) && fileExist(path))`，`interfaces.cpp:296-300`）。

### 4.4 `ruleset=` 语法（BNF）

```
ruleset = GROUP "," ( "[]" RULE | [ TYPE ":" ] URL [ "," INTERVAL ] )
GROUP   = 任意文本（到第一个逗号为止）
TYPE    = "surge" | "quanx" | "clash-domain" | "clash-ipcidr" | "clash-classic"
INTERVAL= 秒（整数）
RULE    = 例如 "GEOIP,CN" / "FINAL" / "MATCH"
```

- 解析器：`INIBinding::from<RulesetConfig>::from_ini`（`src/config/binding.h:266-307`）。
  - 第一个逗号前是 Group；若其后紧跟 `[]`，整段（含 `[]`）存为 Url 并结束；
  - 若存在第二个逗号，则**最后一个**逗号之后的内容按 `to_int(...,0)` 解析为 Interval（解析失败即 0）；中间的才是 Url；
  - **只有 `Group,URL` 两段时，Interval 保留结构体默认值 86400**（`src/config/ruleset.h:20`），不是 0。因此在 Surge（ver>2）输出里，未显式写 interval 的规则集都会带 `update-interval=86400`（`ruleconvert.cpp:372-373`）【证实于代码】；
- 类型前缀识别在 `refreshRulesets()`（`src/handler/settings.cpp:268-275`），映射表 `:22-23`。**`clash:` 不是合法前缀**（只有 `clash-domain:`/`clash-ipcidr:`/`clash-classic:`），写成 `clash:` 会被当成 URL 的一部分去下载 → 失败【证实于映射表】。
- `[]` 行内规则：`refreshRulesets` 发现 Url 里有 `[]` 时，把 `[]` 起的内容当作规则文本（`settings.cpp:260-265`），`rule_path` 为空。后续三个生成器都在 `rule_path.empty()` 分支里 `substr(2)` 去掉 `[]`（`ruleconvert.cpp:307-325,331-353`；`templates.cpp:331-353`）。
- `!!import:<path>`：`importItems()` 在执行前把该行替换为本地/远程文件的行（`settings.cpp:25-70`）。它用 `x.find(":")` 取第一个冒号后的全部内容，且注释/空行会被跳过。
- `README-cn.md:887-917` 是官方说明（含 `[]GEOIP,CN`、`[]FINAL` 示例）。

### 4.5 `custom_proxy_group=` 语法

```
custom_proxy_group = NAME "`" TYPE "`" RULE ("`" RULE)*            # select / relay / ssid / smart
custom_proxy_group = NAME "`" TYPE "`" RULE+ "`" URL "`" TIMES     # url-test / fallback / load-balance
TYPE  = select | url-test | fallback | load-balance | relay | ssid | smart
TIMES = "interval[,timeout][,tolerance]"
RULE  = 正则 | "[]"REF | "!!GROUP=…" | "!!GROUPID=…" | "!!INSERT=…" | "!!TYPE=…" | "!!PORT=…" | "!!SERVER=…" | "script:<path>"
```

- 解析：`INIBinding::from<ProxyGroupConfig>::from_ini`（`src/config/binding.h:194-264`）。
  - `` ` `` 分隔；**少于 3 段直接丢弃**（`:205-207`）；
  - `url-test`/`load-balance`/`fallback` 要求 ≥5 段，倒数第二段是 `url`，最后一段用 `parseGroupTimes` 解析成 `interval,timeout,tolerance`（`:240-247`；`settings.h:104-122`）；
  - 类型不认识 → 丢弃（`default: continue`，`:236-238`）；
  - `!!PROVIDER=name[,name2]` → 进 `UsingProvider`（输出 `use:`），否则进 `Proxies`（`:249-259`）。
  - 类型到输出的映射：`select`/`url-test`/`load-balance`/`fallback`/`relay`/`ssid`/`smart`（`src/config/proxygroup.h:6-62`）。
- 规则匹配 DSL：`applyMatcher()`（`src/generator/config/subexport.cpp:115-169`）
  - `!!GROUP=<regex>`：匹配 `node.Group`，剩余部分继续当 remark 正则；
  - `!!GROUPID=<range>` / `!!INSERT=<range>`：range 语法 `0,1,!2,3-5,7+,8-`（`matchRange`，`:64-113`）；INSERT 用负数编码（`dir=-1`）；
  - `!!TYPE=<regex>`：对 `SS/SSR/VMESS/TROJAN/SNELL/HTTP/HTTPS/SOCKS5/WIREGUARD/HYSTERIA/HYSTERIA2` 做**整串**匹配（`regMatch` 是锚定匹配）；
  - `!!PORT=<range>`、`!!SERVER=<regex>`（`node.Hostname`）；
  - 以上可 `!!` 串联成组合条件（正则 `^!!(?:GROUPID|INSERT)=…(?:!!(.*))?$` 等）。
  - `[]XXX`：直接把字面量 `XXX` 当成员（通常是 `DIRECT`/`REJECT`/另一个组名），不匹配任何节点（`groupGenerate`，`:199-202`）。
  - `script:<path>`：JS 返回换行分隔的名字列表（`:204-221`，需 authorized）。
- 空 pattern 的语义：`applyMatcher` 返回 `real_rule==""`，调用处 `real_rule.empty() || regFind(...)` → **空正则匹配所有节点**（`:226`）。因此 `custom_proxy_group=X`select``（第二个 `` ` `` 后直接结束）会吞掉全部节点。
- 官方说明：`README-cn.md:922-989`。

### 4.6 模板变量与渲染

`render_template()`（`src/generator/template/templates.cpp:80-259`）用 **inja**（Jinja2 for C++，`include/inja.hpp`）。

数据上下文（JSON 指针）：

| 前缀 | 来源 |
| --- | --- |
| `global.*` | pref `[template]` 段的所有键，外加 `managed_config_prefix`（`settings.cpp:982-993`） |
| `request.*` | 本次请求**所有** query 参数（`token` 除外），键名按 `.` 展开为多级（`interfaces.cpp:389-397`；`templates.cpp:95-107`） |
| `request._args` | 原始 `k=v&k=v` 串 |
| `local.*` | 外部配置 `[template]` 段；`clash.new_field_name`（`interfaces.cpp:764`） |

内置函数（`templates.cpp:116-225`）：`UrlEncode`、`UrlDecode`、`trim_of`、`trim`、`find`（正则）、`replace`（正则）、`set`（写 JSON 指针）、`split`、`append`、`getLink`（拼 `managed_config_prefix`）、`startsWith`、`endsWith`、`or`、`and`、`bool`、`string`、`fetch`（网络抓取，**没有关闭开关**）。`{% include %}` 被限制在模板目录内（`templates.cpp:228-243`）。

渲染失败时的行为：`render_template` 返回 -1，`output` 里是 `Template render failed! Reason: …`，调用方**直接把这段错误文本当内容返回**并置 400（`interfaces.cpp:774-779` 等）。所以“模板写错”会得到一个 400 + 错误文本的响应体。

官方示例：`base/base/all_base.tpl`（一个文件按 `{% if request.target == "clash" %}` 分支出所有目标的骨架）；说明见 `README-cn.md:1229-1363`。

### 4.7 覆盖优先级（逐项）

| 项 | 优先级（高 → 低） |
| --- | --- |
| target | URL > `auto` UA 推断 |
| 节点集合 | `url` + `insert_url`（`prepend` 决定先后） |
| include/exclude | `?include=`/`?exclude=`（合法时）> 外部配置 > pref |
| 分组 | 外部配置（非空时）> `?groups=` > pref |
| 规则集 | 外部配置（非空时）> `?ruleset=` > pref |
| rename | `?rename=` > 外部配置 > pref |
| emoji 开关 | `?emoji` / `?add_emoji` / `?remove_emoji` > 外部配置 > pref |
| base 模板路径 | 外部配置 > pref |
| `overwrite_original_rules` | 外部配置（**总是覆盖**，缺省为 false） > pref |
| `enable_rule_generator` | 外部配置（总是覆盖，缺省 true） > pref |
| 模板变量 | `local`（外部配置 `[template]`）> `request` > `global`（同名时 inja 里按显式 `local.`/`request.`/`global.` 取，不会互相覆盖） |

---

## 5. 规则集（`/getruleset` 与内部规则生成）

### 5.1 `type` 语义与输出格式

`src/handler/interfaces.cpp:136-294`：
注释在 `:140`，README 在 `README-cn.md:1439-1443`。

| type | 含义 | 行过滤（`startsWith`） | 每行输出 | 空结果时 |
| --- | --- | --- | --- | --- |
| 1 | Surge ruleset | `SurgeRuleTypes` | 原样输出（**不追加 group**） | 400（源为空或全被过滤） |
| 2 | Quantumult X | `QuanXRuleTypes` | `IP-CIDR6`→`IP6-CIDR`，末尾追加 `,<group>`；`no-resolve` 挪到最后 | 400（源为空或全被过滤） |
| 3 | Clash domain rule-provider | `DOMAIN-SUFFIX,` 或 `DOMAIN,` | `payload:` 头 + `  - '<v>'`；`DOMAIN-SUFFIX` 的值前加 **`+.`** | 200 + `  - '--placeholder--'` |
| 4 | Clash ipcidr rule-provider | `IP-CIDR,` 或 `IP-CIDR6,` | `payload:` 头 + `  - '<v>'` | 200 + `  - '0.0.0.0/32'` |
| 5 | Surge DOMAIN-SET | `DOMAIN-SUFFIX,` 或 `DOMAIN,` | 纯域名；`DOMAIN-SUFFIX` 前加 **`.`**；无 `payload:` 头 | 400（无占位） |
| 6 | Clash classical ruleset | `ClashRuleTypes` | `payload:` 头 + `  - <整行>` | 200 + `  - 'DOMAIN,--placeholder--'` |

细节：

- `filterLine()`（`:177-193`）：一行**至少要有一个逗号**；没有逗号直接丢弃（`return 1`）。只有一个逗号时，值取到行尾；有多个逗号时只取到第二个逗号前，其余（如 `no-resolve`、group）被丢弃。type 3/4/5 走这条路径。
- `DOMAIN-SUFFIX` 的判定用 `strLine[posb - 2] == 'X'`（`:225,244`）——靠类型名最后一个字母区分 `DOMAIN` 与 `DOMAIN-SUFFIX`。这就是 issue #667 里被指出的那段。
- `//` 注释在**所有** type 下都会先被截断（`:204-208`）；`#`/`;` 只在后续过滤里因“不以合法类型开头”被丢掉，**type=1 时 `#` 开头的行也会被丢弃**（因为不 startsWith 任何 Surge 类型）。
- 多个 `url`（`|` 分隔）会**拼接**到同一份输出里；`group` 只对 type=2 有意义。
- 输出 Content-Type 固定 `text/plain;charset=utf-8`（`src/main.cpp:271`）。

### 5.2 方言识别与类型映射

`convertRuleset(content, type)`（`src/generator/config/ruleconvert.cpp:20-96`）。注意 `regFind` 带 `m` 修饰符（`src/utils/regexp.cpp:143-150`），所以 `^payload:` 是“任意行行首”，不要求第一行：

```
if type == RULESET_SURGE:  return content;                    // ← 完全直通，见 5.4
if content 匹配 ^payload:\r?\n   // PCRE2 多行模式：行首匹配即可，不要求第一行
    去掉 "payload:" 行；把行首的 "  - 'xxx'" / "  - \"xxx\"" 还原成 xxx
    if type == RULESET_CLASH_CLASSICAL: return output          // 原样（已去掉 YAML 装饰）
    逐行：
      含 "/" → 是 IP：IPv4 → "IP-CIDR,"，否则 "IP-CIDR6,"
      以 "." 或 "+." 开头 → "DOMAIN-SUFFIX,"（若以 ".*" 结尾则 "DOMAIN-KEYWORD,"）
      其它 → "DOMAIN,"
else:                                                          // 非 payload（QuanX / 裸域名列表）
    host→DOMAIN、ip6-cidr→IP-CIDR6（大小写不敏感）
    用一条正则去掉 group 字段、保留 no-resolve
```

映射表（源 → 中间 Surge 风格）：

| 源形态 | 产物 |
| --- | --- |
| `payload:\n  - '+.example.com'` | `DOMAIN-SUFFIX,example.com` |
| `payload:\n  - '.example.com'` | `DOMAIN-SUFFIX,example.com` |
| `payload:\n  - 'example.com'` | `DOMAIN,example.com` |
| `payload:\n  - '.google.*'`（**以 `.` 开头且以 `.*` 结尾**） | `DOMAIN-KEYWORD,google` |
| `payload:\n  - '1.2.3.0/24'` | `IP-CIDR,1.2.3.0/24` |
| `payload:\n  - '2001:db8::/32'` | `IP-CIDR6,2001:db8::/32` |
| `HOST,example.com`（QuanX） | `DOMAIN,example.com` |
| `HOST-SUFFIX,example.com`（QuanX） | `DOMAIN-SUFFIX,example.com`（先被 `^host`→`DOMAIN` 改写；【推断】） |
| `IP6-CIDR,2001::/32` | `IP-CIDR6,…` |
| `DOMAIN-SUFFIX,example.com,Group` | `DOMAIN-SUFFIX,example.com`（去组） |

【推断】`HOST-SUFFIX` 这条依赖正则 `^((?i:DOMAIN(?:-(?:SUFFIX|KEYWORD))?|IP-CIDR6?|USER-AGENT),)\s*?(\S*?)(?:,(?!no-resolve).*?)(,no-resolve)?$` 的作用范围，仅对 `DOMAIN*`/`IP-CIDR*`/`USER-AGENT` 生效，所以 `HOST-SUFFIX` 会先被 `^host`→`DOMAIN` 规则改写成 `DOMAIN-SUFFIX`，再被去组规则处理。实际输出应为 `DOMAIN-SUFFIX,example.com`。

### 5.3 无效行怎么处理（逐路径矩阵）

| 路径 | 空行与整行注释（`;` `#` `//`） | 未知类型前缀 | 列数不足 | 行内 `#` | 行内 `//` |
| --- | --- | --- | --- | --- | --- |
| `convertRuleset`（Clash payload → Surge） | 跳过 | 不判断（原样加前缀） | 原样 | **保留** | 截断 |
| `rulesetToClash` / `rulesetToClashStr` | 跳过 | 跳过（`none_of(ClashRuleTypes)`） | 由 `transformRuleToCommon` 补 `,group` | **保留** | 截断 |
| `rulesetToSurge` | 跳过 | 按目标方言跳过 | 补 `,group` | **保留** | 截断 |
| `getRuleset` type=1/2 | 跳过 | 丢弃 | 丢弃 | 保留 | 截断 |
| `getRuleset` type=3/4/5 | 丢弃 | 丢弃 | `filterLine()` 丢弃（无逗号） | 保留 | 截断 |
| `getRuleset` type=6 | 丢弃 | 丢弃 | 保留整行 | 保留 | 截断 |
| `renderClashScript` | 跳过 | 不判断（只统计 has_domain/has_ipcidr） | — | 保留 | 不截断 |

**结论：行内 `#` 注释一律不被剥离**（只有 `//` 会被剥离）。这正是 issue #749 提的问题。

### 5.4 “不校验直接透传”的代码路径（重点）

1. **`convertRuleset` 的 `RULESET_SURGE` 直通**
   `src/generator/config/ruleconvert.cpp:28-29`：
   ```cpp
   if(type == RULESET_SURGE)
       return content;
   ```
   下载到什么就返回什么，不做任何语法校验、不改行。这是最大的透传面。
   调用方：`rulesetToClash/…Str/Surge`、`renderClashScript`、`getRuleset` 都走它。

2. **`[]` 行内规则直通**
   `rulesetToClash`（`ruleconvert.cpp:149-158`）：只要以 `[]` 开头，就 `substr(2)` + 补 `,group` 直接入列，**完全不做 `ClashRuleTypes` 校验**。同理 `rulesetToClashStr:220-229`、`rulesetToSurge:307-325`、`renderClashScript:331-353`。
   → 于是 `[]FOO,bar` 会原样变成 Clash 的 `FOO,bar,GROUP`，mihomo 会报未知规则类型。
   → `[]GEOIP,CN`、`[]FINAL`（→`MATCH`）是官方主张的用法。

3. **Surge / Loon 的远程 RULE-SET 引用**
   `rulesetToSurge`（`ruleconvert.cpp:358-376`）：当 `surge_ver > 2` 且 `rule_type == RULESET_SURGE` 时，直接写
   `RULE-SET,<rule_path>,<group>[,update-interval=N]`，**只引用 URL，不下载、不校验**。
   若类型不是 SURGE 且没有 `managed_config_prefix`，则 `continue` 丢弃（`:362-367`）。
   Loon/Surfboard 走 `Remote Rule` 段（`:351-356,385-390`）。

4. **`getruleset` type=1 的前缀过滤**
   只做 `startsWith(strLine, type)`（`interfaces.cpp:215-218`）。`startsWith` 是**前缀**匹配：
   `DOMAIN-SUFFIX2,x` 也能通过 `DOMAIN-SUFFIX` 的检查，`IP-CIDR6X,...` 也能过 `IP-CIDR6`。
   过了前缀检查后**不再校验值**（域名合法性、CIDR 前缀长度都不查）。

5. **`getruleset` type=6 整行透传**
   `interfaces.cpp:249-252`：`  - ` + 原行（含第 4 个字段 `no-resolve`），不校验。

6. **`renderClashScript` 的 `has_domain/has_ipcidr` 判定**
   `templates.cpp:459-466` 只判断每行是否以 `DOMAIN,`/`DOMAIN-SUFFIX,`/`IP-CIDR,`/`IP-CIDR6,` 开头来“打标”；其余行不影响 `behavior` 判定，也不会被报错——provider 的 `url` 仍指向原始内容（或 `getruleset`），由客户端自己解析。

7. **`transformRuleToCommon` 的兜底**
   `ruleconvert.cpp:98-123`：`<2` 个字段时补 `,group`；`>=3` 时保留第三段作为 flag（`no-resolve`）。不校验第二段内容。

> 迁移含义：如果 Worker 想做“更严格”的校验，**必须提供兼容开关**，否则老配置里大量 `[]` 自定义规则、`RULE-SET` 引用会行为改变。

### 5.5 rule-provider 的生成（`expand=false` / `script=true`）

见 §3.1.4。补充：

- provider 名 = 规则文件名（去扩展名，`urlDecode`），重名加 `" 2"`；与 URL 无关（issue #815 关心的是名字里的 `%20`）。
- `path` 用 `hash_(url)`——**自实现的 64 位 FNV-1a**（`src/utils/string_hash.h:9-27`），不是 `std::hash`，因此跨平台/编译器**确定**【证实】。
- `behavior` 由**实际内容**决定：只要出现过 `DOMAIN,`/`DOMAIN-SUFFIX,` 就标 `domain`；出现过 `IP-CIDR` 就额外生成一个 `ipcidr` provider；都没出现才是 `classical`（`templates.cpp:459-531`）。
- 若 `rule_path` 是本地文件且 `surge_ver > 2` 且 `managed_config_prefix` 非空，Surge 输出会用 `getruleset?type=1&url=<b64>` 自引用（`ruleconvert.cpp:334-343`）。

---

## 6. 相关 issue 取证

> 检索方式：GitHub Search API，`curl -G https://api.github.com/search/issues --data-urlencode "q=repo:tindy2013/subconverter <kw>"`。以下是**实际读到的 issue 正文**，不是猜测。

| # | 标题 | 状态 | 与本任务的关系 | 结论 |
| --- | --- | --- | --- | --- |
| [#409](https://github.com/tindy2013/subconverter/issues/409) | 获取规则的大小为1.x兆时报错 `Maximum file size exceeded` | closed | **下载截断** | 报错文本是 libcurl 对 `CURLOPT_MAXFILESIZE` 的固定错误串，说明确实触发了 `max_allowed_download_size`（`webget.cpp:68-80,139`）。具体阈值取决于当时的配置；编译期默认是 1048576（`settings.h:33`） |
| [#770](https://github.com/tindy2013/subconverter/issues/770) | `max_allowed_download_size=0` 没有生效 | **open** | **下载截断** | 用户把三个上限都设 0 后，10 万行的 ChinaMax 规则集仍被跳过。**原因未在 issue 中定论**；代码里 `0` 确实表示“不限制”（`size_checker` 只在非 0 时生效），因此另有原因（如 15s `CURLOPT_TIMEOUT`、`max_allowed_rules` 比较 `total_rules > max` 的边界、或 `explodeSurge`/`convertRuleset` 的解析耗时）。【推断，未验证】 |
| [#667](https://github.com/tindy2013/subconverter/issues/667) | Surge 的 DOMAIN-SET 生成问题 | closed | **DOMAIN/DOMAIN-SUFFIX** | 用户指出 type=5 时 `DOMAIN-SUFFIX` 应以 `.` 开头；当前代码 `interfaces.cpp:244-245` 已实现 `if(strLine[posb-2]=='X') output_content += '.';`，即**该 issue 已被修复**（修复方式与 issue 里的建议一致） |
| [#759](https://github.com/tindy2013/subconverter/issues/759) | 需要增加 Surge 的 domain-set 生成 | **open** | **规则格式** | 希望 `ruleset=` 能在 Surge 目标下生成 DOMAIN-SET；现状是 Surge 只能生成 RULE-SET（`RULESET_SURGE` 直通/引用） |
| [#752](https://github.com/tindy2013/subconverter/pull/752) | fix: clash rule-provider without `payload:` | closed，**未合并**（`merged_at: null`） | **规则格式** | 提议让 `clash-domain:`/`clash-ipcidr:` 类型在**没有 `payload:` 头**时也能正确解析。未合并 → 当前 `convertRuleset` 对无 `payload:` 的内容一律走 QuanX 分支，会给每行加 `DOMAIN,` 前缀 |
| [#749](https://github.com/tindy2013/subconverter/issues/749) | Clash 规则转换：支持 IP-ASN 与注释处理 | **open** | **规则格式** | 两个诉求：① `IP-ASN` 被丢弃（`ClashRuleTypes` 无此项，`ruleconvert.cpp:12-13`）；② 行内 `#` 注释不被处理（代码只处理 `//`，`ruleconvert.cpp:175-179`） |
| [#815](https://github.com/tindy2013/subconverter/issues/815) | rule-providers 名称里的 `%20` 能否还原成空格 | closed | **规则格式** | 报告 `expand=false` 时 provider 名是 `Domestic%20IPs`。当前 master 写的是 `urlDecode(findFileName(rule_path))`（`templates.cpp:360`），`urlDecode` 会把 `%20` 解成空格（`src/utils/urlencode.cpp:46-64`）→ 该问题在 master 上应已修复【推断：未运行验证】 |
| [#646](https://github.com/tindy2013/subconverter/issues/646) | 本地生成 `expand=false` 不生效 | **open** | 规则/模板 | 用户 `config.ini` 里写 `{% if %}` 且 `expand=false`；说明外部配置确实会被当模板渲染（§4.3）。`expand=false` 需要 `managed_config_prefix` 非空才会生成 `rule-providers`（`subexport.cpp:721-733`），否则仍展开【推断】 |
| [#721](https://github.com/tindy2013/subconverter/issues/721) | Surge/Surfboard 转换后没有节点/部分分组被当成节点 | closed | 输入解析 | 提示 `explodeSurge` 会把“看起来像 key=value”的行当节点；与 §2.4 的宽松解析一致 |
| [#870](https://github.com/tindy2013/subconverter/issues/870) | 有的订阅地址不能订阅到节点（v0.9.0） | **open** | 输入解析 | 纯 hysteria2 的 Base64 订阅返回 `Invalid subscription`。我按源码推演该样例应能解析（`hysteria2://uuid@ip:port/?…#name` 会被 `/\?`→`?` 后正确切分），**未能定位原因**，作为已知未解决缺陷记录 |
| [#738](https://github.com/tindy2013/subconverter/issues/738) | 转换的 route 规则中 `geoip` 拼写变成 `eoip` | closed | 规则格式 | 规则文本在转换链路中首字母被吞（issue 未给出根因）；提醒移植时必须做“规则文本逐字节保真”测试，尤其 `convertRuleset` 的正则替换 |

**关于 “DOMA”**：在仓库内 `grep -rnw "DOMA" src include README-cn.md base` **零命中**；GitHub issue 搜索 `DOMA` 也是 `total 0`。代码里与它最接近的是 `DOMAIN` / `DOMAIN-SUFFIX`（§5.1、#667）。因此不存在名为 DOMA 的规则类型或常量；若上游需求里出现 “DOMA”，应确认是否指 `DOMAIN` 系列规则或 DOMAIN-SET（§5.1 type=5）。

---

## 7. 迁移到 Cloudflare Worker 的风险清单

按“会直接导致行为不一致”排序。

| # | 风险 | 原版行为（证据） | Worker 上的后果 / 建议 |
| --- | --- | --- | --- |
| R1 | **下载超时 15 s 且不可配置** | `webget.cpp:134` `CURLOPT_TIMEOUT 15`；`max_fails=1`，且 APIMode 下**不重试**（`:233-241`） | 大订阅/慢源直接丢节点。Worker 需要显式超时策略（`fetch` + `AbortSignal.timeout`），并明确“超时=整条订阅失败”还是“跳过” |
| R2 | **非 200 / 传输失败 → 内容被清空** | `webget.cpp:266-271`：失败即 `data->clear(); shrink_to_fit()` | 上游 5xx/403 无法把错误文本透出，最终表现为 `Invalid subscription` / `No nodes were found!`。Worker 应保留“失败原因”以便排障，但对外错误文本要保持一致 |
| R3 | **下载大小上限，超限即整段丢弃（不是截断）** | `webget.cpp:68-80,139`（`CURLOPT_MAXFILESIZE` + 进度回调 `dlnow > limit` 返回 1 中止）；默认 1 MB（`settings.h:33`），示例配置 0=不限（`pref.example.ini:283`） | 必须决定 Worker 的默认上限；区间语义是“超限=空”，不是“截断到上限” |
| R4 | **TLS 校验被关闭** | `webget.cpp:132-133` `SSL_VERIFYPEER=0`, `SSL_VERIFYHOST=0` | Worker 的 `fetch` 无法关闭校验，且对自签源会失败 → 需在规格里声明“不支持无证书源” |
| R5 | **请求头转发** | `webserver_httplib.cpp:15-27,42-51` 除 `host/accept/accept-encoding` 外全转发；`webget.cpp:178-180` 无 UA 时用 `subconverter/<ver> cURL/<ver>`；并加 `SubConverter-Request: 1`（`:181`） | Cloudflare 会改写/禁止部分头（`Host`、`Cookie` 等）；UA 默认值会变。需要白名单策略并固定 UA |
| R6 | **无 VLESS** | 全仓库 0 命中 | 若目标要 VLESS，是新增解析/生成，必须单独立项与验收 |
| R7 | **PCRE2 方言** | `regMatch` 是**整串锚定**（`PCRE2_ANCHORED` + `PCRE2_ENDANCHORED`，`regexp.cpp:134-141`）；`regFind` 是搜索（`:143-150`）；`regReplace` 默认 **global+multiline**（`regexp.h:8`）；配置里 `(?i)` 内联标志、`\U$1\E`、`${3:-}` 等 PCRE2/替换语法（`ruleconvert.cpp:93`） | JS `RegExp` 不支持 `(?i)`、`\U`、`${x:-y}`；`regMatch` 需要加 `^(?:…)$`。必须做正则适配层 + 迁移测试用例 |
| R8 | **INI 方言** | 键名前缀匹配 `get_all`（`ini_reader.h:417-434`）、仅整行注释、`\n`/`\r`/`\t` 反转义、无段行归 `[custom]`、重复段合并 | 自己写解析器时容易只实现“标准 INI”，导致 `ruleset=`/`custom_proxy_group=` 取不到值（它们是**前缀** 匹配） |
| R9 | **默认字段名依赖 pref** | 编译期 `clash_use_new_field_name=false`（`settings.h:50`），示例配置 `true`（`pref.example.ini:110`） | 不锁定基线就会出现 `Proxy` vs `proxies` 的验收分歧 |
| R10 | **`expand` 的隐式耦合** | clash 目标下 `expand` 默认 true；`expand=false` 强制 `new_name=true`（`interfaces.cpp:410-433`）；且 `expand=false` 只有 `managed_config_prefix` 非空才真的生成 provider（`subexport.cpp:721-733`） | 需要把 `expand×new_name×managed_config_prefix` 三者的组合行为写成真值表并逐项测试 |
| R11 | **规则文本是字符串拼接** | `rulesetToClashStr` 把 `rules:` 追加在 `YAML::Dump()` 之后（`subexport.cpp:735-740`），缩进固定、无 YAML 转义 | 用真正的 YAML 序列化器会改变输出（引号、顺序、换行），diff 测试会全红；需要“按文本生成”还是“按语义生成”做决策 |
| R12 | **行内 `#` 注释不剥离** | `ruleconvert.cpp:175-179` 只处理 `//` | mihomo 会把 `DOMAIN,x # comment` 当域名解析失败；Worker 若修掉它，会改变行为（可用开关） |
| R13 | **未知规则类型/列数不足被静默丢弃** | `none_of(ClashRuleTypes)` → `continue`（`ruleconvert.cpp:173-174`）；`filterLine()` 对“无逗号行”返回 1 丢弃（`interfaces.cpp:177-193`） | 静默丢规则非常难排障；Worker 应记指标/日志，但默认行为要保持 |
| R14 | **`[]` 行内规则不校验** | §5.4(2) | 若加校验，老配置会 400/丢规则 |
| R15 | **`getruleset` 空结果仍返回 200 + 占位行** | `interfaces.cpp:278-292` | 验收要覆盖“源非空但全被过滤”的用例，期望占位而非 400 |
| R16 | **`getruleset` 可读本地文件** | `refreshRulesets` → `fetchFileAsync(..., find_local=true)`（`settings.cpp:277`；`multithread.cpp:66-69`），仅拦 `..`/绝对路径（`file.cpp:7-17`） | Worker 无本地 FS：需把 `url` 限制为 http(s)/data，并对 `file:` 语义给出明确错误 |
| R17 | **配置写接口** | `/updateconf` 写 `prefPath`（`main.cpp:238`）；`/getlocal` 读任意相对路径（`main.cpp:287`） | 不应移植；迁移时须在路由层删除 |
| R18 | **`#!MANAGED-CONFIG` 指向 127.0.0.1** | `interfaces.cpp:808-811`；示例配置 `managed_config_prefix=http://127.0.0.1:25500`（`pref.example.ini:140`） | 直接把示例配置搬过来，Surge 客户端会拿到指向 localhost 的托管配置 |
| R19 | **`Subscription-UserInfo` 透传** | `interfaces.cpp:668-669`；来源 `infoparser.cpp:71-84` | Worker 需保留同名响应头，且 `append_info=false` 时不能带 |
| R20 | **`interval/3600` 整数除法** | `interfaces.cpp:765` | `interval=3599` → `profile-update-interval: 0`；验收要覆盖 |
| R21 | **JS 脚本能力（filter/rename/sort/group/parse）** | QuickJS，仅 `authorized` 时执行（`nodemanip.cpp:381,204-219`；`groupGenerate`） | Worker 内执行用户 JS 有安全与 CPU 限制问题；建议直接不支持并返回明确错误（这是能力回退，需产品确认） |
| R22 | **无节点去重** | 无 `std::unique` 节点去重；只做重名改名（`subexport.cpp:186-193`） | 若 Worker 自作主张去重，节点数会变少 |
| R23 | **`mixed` 只支持 4 种协议** | `proxyToSingle` 的 `default: continue`（`subexport.cpp:1162-1163`） | Hysteria2/AnyTLS/WireGuard/Snell 在 `target=mixed`、`ss`、`ssr`、`v2ray`、`trojan` 下静默消失 |
| R24 | **`explodeSurge` 的 anytls 落空** | `subparser.cpp:2400-2437` 缺 `break`，落入 `default: continue` | 原版不产出的节点，Worker 若“修好”了会多节点；属于行为差异，需明确是否保留 bug 兼容 |
| R25 | **Clash YAML 输入异常会 500** | `explodeSub` 里 `catch(...) { throw; }`（`subparser.cpp:2628-2633`） | Worker 需决定：复刻 500，还是 400 + 可读错误 |

---

## 8. 本次未能验证的事项（如实记录）

1. **未编译、未运行 subconverter**：所有运行时行为（包括正则替换结果、YAML 输出细节、`hash_()` 的具体取值）均为静态推演。
2. **raw.githubusercontent.com 不可达**（25 s 超时），因此无法逐文件点开 GitHub 网页比对；改用 codeload 的完整 tar 包（同样来自 GitHub，内容等价）。
3. **未抓取 Wiki**（302 重定向后未跟进）；文档以 `README-cn.md` 为准。
4. **未验证 issue #770 的真实根因**（大规则集仍失败）：issue 本身未定论，我也没有运行环境复现。
5. **未验证 issue #870 的根因**：按代码推演该样例应可解析，结论留白。
6. **未核对历史版本（v0.8.1 等）与本快照的差异**：本文所有行号/行为仅对应 commit `a0d4eab`。
7. **未验证 `singbox` 目标的完整字段映射**（本文只记录了入口与规则类型差异，未逐字段核对）。

---

## 9. 来源索引

### 9.1 主要源码文件（GitHub 上同 commit 路径）

基址：`https://github.com/tindy2013/subconverter/blob/a0d4eab28cb8b6c782d4ce5c3a918de4829b4a72/`

| 文件 | 关键内容 |
| --- | --- |
| `src/handler/interfaces.cpp` | 所有 HTTP handler、`/sub` 参数、`/getruleset` |
| `src/main.cpp` | 路由注册、pref 选择 |
| `src/server/webserver_httplib.cpp` | HTTP 层、CORS、鉴权、别名重定向、异常处理 |
| `src/server/webserver.h` | `Request`/`Response`/`responseRoute` 定义 |
| `src/parser/subparser.cpp` | 所有输入协议解析 |
| `src/parser/infoparser.cpp` | Subscription-UserInfo |
| `src/parser/config/proxy.h` | `ProxyType`、`Proxy`、默认组名 |
| `src/generator/config/subexport.cpp` | 所有目标格式生成 |
| `src/generator/config/nodemanip.cpp` | 订阅下载、过滤、重命名、emoji、排序 |
| `src/generator/config/ruleconvert.cpp` | 规则方言转换、规则生成 |
| `src/generator/config/subexport.h` | `extra_settings` |
| `src/generator/template/templates.cpp` | inja 渲染、rule-providers、Clash Script |
| `src/config/binding.h` | `custom_proxy_group` / `ruleset` / `rename` / `emoji` 的 INI 解析 |
| `src/config/proxygroup.h` | 策略组类型枚举 |
| `src/handler/settings.cpp` | pref 读取、外部配置、ruleset 刷新 |
| `src/handler/settings.h` | 全部编译期默认值 |
| `src/handler/webget.cpp` | 下载、超时、大小限制、缓存 |
| `src/handler/multithread.cpp` | `fetchFile` 本地/远程分流 |
| `src/utils/ini_reader/ini_reader.h` | INI 语法 |
| `src/utils/regexp.cpp` / `.h` | PCRE2 封装与默认参数 |
| `src/utils/base64/base64.cpp` | 宽松 Base64 |
| `src/utils/file.cpp` | 路径越界检查 |
| `src/utils/tribool.h` | 三态布尔 |
| `CMakeLists.txt` | 默认 HTTP 后端 |
| `README-cn.md` | 官方中文文档 |

### 9.2 官方文档位置（README-cn.md）

- 支持类型矩阵：`:118-153`
- 简易用法与参数：`:161-267`
- 进阶参数表（全部 query 参数）：`:308-342`
- 配置档案 `/getprofile`：`:364-405`
- `[ruleset]` 语法：`:870-919`
- `[proxy_group]` 语法与匹配 DSL：`:921-990`
- `[aliases]`：`:992-1015`
- `[template]`：`:1055+`
- 模板功能：`:1229-1363`
- `/getruleset`：`:1427-1445`

### 9.3 随包示例配置

- `base/pref.example.ini`（含 `[aliases]`、`[rulesets]`、`[proxy_groups]`、`[emojis]`、`[managed_config]`、`[advanced]`）
- `base/config/example_external_config.ini`（`[custom]` 全键示例，`:1-66`）
- `base/base/all_base.tpl`（多目标 base 模板）
- `base/snippets/{groups,rulesets,emoji,rename_node}.txt`（`!!import:` 目标）

### 9.4 Issue / PR

见 §6 表格中的链接（#409、#646、#667、#721、#738、#749、#752、#759、#770、#815、#870）。
