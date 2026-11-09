# 兼容矩阵与差距（PARITY）

- 本项目：`subconverter-worker` 1.0.0（mihomo/Clash only）
- 对照对象：tindy2013/subconverter `a0d4eab28cb8b6c782d4ce5c3a918de4829b4a72`（v0.9.0）
- 参考审计：dianbanjiu/subconverter `01fbd67633c34f9924a9c7488e1a1cc02ef69610`
- 证据：`docs/research/original-subconverter.md`、`docs/research/reference-audit.md`、`docs/research/doma-diagnosis.md`、`docs/research/cloudflare-workers.md`

> 本文件的“tindy”列只描述**行为**，不代表复制其代码。tindy 是 GPL-3.0；本项目为清洁室实现（见 §1）。

---

## 1. 结论摘要

| 维度 | tindy v0.9.0 | 本项目 v1 | 判定 |
|---|---|---|---|
| 真实端点 | `/sub`、`/sub2clashr`、`/surge2clash`、`/getruleset`、`/getprofile`、`/render`、`/version`、`/refreshrules`、`/readconf`、`/updateconf`、`/flushcache`（+ 非 API 的 `/get`、`/getlocal`）；`/clash` 等是 302 别名 | `/sub`、`/clash`（真实路由）、`/getruleset`、`/version`、`/` | **有意收窄** |
| target | 15 个 + `auto`（UA 白名单） | 仅 `clash`（mihomo） | **有意收窄** |
| 输入格式 | URL/文件/data URI、`\|` 合并、Clash/Surge/QuanX/Loon/SS/SSD/SSR/v2rayN/SSAndroid/SSTap/Netch 等 | Base64、纯文本 URI、Clash YAML（仅 proxies）；`inline:`/`data:` | **收窄** |
| 协议 | SS/SSR/VMess/Trojan/Snell/HTTP/HTTPS/SOCKS5/WireGuard/Hysteria/Hysteria2/AnyTLS；**无 VLESS** | SS/SSR/VMess/Trojan/**VLESS** | 5 种；VLESS 是新增 |
| 规则 | 类型前缀白名单（13 个）+ 多条直通/静默丢弃路径；`/getruleset` 6 种 type | 37 类型精确注册表 + payload/目标校验；`/getruleset` type 3/4/6 | **更严格** |
| Clash 输出 | 新/旧字段名可配；rules 字符串拼接、不加引号；base 规则可透传 | 永远新字段名；rules 强制双引号；模板规则必须校验；读回校验 | **更安全** |
| 非法规则 | `DOMA` 可从 base 透传/`[]DOMA`/截断产生；大量静默丢弃 | 缺 target/未知类型/坏 payload 一律丢弃 + 结构化 Warning；尾部截断检测 | **修复** |
| 下载 | 15 s 硬超时；关闭 TLS 校验；非 200/超限清空内容 | 10 s 总 deadline、5 s/跳；TLS 必须有效；错误可区分；不静默清空 | **有意改变** |
| 安全 | 本地文件读取、配置写接口、脚本执行、转发上游头 | 无本地文件、无写接口、无脚本、无上游头透传；SSRF/限长/限时 | **有意收窄** |
| ACL4SSR INI | 完整 `[custom]` + inja 模板 + 完整 DSL | 子集（组/规则/rename/include/exclude/clash_rule_base） | **部分兼容** |
| 参考实现 dianbanjiu | — | 借鉴 IR/状态码/流式限长思路；不复刻 SSRF/无超时/js-yaml/规则丢弃 | 见 §11 |

**一句话**：本项目的“兼容”是**对 mihomo 用户有用的行为兼容**，不是 tindy 全功能克隆。所有收窄都会返回明确错误或在 PARITY 中登记，不做“看起来支持、实际不同物”的伪兼容。

---

## 2. 端点兼容

| tindy 端点 | tindy 行为 | 本项目 | 说明 |
|---|---|---|---|
| `/sub` | 主转换，参数矩阵 30+ | `/sub`（子集） | 见 §6 |
| `/clash` | **不是路由**，是 `[aliases]` 的 302 → `/sub?target=clash`（`original:71-74`） | 真实路由，等价 `/sub?target=clash` | 不依赖 pref 别名；行为更可预测 |
| `/surge`、`/ss`、`/v2ray` 等 | 302 别名 | 404 | v1 不支持 |
| `/sub2clashr` | ClashR 输出 | 不存在 | 不支持 clashr |
| `/surge2clash` | Surge conf → Clash | 不存在；Surge 输入不在 v1 | 可用本文档 §5 的协议矩阵评估未来 |
| `/getruleset` | type 1..6；`url` 为 urlsafe-base64；type=2 必填 group | type 3/4/6；`src` 或 tindy 兼容 `url`；空结果占位 | 只服务 mihomo provider |
| `/getprofile` | 读取 profile、拼参数、可能读本地文件 | 不存在 | 无本地 FS/无 profile 概念 |
| `/render` | inja 模板渲染任意路径 | 不存在 | 模板只在内存中 sanitize/合并，不执行模板语言 |
| `/version` | `subconverter v0.9.0 backend\n` | `subconverter-worker 1.0.0 target=clash\n` | 文本形态兼容，内容不同 |
| `/refreshrules`、`/readconf`、`/updateconf`、`/flushcache` | 运行时管理/写配置 | 不存在 | 安全收窄；无状态 Worker 无此概念 |
| `/get`、`/getlocal` | 非 API 模式读任意路径 | 不存在 | 安全收窄 |
| `/` | 404（路由被注释） | 200 帮助页 | 新增 |

---

## 3. target 兼容

tindy 的合法 target 共 15 个 + `auto`（`original:130-158`）；`auto` 依赖 User-Agent 白名单，未命中直接 400。

| target | tindy | 本项目 | 备注 |
|---|---|---|---|
| `clash` | ✅ | ✅（唯一） | mihomo 方言；永远新字段名 |
| `clashr` | ✅ | ❌ 400 `unsupported_target` | 不做旧 SSR 字段 |
| `surge` / `surfboard` | ✅ | ❌ | 非 Clash |
| `loon` / `quan` / `quanx` / `mellow` | ✅ | ❌ | 非 Clash |
| `singbox` | ✅ | ❌ | 非 Clash；未来可单独立项 |
| `ss` / `ssr` / `v2ray` / `trojan` / `mixed` | ✅ | ❌ | 单链接输出 |
| `ssd` / `sssub` | ✅ | ❌ | SSD/SIP008 |
| `auto` | ✅（UA 表） | ❌ 400 | 不做 UA 嗅探；客户端显式传 `clash` |
| 缺省 target | 400（必填） | 默认 `clash` | 更宽松；PARITY 记录 |
| `target=clash-meta` | 非法（tindy 无此值） | 400 | 不制造“clash/clash-meta 同物”的假象（参考实现的问题：`reference:118-120`） |

---

## 4. 输入格式与协议

### 4.1 输入容器

| 输入 | tindy | 本项目 |
|---|---|---|
| Base64 订阅 | ✅（宽松解码；非 base64 字符原样复制） | ✅（严格解码；UTF-8 fatal；可打印率检查） |
| 纯文本 URI 列表 | ⚠️ 实际不可靠（tindy 会无条件先做 base64，见 `original:336-339`） | ✅（显式检测，明文优先） |
| Clash YAML | ✅（只读 `proxies`/`Proxy`） | ✅（只读 `proxies`/`Proxy`；组/规则段告警忽略） |
| data URI | ✅ | ✅（仅 `text/plain;base64`） |
| 本地文件路径 | ✅（非 API 模式） | ❌（无本地 FS） |
| `\|` 多订阅 | ✅ | ✅（最多 8 个） |
| `tag:组名,链接` | ✅ | ✅（`tag:<label>,<source>`） |
| `script:` / `nullnode` | ✅ | ❌（无脚本；nullnode 无意义） |
| SSD/SIP008/v2rayN/SSTap/Netch/SSAndroid/Surge/Loon/QuanX 输入 | ✅ | ❌（`unsupported_input_format`） |
| Clash 输入的 `proxy-groups`/`rules` | 忽略 | 忽略 + `W_CLASH_SECTION_IGNORED` |
| 输入节点去重 | 无 | 无（只做重名改名） |

### 4.2 协议

| 协议 | tindy | 本项目 | 说明 |
|---|---|---|---|
| SS | ✅ | ✅ | SIP002/旧式/明文；plugin 仅 obfs/v2ray-plugin |
| SSR | ✅ | ✅ | 含 IPv6 的“最后 5 个冒号”解析 |
| VMess | ✅ | ✅ | JSON v2 + URI；传输 tcp/ws/grpc |
| Trojan | ✅ | ✅ | 传输 tcp/ws/grpc |
| VLESS | ❌ **全仓库零命中**（`original:296-300`） | ✅ **新增** | Reality/ws/grpc/tcp；flow vision |
| Snell | ✅（Clash/Surge 输入） | ❌ | v1 非目标 |
| WireGuard | ✅（Clash/Surge 输入） | ❌ | v1 非目标 |
| Hysteria v1 / Hysteria2 | ✅ | ❌ | v1 非目标 |
| AnyTLS | ✅ | ❌ | v1 非目标 |
| SOCKS5 / HTTP(S) | ✅ | ❌ | v1 非目标 |
| TUIC | ❌ | ❌ | 双方都不支持 |
| SSD `ssd://` | ✅ | ❌ | v1 非目标 |

**迁移影响**：含 Snell/WireGuard/Hysteria2/TUIC 的订阅会丢节点并产生 `W_NODE_UNSUPPORTED_PROTOCOL`；不会产生坏配置。需要这些协议时应新增 IR/parser/emitter（ARCHITECTURE §12.1）。

---

## 5. 参数兼容

### 5.1 支持

`url`、`target`、`config`、`ruleset`、`groups`、`template`、`rules_mode`/`expand`、`diagnostics`、`include`、`exclude`、`rename`、`sort`、`udp`、`tfo`、`scv`、`group`、`interval`、`append_info`、`filename`。

### 5.2 已知但不支持（忽略 + `W_PARAM_UNSUPPORTED`）

`new_name`、`ver`、`sort_script`、`script`、`list`、`insert`、`prepend`、`fdn`、`append_type`、`emoji`、`add_emoji`、`remove_emoji`、`dev_id`、`token`、`upload`、`upload_path`、`profile_data`、`filter_script`、`strict`、`surge`。

- **不得**执行其语义：不上传 Gist、不运行 JS、不读本地文件、不根据 target 改字段名。
- 这些参数出现时不会 400，避免老客户端直接坏掉；但会在 Warning 中明确“未执行”。

### 5.3 语义差异

| 参数/行为 | tindy | 本项目 |
|---|---|---|
| `target` 缺省 | 400 | 默认 `clash` |
| `auto` | UA 白名单 | 400 |
| 无值布尔（`?emoji`） | 视为未设置（tribool indeterminate） | 视为 `true` |
| `include`/`exclude` 非法正则 | 逐条丢弃；全无效则保留原配置 | 400 `invalid_regex`（fail-closed） |
| `rename` 语法 | `` ` `` 分隔多条 `pattern@replacement` | 重复 `rename` 参数；每个 `pattern@replacement` |
| `config` 与 `groups`/`ruleset` | config 存在时忽略 query | 同左 + Warning |
| `expand` | clash 下默认 true；`false` 需 `managed_config_prefix` 才生成 provider | `rules_mode=providers` 生成 provider；无需外部 prefix，使用 request origin |
| `new_name` | 可切旧字段名 | 永远新字段名 |
| `token` | API 模式鉴权 | 无鉴权；忽略 + Warning |
| `upload` | Gist 上传 | 不存在；忽略 + Warning |
| `interval` | Clash `profile-update-interval` + Surge 头 | 只影响 `profile-update-interval` |
| `append_info` | 透传 `Subscription-UserInfo` | 同左，但先做正则/长度校验 |

---

## 6. 规则管线兼容（重点）

### 6.1 tindy 的类型白名单 vs 本项目

tindy 的 `ClashRuleTypes` 只有 13 个前缀：`DOMAIN`、`DOMAIN-SUFFIX`、`DOMAIN-KEYWORD`、`IP-CIDR`、`SRC-IP-CIDR`、`GEOIP`、`MATCH`、`FINAL`、`IP-CIDR6`、`SRC-PORT`、`DST-PORT`、`PROCESS-NAME`（`doma:301-302`）。它用 `startsWith` 做前缀匹配（`doma:319-320`），所以：

- `MATCHBOX`、`DOMAIN-FOO` 可通过；
- `FINAL` 在普通规则集路径不会被转成 `MATCH`（P3）；
- `DOMAIN-REGEX` 因以 `DOMAIN` 开头而通过，随后被朴素逗号分割破坏（P5）。

本项目改为 **37 个精确类型 + 类型分组 + payload 校验 + target 校验**（SPEC §5）。这是“彻底避免 DOMA”的核心。

### 6.2 直通路径的处置

| tindy 直通路径 | 证据 | 本项目 |
|---|---|---|
| `convertRuleset` 对 `RULESET_SURGE` 直接 `return content` | `original:721-729` | 所有内容必须走 `dialects → parse → validate`；不存在直通 |
| `[]` 行内规则只 `substr(2)` + 补 group，不校验类型 | `original:732-735`；P2 | `[]RULE` 按普通规则解析；未知类型/缺 payload 丢弃 + Warning |
| base 配置 `rules` 原样复制（`overwrite_original_rules=false`） | `doma:317`；P1 | 模板规则逐条校验；默认 `overwrite_original_rules=true` 直接丢弃模板规则 |
| Surge/Loon 远程 `RULE-SET` 只写 URL 不校验 | `original:737-741` | provider 模式只引用本 Worker 的 `/getruleset`，内容重新校验 |
| `getruleset` type=1 前缀过滤、不校验值 | `original:743-746` | v1 不支持 type=1；type 3/4/6 均校验 |
| `getruleset` type=6 整行透传 | `original:748-749` | type=6 逐条解析/过滤，输出无 target 的已校验行 |
| `renderClashScript` 只按前缀统计 behavior | `original:751-752` | provider behavior 由**已校验规则类型**决定 |

### 6.3 DOMA 根因逐项映射（来自 `doma-diagnosis.md` P1–P18）

| 路径 | 原版行为（证据） | 本项目处置 | 结果 |
|---|---|---|---|
| P1 base 规则原样透传 | `ruleconvert.cpp:201-205`；`doma:317` | 模板规则必须经过同一校验器；默认 `overwrite_original_rules=true` 丢弃 | 裸 `DOMA` 无法进入输出 |
| P2 `[]DOMA` 内联透传 | `ruleconvert.cpp:220-229`；`doma:318` | `[]RULE` 解析后精确类型校验；`DOMA` 不在注册表 | 丢弃 + `E_RULE_UNKNOWN_TYPE` |
| P3 `FINAL` 未转 `MATCH` | `doma:319` | 别名表 `FINAL → MATCH`，产生 `W_RULE_TYPE_ALIAS` | 输出合法 `MATCH` |
| P4 前缀白名单放过 `MATCHBOX` | `doma:320` | 精确匹配；`MATCHBOX` 不在注册表 | 丢弃 + `E_RULE_UNKNOWN_TYPE` |
| P5 朴素逗号分割破坏 `DOMAIN-REGEX` | `doma:321` | 类型感知拆分；规则集来源先剥离命中 knownTargets/wrapper 的最后字段，再重组 payload；明确禁止把 `,GROUP` 留在 payload | payload 保持完整 |
| P6 行内 `#` + 不加引号 | `doma:322` | 非正则 payload 截断 ` #`/` //` + Warning；输出规则强制双引号 | 不再产生 `DOMAIN,x` 两字段 |
| P7 下载在完整类型 token 处截断 | `doma:323` | 尾部检测：无换行且为类型/前缀/逗号结尾 → `E_TRUNCATED_TAIL` | 丢弃 + 高优先级 Warning |
| P8 下载在 `DOMA` 处截断 | `doma:324` | typed 方言尾部检测；domain 方言用声明计数/尾部启发式 | 不会静默输出；告警 |
| P9/P10 BOM | `doma:325-326` | 解析前剥离 BOM；`payload:` 检测不再被 BOM 破坏 | 规则正常 |
| P11 小写类型 | `doma:327` | `trim().toUpperCase()` 后精确匹配（mihomo 本身大小写不敏感） | 正常接受 |
| P12 CRLF | `doma:328` | 统一 LF；YAML 解析器处理 CRLF | 正常 |
| P13 空行/整行注释 | `doma:329` | 跳过 | 正常 |
| P14 空 `[]` UB | `doma:330` | 空规则 → `E_RULE_EMPTY`，不输出 | 不会产生 `,GROUP` |
| P15 HTTP 200 HTML 错误页 | `doma:331` | Content-Type/正文嗅探 HTML → `E_FETCH_HTML`，source 失败 | 不会把 HTML 当规则 |
| P16 HTTP 非 200 | `doma:332` | 502 `upstream_status`，不清空后继续 | 可排障 |
| P17 `max_allowed_rules` 截断 | `doma:333` | MAX_RULES 截断在完整行边界 + `W_RULE_LIMIT` | 不会半截 |
| P18 大小/15s 超时 | `doma:334` | 413/504，可区分；不静默跳过 | 可排障 |

### 6.4 其它规则行为差异

| 行为 | tindy | 本项目 |
|---|---|---|
| 类型大小写 | `startsWith` 大小写敏感；小写行静默丢 | `toUpperCase` 后精确匹配 |
| 行内 `#` | 从不剥离 | 非正则 payload 截断 + Warning |
| 行内 `//` | 截断 | 非正则 payload 截断；正则 payload 保留（避免破坏正则） |
| 未知类型 | 静默丢弃 | 丢弃 + `E_RULE_UNKNOWN_TYPE` |
| 列数不足 | 普通路径补 group；`[]`/base 可能产生坏行 | 规则集由 GROUP 补 target；模板缺 target → `E_RULE_NO_TARGET` |
| `FINAL` | 普通路径透传（非法） | 一律 `MATCH` |
| `MATCH` 多行 | 可能多行 | 只保留最后一条，其余 `W_RULE_DUPLICATE_MATCH` |
| 源里已有 target | 被当作第 3 字段/flag，可能错位 | 规则集来源由 GROUP 覆盖；仅 `no-resolve` 保留 |
| `no-resolve` | 任意第 3 字段都保留 | 只允许 `no-resolve`，否则 `W_RULE_PARAM_IGNORED` |
| 规则去重 | 无 | 无 |
| 规则输出引号 | 无（字符串拼接） | 强制双引号标量 |
| 输出读回 | 无 | 必须读回并断言 |
| 规则上限 | `max_allowed_rules` 默认 32768；0=不限 | 50,000；超限截断 + Warning |

---

## 6.5 tindy `getruleset` 与本项目

| type | tindy | 本项目 |
|---|---|---|
| 1 | Surge ruleset，前缀过滤，不校验 | ❌ 400 `unsupported_ruleset_type` |
| 2 | QuanX，需 group | ❌ |
| 3 | Clash domain provider；空结果 `--placeholder--` | ✅ 校验后 domain payload：`DOMAIN`→裸域名，`DOMAIN-SUFFIX`→`+.domain`；其它类型丢弃 + `W_RULESET_TYPE_FILTERED`；空结果 `+.placeholder.invalid`；**payload 不得出现 `DOMAIN-SUFFIX,`** |
| 4 | Clash ipcidr provider；空结果 `0.0.0.0/32` | ✅ 仅 `IP-CIDR`/`IP-CIDR6`→CIDR；其它丢弃 + Warning；空结果相同 |
| 5 | Surge DOMAIN-SET | ❌ |
| 6 | Clash classical；空结果 `DOMAIN,--placeholder--` | ✅ 除 `MATCH`/`RULE-SET`/`SUB-RULE` 外输出无 target 的 `TYPE,PAYLOAD[,no-resolve]`；空结果 `DOMAIN,placeholder.invalid` |
| `url` 编码 | urlsafe-base64 | `src` 明文或 `url` base64url |
| 多 url | `\|` 拼接 | v1 只接受一个 source（`src` 或 `url` 二选一） |
| 输出 Content-Type | `text/plain;charset=utf-8` | `text/yaml; charset=utf-8` |
| 空结果 HTTP | type 3/4/6 → 200 + 占位 | 200 + 占位 + `X-Subconverter-Placeholder` |
| 非 200 上游 | 清空 → 空结果/400 | 502/504（不伪装成空集） |

---

## 7. Clash 输出兼容

| 项 | tindy | 本项目 |
|---|---|---|
| 字段名 | `new_name` 可切 `Proxy`/`Proxy Group`/`Rule` | 永远 `proxies`/`proxy-groups`/`rules` |
| `proxies` 字段 | 按类型映射；端口整数；纯数字密码加引号 | 同目标；但所有字符串由 YAML emitter 安全引号化 |
| `proxy-groups` | select/url-test/fallback/load-balance/relay/ssid/smart；`smart`→url-test | 仅前 4 种；其它丢弃 + Warning |
| 组内无节点 | 补 `DIRECT` | 补 `DIRECT` + Warning |
| 同名组 | 替换原有组 | 重名加 `" 2"` + Warning（不静默替换） |
| `use:` / proxy-providers | 支持引用 base 里已有的 provider；从不生成 proxy-providers | 不支持；`!!PROVIDER` → Warning |
| `rules` | 字符串拼接在 YAML dump 之后；缩进固定；不加引号 | 结构化生成；规则 `Scalar QUOTE_DOUBLE`；最终换行 |
| `rule-providers` | `expand=false` + `managed_config_prefix`；name/hash/path 有自实现 FNV-1a | `rules_mode=providers`；name/hash/path 自有规则；URL 指向本 Worker 的 canonical `PUBLIC_ORIGIN`（未配置则 request origin + 禁止 public cache + `W_PROVIDER_ORIGIN_UNPINNED`） |
| 模板 | inja 全功能；`request/global/local` 变量；`fetch()` 函数 | 仅 YAML 顶层键 allowlist 合并；无模板语言、无 fetch |
| base 规则 | `overwrite_original_rules` 可保留 | 默认丢弃；显式 false 时校验后追加 |
| 输出风格 | flow/block/compact 可配 | 固定 `yaml` 默认 block；`indent:2`、`lineWidth:0` |
| 空 proxy-groups | 删除键 | 至少保留默认组（无配置时 PROXY/AUTO） |
| ClashR 旧 SSR 字段 | `protocolparam`/`obfsparam` | 不存在；永远 `protocol-param`/`obfs-param` |

---

## 8. ACL4SSR 风格 INI 子集

### 8.1 键级矩阵

| 键 | tindy | 本项目 | 说明 |
|---|---|---|---|
| `custom_proxy_group` | 完整 DSL：select/url-test/fallback/load-balance/relay/ssid/smart；`!!GROUP`/`!!GROUPID`/`!!INSERT`/`!!TYPE`/`!!PORT`/`!!SERVER`/`!!PROVIDER`/`script:`/`[]` | 子集：4 种类型；`[]`、`!!TYPE`、`!!GROUP`、`!!SERVER`、`!!PORT`、普通正则；其余告警忽略 | ACL4SSR 最常见的 `[]组` + `.*` 可工作 |
| `ruleset` / `surge_ruleset` | `GROUP,[type:]URL[,interval]`；`[]` 内联；`!!import:`；`\|` 多 URL | 同左，但 `!!import:` 不支持；`\|` 多 URL 不支持；`clash-classic:` 作为 `clash-classical:` 别名接受；`quanx:` 显式拒绝 | 单 URL 足够常见；tindy 拼写不再 400 |
| `clash_rule_base` | 路径/URL | source（URL/inline）或内置名；`base/all_base.tpl|.yml|.conf` 映射内置模板 + `W_BUILTIN_TEMPLATE_MAPPED`；其它裸本地路径 → `invalid_template` | 真实 ACL4SSR 配置里的 `base/all_base.tpl` 可用 |
| `overwrite_original_rules` | 默认 false（ExternalConfig 结构体） | 默认 **true** | 有意改变，降低 DOMA 风险 |
| `enable_rule_generator` | ✅ | ✅ | false 时只生成组 |
| `rename` | 多行 `pattern@replace`；PCRE2 替换语法 | 多行 `pattern@replacement`；JS `$1`；`\U`/`${x:-y}` 不支持 | 常见 `$1` 可用 |
| `include_remarks` / `exclude_remarks` | 多行正则 | 多行正则；非法/不安全 → 告警忽略 | |
| `emoji` / `add_emoji` / `remove_old_emoji` | ✅ | ❌ 告警忽略 | 非目标 |
| `surge_rule_base` / `quan_rule_base` / `loon_rule_base` / `singbox_rule_base` 等 | ✅ | ❌ 告警忽略 | 只支持 Clash |
| `[template]` 段 | 模板变量 | ❌ 告警忽略 | 无 inja |
| `filter_script` / `sort_script` / `script:` | QuickJS | ❌ | 安全收窄 |
| `!!import:` | 读本地/远程并展开 | ❌ 告警丢弃 | 无本地 FS；远程展开会扩大 SSRF 面 |
| `profile_token` / `update_interval` / `update_strict` | ✅ | ❌ 告警忽略 | 无 profile |
| inja/Jinja（`{% if %}`） | 外部配置先渲染 | ❌ 按普通文本，通常告警/无效 | 明确降级 |

### 8.2 判定：子集可行，完整兼容不可行

- **可行**：ACL4SSR 线上配置的核心是 `custom_proxy_group`（`[]组` + `.*` + `url-test`）和 `ruleset`（`GROUP,URL`），这两类在本项目中可用。
- **不可行/不计划**：inja 模板、`!!PROVIDER`（无 proxy-providers）、`script:`、emoji、relay/ssid/smart、完整 `!!GROUPID`/`!!INSERT`、任意本地路径。这些在 SPEC/PARITY 中明确降级，不假装支持；唯一的本地路径例外是 `base/all_base.tpl|.yml|.conf` 映射到内置模板。
- **迁移建议**：把 ACL4SSR 配置中的 `emoji`/`[template]`/`filter_script` 删掉；把 `!!PROVIDER` 改成显式节点正则；把 `script:` 改成静态组；把 `surge_rule_base` 改为 `clash_rule_base`/`template`。

---

## 9. 下载/超时/安全行为对比

| 项 | tindy | 本项目 |
|---|---|---|
| 连接超时 | 15 s 硬编码（`original:796`） | 总 deadline 10 s；单跳 5 s；可配 |
| TLS 校验 | 关闭（`original:801`） | 必须有效；不支持自签源 |
| 非 200 | 清空内容（`original:797`） | 502 `upstream_status`，保留原因码 |
| 大小超限 | 清空整段（`original:798`） | 413 `upstream_too_large`，流式取消 |
| 重定向 | 跟随（平台/库默认） | `manual`，最多 3 跳，每跳 SSRF 复检 |
| 上游头 | 除 host/accept/accept-encoding 外全部转发 | 只发固定 UA/Accept；不转发用户头 |
| 响应头 | 透传 `Subscription-UserInfo` | 校验后透传；其它不透传 |
| SSRF | 无（可读本地文件/data URI） | 协议/端口/IP 网段/主机名/重定向/平台 flag |
| 日志 | 可能记录 URL/配置 | 只记录 host hash/code/counts |
| 缓存 | 本地文件缓存 60/300/21600 s | 无 KV；Workers Cache 只缓存本服务响应；订阅默认 private |
| 脚本 | QuickJS（filter/sort/group/parse） | 不支持 |
| 配置写 | `/updateconf` 写 pref | 不存在 |
| 本地文件 | `/getlocal`、`fileGet` | 不存在 |

**生产注意**：Cloudflare 平台 egress 对“解析到私网的域名”的拦截、重定向逐跳行为，本架构阶段**未在真实账户验证**（`docs/research/cloudflare-workers.md:591-601`）。本项目已启用 `global_fetch_strictly_public` 并做应用层校验，但仍应在上线前用 canary URL 验证。

---

## 10. 默认值对比

| 项 | tindy 编译期 | tindy 示例 pref | 本项目 |
|---|---|---|---|
| Clash 字段名 | 旧名 | 新名 | **新名** |
| `api_mode` | true | false | 无此概念 |
| 监听 | 127.0.0.1:25500 | 0.0.0.0:25500 | Workers |
| `max_allowed_download_size` | 1 MiB | 0（不限） | 8 MiB/source，16 MiB 总 |
| `max_allowed_rules` | 32768 | 0 | 50,000 |
| `enable_cache` | 无开关（TTL 恒生效） | false | 无 KV；Workers Cache 响应级 |
| `clash_use_new_field_name` | false | true | true（固定） |
| `overwrite_original_rules` | true | false | **true** |
| `add_emoji`/`remove_old_emoji` | false/false | true/true | 不支持 |
| `update_interval` | 0 | 86400 | `interval` 参数，默认 0 |
| 默认 base | 空 | `base/all_base.tpl` | 内置最小 mihomo 模板 |
| `expand` | clash 下强制 true | — | `rules_mode=inline` 默认 |
| `managed_config_prefix` | 空 | 127.0.0.1:25500 | request origin 自动推导 |

---

## 11. 参考实现 dianbanjiu 的教训（不作为兼容目标）

| dianbanjiu 的问题 | 证据 | 本项目 |
|---|---|---|
| SSRF 只查字面量 host；`localhost.`、`nip.io`、`localtest.me`、302 可绕过 | `reference:180-228` | 数值 IP + 末尾点归一化 + 通配 DNS 拒绝表 + 逐跳复检 + 平台 flag |
| 无应用层超时；慢上游永久挂起 | `reference:230-251` | 总 deadline/单跳超时/504 |
| 锁定 `js-yaml@4.1.1`，merge-chain 162KB 耗时 1,585ms | `reference:319-342` | `yaml@2.9.x`，`maxAliasCount:50`，`merge:false`，大小/CPU 上限 |
| `port: .nan`、重复名/保留名、kcp 无 transport | `reference:294-317` | 端口 1..65535、名称分配器、传输白名单 |
| `clash` 与 `clash-meta` 输出相同；`clash` 写入 vless/hysteria2/tuic | `reference:118-120`、`:165` | 只声明 `target=clash`（mihomo），不制造同物别名 |
| 输入 `rules:`/`proxy-groups:` 全丢，输出固定 7 条 | `reference:390-435` | 完整规则管线；输入 Clash 组/规则忽略但告警 |
| 日志打印完整订阅 URL/URI | `reference:171`、`:356-360` | 日志脱敏，只留 host hash |
| KV 以明文 key 名存密钥 | `reference:264-270` | v1 无 KV/鉴权 |
| 无测试/CI/运行时 schema | `reference:347-354` | vitest 单元/集成/E2E + ownership + typecheck + dry-run |

**借鉴的思路**（不复制代码）：统一 IR、target 白名单、抓取层“Content-Length 预检 + 流式硬上限”、状态码语义化、Header 优先的鉴权 UX（本项目 v1 不做鉴权）。

---

## 12. 本架构阶段的验证状态（如实记录）

### 12.1 已执行

| 检查 | 命令/操作 | 结果 |
|---|---|---|
| 读取四份取证 | 读取 `docs/research/*.md` | 完成；本文引用其行号 |
| 依赖版本 | `npm view yaml version` / `npm view vitest version` / `npm view @cloudflare/vitest-plugin version peerDependencies --json` / `npm view typescript version` | `yaml 2.9.1`；`vitest 5.1.0`；`@cloudflare/vitest-plugin 1.6.0`（peer `vitest ^4.1.0 \|\| ^5.0.0`）；`typescript 7.0.2` |
| `yaml` 行为 | 临时目录 `npm i yaml@2.9.1`；Node 脚本 | `maxAliasCount:0` 抛 `ReferenceError: Alias resolution is disabled`；`merge:false` 时 `<<` 不被展开；`Scalar QUOTE_DOUBLE` 输出 `- "DOMAIN,a.com,PROXY"` |
| wrangler 配置 | 临时目录以 §2.1 的 `wrangler.jsonc` + 最小 `src/index.ts` 运行 `npx --yes wrangler@4.158.0 deploy --dry-run --outdir dist` | 退出 0；`Total Upload: 0.44 KiB`；**19 个 env vars** 被识别（含 `MAX_INLINE_SOURCE_CHARS`、`PUBLIC_ORIGIN`、`ENVIRONMENT`、`ALLOW_TEST_UPSTREAM_HOSTS`）；`cache.enabled`/`limits.cpu_ms`/`global_fetch_strictly_public` 被接受 |
| wrangler 测试配置 | 同一临时目录 `npx --yes wrangler@4.158.0 deploy --dry-run --config wrangler.test.jsonc --outdir dist-test` | 退出 0；`Total Upload: 0.44 KiB`；19 个 vars；`ENVIRONMENT=test`、`ALLOW_HTTP_UPSTREAM=true`、`UPSTREAM_ALLOWED_PORTS=80,443,8790`、`ALLOW_TEST_UPSTREAM_HOSTS=127.0.0.1:8790` 被接受；未包含 `global_fetch_strictly_public` |
| 大规则文件尺寸复核 | `node -e` 生成 20,674 条 `DOMAIN,xN,G`（评审样例）与 `DOMAIN,xN`（本项目 fixture）各加 `DOMA`，并算 base64url | 3 字段：`319678` / `426238`；2 字段：`278330` / `371107`；`8192 -> 10923 chars`、`16384 -> 21846 chars`；证明 inline 不可承载 20k 规则，且 16 KiB 解码不可行 |
| TypeScript | 同一临时目录 `npx tsc --noEmit`（TS 7.0.2 + workers-types 5.20261109.1） | 退出 0（仅最小样例） |
| Node/npm | `node --version` / `npm --version` | `v24.21.0` / `11.19.0` |

### 12.2 未执行（不得当成通过）

| 项 | 原因 |
|---|---|
| 全项目 `npm run typecheck` | 尚未实现代码；只做了最小样例 |
| 全项目 `npm test` / unit / integration | 尚未实现代码 |
| `wrangler deploy --dry-run` 对完整项目 | 只验证了配置 + 最小入口 |
| 真实 Cloudflare 部署 | 无凭据；本架构阶段不做部署 |
| 生产 SSRF/egress 行为 | 未部署；平台文档结论，非实测 |
| `@cloudflare/vitest-plugin@1.6.0` 实际跑通 | 只核对版本/peer，未安装运行（研究文档同样未验证） |
| mihomo `-t` 校验 | 未实现输出；未下载/运行 mihomo 二进制；**`npm run test:mihomo` 是发布必过门禁，但本 ask 未运行**（AC-24） |
| 真实机场订阅/机场反爬/TLS | 未使用真实订阅 |
| `npm audit` | 未运行（研究环境 registry 不支持 audit bulk；本项目后续可在 CI 用 OSV/npm audit 另行检查） |

### 12.3 结论可信度

- 行为规格（规则/协议/端点差异）来自四份取证文档的源码/实验证据，置信度见各文档。
- Worker 平台限制来自官方文档 + 研究文档中的本地实测；生产行为未验证。
- 本项目的“可部署性”目前只到**配置级 dry-run**，不是“已部署验证”。

---

## 13. 差距登记（Gap Register）

| ID | 差距 | 影响 | 决策 | 未来 |
|---|---|---|---|---|
| G-01 | 只支持 `target=clash` | 非 mihomo 用户不能迁移 | 有意（用户优先级） | 可新增 emitter/target |
| G-02 | 只支持 5 种协议 | Snell/WireGuard/Hysteria2/TUIC 节点丢失 | v1 范围 | 按 ARCHITECTURE §12.1 扩展 |
| G-03 | 无 inja 模板/`[template]` 变量 | 使用模板变量的 ACL4SSR 配置降级 | 明确降级 | 可做受限变量替换 |
| G-04 | 无 `script:`/filter/sort JS | 依赖脚本的配置不能迁移 | 安全收窄 | 不建议在 Worker 内执行用户 JS |
| G-05 | 无 proxy-providers/relay/ssid/smart | 部分高级组配置丢失 | v1 范围 | 可评估 proxy-providers |
| G-06 | 无 emoji/append_type 等节点名称装饰 | 输出名称与 tindy 示例不同 | v1 范围 | 可加纯文本装饰 |
| G-07 | 无 `/getprofile`、`/render`、配置写端点 | 管理型工作流不可用 | 安全收窄 | 不建议 |
| G-08 | 无 DNS 解析级 SSRF | 解析到私网的域名依赖平台 | 平台兜底 + flag | 平台能力变化时重评 |
| G-09 | 无鉴权/限速/KV 短链 | 公开部署需外部防护 | v1 无状态 | 可加 Access/WAF 模板 |
| G-10 | 完整 ACL4SSR 不兼容 | 复杂配置需手工改 | 子集 | 按 §8 逐步扩展 |
| G-11 | 生产 SSRF/缓存行为未实测 | 上线前风险 | 部署清单 canary | 真实账户验证 |
| G-12 | mihomo 二进制需由 CI/开发者提供 | 发布门禁依赖 `MIHOMO_BIN` | AC-24 **必过**；CI 用 pinned release + checksum | 可在 CI 缓存二进制 |
| G-13 | `DOMAIN-REGEX` 正则引擎差异 | 少数正则可能客户端失败 | `W_REGEX_ENGINE_DIFF` + 必过 `-t` | 可维护兼容子集 |
| G-14 | 默认 HTTPS-only/端口 80/443 | 自定义端口/HTTP 订阅需配置 | 安全默认 | 部署者可改 env |
| G-15 | `getruleset` 仅 type 3/4/6 | tindy type 1/2/5 用户不能用 | mihomo 优先 | 可加 type 1/5 |
| G-16 | inline 仅 8,192 解码字节 / 12,000 source 字符 | 20k+ 规则必须走远程 URL，不能内联 | 受 Workers URL 16 KiB 限制 | 可评估 POST body 或 R2 |
| G-17 | providers 模式需 canonical `PUBLIC_ORIGIN` 才可 public cache | 未配置时订阅响应强制 private | 安全默认 | 部署者配置 |
| G-18 | 测试夹具需要 `ENVIRONMENT=test` + 精确 host:port | 生产不可用；E2E 才能访问本地 fixture | 仅测试用 | 可改为 service binding |

---

## 14. 迁移建议（从 tindy 到本项目）

1. 把 `target` 固定为 `clash`；删除 `/surge`、`/clashr`、`/singbox` 等调用。
2. 把订阅 URL 放入 `url=`；多个用重复 `url` 或 `|`；最多 8 个。
3. 把 tindy 的 `ruleset=`（base64 多行）改成重复的 `ruleset=GROUP,SOURCE`；`SOURCE` 可用 `clash-classic:`（别名）/`surge:`/`domain:` 前缀；`quanx:` 会显式 `invalid_source`。
4. 把 `custom_proxy_group` 里不支持的 `relay`/`ssid`/`smart`/`!!PROVIDER`/`script:` 改成 select/url-test/fallback/load-balance + 正则/`[]`。
5. 把 `expand=false` 改成 `rules_mode=providers`；配置 `PUBLIC_ORIGIN`（canonical https origin），否则 providers 模式响应强制 private；确保 mihomo 能访问 Worker 的 `/getruleset`。
6. 删除 `emoji`/`add_emoji`/`remove_emoji`/`append_type`/`sort_script`/`filter_script`/`upload` 等参数（会被告警忽略）。
7. 若依赖 base 规则，显式设置 `overwrite_original_rules=false`，并确保 base 规则能通过校验（`DOMA` 会被丢弃并告警）。
8. 用 `diagnostics=json` 在测试环境检查 Warning；生产用 `X-Subconverter-Warnings`/`Warn-Codes` 监控。
9. 发布前用 `MIHOMO_BIN=... npm run test:mihomo` 做**必过**客户端校验；`npm run test:e2e` 的 SKIP 不计入发布门禁。大规则集（如 20k+ 条）走远程 URL，不能塞 inline（8,192 解码字节上限）。

---

## 15. 一句话总结

- **对 mihomo 用户**：本项目提供比 tindy 更严格、更可排障、更安全的 Clash 输出，并且原生支持 VLESS。
- **对 tindy 全功能用户**：本项目不是 drop-in replacement；端点、target、协议、INI 都有明确收窄，所有差距在 §2–§8/§13 登记。
- **对“DOMA 问题”**：本项目的规则管线从设计上移除了所有已知透传路径；AC-06/AC-07 是硬验收。
