# 行为规格（SPEC）

- 项目：`subconverter-worker`（Cloudflare Worker 订阅转换）
- 版本：1.0.0（架构基线；实现必须按本文验收）
- 目标运行时：Cloudflare Workers **Paid**（Free 的 10 ms CPU 不足以完成 YAML/规则处理，见 `docs/research/cloudflare-workers.md:31-51`）
- 兼容基线：tindy2013/subconverter `a0d4eab28cb8b6c782d4ce5c3a918de4829b4a72`（v0.9.0）的**行为**，不是源码
- 参考实现：dianbanjiu/subconverter 仅作为“轻量 Worker 的经验/教训”参考，不作为正确性、安全性或兼容性的依据
- 关键词：**必须**（MUST）、**应当**（SHOULD）、**可以**（MAY）、**不得**（MUST NOT）

> 本文是规范。任何与本文冲突的实现细节以本文为准；任何本文未规定的行为，实现应当选择“宁可丢弃并告警，也不产出客户端无法加载的配置”。

---

## 0. 结论摘要

1. v1 **只支持** `target=clash`，输出 mihomo（Clash.Meta）可加载的 YAML。其它 tindy target 一律明确拒绝，不做“同名不同物”的伪兼容。
2. 输入支持三类：Base64 订阅、纯文本 URI 列表、Clash YAML（只取 `proxies`/`Proxy`）。协议至少支持 `ss`、`ssr`、`vmess`、`trojan`、`vless`。
3. **规则边界是 fail-closed 的**：任何来源（规则集、模板、内联规则、配置文件）的每一条规则都必须经过精确类型注册表、字段拆分、payload 语法、目标存在性四道校验；非法规则**丢弃并产生结构化 Warning**，不原样透传。发布门禁再用真实 mihomo `-t` 做独立校验（AC-24）。
4. `rules[20674] [DOMA] error: format invalid` 类问题的直接原因是规则行缺少 target；本规格通过“缺 target 必丢弃 + 截断尾部检测 + 输出引号 + 读回校验”四层机制保证不再出现（见 §6.8、§7.4、§11 AC-06/AC-07）。
5. 下载层不得静默清空：非 200、超时、超限、HTML 错误页、Content-Type 欺骗都必须产生可区分的错误或 Warning；不得把“空内容”当成成功。
6. 默认安全姿态：仅 HTTPS 上游、仅 80/443 端口、手动重定向逐跳复检、私网/回环/链路本地/CGNAT/ULA/IPv4-mapped 全部拒绝、上游响应流式限长、总 deadline 与 CPU 上限。
7. 唯一运行时依赖是 `yaml`（v2.9.x）；不引入 `js-yaml`、不引入 Node 专属网络库、不使用 `node:dns`。
8. 每个文件只属于 `links` / `rules` / `emitter` / `integration` 四个 owner 之一；`ownership.json` + `scripts/check-ownership.ts` 在 CI 强制检查。

---

## 1. 兼容性基线与法律边界

### 1.1 tindy v0.9.0 的真实端点

取证结论（`docs/research/original-subconverter.md:49-77`）：原版**没有**内置 `/clash`、`/surge` 路由。它们是 `base/pref.example.ini:244-259` 的 `[aliases]` 302 别名；真实端点是 `/sub`、`/sub2clashr`、`/surge2clash`、`/getruleset`、`/getprofile`、`/render`、`/version`、`/refreshrules`、`/readconf`、`/updateconf`、`/flushcache`，以及非 API 模式的 `/get`、`/getlocal`。`/` 在原版返回 404（`src/main.cpp:180-185`）。

本项目的 `/clash` 是**真实路由**（不是 302），语义等价于 `/sub?target=clash`。这是有意的行为差异，PARITY 中记录。

### 1.2 命名与字段基线

- tindy 的编译期默认字段名是旧名 `Proxy` / `Proxy Group` / `Rule`，随包示例 `base/pref.example.ini` 改为新名 `proxies` / `proxy-groups` / `rules`（`docs/research/original-subconverter.md:501-521`）。
- 本项目**永远**输出 mihomo 新字段名：`proxies`、`proxy-groups`、`rules`、`rule-providers`。不提供 `new_name=false` 的旧名输出。

### 1.3 清洁室声明

tindy2013/subconverter 是 GPL-3.0。本项目从行为规格独立实现，不复制其 C++ 源码、`base/` 配置、模板或规则文件。实现者不得把 GPL 代码/配置粘入本仓库；如确需兼容某个 GPL 文本，必须重新编写并单独评审许可证义务。PARITY 中记录参考实现只借鉴“思路”而非代码。

---

## 2. HTTP API

### 2.1 端点总表

| 方法 | 路径 | 用途 | 成功响应 |
|---|---|---|---|
| GET | `/` | 帮助页（自包含 HTML，无外部资源） | `200 text/html; charset=utf-8` |
| GET | `/version` | 版本信息 | `200 text/plain; charset=utf-8` |
| GET | `/sub` | 主转换端点 | `200 text/yaml; charset=utf-8`（`diagnostics=json` 时为 `application/json`） |
| GET | `/clash` | `/sub` 的显式入口，强制 `target=clash` | 同 `/sub` |
| GET | `/getruleset` | 规则集 → mihomo rule-provider payload | `200 text/yaml; charset=utf-8` |
| OPTIONS | 任意已注册路径 | CORS 预检 | `204`，无响应体 |
| HEAD | `/`、`/version` | 元数据 | `200`，无响应体 |
| 其它方法 | 任意 | 不支持 | `405` + `Allow` |

- `/sub`、`/clash`、`/getruleset` **不支持 HEAD**：返回 `405`，`Allow: GET, OPTIONS`。原因：避免 HEAD 触发完整上游下载与 CPU 消耗（tindy 的 HEAD `/sub` 会完整解析，见 `docs/research/original-subconverter.md:192`）。这是有意差异。
- 未注册路径返回 `404 text/plain`。
- 所有响应必须带 `X-Content-Type-Options: nosniff`；帮助页额外带 CSP 与 `Referrer-Policy: no-referrer`。

### 2.2 CORS

| 响应头 | 值 |
|---|---|
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Allow-Methods` | `GET, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type` |
| `Access-Control-Max-Age` | `86400` |
| `Access-Control-Allow-Credentials` | 不发送 |

预检：`OPTIONS` 对已注册路径返回 204；对未注册路径返回 404。CORS 不需要凭据；v1 无鉴权/cookie。

### 2.3 通用响应头

| 头 | 出现条件 | 说明 |
|---|---|---|
| `X-Subconverter-Version` | 所有响应 | 如 `1.0.0` |
| `X-Subconverter-Target` | `/sub`、`/clash` | 恒为 `clash` |
| `X-Subconverter-Warnings` | `/sub`、`/clash`、`/getruleset` | 警告总数（不是 unique code 数） |
| `X-Subconverter-Warn-Codes` | 同上且 warning > 0 | 排序后的 unique code，逗号分隔；最多 20 个，超出以 `,+N` 结尾 |
| `X-Subconverter-Node-Count` | `/sub`、`/clash` | 输出节点数 |
| `X-Subconverter-Rule-Count` | `/sub`、`/clash` | 输出 `rules` 条数（含最终 MATCH） |
| `X-Subconverter-Provider-Count` | `/sub`、`/clash` | `rule-providers` 数量 |
| `X-Subconverter-Placeholder` | `/getruleset` 空结果 | 值为 `1` |
| `X-Subconverter-Error` | 错误响应 | 见 §2.7 错误码 |
| `X-Subconverter-Diagnostics` | 响应为 JSON 诊断 | `json` |
| `Subscription-UserInfo` | 上游提供且 `append_info=true` | 仅透传经校验的 ASCII 值，≤512 字节；见 §9.6 |
| `profile-update-interval` | `/sub`/`/clash` 且 `interval>0` | `floor(interval/3600)`；整数除法，与 tindy 一致 |

不得透传上游的 `Set-Cookie`、`Location`、`Server`、`Content-Type`、`Content-Length` 或其它任意头给客户端。

### 2.4 `/sub` 参数

所有参数来自 query string；不支持 POST body。布尔参数：裸键（`?udp`）视为 `true`；`true`/`1` 为 true；`false`/`0` 为 false；其它值 → `400 invalid_boolean`。

| 参数 | 类型/范围 | 默认 | 可重复 | 语义 |
|---|---|---|---|---|
| `url` | source，见 §2.5 | 无（必填） | 是，最多 8 个；也可用 `\|` 分隔 | 节点来源 |
| `target` | `clash` | `clash` | 否 | v1 只接受 `clash`；其它值 → `400 unsupported_target` |
| `config` | source | 无 | 否 | ACL4SSR 风格 INI 子集，见 §8 |
| `ruleset` | rule-source spec，见 §6.1 | 无 | 是，最多 8 个 | 规则来源 |
| `groups` | base64url 文本 | 无 | 否 | 每行一个 `custom_proxy_group` 语法；`config` 存在时被忽略并告警 |
| `template` | source | 内置默认模板 | 否 | mihomo 顶层配置模板；见 §7.1 |
| `rules_mode` | `inline` \| `providers` | `inline` | 否 | `providers` 生成 `rule-providers` + `RULE-SET`；`expand=true/false` 为兼容别名 |
| `diagnostics` | `none` \| `json` | `none` | 否 | `json` 返回结构化诊断包络，见 §2.8 |
| `include` | 正则 | 无 | 是，最多 16 个 | 仅保留名称匹配的节点；非法/不安全正则 → 400 |
| `exclude` | 正则 | 无 | 是，最多 16 个 | 排除名称匹配的节点；非法/不安全正则 → 400 |
| `rename` | `pattern@replacement` | 无 | 是，最多 32 个 | 对节点名做全局正则替换；非法/不安全正则 → 400 |
| `sort` | bool | `false` | 否 | 按节点名 Unicode code unit 稳定排序 |
| `udp` | bool | 不输出 | 否 | 为支持的协议输出 `udp: true` |
| `tfo` | bool | 不输出 | 否 | 为支持的协议输出 `tfo: true` |
| `scv` | bool | 不输出 | 否 | 为支持的协议输出 `skip-cert-verify: true` |
| `group` | 字符串，≤64 | 无 | 否 | 覆盖所有节点的 `sourceGroup` 标签（用于 `!!GROUP=` 匹配） |
| `interval` | 整数 0..2592000 | `0` | 否 | 仅用于 `profile-update-interval` 响应头 |
| `append_info` | bool | `true` | 否 | 是否透传经校验的 `Subscription-UserInfo` |
| `filename` | 字符串，≤128 | 无 | 否 | 可选 `Content-Disposition`；禁止 CR/LF/引号/非 ASCII 控制字符；不改变正文 |

**已知但 v1 不支持的 tindy 参数**（`new_name`、`ver`、`sort_script`、`script`、`list`、`insert`、`prepend`、`fdn`、`append_type`、`emoji`、`add_emoji`、`remove_emoji`、`dev_id`、`token`、`upload`、`upload_path`、`profile_data`、`filter_script`、`strict`、`surge` 等）：**不得执行其语义**；若出现，产生 `W_PARAM_UNSUPPORTED`（每个参数名一次）并忽略。未知参数产生 `W_PARAM_UNKNOWN` 并忽略，以容忍缓存穿透参数。

### 2.5 source 语法

```
source := "inline:" + base64url(UTF-8 text)
        | "data:text/plain;base64," + base64
        | "https://" + ...
        | "http://" + ...            # 仅当 ALLOW_HTTP_UPSTREAM=true
```

- `inline:` 与 `data:` 是**本地内容**，不发起网络请求；解码后必须是合法 UTF-8，且 ≤ `MAX_INLINE_BYTES`（8,192）。inline/data 的**整个 source 字符串** ≤ `MAX_INLINE_SOURCE_CHARS`（12,000）；8,192 字节解码后的 base64url 为 10,923 字符，`inline:`/`data:` 前缀后仍 <12,000（已用 Node 实测：`inline:` 总长 10,930，`data:` 总长 10,946），并给 URL 其余参数留出约 4 KB 余量。
- 远程 source 必须通过 §9 的 SSRF 校验；`file:`、`ftp:`、`gopher:`、`ws:`、`wss:`、裸路径一律 `400 invalid_source`。
- `url` 的每一项还可以写成 `tag:<label>,<source>`：`<label>` 为 1..64 字符，赋给该来源所有节点的 `sourceGroup`。先解析 `tag:` 前缀，再解析 source。
- `url` 参数整体可重复或使用字面 `|` 分隔；空项丢弃并产生 `W_SOURCE_EMPTY`。超过 8 个 → `400 too_many_sources`。
- **远程 URL** 字符串长度 ≤ 4,096；**inline/data** source 字符串长度 ≤ 12,000；超长 → `400 invalid_source`。不得把 16 KiB 解码后的内容塞进 inline（base64 后约 21,846 字符，必然超过 12,000/16 KiB URL）。

### 2.6 `/clash`

- 与 `/sub` 完全相同的参数与处理；强制 `target=clash`。
- 若同时传 `target` 且不是 `clash`：忽略该参数并产生 `W_PARAM_IGNORED`（不返回 400），因为 `/clash` 的语义足够明确。
- `/clash` 与 `/sub?target=clash` 的输出必须逐字节一致（同一请求、同一时间、无缓存差异）。

### 2.7 `/getruleset`

| 参数 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | `3` = domain provider；`4` = ipcidr provider；`6` = classical provider |
| `src` | 二选一 | source 字符串（§2.5），按 query 规则 URL 编码 |
| `url` | 二选一 | tindy 兼容：`base64url(source)`；与 `src` 互斥 |
| `dialect` | 否 | `auto`（默认）\| `clash-classical` \| `clash-classic`（别名） \| `clash-domain` \| `clash-ipcidr` \| `surge` \| `domain` \| `base64`；`quanx` 显式拒绝 |
| `group` | 否 | tindy 兼容参数；对 type 3/4/6 无意义，忽略并产生 `W_PARAM_IGNORED` |
| `diagnostics` | 否 | `none` \| `json` |

- `type=1/2/5` 或其它值 → `400 unsupported_ruleset_type`。v1 只服务 mihomo provider。
- 输出为 YAML 文档，只有一个顶层键 `payload`，值为字符串数组；每条字符串必须被双引号包裹；文件以 `\n` 结尾。
- **type → payload 的精确映射**（非空结果）：

| type | 接受的已校验规则 | 输出 payload 项 | 其它类型 |
|---|---|---|---|
| 3（domain） | `DOMAIN` | 裸域名 `example.com` | 丢弃 + `W_RULESET_TYPE_FILTERED` |
| 3（domain） | `DOMAIN-SUFFIX` | `+.example.com` | — |
| 4（ipcidr） | `IP-CIDR` | `1.2.3.0/24` | 丢弃 + `W_RULESET_TYPE_FILTERED` |
| 4（ipcidr） | `IP-CIDR6` | `2001:db8::/32` | — |
| 6（classical） | 除 `MATCH`、`RULE-SET`、`SUB-RULE` 外的已校验类型 | `TYPE,PAYLOAD` 或 `TYPE,PAYLOAD,no-resolve`（**无 target**） | 丢弃 + `W_RULESET_TYPE_FILTERED` |

- 关键不变量：type 3 的 payload **不得**出现 `DOMAIN-SUFFIX,`/`DOMAIN,` 等 typed 字符串（mihomo 的 domain provider 会跳过它们，导致规则静默丢失）；type 4 只能出现 CIDR；type 6 不能出现 target 字段。读回/测试必须断言这些不变量。
- 空结果（源为空、全部行非法、或全部被类型过滤）**不返回 400**：返回 200 + 一个合法占位项，并带 `X-Subconverter-Placeholder: 1` 与 Warning。占位项：
  - type 3：`'+.placeholder.invalid'`
  - type 4：`'0.0.0.0/32'`
  - type 6：`'DOMAIN,placeholder.invalid'`
  - 这样 mihomo 的 provider 拉取不会因 400 失败。与 tindy 的 `--placeholder--` 不同（PARITY 记录）。
- 网络失败/超时/超限仍按 §2.9 的错误码返回 502/504/413；不用占位项掩盖传输错误。
- `diagnostics=json` 时返回 `{ok, type, output, warnings, stats}`；`output` 为 payload YAML 字符串。

### 2.8 `diagnostics=json` 包络

`/sub`、`/clash`、`/getruleset` 支持 `diagnostics=json`。成功响应：

```json
{
  "ok": true,
  "version": "1.0.0",
  "target": "clash",
  "contentType": "text/yaml; charset=utf-8",
  "output": "proxies:\n  - ...\n",
  "stats": {
    "nodes": 2,
    "groups": 2,
    "rules": 7,
    "providers": 0,
    "sources": 1,
    "bytesIn": 1234,
    "bytesOut": 5678,
    "warnings": 1,
    "warningCodes": ["E_RULE_NO_TARGET"]
  },
  "warnings": [
    {
      "code": "E_RULE_NO_TARGET",
      "severity": "error",
      "stage": "rules",
      "message": "rule has no target; expected TYPE,PAYLOAD,GROUP",
      "source": "url#1",
      "line": 20675,
      "raw": "DOMA",
      "hint": "line may be truncated; see SPEC §6.8"
    }
  ]
}
```

- `warnings` 最多 `MAX_WARNINGS=200` 条；超出时截断并追加一条 `W_WARNING_LIMIT`，`stats.warnings` 仍是真实总数。
- 失败响应：`{ok:false, error:{code,message}, warnings:[...]}`，HTTP 状态按 §2.9。
- `raw` 字段最多 160 字符，控制字符转义为 `\uXXXX`；不得包含节点密码/UUID/订阅 token。规则文本可保留，但实现仍应对长度截断。

### 2.9 错误码与状态码

| 错误码 | HTTP | 触发 |
|---|---|---|
| `invalid_request` | 400 | 缺参数、参数格式错、source 为空 |
| `invalid_boolean` | 400 | 布尔值不是 true/false/1/0 |
| `invalid_regex` | 400 | include/exclude/rename 正则非法或不安全 |
| `invalid_source` | 400 | source 语法错误、scheme 不允许、超长 |
| `blocked_upstream` | 400 | SSRF 校验拒绝 |
| `unsupported_target` | 400 | `target` 非 `clash` |
| `unsupported_ruleset_type` | 400 | `/getruleset` type 非 3/4/6 |
| `conflicting_params` | 400 | `src` 与 `url` 同时出现；`rules_mode` 与 `expand` 冲突 |
| `invalid_config` | 400 | config 完全无法解析（非 INI / 无 `[custom]`） |
| `invalid_template` | 400 | template 不是 YAML 对象或超过上限 |
| `too_many_sources` | 400 | url 或 ruleset 超过 8 个 |
| `upstream_too_large` | 413 | 上游响应（或 inline）超过字节上限 |
| `no_nodes` | 422 | 所有来源都成功处理但零个合法节点 |
| `upstream_status` | 502 | 上游非 2xx |
| `upstream_network` | 502 | DNS/TLS/连接错误或平台阻断 |
| `upstream_timeout` | 504 | 单跳或总 deadline 超时 |
| `internal_error` | 500 | 未捕获异常 / 输出读回校验失败 |

错误响应体（默认）：

```text
error: <code>
message: <不含 URL/token 的短说明>
```

`diagnostics=json` 时为 JSON 包络。所有错误响应 `Cache-Control: no-store`，并带 `X-Subconverter-Error: <code>`。

**部分失败不算错误**：多个 source 中一个失败、其余成功并产生节点 → 200 + Warning；单条节点/规则非法 → 丢弃 + Warning，不影响 200。只有“零节点”或“全部 source 失败”才返回错误。

---

## 3. 输入检测与解析

### 3.1 总体流程

```
source text
  ├─ strip UTF-8 BOM；拒绝含 NUL 的内容
  ├─ 若含 (?m)^(proxies|Proxy)\s*: → Clash YAML
  ├─ 若含 (?i)\b(ss|ssr|vmess|trojan|vless):// → 纯文本 URI 列表
  ├─ 否则尝试严格 base64url 解码（最多 1 层）
  │    └─ 解码成功且为 UTF-8/可打印 → 递归上面的检测
  └─ 否则 → E_UNSUPPORTED_INPUT_FORMAT（该 source 失败并告警）
```

- 先按“像不像 URI/Clash”判断，再尝试 base64；不得像 tindy 那样无条件对整段做宽松 base64 解码（`docs/research/original-subconverter.md:327-339`）。
- Base64 严格性：只允许 `[A-Za-z0-9+/_-]` 与末尾 `=`；拒绝其它字符；支持无 padding；解码后必须通过 `TextDecoder('utf-8', {fatal:true})`；可打印字符比例 ≥ 0.9 才认为“是文本订阅”，否则按解码失败处理。
- 每个 source 独立：一个 source 失败不阻止其它 source；失败产生 Warning，原因码见 §10。
- 一个 source 内逐行隔离：单行解析失败只丢该行，产生一行 Warning；不得让整份订阅 500。

### 3.2 纯文本 URI 列表

- 行分隔：先 `\n`，兼容 `\r\n`/`\r`；空行、首尾空白行跳过。
- 整行注释：`#`、`;`、`//` 开头（去除前导空白后）跳过。
- 每行长度 ≤ 4096；超长 → `E_NODE_LINE_TOO_LONG`，丢弃。
- scheme 大小写不敏感；统一转小写后分派。
- 不支持的 scheme（如 `http://`、`socks://`、`hysteria2://`、`tuic://`）→ `E_NODE_SCHEME_UNSUPPORTED`，丢弃该行；不尝试把 http URL 当 HTTP 代理（tindy 的 `explodeHTTPSub` 行为不复刻）。
- 单行解析异常必须被捕获，产生 Warning，继续下一行。

### 3.3 Clash YAML 输入

- 用 `yaml` 2.9.x 解析：`schema:'core'`、`merge:false`、`maxAliasCount:50`、`uniqueKeys:true`、`customTags:[]`；只接受单文档；多文档 → `E_YAML_MULTI_DOC`，该 source 失败。
- 顶层键 `proxies` 优先；否则 `Proxy`；二者都有时用 `proxies` 并产生 `W_CLASH_DUPLICATE_PROXY_KEY`。
- 只读取节点数组。`proxy-groups`、`rules`、`rule-providers`、`proxy-providers`、`script` 等段**不参与转换**；若存在，产生一条聚合 Warning `W_CLASH_SECTION_IGNORED`，列出被忽略的键。
- 数组元素必须是对象；`type` 必须是字符串；只支持 `ss`、`ssr`、`vmess`、`trojan`、`vless`。其它 type → `W_NODE_UNSUPPORTED_PROTOCOL`，丢弃该节点。
- 每个节点独立校验：`name`、`server`、`port`（1..65535）、协议必填字段；任何字段非法 → 该节点丢弃 + Warning，继续下一个。
- 允许的公共可选字段：`udp`、`tfo`、`skip-cert-verify`。其它字段忽略（聚合 Warning `W_NODE_FIELDS_IGNORED`）。
- 不支持 JSON 形态的 v2ray/sing-box/SSD/SIP008 配置；若检测到（`outbounds`/`servers`/`airport` 等）→ `E_UNSUPPORTED_INPUT_FORMAT`，该 source 失败。

### 3.4 五种协议映射

#### 3.4.1 Shadowsocks（`ss://`）

- 支持：
  - SIP002：`ss://base64(method:password)@host:port[/?plugin=...]#name`
  - 旧式：`ss://base64(method:password@host:port)#name`
  - 明文 userinfo：`ss://method:password@host:port#name`（仅在 userinfo 不含 `@`/`/` 时可解析）
- `method` 必须在注册表内：`aes-128-gcm`、`aes-192-gcm`、`aes-256-gcm`、`aes-128-cfb`、`aes-192-cfb`、`aes-256-cfb`、`aes-128-ctr`、`aes-192-ctr`、`aes-256-ctr`、`rc4-md5`、`chacha20-ietf`、`chacha20-ietf-poly1305`、`xchacha20-ietf-poly1305`、`2022-blake3-aes-128-gcm`、`2022-blake3-aes-256-gcm`、`2022-blake3-chacha20-poly1305`、`none`。未知 → `E_NODE_CIPHER`，丢弃节点。
- `plugin` 仅支持 `obfs`（`obfs-local`）与 `v2ray-plugin`；解析 `plugin;key=value;...`。其它 plugin → `E_NODE_PLUGIN`，丢弃节点（不静默去掉插件）。
- 输出：`type: ss`、`cipher`、`password`、`server`、`port`；有插件时输出 `plugin` 与 `plugin-opts`。

#### 3.4.2 ShadowsocksR（`ssr://`）

- 解码 `base64url(host:port:protocol:method:obfs:base64(password)/?remarks=&group=&obfsparam=&protoparam=)`。
- 为兼容 IPv6，解析时按“最后 5 个冒号字段”切分，冒号之前整体作为 host；host 可带 `[]`。
- `protocol` 允许：`origin`、`auth_sha1_v4`、`auth_aes128_md5`、`auth_aes128_sha1`、`auth_chain_a`、`auth_chain_b`；`obfs` 允许：`plain`、`http_simple`、`http_post`、`random_head`、`tls1.2_ticket_auth`。未知 → `E_NODE_CIPHER`，丢弃。
- `method` 使用 SS 的 cipher 注册表；`cipher: none` 输出为 `dummy`（mihomo SSR 约定）。
- 输出：`type: ssr`、`cipher`、`password`、`protocol`、`protocol-param`、`obfs`、`obfs-param`、`server`、`port`。

#### 3.4.3 VMess（`vmess://`）

- 支持：
  - Base64 JSON v2：`{v,ps,add,port,id,aid,net,type,host,path,tls,sni,alpn}`
  - URI 形态：`vmess://uuid@host:port?type=ws&security=tls&path=...&host=...&sni=...&aid=0#name`
- `id` 必须是 8-4-4-4-12 十六进制 UUID（大小写不敏感）；`aid` 为 0..65535 整数；`port` 1..65535。
- 传输仅支持 `tcp`、`ws`、`grpc`；其它（`h2`、`http`、`kcp`、`quic`）→ `E_NODE_TRANSPORT`，丢弃节点。理由：mihomo 的 h2/http/kcp/quic 选项差异大，v1 不输出半成品。
- 输出：`type: vmess`、`uuid`、`alterId`、`cipher: auto`、`server`、`port`、`tls`/`servername`、`network` 与 `ws-opts`/`grpc-opts`、可选 `skip-cert-verify`。

#### 3.4.4 Trojan（`trojan://`）

- `trojan://password@host:port?security=tls&sni=&alpn=&allowInsecure=1&type=ws&path=&host=#name`。
- `password` 非空；`port` 1..65535；TLS 恒为开启。
- 传输仅支持 `tcp`、`ws`、`grpc`；其它 → `E_NODE_TRANSPORT`，丢弃。
- 输出：`type: trojan`、`password`、`sni`、`skip-cert-verify`、`network` 与对应 opts；`alpn` 为数组时原样输出字符串数组。

#### 3.4.5 VLESS（`vless://`）

- `vless://uuid@host:port?encryption=none&security=tls|reality|none&sni=&fp=&pbk=&sid=&type=ws|grpc|tcp&path=&host=&flow=xtls-rprx-vision#name`。
- `encryption` 必须是 `none`；否则 `E_NODE_ENCRYPTION`，丢弃。
- `security=reality` 时必须有 `pbk`；缺失 → `E_NODE_REALITY`，丢弃。`sid` 可选。
- `flow` 仅允许空或 `xtls-rprx-vision`；其它 → `E_NODE_FLOW`，丢弃。
- 传输仅支持 `tcp`、`ws`、`grpc`；其它 → `E_NODE_TRANSPORT`，丢弃。
- 输出：`type: vless`、`uuid`、`server`、`port`、`tls`、`servername`、`network`、`flow`、`client-fingerprint`、`reality-opts`、可选 `skip-cert-verify`。

### 3.5 节点名、服务器、端口

- `name`：URL fragment 解码后的字符串；空 → `server:port`；去除控制字符；长度 ≤128（超出截断并 `W_NODE_NAME_TRUNCATED`）。
- `server`：必须是合法 IP 字面量或 DNS 名（ASCII/IDNA punycode）。禁止空白、控制字符、`/`、`,`、`#`、`?`；长度 ≤253。非法 → 丢弃节点。
- `port`：整数 1..65535；`0`、负数、>65535、`NaN` 一律丢弃（不得输出 `port: .nan`，参见 `docs/research/reference-audit.md:294-317`）。
- 保留名与重名：
  - mihomo 保留目标名：`DIRECT`、`REJECT`、`REJECT-DROP`、`PASS`。
  - 组名优先占用命名空间；节点名与组名、保留名、其它节点名冲突时，按出现顺序追加 `" 2"`、`" 3"`…（大小写不敏感比较），并产生 `W_NODE_NAME_DUPLICATE` 或 `W_NODE_NAME_RESERVED`。
  - 两个组同名时，后一个追加 `" 2"` 并产生 `W_GROUP_NAME_DUPLICATE`；组名是保留名且无法改名时丢弃该组并告警。

### 3.6 节点过滤、重命名、排序、来源标签

处理顺序（固定）：

1. 解析节点（多 source 按 `url` 顺序）。
2. 应用 `include`/`exclude`（对原始 `name`；多个 include 为 OR，多个 exclude 为 OR；先 include 后 exclude）。
3. 应用 `rename`（按参数顺序；每个 pattern 全局替换；支持 `$1`..`$9`）。
4. 应用 `group`/`tag:` 得到的 `sourceGroup`（`group` 参数覆盖所有）。
5. 名称分配（§3.5）。
6. 若 `sort=true`，按最终名称稳定排序。
7. 截断到 `MAX_NODES`（超过时 `W_NODE_LIMIT`）。

### 3.7 节点数量

- 最终节点数 > `MAX_NODES`（10,000）：保留前 10,000 个（排序后顺序），产生 `W_NODE_LIMIT`；不失败。
- 最终节点数 = 0：`422 no_nodes`。

---

## 4. 规则来源与方言

### 4.1 来源语法

`ruleset` 参数（可重复）与 config 的 `ruleset` 键使用同一语法：

```
rule-source := GROUP "," ( "[]" RULE | [DIALECT ":"] SOURCE ["," INTERVAL] )
GROUP       := 非空字符串，≤64 字符，不得含逗号
DIALECT     := clash-classical | clash-classic | clash-domain | clash-ipcidr | surge | domain | base64
SOURCE      := §2.5 的 source
INTERVAL    := 整数 60..604800（秒）；仅 providers 模式使用；缺省 86400
RULE        := 一行规则文本（不得含换行）
```

- 只有两个逗号字段且最后字段不是整数时，整个剩余部分视为 SOURCE；若 URL 中含逗号，按 tindy 的“最后一个逗号且可解析为整数才当 interval”规则处理（`docs/research/original-subconverter.md:565-580`）。
- `clash-classic` 是 tindy 的拼写，作为 `clash-classical` 的**别名**接受，产生 `W_DIALECT_ALIAS`；规范化后使用同一解析器。`quanx:` 是 tindy 支持但本项目不支持的方言：显式产生 `W_DIALECT_UNSUPPORTED`，该 source 按 `invalid_source` 跳过（不把它误当 URL）。
- `[]RULE`：内联规则，target 由 GROUP 提供；`[]` 后不允许再拆分。
- `!!import:` 不支持 → `W_RULESET_IMPORT_UNSUPPORTED`，整行丢弃。
- 无 dialect 前缀时自动检测（§4.2）。

### 4.2 方言检测

按顺序：

1. 显式 dialect 前缀优先。
2. 内容 strip BOM 后，若匹配 `(?m)^(payload|rules)\s*:`，或整体可解析为 YAML 字符串数组 → `clash-classical` 候选；再按内容细分：
   - 若所有条目无逗号且像域名 → `clash-domain`
   - 若所有条目无逗号且像 CIDR → `clash-ipcidr`
   - 否则 → `clash-classical`
3. 若内容第一行（非注释）的第一个逗号前 token 是已知 mihomo 类型或别名（大小写不敏感）→ `surge`。
4. 若内容严格 base64url 且解码后为文本 → `base64`，解码后重新检测（最多 1 层）。
5. 否则 → `domain`（裸域名列表）。

内容类型（`text/yaml` 等）只作为提示，不作为唯一依据；不信任上游 Content-Type。

### 4.3 各方言的行语义

| 方言 | 行形态 | 处理 |
|---|---|---|
| `clash-classical`（别名 `clash-classic`） | YAML `payload:` 数组、`rules:` 数组、顶层字符串数组 | YAML 解析；非字符串项丢弃并告警；每项按规则行解析；无 target 的行由 GROUP 补；`clash-classic` 走同一路径 + `W_DIALECT_ALIAS` |
| `clash-domain` | YAML `payload:` 数组，元素为裸域名、`.domain`、`+.domain` | 裸域名 → `DOMAIN`；`.`/`+.` 前缀 → `DOMAIN-SUFFIX`；其它字符串丢弃 |
| `clash-ipcidr` | YAML `payload:` 数组，元素为 CIDR | 裸 CIDR → `IP-CIDR`（v4）或 `IP-CIDR6`（v6）；其它丢弃 |
| `surge` | `TYPE,VALUE[,policy][,no-resolve]` 文本行 | 注释/空行跳过；按 §5 解析；源里的 policy 字段不作为 target（由 GROUP 提供）；若 policy 等于 wrapper group/已知 target/内置目标，先剥离并 `W_RULE_SOURCE_TARGET_IGNORED`，再按类型重组 payload；仅在值为 `no-resolve` 时保留为参数。 |
| `domain` | 裸域名列表，支持 `full:`/`domain:`/`keyword:`/`regexp:` 前缀 | `full:` → `DOMAIN`；`domain:`/裸域名 → `DOMAIN-SUFFIX`；`keyword:` → `DOMAIN-KEYWORD`；`regexp:` → `DOMAIN-REGEX`；`include:` → 丢弃并告警 |
| `base64` | 整段 base64url | 解码后按上述重新检测；嵌套深度最多 1 |

### 4.4 注释与空白

- 整行注释：`#`、`;`、`//`（去除前导空白后）跳过。YAML 方言由 YAML 解析器自然处理。
- 行内注释：
  - 非正则类 payload：若 ` #` 或 ` //` 前有空白，截断并产生 `W_RULE_INLINE_COMMENT`。
  - 正则类（`DOMAIN-REGEX`、`PROCESS-NAME-REGEX`、`PROCESS-PATH-REGEX`）：不截断 `#`（它可能是正则字符）；`//` 也可能出现在正则里，同样不截断。若最终正则编译失败则丢弃并告警。
- 空行/纯空白行跳过，不产生 Warning（避免刷屏）。
- CRLF/CR 统一为 LF；BOM 在解析前剥离（解决 tindy 的 BOM 问题，见 `docs/research/doma-diagnosis.md:325`）。

---

## 5. mihomo 规则类型注册表与校验

### 5.1 精确类型注册表（37 个）

类型必须先 `trim().toUpperCase()`，再做**精确匹配**；不得用 `startsWith`（否则 `MATCHBOX`、`DOMAIN-FOO` 会混入，见 `docs/research/doma-diagnosis.md:319-320`）。注册表与 mihomo `Alpha@478af2a` 的 `rules/parser.go` 对齐（`docs/research/doma-diagnosis.md:48-91`）。

| # | 类型 | 分组 | payload 校验 | v1 输出 |
|---|---|---|---|---|
| 1 | `DOMAIN` | domain | 非空；小写；无空白/控制/`/`/`,`；≤253 | 是 |
| 2 | `DOMAIN-SUFFIX` | domain | 同 DOMAIN；可带前导 `.`/`+.`（归一化去掉） | 是 |
| 3 | `DOMAIN-KEYWORD` | domain | 非空；无空白/控制/`,`；≤128 | 是 |
| 4 | `DOMAIN-REGEX` | domain | JS `RegExp` 可编译；长度 ≤512；支持前导 `(?i)` 翻译为 `i` | 是 |
| 5 | `DOMAIN-WILDCARD` | domain | 仅 `[A-Za-z0-9.*?-]`；至少一个 `*` 或 `?` | 是 |
| 6 | `GEOSITE` | geo | `^[A-Za-z0-9_-]{2,32}$` | 是 |
| 7 | `GEOIP` | geo | 同 GEOSITE | 是 |
| 8 | `SRC-GEOIP` | geo | 同 GEOSITE | 是 |
| 9 | `IP-ASN` | ip | `^(AS)?\d{1,10}$` | 是 |
| 10 | `SRC-IP-ASN` | ip | 同 IP-ASN | 是 |
| 11 | `IP-CIDR` | ip | 合法 IPv4 CIDR；前缀 0..32 | 是 |
| 12 | `IP-CIDR6` | ip | 合法 IPv6 CIDR；前缀 0..128 | 是 |
| 13 | `SRC-IP-CIDR` | ip | 合法 IPv4 或 IPv6 CIDR | 是 |
| 14 | `IP-SUFFIX` | ip | 0..32 的整数，或合法 CIDR | 是 |
| 15 | `SRC-IP-SUFFIX` | ip | 同 IP-SUFFIX | 是 |
| 16 | `SRC-PORT` | port | 0..65535 整数或 `a-b` 范围 | 是 |
| 17 | `DST-PORT` | port | 同 SRC-PORT | 是 |
| 18 | `IN-PORT` | port | 同 SRC-PORT | 是 |
| 19 | `DSCP` | misc | 0..63 整数 | 是 |
| 20 | `PROCESS-NAME` | process | 非空；无控制字符；≤256 | 是 |
| 21 | `PROCESS-PATH` | process | 同 PROCESS-NAME | 是 |
| 22 | `PROCESS-NAME-REGEX` | process | JS RegExp 可编译；≤512 | 是 |
| 23 | `PROCESS-PATH-REGEX` | process | 同 PROCESS-NAME-REGEX | 是 |
| 24 | `PROCESS-NAME-WILDCARD` | process | 仅 `[A-Za-z0-9.*?-]`；至少一个通配符 | 是 |
| 25 | `PROCESS-PATH-WILDCARD` | process | 同 PROCESS-NAME-WILDCARD | 是 |
| 26 | `NETWORK` | misc | `tcp` 或 `udp`（大小写不敏感，输出小写） | 是 |
| 27 | `UID` | misc | 非负整数或 `a-b` 范围 | 是 |
| 28 | `IN-TYPE` | misc | 非空；≤64；无控制字符 | 是 |
| 29 | `IN-USER` | misc | 非空；≤256；无控制字符 | 是 |
| 30 | `IN-NAME` | misc | 非空；≤256；无控制字符 | 是 |
| 31 | `REMATCH-NAME` | misc | 非空；≤256；无控制字符 | 是 |
| 32 | `SUB-RULE` | logic | 需 `sub-rules` 定义 | **否**：`W_RULE_SUB_RULE_UNSUPPORTED`，丢弃 |
| 33 | `AND` | logic | `(...)` 包裹；括号平衡；≥2 个子规则；递归校验；禁止 MATCH/SUB-RULE 子规则 | 是 |
| 34 | `OR` | logic | 同 AND | 是 |
| 35 | `NOT` | logic | `(...)` 包裹；恰好 1 个子规则 | 是 |
| 36 | `RULE-SET` | ref | payload 必须是本次生成的 provider 名 | 是（仅 providers 模式） |
| 37 | `MATCH` | final | payload 必须为空；target 必填 | 是 |

补充：

- `IP-CIDR` 与 `IP-CIDR6` 在 mihomo 中共用同一个 parser case；本项目仍按 v4/v6 分别校验，避免把 v6 写进 v4 类型。
- `DOMAIN-REGEX`/`PROCESS-*-REGEX` 的 JS 校验是**尽力而为**；mihomo 使用 regexp2（.NET 语义），两者不等价。发现明显不兼容结构时产生 `W_REGEX_ENGINE_DIFF`，但保留规则（见 §10 风险 R7）。
- `SUB-RULE` 是唯一在 v1 明确不输出的类型；其余 36 个类型可输出。未知类型（不在表内）→ `E_RULE_UNKNOWN_TYPE`，丢弃。

### 5.2 类型别名与方言翻译

| 输入类型 | 输出/处理 |
|---|---|
| `FINAL` | 归一化为 `MATCH`，产生 `W_RULE_TYPE_ALIAS` |
| `HOST` | `DOMAIN` |
| `HOST-SUFFIX` | `DOMAIN-SUFFIX` |
| `HOST-KEYWORD` | `DOMAIN-KEYWORD` |
| `HOST-WILDCARD` | `DOMAIN-WILDCARD` |
| `DEST-PORT` | `DST-PORT` |
| `IP6-CIDR` | `IP-CIDR6` |
| `SRC-IP` | 若 payload 是合法 CIDR → `SRC-IP-CIDR`；否则丢弃 |
| `URL-REGEX`、`USER-AGENT`、`PROCESS-USER-AGENT`、`DOMAIN-SET` | mihomo 无等价类型 → `W_RULE_TYPE_UNSUPPORTED`，丢弃 |
| `MATCHBOX`、`DOMAIN-FOO` 等前缀相似但非精确类型 | `E_RULE_UNKNOWN_TYPE`，丢弃 |

### 5.3 字段拆分（不能一律 `split(',')`）

与 mihomo `ParseRulePayload` 对齐（`docs/research/doma-diagnosis.md:107-112`）：

| 类型组 | 形态 | 解析 |
|---|---|---|
| 普通类型 | `TYPE,PAYLOAD,TARGET[,PARAM...]` | 第 1 字段类型，第 2 字段 payload，第 3 字段 target；后续仅允许 `no-resolve`（IP 类） |
| `MATCH` | `MATCH,TARGET` | 第 1 字段类型，第 2 字段 target；多余字段丢弃并告警 |
| payload 可含逗号 | `DOMAIN-REGEX`、`PROCESS-NAME-REGEX`、`PROCESS-PATH-REGEX`、`AND`、`OR`、`NOT`、`SUB-RULE` | 目标取**最后一个**逗号字段；payload 是中间全部字段用逗号重新拼接 |
| 逻辑规则 | `AND,(...),TARGET` | 先做括号配对，再递归解析子规则 |

- `/getruleset` 的 provider 上下文：不要求 target；解析出的规则 target 为空，输出 payload 时去掉 target。`MATCH`、`RULE-SET`、`SUB-RULE` 在该上下文丢弃并告警（provider 内不应出现 catch-all/嵌套引用）。
- 规则集来源的 target 一律由 GROUP 提供（包括 `MATCH`/`FINAL`）；源里显式 target 被忽略并产生 `W_RULE_SOURCE_TARGET_IGNORED`。
  - 对普通类型，第 3 字段只可能是 `no-resolve`。
  - 对 payload 可含逗号类型（`DOMAIN-REGEX`、`PROCESS-*-REGEX`、`AND`、`OR`、`NOT`、`SUB-RULE`），在重新拼接 payload **之前**先检查最后一个逗号字段：若它等于 wrapper group、已知 group/proxy 或内置目标，则把它作为源 target 剥离（`W_RULE_SOURCE_TARGET_IGNORED`），其余字段重新拼接为 payload；若不等，则保留为 payload；若它形似 target（仅 `[A-Za-z0-9_. -]`），额外产生 `W_RULE_SOURCE_TARGET_AMBIGUOUS`，再检查正则/逻辑是否仍可编译。这样 `DOMAIN-REGEX,^a{1,3}$,GROUP` 与 `AND,((DOMAIN,a.com),(NETWORK,tcp)),GROUP` 不会把 `,GROUP` 留在 payload 里（修复 P5 的复现面）。
  - 模板来源才按上表“最后字段是 target”拆分。
- 对普通类型，空字段（如 `DOMAIN,,GROUP`）→ `E_RULE_EMPTY_PAYLOAD`。
- 对 IP 类，`no-resolve` 是唯一允许的第 4 字段；其它值 → `W_RULE_PARAM_IGNORED`，丢弃该字段，保留规则。
- **缺 target**：
  - 先做保守的字段数预检：**没有任何逗号的单字段非空行**，若类型归一化为 `MATCH`（或别名 `FINAL`）且存在 wrapper group → 合法 `MATCH,GROUP`；其它情况（如 `DOMA`、`DOMAIN`）在类型白名单之前直接判定 `E_RULE_NO_TARGET`（`hint` 提示可能截断），并丢弃。这样即使类型本身也未知，也能给出与 mihomo 一致的“缺 target”原因。
  - 规则集来源（`ruleset=GROUP,SOURCE`）：2 字段行（`TYPE,PAYLOAD`，无 target）合法，target 由 GROUP 提供；1 字段行仍按上一条丢弃。
  - 模板来源：非 `MATCH` 的 2 字段行 → `E_RULE_NO_TARGET`，丢弃。这是 `rules[20674] [DOMA]` 的直接拦截点。
  - `MATCH` 只有 1 字段 → `E_RULE_NO_TARGET`。
- 空行/纯空白行已在方言层跳过；若仍到达解析器 → `E_RULE_EMPTY`（Warning，不输出）。
- 行长度 > 4096 → `E_RULE_TOO_LONG`，丢弃。

### 5.4 目标存在性

- 规则 target 必须属于以下之一：
  - 已解析的 proxy group 名称
  - 已解析的节点名称
  - 内置 `DIRECT`、`REJECT`、`REJECT-DROP`、`PASS`
  - `RULE-SET` 的 payload 必须是已生成的 provider 名
- 目标不存在：
  - 规则集来源的 GROUP 未定义 → 自动创建 `select` 组（成员 = 当前全部节点 + DIRECT），产生 `W_GROUP_AUTO_CREATED`；若组数已到 `MAX_GROUPS` → `E_RULE_TARGET_NOT_FOUND`，丢弃该来源的规则。
  - 模板/内联来源 → `E_RULE_TARGET_NOT_FOUND`，丢弃该规则。
- 禁止 target 为空字符串（`DOMA,`）或纯空白。
- 节点名/组名比较区分大小写；自动创建和重名处理按 §3.5。

### 5.5 MATCH 策略

- 所有来源中允许出现 `MATCH`；最终**只保留一个**，并放在 `rules` 数组末尾。
- 多个 `MATCH`：保留最后一个（按来源顺序/行顺序），之前的产生 `W_RULE_DUPLICATE_MATCH` 并丢弃。
- 没有任何 `MATCH`：追加 `MATCH,<defaultGroup>`，产生 `W_DEFAULT_MATCH_ADDED`（info）。
- `defaultGroup`：
  - 存在名为 `PROXY` 的组 → `PROXY`
  - 否则第一个 `select` 组
  - 否则第一个组
  - 否则 `DIRECT`
- `MATCH` 的 payload 必须为空；`MATCH,GROUP,EXTRA` 只保留 `MATCH,GROUP` 并告警。

### 5.6 规则顺序、数量、去重

- 顺序：`ruleset` 来源按请求顺序 → 每个来源内按行顺序；config 的 `ruleset` 按行顺序；模板规则（仅当 `overwrite_original_rules=false`）追加在最后；最后是唯一的 `MATCH`。
- 不去重规则（tindy 也不去重）；重复规则合法。
- 规则数 > `MAX_RULES`（50,000）：保留前 50,000 条（MATCH 仍强制在末尾），产生 `W_RULE_LIMIT`；不失败。
- `MATCH` 不受上限影响：即使达到上限，最终 MATCH 仍必须输出。

### 5.7 providers 模式

- `rules_mode=providers`（或 `expand=false`）时：
  - 每个远程/可内联的 `ruleset` 来源生成一个 provider；
  - 生成 `rule-providers.<name>` 与 `RULE-SET,<name>,<GROUP>`；
  - 无法作为 provider 的来源（包含 MATCH、RULE-SET、SUB-RULE，或 provider URL 超过 `PROVIDER_URL_MAX_LEN=12000`）回退为内联规则，并产生 `W_PROVIDER_INLINE_FALLBACK`。
- provider 名：`rs_<8位十六进制FNV-1a>_<slug>`；`slug` 来自 source 路径最后一段或 `inline`，只保留 `[a-z0-9_-]`，≤24 字符；冲突时增加哈希长度到 12 位。
- provider URL：`<providerOrigin>/getruleset?type=<3|4|6>&src=<encodeURIComponent(source)>&dialect=<dialect>&v=1`。
  - `providerOrigin = PUBLIC_ORIGIN`（若配置）否则 `request origin`。
  - 未配置 `PUBLIC_ORIGIN` 时产生 `W_PROVIDER_ORIGIN_UNPINNED`，且 providers 模式响应强制 `private, no-store`（§9.5）。
  - `PUBLIC_ORIGIN` 必须是绝对 `https://host[:port]`，不得含 path/query；非法 → `400 invalid_config`（启动期 env 校验也拒绝）。
- provider 条目：

```yaml
rule-providers:
  rs_1a2b3c4d_domestic:
    type: http
    behavior: domain        # domain | ipcidr | classical
    format: yaml
    url: https://worker.example/getruleset?type=3&src=...
    path: ./providers/rs_1a2b3c4d_domestic.yaml
    interval: 86400
```

- `behavior` 判定：
  - 所有输出规则都是 `DOMAIN`/`DOMAIN-SUFFIX` → `domain`
  - 所有输出规则都是 `IP-CIDR`/`IP-CIDR6` → `ipcidr`
  - 否则 → `classical`
- `interval` 来自规则源第三字段，缺省 86400；范围 60..604800。
- 同一个 source+GROUP 只生成一个 `RULE-SET`；同一个 source 被多个 GROUP 引用时复用同一个 provider。
- `/getruleset` 的输出必须与 providers 模式内联展开的规则集语义一致（同解析器、同校验器）；这是验收项。

---

## 6. 截断、错误页与不可信内容检测

### 6.1 HTTP 层

- 只接受 2xx；非 2xx → `upstream_status`（502）。不得像 tindy 那样清空内容后继续（`docs/research/original-subconverter.md:796-801`）。
- `Content-Type` 为 `text/html`、`application/xhtml+xml` → `E_FETCH_HTML`，该 source 失败。
- 正文嗅探：strip BOM/前导空白后，若前缀是 `<!doctype html`、`<html`、`<head`、`<body` → HTML 错误页，失败。
- 若 `Content-Type: application/json` 且正文是 `{...}`，但既无 `payload` 也无 `rules`/`proxies`，且含 `error`/`message` → `E_FETCH_ERROR_PAGE`，失败。
- `Content-Length` 仅作预检：若存在且大于单 source 上限 → 413；**不**因压缩后长度与解码后长度不一致而误报（Workers fetch 会自动解压）。
- 正文必须能被 `TextDecoder('utf-8', {fatal:true})` 解码；否则 `E_UTF8_INVALID`，失败。
- 空正文/纯空白 → `E_FETCH_EMPTY`，失败。

### 6.2 规则文本尾部截断

尾部检测必须拿到**原始文本、行数组、是否以换行结尾**三者；只给 `lines[]` 无法判断“文件没有最终换行”（评审 P0-3）。契约：

```ts
checkTail({ rawText, lines, hadFinalNewline, dialect, sourceId }): Warning[]
```

对 **typed 方言**（`surge`、`clash-classical`、`clash-domain`/`clash-ipcidr` 的 typed 元素）检查最后一条非注释行：

- 若文件没有最终换行，且最后一行满足任一条件：
  - 无逗号，且是某个已知类型或别名的**严格前缀**（如 `DOMA`、`DOMAIN-SUFFI`、`MATCHBO`）；
  - 以逗号结尾（如 `DOMAIN,`）；
  - 只有类型 token（如 `DOMAIN`）。
- 判定为 `E_TRUNCATED_TAIL`（stage=`rules`）；该行不会进入输出（由解析器的单字段/空 payload 检查丢弃，或由调用方丢弃）。尾部检测本身只产生 Warning，不静默改行。
- 对 **template**：在 YAML 解析**之前**对原始模板文本做同样的“最后一行无换行且是 `- DOMA`/`- DOMAIN`/以逗号结尾”检查，产生 `E_TRUNCATED_TAIL`（stage=`template`）；随后模板规则仍逐条校验并丢弃。不能只在 YAML 解析后的 `rules` 数组上检查——那时换行信息已丢失（评审 P0-3）。
- 对 `domain` 方言，不使用“类型前缀”启发式（`DOMA` 可能是合法域名），改用：
  - 声明计数：解析 `# TOTAL: N`、`# COUNT: N`、`# TOTAL N` 形式的注释；实际条目数 < N → `E_TRUNCATED_SOURCE`。
  - 最终换行缺失且最后一行只有空白 → `W_TRUNCATED_TAIL_SUSPECT`（Warning，不丢弃）。
- 下载层已经失败的内容不得进入规则解析；不得用“半截内容”生成配置。

### 6.3 输出读回校验

- emitter 生成 YAML 后必须用同一 `yaml` 库重新解析（`schema:'core'`、`maxAliasCount:50`）。
- **完整重校验**（评审 P0-2）：对 `rules` 数组的每条字符串，重新调用 `rules.parseRuleLine`（`mode:'template'`，knownTargets/knownProviders 为本次生成的全部目标，strict=true）。任何 `E_*` 都视为内部错误；`DOMAIN,,PROXY`、缺 target、坏 CIDR、括号不平衡的 `AND` 都会在这一步被拒绝。仅做“有逗号 + 类型前缀”的快速检查不够。
- 额外独立不变量（不依赖 YAML 解析结果）：
  - `rules` 恰好有一条 `MATCH`，且位于末尾；
  - 每条规则至少 2 个字段；普通规则 target 非空；`MATCH` 恰好 2 个字段；
  - 类型精确命中 37 项注册表；
  - `IP-CIDR`/`IP-CIDR6` 可解析；端口/ASN 在范围内；逻辑规则括号平衡且无嵌套 MATCH/SUB-RULE；
  - 没有 `DOMA`、`port: .nan`、`null` 端口；
  - 最终换行存在。
- 读回失败 → `500 internal_error`，不下发坏配置。
- **独立客户端门禁**：发布前必须运行 `MIHOMO_BIN=... npm run test:mihomo`，用真实 mihomo `-t -f` 加载生成配置（AC-24）。读回校验与 mihomo 门禁是两道独立证据；AC-24 未通过时不得作“输出必被客户端接受”的发布声明。

---

## 7. 输出规格

### 7.1 顶层结构与模板合并

- 输出键顺序固定：
  1. 模板中允许的键（按模板出现顺序；默认模板的键固定）
  2. `proxies`
  3. `proxy-groups`
  4. `rule-providers`（仅 providers 模式且非空）
  5. `rules`
- 模板来源：`template` 参数（source）优先；否则 config 的 `clash_rule_base`；否则内置 `src/emitter/default-template.ts`。
- `clash_rule_base` 的**本地路径兼容**（评审 P0-7）：真实 ACL4SSR/pref 常用 `clash_rule_base=base/all_base.tpl` 这类本地路径，Worker 无文件系统。处理：
  - 若值是 source（`http(s)`/`inline:`/`data:`）→ 正常解析。
  - 若值是裸路径且命中内置映射（`base/all_base.tpl`、`base/all_base.yml`、`base/all_base.conf`）→ 使用内置默认模板，产生 `W_BUILTIN_TEMPLATE_MAPPED`。
  - 其它裸路径 → `400 invalid_template`，message 明确提示“Worker 不支持本地路径，请改用 inline:/URL 或内置模板名”，不得静默忽略。
- 模板必须是 YAML 对象；否则 `400 invalid_template`。大小 ≤256 KiB。
- **模板顶层键允许表**：
  `mixed-port`、`port`、`socks-port`、`redir-port`、`tproxy-port`、`allow-lan`、`bind-address`、`mode`、`log-level`、`ipv6`、`unified-delay`、`tcp-concurrent`、`find-process-mode`、`global-client-fingerprint`、`interface-name`、`routing-mark`、`disable-keep-alive`、`keep-alive-idle`、`keep-alive-interval`、`dns`、`tun`、`sniffer`、`hosts`、`profile`、`geodata-mode`、`geo-auto-update`、`geox-url`、`geosite`、`geodata`。
- **模板拒绝键**（出现即丢弃并告警 `W_TEMPLATE_KEY_DENIED`）：
  `proxies`、`proxy-groups`、`rules`、`rule-providers`、`proxy-providers`、`script`、`external-controller`、`external-ui`、`secret`、`authentication`、`listeners`、`tunnels`、`sub-rules`、`experimental`、以及任何未在允许表中的键。
- 核心键 `proxies`/`proxy-groups`/`rules`/`rule-providers` 由生成器负责；模板中的同名键：
  - `proxies`/`proxy-groups`/`rule-providers`：丢弃并告警 `W_TEMPLATE_CORE_IGNORED`。
  - `rules`：默认丢弃（`overwrite_original_rules=true`）；若 config 显式 `overwrite_original_rules=false`，用同一规则校验器逐条校验，合法规则**追加在生成规则之后**，非法规则丢弃并告警；模板规则不得静默透传（修复 tindy 的 P1 路径，见 `docs/research/doma-diagnosis.md:315-318`）。
- 模板中的 `dns`/`tun`/`hosts` 等对象原样合并；不递归修改。模板值不得包含自定义 YAML tag（解析时拒绝）。
- `proxies`、`proxy-groups`、`rules`、`rule-providers` 永远由生成器覆盖，不得从模板继承。

### 7.2 `proxies`

- 数组元素字段严格按 §3.4；不得输出未定义字段、`null`、`NaN`、空字符串端口。
- `name`、`server`、`password`、`uuid`、`sni` 等字符串统一由 YAML emitter 安全引号化。
- `port` 必须是整数。
- 通用可选字段：`udp: true`、`tfo: true`、`skip-cert-verify: true` 仅在请求/节点明确要求时输出。
- 节点顺序：解析/过滤/排序后的顺序；同一输入必须稳定。

### 7.3 `proxy-groups`

- 组类型仅 `select`、`url-test`、`fallback`、`load-balance`；其它类型（`relay`、`ssid`、`smart`）→ `W_GROUP_UNSUPPORTED_TYPE`，丢弃该组。
- 字段：
  - 必出：`name`、`type`、`proxies`
  - `url-test`/`fallback`/`load-balance`：`url`（默认 `https://www.gstatic.com/generate_204`）、`interval`（默认 300）
  - `url-test`：`tolerance`（默认 50）
  - `load-balance`：`strategy`（仅当配置提供 `round-robin`/`consistent-hashing`）
- `proxies` 成员：按 matcher 规则展开（§8.2），去重保序；不得自引用；不得为空。空组补 `DIRECT` 并产生 `W_GROUP_EMPTY`。
- 默认组：
  - 没有任何 config/groups：生成 `PROXY`（select，全部节点 + DIRECT）与 `AUTO`（url-test，全部节点，url/interval 默认）。
  - 有 config/groups：不自动生成 `PROXY`/`AUTO`；`defaultGroup` 按 §5.5。
- 组数量 > `MAX_GROUPS`（128）：保留前 128 个，产生 `W_GROUP_LIMIT`；后续组及其规则目标按 `E_RULE_TARGET_NOT_FOUND` 处理。

### 7.4 `rules`

- 每条规则是一个字符串，**必须**由 YAML emitter 以双引号标量输出，例如：
  ```yaml
  rules:
    - "DOMAIN-SUFFIX,example.com,PROXY"
    - "MATCH,PROXY"
  ```
- 规则文本格式：`TYPE,PAYLOAD,TARGET[,no-resolve]`；`MATCH,TARGET`。
- 不得输出：
  - 空字符串、纯空白；
  - 没有 target 的普通规则；
  - `DOMA` 或任何未知类型；
  - 行内 `#` 注释（解析阶段已处理）；
  - 未转义的 YAML 特殊字符（由 emitter 负责）。
- 最终必须恰好有一条 `MATCH`，且在数组末尾（§5.5）。
- 读回校验必须重新断言上述不变量。

### 7.5 `rule-providers`

- 字段：`type: http`、`behavior`、`format: yaml`、`url`、`path`、`interval`。
- `path` 默认 `./providers/<name>.yaml`；只允许 `[A-Za-z0-9_./-]`，不得包含 `..`。
- `url` 必须是绝对 URL，指向本 Worker 的 `/getruleset`；不得指向上游原文（否则 mihomo 直接取未校验内容）。
- provider 内容由 `/getruleset` 重新解析/校验，保证与内联模式同语义。
- 生成的 `RULE-SET` 规则必须引用存在的 provider；否则 `E_RULE_TARGET_NOT_FOUND`。

### 7.6 YAML 序列化

- 使用 `yaml` 2.9.x；`lineWidth: 0`（不自动折行）、`indent: 2`、`sortMapEntries: false`。
- 只对规则值使用 `Scalar` + `QUOTE_DOUBLE`；其它字符串使用库的安全默认引号策略（必要时自动加引号）。
- 文件头注释（可选但推荐）：
  ```yaml
  # Generated by subconverter-worker 1.0.0; nodes=2 groups=2 rules=7 warnings=0
  ```
  注释中不得包含用户可控文本（除数字/固定版本），避免换行注入。
- 文件必须以单个 `\n` 结尾。
- 同一输入、同一配置、同一版本必须产出逐字节相同的 YAML（不得有时间戳、随机 hash、Map 迭代不确定性）。

### 7.7 响应 Content-Type

- `/sub`、`/clash`：`text/yaml; charset=utf-8`
- `/getruleset`：`text/yaml; charset=utf-8`
- `diagnostics=json`：`application/json; charset=utf-8`
- `/version`：`text/plain; charset=utf-8`
- `/`：`text/html; charset=utf-8`

`/version` 正文：`subconverter-worker <version> target=clash\n`。

---

## 8. ACL4SSR 风格 INI 子集

### 8.1 解析规则

- INI 语法：
  - 每行 trim；`;`、`#`、`//` 整行注释跳过；不支持行内注释（与 tindy 一致，`docs/research/original-subconverter.md:523-537`）。
  - `[section]` 段名大小写不敏感；`[custom]` 是唯一有语义的段；其它段（含 `[template]`）忽略并产生 `W_CONFIG_SECTION_IGNORED`。
  - 键值以第一个 `=` 分割；键名大小写不敏感；值去除前导空格；重复键按出现顺序累积。
  - 空行跳过。
- 如果内容没有 `[custom]` 且没有任何已知键 → `400 invalid_config`。
- 配置不执行 inja/Jinja 模板；含 `{% ... %}` 的行按普通文本处理，通常会导致键值无效并告警。这是明确降级（PARITY）。
- 配置大小 ≤256 KiB；超限 → `400 invalid_config`。

### 8.2 支持的键

| 键 | 语法 | 行为 |
|---|---|---|
| `custom_proxy_group` | 每行一个组，`` ` `` 分隔 | 见 §8.3 |
| `ruleset` / `surge_ruleset` | 每行一个规则源 | 见 §4.1 |
| `enable_rule_generator` | bool | `false` 时不生成 `ruleset` 规则（仍生成组）；默认 `true` |
| `overwrite_original_rules` | bool | 默认 **true**；`false` 时校验并追加模板 `rules` |
| `rename` | `pattern@replacement` | 全局正则替换；非法/不安全 → 告警并忽略该行 |
| `include_remarks` | 正则 | 每行一个；非法/不安全 → 告警并忽略 |
| `exclude_remarks` | 正则 | 同上 |
| `clash_rule_base` | source 或内置名 | 模板来源；query `template` 优先；`base/all_base.tpl`/`.yml`/`.conf` 映射到内置默认模板 + `W_BUILTIN_TEMPLATE_MAPPED`；其它裸本地路径 → `invalid_template` |

**不支持但可容忍的键**（产生 `W_CONFIG_KEY_UNSUPPORTED` 并忽略，不失败）：
`emoji`、`add_emoji`、`remove_old_emoji`、`surge_rule_base`、`surfboard_rule_base`、`mellow_rule_base`、`quan_rule_base`、`quanx_rule_base`、`loon_rule_base`、`sssub_rule_base`、`singbox_rule_base`、`insert_url`、`enable_insert`、`prepend_insert`、`filter_script`、`sort_script`、`profile_token`、`update_interval`、`update_strict`。

### 8.3 `custom_proxy_group` 子集

```
select:              NAME`select`ELEM (`\``ELEM)*
url-test/fallback:   NAME`TYPE`ELEM...`URL`TIMES
load-balance:        NAME`load-balance`ELEM...`URL`TIMES
```

- 至少 3 段；`select` 少于 2 个 ELEM 时允许（成员可为空，补 DIRECT）。
- `url-test`/`fallback`/`load-balance` 至少 5 段；倒数第二段是 URL（必须 http/https），最后一段是 `interval[,tolerance]` 或 `interval`；解析失败 → 默认 `300`/`50` 并告警。
- 组类型仅 `select`、`url-test`、`fallback`、`load-balance`；`relay`/`ssid`/`smart` → 丢弃该组 + `W_GROUP_UNSUPPORTED_TYPE`。
- ELEM 语法：
  - `[]NAME`：字面成员（内置目标、节点名或另一个组名）。
  - `!!TYPE=<regex>`：按节点 kind（`SS`/`SSR`/`VMESS`/`TROJAN`/`VLESS`）过滤。
  - `!!GROUP=<regex>`：按 `sourceGroup` 过滤。
  - `!!SERVER=<regex>`：按 `server` 过滤。
  - `!!PORT=<a-b|a|a+|a->`：按端口过滤。
  - `!!PROVIDER=...`、`!!GROUPID=...`、`!!INSERT=...`、`script:...`：不支持 → `W_GROUP_DIRECTIVE_UNSUPPORTED`，忽略该 ELEM。
  - 其它字符串：按正则匹配节点名（不锚定；大小写敏感；`u` 标志；长度 ≤256；不安全正则 → 告警并忽略该 ELEM）。
- 展开顺序：按 ELEM 顺序，每个 ELEM 内按节点顺序；成员去重保序；`[]` 字面成员立即加入。
- 组内不得出现组自身；出现则丢弃该成员并告警。
- 空组补 `DIRECT` + `W_GROUP_EMPTY`。
- 组名重名/保留名处理按 §3.5。

### 8.4 配置优先级

从高到低：

1. query 参数（`template`、`include`、`exclude`、`rename`、`rules_mode`、布尔开关）
2. config 的 `[custom]` 值
3. 内置默认

例外（与 tindy 一致的“config 覆盖 query”）：

- `config` 存在时，query 的 `groups` 与 `ruleset` 被忽略并产生 `W_CONFIG_OVERRIDES_PARAMS`；config 的 `custom_proxy_group`/`ruleset` 优先。
- `config` 存在且没有 `overwrite_original_rules` 时，默认值仍为 **true**（tindy 的 ExternalConfig 默认 false 是 DOMA P1 的温床，本项目有意改变；PARITY 记录）。

---

## 9. 安全与资源限制

### 9.1 威胁模型

订阅转换本质上是“替用户请求任意 URL”。攻击面包括：SSRF 读云元数据/内网、把 Worker 当高信誉代理、超大/超慢响应耗尽 CPU/内存/账单、恶意 YAML/正则 DoS、用错误页/截断内容制造坏配置。

### 9.2 SSRF 校验顺序（每个 URL、每一跳）

1. 长度 ≤4096；`new URL()` 成功。
2. 协议：仅 `http:`/`https:`；`http:` 仅当 `ALLOW_HTTP_UPSTREAM=true`（默认 false）。
3. 拒绝非空 `username`/`password`。
4. hostname 小写化；去掉末尾的一个或多个 `.`；拒绝空 host。
5. hostname 拒绝表：
   - `localhost`、`*.localhost`、`*.local`、`*.internal`、`*.home.arpa`
   - `metadata`、`metadata.google.internal`、`instance-data`、`metadata.azure.com`
   - 通配 DNS 服务：`localtest.me`、`*.localtest.me`、`lvh.me`、`*.lvh.me`、`vcap.me`、`*.vcap.me`、`nip.io`、`*.nip.io`、`sslip.io`、`*.sslip.io`、`xip.io`、`*.xip.io`、`traefik.me`、`*.traefik.me`
6. 若 host 是 IP 字面量（`new URL` 已把十进制/十六进制/八进制/短写 IPv4 归一化；IPv6 为 `[...]`）：
   - 去方括号，解析为字节；
   - IPv4-mapped IPv6（`::ffff:0:0/96`）还原为 IPv4 后按 IPv4 规则判断；
   - 拒绝网段：
     - IPv4：`0.0.0.0/8`、`10.0.0.0/8`、`100.64.0.0/10`、`127.0.0.0/8`、`169.254.0.0/16`、`172.16.0.0/12`、`192.0.0.0/24`、`192.0.2.0/24`、`192.168.0.0/16`、`198.18.0.0/15`、`198.51.100.0/24`、`203.0.113.0/24`、`224.0.0.0/4`、`240.0.0.0/4`、`255.255.255.255/32`
     - IPv6：`::/128`、`::1/128`、`::ffff:0:0/96`、`64:ff9b::/96`、`100::/64`、`2001:2::/48`、`2001:10::/28`、`2001:db8::/32`、`2002::/16`、`fc00::/7`、`fe80::/10`、`fec0::/10`、`ff00::/8`
   - 无法解析的 IPv6 字面量 → 拒绝（fail-closed）。
7. 非 IP hostname：通过拒绝表后放行到平台；Worker 内**无法解析 DNS**（`node:dns` 在 workerd 不可用，见 `docs/research/cloudflare-workers.md:310-331`），因此 DNS 解析到私网的域名只能依赖平台 egress 白名单与 `global_fetch_strictly_public`。这是已知残余风险（§11 R2）。
8. 端口：`url.port` 为空时按 scheme 取 80/443；否则必须是 `UPSTREAM_ALLOWED_PORTS` 列表（默认 `80,443`；支持 `a-b` 范围）之一；否则拒绝。
9. 通过后返回规范化 `URL`；后续 fetch 只使用规范化结果。
10. **仅 E2E 的测试夹具例外**：当 `ENVIRONMENT=test` 且 URL 的 `host:port` **精确等于** `ALLOW_TEST_UPSTREAM_HOSTS` 列表中的项时，允许该 host:port 通过第 6/7 步（仍执行协议/端口/userinfo 校验）。该变量默认空；生产 `wrangler.jsonc` 不得设置；只用于本地 fixture server（如 `127.0.0.1:8790`）。生产模式（`ENVIRONMENT=production`）即使设置了该变量也**忽略**。AC-33 验证：生产模式下 `127.0.0.1` 仍被拒绝。

### 9.3 重定向

- 统一 `redirect: 'manual'`；最多 `MAX_REDIRECTS=3` 跳。
- 每跳 301/302/303/307/308：解析 `Location`（相对/绝对），回到 §9.2 第 1 步重新校验；不继承任何请求头；303 仍用 GET（本来只有 GET）。
- 超过 3 跳、缺少 Location、Location 非法 → 错误。
- 每跳独立 `AbortSignal.timeout(min(PER_HOP_TIMEOUT_MS, remaining))`；总 deadline 10s。
- 不发送 Cookie/Authorization/用户传入的任何头。

### 9.4 超时与大小

| 限制 | 默认 | 说明 |
|---|---|---|
| 总请求 deadline | 10,000 ms | 所有上游共享；超时 → 504 |
| 单跳超时 | 5,000 ms | 也受总 deadline 约束 |
| 单 source 上游 | 8 MiB | 订阅/规则/配置/模板统一上限，按 source 类型另有更小值 |
| 总上游 | 16 MiB | 所有 source 累计 |
| 远程 URL 字符 | 4,096 | http(s) source |
| inline/data source 字符 | 12,000 | 含前缀；8,192 解码后 base64url 为 10,923 + 前缀 <12,000 |
| inline 解码后 | 8 KiB | 受 Workers URL 16 KB 限制；16 KiB 解码后约 21,846 字符，必然超限 |
| config | 256 KiB | |
| template | 256 KiB | |
| ruleset | 4 MiB | |
| 节点数 | 10,000 | 超出截断 + Warning |
| 规则数 | 50,000 | 超出截断 + Warning |
| 组数 | 128 | 超出截断 + Warning |
| 输出 | 16 MiB | 超出 → 500/413 |
| warnings | 200 | 超出聚合 |
| 输出 provider URL | 12,000 字符 | 超出回退内联 |

- 读取上游必须流式累加，超过单 source 上限立即 `reader.cancel()` 并返回 `upstream_too_large`；不得先 `await res.text()` 再判断。
- `Content-Length` 预检只用于提前拒绝；缺失时依赖流式计数。

### 9.5 缓存策略

| 端点 | `Cache-Control` |
|---|---|
| `/`、`/version` | `public, max-age=3600` |
| `/getruleset` | `public, max-age=<RULESET_CACHE_TTL=300>, stale-while-revalidate=600` |
| `/sub`、`/clash` | 默认 `private, no-store` |
| `/sub` 且 `PUBLIC_SUBSCRIPTION_CACHE=true` | `public, max-age=<SUBSCRIPTION_CACHE_TTL=60>, stale-while-revalidate=300` |
| 所有错误 | `private, no-store` |

- `PUBLIC_SUBSCRIPTION_CACHE` 默认 false：订阅 URL 常含 token，不能默认放到 CDN。部署者显式开启即接受“URL 即凭据”的风险。
- Workers Cache 的 key 含 path+query、不含 hostname（`docs/research/cloudflare-workers.md:176-189`）。
  - **inline 模式**：输出只依赖 path+query，多域名共享缓存不会串内容。
  - **providers 模式**：`rule-providers[].url` 嵌入了 origin（§5.7）。若不同 hostname 命中同一 cache key，host A 的缓存可能返回 host B 的 provider URL。因此：
    - 配置 `PUBLIC_ORIGIN`（绝对 https origin，无 path）时，provider URL 恒用该 canonical origin，缓存安全；
    - `PUBLIC_ORIGIN` 为空时，**providers 模式的 `/sub`/`/clash` 永远 `private, no-store`**，即使 `PUBLIC_SUBSCRIPTION_CACHE=true`；同时产生 `W_PROVIDER_ORIGIN_UNPINNED`。
    - AC-29 用两个 hostname 验证：无 `PUBLIC_ORIGIN` 时不产生 public cache；有 `PUBLIC_ORIGIN` 时两份响应都指向同一 canonical origin。
- `/getruleset` 的 payload 只依赖 path+query（source/dialect/type），不含 origin，因此可 public cache。
- 不缓存上游原始响应；不把用户可控 URL 作为 Cache API 的共享 key（避免跨租户缓存投毒）。
- 不使用 KV/D1/R2；v1 无状态。

### 9.6 头与日志

- 上游 `Subscription-UserInfo` 仅在匹配 `^(upload|download|total|expire)=\d+(;\s*(upload|download|total|expire)=\d+)*$` 且 ASCII、≤512 字节时透传；否则忽略并 `W_USERINFO_INVALID`。
- 日志（`console.*`）只允许：错误码、阶段、host、host 的 FNV-1a hash、行号、节点/规则计数、耗时。**不得**记录完整 URL、query、fragment、userinfo、节点 URI、密码、UUID、token。
- Warning 的 `raw` 字段不得包含节点 URI/密码/UUID；规则文本可保留但截断到 160 字符。

### 9.7 鉴权与滥用

- v1 不内置鉴权、速率限制、KV 短链。公开部署应使用 Cloudflare WAF/速率限制、Cloudflare Access 或自建网关。
- `/getruleset` 是一个受控的“取回并转换”端点：它只返回校验后的规则 payload，不返回上游原文；仍应通过 WAF 限制滥用与带宽。

---

## 10. 结构化 Warning

### 10.1 数据结构

```ts
type Severity = 'info' | 'warning' | 'error';
type Stage = 'request' | 'fetch' | 'decode' | 'yaml' | 'nodes' | 'rules' | 'groups' | 'template' | 'emit';

interface Warning {
  code: WarningCode;      // 稳定字符串，见 §10.2
  severity: Severity;
  stage: Stage;
  message: string;        // 英文短句，不含敏感信息
  source?: string;        // "url#1" / "config" / "template" / "inline#2"
  line?: number;          // 1-based
  raw?: string;           // ≤160 字符，控制字符转义
  hint?: string;          // 可操作建议
}
```

### 10.2 原因码表

| code | severity | stage | 含义 |
|---|---|---|---|
| `W_PARAM_UNKNOWN` | info | request | 未知 query 参数，已忽略 |
| `W_PARAM_UNSUPPORTED` | warning | request | 已知 tindy 参数但 v1 不支持，已忽略 |
| `W_PARAM_IGNORED` | info | request | 参数在当前上下文无意义，已忽略 |
| `W_CONFIG_OVERRIDES_PARAMS` | warning | request | config 存在，groups/ruleset 查询参数被忽略 |
| `W_SOURCE_EMPTY` | warning | request | 空 source 项被丢弃 |
| `E_BASE64_INVALID` | error | decode | base64 解码失败 |
| `E_UTF8_INVALID` | error | decode | 内容不是合法 UTF-8 |
| `E_UNSUPPORTED_INPUT_FORMAT` | error | decode | source 不属于支持的输入格式 |
| `W_INPUT_BASE64_DETECTED` | info | decode | 自动识别为 base64 |
| `E_FETCH_STATUS` | error | fetch | 上游非 2xx |
| `E_FETCH_TIMEOUT` | error | fetch | 上游超时 |
| `E_FETCH_TOO_LARGE` | error | fetch | 上游超过字节上限 |
| `E_FETCH_NETWORK` | error | fetch | 网络/TLS/平台错误 |
| `E_FETCH_REDIRECT_LIMIT` | error | fetch | 重定向超过 3 跳 |
| `E_FETCH_HTML` | error | fetch | 检测到 HTML 错误页 |
| `E_FETCH_ERROR_PAGE` | error | fetch | 检测到 JSON 错误页 |
| `E_FETCH_EMPTY` | error | fetch | 空响应 |
| `E_SSRF_BLOCKED` | error | fetch | SSRF 校验拒绝 |
| `W_FETCH_REDIRECT` | info | fetch | 跟随了一次重定向 |
| `W_FETCH_CONTENT_TYPE` | warning | fetch | Content-Type 非预期但内容可用 |
| `E_YAML_PARSE` | error | yaml | YAML 解析失败 |
| `E_YAML_MULTI_DOC` | error | yaml | 多文档 YAML |
| `E_YAML_TAG` | error | yaml | 自定义 YAML tag |
| `W_CLASH_DUPLICATE_PROXY_KEY` | warning | yaml | `proxies` 与 `Proxy` 同时存在 |
| `W_CLASH_SECTION_IGNORED` | warning | yaml | Clash 输入中的组/规则段被忽略 |
| `W_NODE_UNSUPPORTED_PROTOCOL` | warning | nodes | Clash 节点类型不在 v1 范围 |
| `W_NODE_FIELDS_IGNORED` | warning | nodes | 节点有未识别字段（聚合） |
| `E_NODE_LINE` | error | nodes | 单行 URI 解析失败 |
| `E_NODE_SCHEME_UNSUPPORTED` | error | nodes | URI scheme 不支持 |
| `E_NODE_LINE_TOO_LONG` | error | nodes | 单行超过 4096 |
| `E_NODE_PORT` | error | nodes | 端口非法 |
| `E_NODE_SERVER` | error | nodes | 服务器地址非法 |
| `E_NODE_UUID` | error | nodes | UUID 非法 |
| `E_NODE_CIPHER` | error | nodes | cipher/protocol/obfs 非法 |
| `E_NODE_TRANSPORT` | error | nodes | 传输不支持 |
| `E_NODE_PLUGIN` | error | nodes | SS plugin 不支持 |
| `E_NODE_ENCRYPTION` | error | nodes | VLESS encryption 非 none |
| `E_NODE_REALITY` | error | nodes | Reality 缺 pbk |
| `E_NODE_FLOW` | error | nodes | VLESS flow 不支持 |
| `W_NODE_NAME_EMPTY` | info | nodes | 空名称，使用 server:port |
| `W_NODE_NAME_TRUNCATED` | warning | nodes | 名称超过 128 字符 |
| `W_NODE_NAME_DUPLICATE` | warning | nodes | 名称冲突，已加后缀 |
| `W_NODE_NAME_RESERVED` | warning | nodes | 名称与保留名冲突，已加后缀 |
| `W_NODE_LIMIT` | warning | nodes | 节点数超过 10,000 |
| `E_RULE_EMPTY` | warning | rules | 空规则行（通常已提前跳过） |
| `E_RULE_TOO_LONG` | error | rules | 规则行超过 4096 |
| `E_RULE_UNKNOWN_TYPE` | error | rules | 类型不在精确白名单 |
| `E_RULE_NO_TARGET` | error | rules | 缺 target（DOMA 类错误的直接拦截点） |
| `E_RULE_EMPTY_PAYLOAD` | error | rules | payload 为空 |
| `E_RULE_BAD_DOMAIN` | error | rules | 域名非法 |
| `E_RULE_BAD_CIDR` | error | rules | CIDR 非法 |
| `E_RULE_BAD_PORT` | error | rules | 端口/范围非法 |
| `E_RULE_BAD_ASN` | error | rules | ASN 非法 |
| `E_RULE_BAD_REGEX` | error | rules | 正则非法 |
| `E_RULE_BAD_NETWORK` | error | rules | NETWORK 非 tcp/udp |
| `E_RULE_BAD_PAYLOAD` | error | rules | 其它 payload 非法 |
| `E_RULE_BAD_LOGIC` | error | rules | 逻辑规则括号/子规则非法 |
| `E_RULE_TARGET_NOT_FOUND` | error | rules | target 不存在 |
| `W_RULE_TYPE_ALIAS` | info | rules | FINAL/HOST* 等已翻译 |
| `W_RULE_TYPE_UNSUPPORTED` | warning | rules | Surge/QuanX 类型无 mihomo 等价 |
| `W_RULE_SUB_RULE_UNSUPPORTED` | warning | rules | SUB-RULE 在 v1 不输出 |
| `W_RULE_INLINE_COMMENT` | warning | rules | 行内注释已截断 |
| `W_RULE_PARAM_IGNORED` | warning | rules | 非 no-resolve 的第 4 字段被丢弃 |
| `W_RULE_SOURCE_TARGET_IGNORED` | warning | rules | 规则集源里的 target 被 GROUP 覆盖 |
| `E_TRUNCATED_TAIL` | error | rules | 尾部疑似截断 |
| `E_TRUNCATED_SOURCE` | error | rules | 声明计数与实际不符 |
| `W_TRUNCATED_TAIL_SUSPECT` | warning | rules | 尾部缺失换行但无法确定 |
| `W_RULE_DUPLICATE_MATCH` | warning | rules | 多个 MATCH，保留最后一个 |
| `W_DEFAULT_MATCH_ADDED` | info | rules | 自动补最终 MATCH |
| `W_RULE_LIMIT` | warning | rules | 规则数超过 50,000 |
| `W_RULESET_IMPORT_UNSUPPORTED` | warning | rules | `!!import:` 不支持 |
| `W_DIALECT_ALIAS` | info | rules | `clash-classic` 作为 `clash-classical` 别名接受 |
| `W_DIALECT_UNSUPPORTED` | warning | rules | `quanx:` 等 tindy 方言不支持，source 跳过 |
| `W_RULESET_TYPE_FILTERED` | warning | rules | `/getruleset` 因 type 过滤掉不兼容规则 |
| `W_RULE_SOURCE_TARGET_AMBIGUOUS` | warning | rules | 规则集源最后一个字段疑似 target 但不在已知目标中，按 payload 保留 |
| `W_RULESET_EMPTY` | warning | rules | 规则源为空/全部被过滤 |
| `W_PROVIDER_INLINE_FALLBACK` | warning | rules | provider 不可用，回退内联 |
| `W_PROVIDER_ORIGIN_UNPINNED` | warning | rules | providers 模式未配置 PUBLIC_ORIGIN，响应禁止公开缓存 |
| `W_GROUP_UNSUPPORTED_TYPE` | warning | groups | 组类型不支持 |
| `W_GROUP_EMPTY` | warning | groups | 空组补 DIRECT |
| `W_GROUP_DIRECTIVE_UNSUPPORTED` | warning | groups | `!!PROVIDER` 等指令不支持 |
| `W_GROUP_MATCHER_INVALID` | warning | groups | matcher 正则非法/不安全 |
| `W_GROUP_NAME_DUPLICATE` | warning | groups | 组名冲突，已加后缀 |
| `W_GROUP_AUTO_CREATED` | warning | groups | 规则引用的组不存在，已自动创建 |
| `W_GROUP_LIMIT` | warning | groups | 组数超过 128 |
| `W_GROUP_DEFAULT_ADDED` | info | groups | 无配置时添加默认组 |
| `W_TEMPLATE_KEY_DENIED` | warning | template | 模板键不在允许表 |
| `W_TEMPLATE_CORE_IGNORED` | warning | template | 模板核心键被生成器覆盖 |
| `W_BUILTIN_TEMPLATE_MAPPED` | info | template | `clash_rule_base` 的已知本地路径映射到内置模板 |
| `W_TEMPLATE_RULES_APPENDED` | info | template | 模板规则已校验并追加 |
| `W_CONFIG_SECTION_IGNORED` | warning | template | config 段被忽略 |
| `W_CONFIG_KEY_UNSUPPORTED` | warning | template | config 键不支持 |
| `W_USERINFO_INVALID` | warning | fetch | Subscription-UserInfo 格式非法，未透传 |
| `E_EMIT_INVALID` | error | emit | 输出读回校验失败（致命） |
| `E_OUTPUT_TOO_LARGE` | error | emit | 输出超过 16 MiB（致命） |
| `W_WARNING_LIMIT` | warning | emit | Warning 超过 200 条，已截断 |

- `E_*` 表示“该条目/该 source 失败”；只有顶层致命错误（§2.9）才改变 HTTP 状态。单条 `E_RULE_NO_TARGET` 不会让整个请求失败，除非最终零节点。
- 同一个 `(code, source, line, raw)` 只记录一次；相同 code 的重复条目可聚合，但 `stats.warnings` 计数保持真实。

---

## 11. 验收标准

> 以下命令在实现完成后执行；架构阶段只验证了环境与配置（见 PARITY §12）。

| ID | 场景 | 方法 | 通过标准 |
|---|---|---|---|
| AC-01 | 依赖与构建 | `npm ci` | 退出 0；lockfile 完整；生产依赖只有 `yaml` |
| AC-02 | 类型检查 | `npm run typecheck` | `tsc --noEmit` 退出 0 |
| AC-03 | 单元测试 | `npm run test:unit` | 全部通过；覆盖 links/rules/emitter 的矩阵 |
| AC-04 | 集成测试 | `npm run test:integration` | 在 workerd 中全部通过；路由/CORS/错误码 |
| AC-05 | 打包校验（生产/测试双配置） | `npx wrangler deploy --dry-run --outdir dist` 与 `npx wrangler deploy --dry-run --config wrangler.test.jsonc --outdir dist-test` | 均退出 0；无 KV 绑定；bundle < 5 MiB；生产配置含 `global_fetch_strictly_public`，测试配置不含 |
| AC-06 | 20,675 条规则 + 第 20675 条 `DOMA`（规则语义 + HTTP 端到端） | 单元 `tests/unit/rules/doma-regression.test.ts` 直接调 `buildRules`；E2E 由 `scripts/e2e-acceptance.ts` 启动 `127.0.0.1:8790` fixture server 提供 `tests/fixtures/rules/doma-20675.txt`（使用 2 字段 `DOMAIN,xN` 行 + 末尾 `DOMA`，278,330 B，371,107 base64url 字符，远超 inline 上限），并用 `wrangler dev --config wrangler.test.jsonc`（`ENVIRONMENT=test`、`ALLOW_HTTP_UPSTREAM=true`、`UPSTREAM_ALLOWED_PORTS=80,443,8790`、`ALLOW_TEST_UPSTREAM_HOSTS=127.0.0.1:8790`，无 `global_fetch_strictly_public`），请求 `url=inline:<small node sub>&ruleset=GROUP,http://127.0.0.1:8790/doma-20675.txt` | 单元断言通过；E2E 200；输出无 `- DOMA`、无未知类型；20,674 条合法规则 + 1 条最终 MATCH；Warning 含 `E_RULE_NO_TARGET` 且 `line=20675`（可同时含 `E_TRUNCATED_TAIL`）；YAML 读回 + 全量规则重校验通过 |
| AC-07 | 尾部截断 `- DOMA`（ruleset + template） | `url=inline:<small node sub>`；`ruleset=GROUP,inline:<b64 of 2 good lines + DOMA without final newline>`；`template=inline:<b64 of valid template + "- DOMA" without final newline>`（两者均 < 8,192 解码字节） | 行被丢弃；Warning 含 `E_TRUNCATED_TAIL`（stage=`rules`/`template`）；其余规则保留；模板规则默认丢弃；不得 400 |
| AC-08 | 五协议输入 | Base64 订阅含 ss/ssr/vmess/trojan/vless 各 1 条 | 200；5 个 proxies；字段/端口/名称正确；无 Warning |
| AC-09 | 单条坏数据隔离 | 5 条好 URI + 1 条坏 URI | 200；5 个节点；1 条 `E_NODE_*`；其余节点完整 |
| AC-10 | 非法规则矩阵 | `DOMA`、`DOMA,example.com`、`MATCHBOX,...`、`FINAL,DIRECT`、`DOMAIN-REGEX,^a{1,3}$,G`、`DOMAIN,x #c,G`、`domain,lower,G`、BOM、CRLF | 各自按 §5/§6 处理；输出全部可读回；无非法类型；每类有对应 Warning |
| AC-11 | 规则类型注册表 | 对 37 个类型各给合法/非法 payload | 合法全部输出（SUB-RULE 除外）；非法全部丢弃 + 精确 code |
| AC-12 | 逻辑规则 | `AND,((DOMAIN,a.com),(NETWORK,tcp)),G` 等 | 合法输出；括号不平衡/嵌套 MATCH 丢弃 + `E_RULE_BAD_LOGIC` |
| AC-13 | providers 模式（非空内容） | 2 个规则源（domain 列表 + surge/classical 列表，含 `DOMAIN-REGEX,...,G` 与 `AND,(...),G`）+ 2 个组；`rules_mode=providers` | 生成 `rule-providers` 与 `RULE-SET`；type 3 payload 恰好为 `+.example.com`/裸域名（不得出现 `DOMAIN-SUFFIX,`）；type 6 输出无 target；`/getruleset` 与内联展开同语义；AC-24 的 mihomo 接受 |
| AC-14 | `/getruleset` 空结果 | 全非法源，type=3/4/6 | 200 + 合法占位项（`+.placeholder.invalid` / `0.0.0.0/32` / `DOMAIN,placeholder.invalid`）+ `X-Subconverter-Placeholder: 1` + Warning |
| AC-15 | 代理组 | select/url-test/fallback/load-balance 各 1 个组 | 字段完整；空组补 DIRECT；成员不重复、不自引用 |
| AC-16 | 模板合并 | 模板含 `mixed-port`、`dns`、`script`、`proxies`、`rules` | 允许键保留；拒绝键丢弃 + Warning；核心键不覆盖生成器；模板规则默认丢弃 |
| AC-17 | ACL4SSR INI | 含 `custom_proxy_group`、`ruleset`、`clash_rule_base=base/all_base.tpl`、`rename`、`include_remarks` 的配置 | 组/规则/重命名生效；`clash_rule_base` 映射到内置模板 + `W_BUILTIN_TEMPLATE_MAPPED`；不支持键告警；输出可读回 |
| AC-18 | 确定性 | 同一输入连续请求 2 次 | 输出逐字节相同 |
| AC-19 | SSRF 矩阵 | `127.0.0.1`、`169.254.169.254`、`[::1]`、`[::ffff:127.0.0.1]`、`2130706433`、`0x7f000001`、`0177.0.0.1`、`127.1`、`localhost.`、`localtest.me`、`nip.io`、userinfo、302→私网、`file:` | 全部 400 `blocked_upstream` 或 `invalid_source`；不得发起请求 |
| AC-20 | 超时/大小 | 假上游永不响应；假上游返回 8 MiB+1 | 504；413；均不挂起、不 OOM |
| AC-21 | CORS/方法 | OPTIONS、POST、HEAD `/sub` | 204；405 + Allow；405 + Allow |
| AC-22 | 诊断 JSON | `diagnostics=json` 成功/失败 | 包络字段完整；Warning 结构化；`output` 与默认响应一致 |
| AC-23 | 端到端脚本 | `npm run test:e2e` | 本地 workerd 启动；全部断言通过；无需 Cloudflare 登录 |
| AC-24 | mihomo 客户端（**发布必过**） | `MIHOMO_BIN=/path/to/mihomo npm run test:mihomo`；CI 使用 pinned release + checksum；未设置 `MIHOMO_BIN` 时脚本非零退出 | AC-06/08/13/16/17 生成的配置均通过 `mihomo -t -f`，退出 0 |
| AC-24b | E2E 无 mihomo 时的降级 | `npm run test:e2e`（不设置 `MIHOMO_BIN`） | 允许打印 `SKIP mihomo validation`，**不计入**发布门禁；不得把 SKIP 写成 pass |
| AC-25 | 文件归属 | `npm run check:ownership` | 每个文件恰好一个 owner；无未归属/重复归属 |
| AC-26 | 安全字符串 | `include=(a+)+$`、`rename=(a+)+$@x` | 400 `invalid_regex`（不安全正则拒绝） |
| AC-27 | 项目门禁 | `npm test` | ownership + 单元 + 集成全部通过 |
| AC-28 | 输出读回/属性测试 | `npm run test:unit` 执行 `tests/unit/rules/fuzz.test.ts`、`tests/unit/emitter/invariants.test.ts`；seed 固定，≥10,000 组合法/非法规则；向 emitter 注入 `DOMAIN,,PROXY`、不平衡 `AND`、坏 CIDR、缺 target | 任何非法输出必须被完整重校验拒绝（`E_EMIT_INVALID` 或测试失败）；合法输出 100% 可被 `rules.parseRuleLine` 重解析 |
| AC-29 | providers 缓存跨 host | `tests/integration/provider-cache.test.ts`：同一 path+query 用两个 hostname；分别测 `PUBLIC_ORIGIN` 空/非空 | 空：`Cache-Control: private, no-store` + `W_PROVIDER_ORIGIN_UNPINNED`；非空：public 缓存且两 host 的 provider URL 都指向 canonical `PUBLIC_ORIGIN` |
| AC-30 | `clash_rule_base` 本地路径 | config 含 `clash_rule_base=base/all_base.tpl`；另一例 `clash_rule_base=./local/base.yaml` | 前者映射内置模板 + `W_BUILTIN_TEMPLATE_MAPPED`；后者 400 `invalid_template` 且 message 提示改用 inline/URL |
| AC-31 | 方言别名/拒绝 | `ruleset=G,clash-classic:<source>`；`ruleset=G,quanx:<source>` | 前者正常解析 + `W_DIALECT_ALIAS`；后者 `invalid_source` + `W_DIALECT_UNSUPPORTED`，不误当 URL |
| AC-32 | inline 边界 | 8,192 解码字节（10,930 source 字符）接受；8,193 解码字节拒绝；12,001 source 字符拒绝（source 字符上限 12,000）；16,384 解码字节（21,846 字符）拒绝；远程 4,097 字符拒绝 | 边界值按 §2.5/§9.4；错误为 `invalid_source`，不得触发 Workers URL 16 KiB 平台错误 |
| AC-33 | 测试夹具隔离 | 生产模式下设置 `ALLOW_TEST_UPSTREAM_HOSTS=127.0.0.1:8790` 请求 `http://127.0.0.1:8790/`；测试模式下设置 `ENVIRONMENT=test`、`UPSTREAM_ALLOWED_PORTS=80,443,8790`，白名单精确匹配/不匹配各一例 | 生产模式仍 400 `blocked_upstream`；测试模式精确匹配才放行，不匹配仍拒绝 |
| AC-34 | 独立输出不变量 | 对 AC-06/13/16/17 输出运行 `tests/unit/emitter/invariants.test.ts` | 恰好一条末尾 MATCH；无空 target/payload；无 `DOMA`；端口/CIDR/逻辑括号合法；最后换行存在 |

### 11.1 测试命令

```bash
npm ci
npm run typecheck
npm run test:unit
npm run test:integration
npm test
npx wrangler deploy --dry-run --outdir dist
npm run test:e2e
npm run check:ownership
# 发布门禁（必过；未设置 MIHOMO_BIN 时 test:mihomo 非零退出）：
MIHOMO_BIN=/path/to/mihomo npm run test:mihomo
```

---

## 12. 附录

### 12.1 最小请求示例

纯文本 / inline（URL-safe base64）：

```text
GET /sub?target=clash&url=inline:c3M6Ly9hZXMtMjU2LWdjbTpwYXNzQDEuMi4zLjQ6ODM4OCNub2RlMQ
```

Clash YAML 输入：

```yaml
proxies:
  - {name: n1, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-256-gcm, password: p}
```

带规则集（inline 规则文本）：

```text
GET /sub?target=clash&url=inline:...&ruleset=PROXY,[]DOMAIN-SUFFIX,example.com
```

注意：`[]DOMAIN-SUFFIX,example.com` 会被解析为 `DOMAIN-SUFFIX,example.com,PROXY`；而 `[]DOMA` 会产生 `E_RULE_NO_TARGET`（单字段预检）或 `E_RULE_UNKNOWN_TYPE`，不会进入输出。

### 12.2 默认模板（内置）

```yaml
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: true
dns:
  enable: true
  ipv6: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - https://1.1.1.1/dns-query
    - https://8.8.8.8/dns-query
```

### 12.3 输出片段示例

```yaml
# Generated by subconverter-worker 1.0.0; nodes=2 groups=2 rules=3 warnings=0
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: true
dns:
  enable: true
  ipv6: true
  enhanced-mode: fake-ip
proxies:
  - name: "node1"
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-256-gcm
    password: "pass"
proxy-groups:
  - name: PROXY
    type: select
    proxies: [node1, DIRECT]
  - name: AUTO
    type: url-test
    url: https://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50
    proxies: [node1]
rules:
  - "DOMAIN-SUFFIX,example.com,PROXY"
  - "MATCH,PROXY"
```
