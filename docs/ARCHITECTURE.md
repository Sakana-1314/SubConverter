# 架构（ARCHITECTURE）

- 项目：`subconverter-worker`
- 版本：1.0.0
- 对应规格：`docs/SPEC.md`
- 运行时：Cloudflare Workers Paid + Wrangler 4.158.x + TypeScript 7.x + `yaml` 2.9.x
- 目标：把 tindy2013/subconverter 的**行为**迁移到边缘运行时；优先 mihomo/Clash 输出；规则管线 fail-closed；不复制 C++ 源码/base 配置

---

## 1. 设计原则

1. **行为优先，独立实现**：以 `docs/research/original-subconverter.md` 的行为取证为输入，重新设计模块边界；不逐行翻译 C++。
2. **单一规则边界**：所有规则（远程规则集、模板规则、内联规则、INI 配置）必须经过 `rules` 模块的同一套 `parse → validate → target resolve`；`emitter` 不得接受未经 `rules` 校验的规则字符串。
3. **失败隔离**：单个 URL、单个节点、单行规则、单个配置键的失败只影响该条目，产生结构化 Warning；只有“零节点/全部 source 失败/内部读回失败”才让请求失败。
4. **不原样透传**：下游不会看到“未校验的远端文本”。`RULESET_SURGE` 直通、`[]` 行内直通、base 规则原样复制这三条 tindy 路径在本项目中被明确移除（`docs/research/original-subconverter.md:721-757`、`docs/research/doma-diagnosis.md:315-334`）。
5. **最小依赖**：生产依赖只有 `yaml@2.9.x`；不使用 `js-yaml`（其 4.1.1 有 merge/omap 二次复杂度 DoS，见 `docs/research/reference-audit.md:319-342`），不使用 `node:dns`/`node:net`。
6. **确定性**：同一输入 + 同一版本 + 同一配置 → 逐字节相同的 YAML；不写时间戳/随机数/不稳定 Map 顺序。
7. **单文件单 owner**：`links` / `rules` / `emitter` / `integration` 四个 owner；用 `ownership.json` + 检查脚本强制。
8. **可测试的纯核心**：links/rules/emitter 的核心函数不依赖 Worker API；integration 才接触 `Request`/`Response`/`fetch`/`caches`。

---

## 2. 运行时约束（决定架构的事实）

| 事实 | 影响 | 证据 |
|---|---|---|
| Free 计划 CPU 10 ms；Paid 默认 30 s，可配 `limits.cpu_ms` | 生产必须 Paid；显式 `cpu_ms: 5000` | `docs/research/cloudflare-workers.md:31-51` |
| 平台对 HTTP 请求**没有总超时** | 必须自建 deadline/AbortSignal | `docs/research/cloudflare-workers.md:73-86` |
| Worker 内 `node:dns.lookup` 不可用 | SSRF 只能做 URL/IP 字面量校验 + 平台 egress 兜底 | `docs/research/cloudflare-workers.md:310-331` |
| `redirect:'error'` 不支持；默认跟随会转发头 | 必须 `redirect:'manual'` 逐跳校验 | `docs/research/cloudflare-workers.md:264-288` |
| `new URL()` 会归一化十进制/十六进制/短写 IPv4，IPv6 变十六进制 | SSRF 必须基于 `new URL()` + 数值网段 | `docs/research/cloudflare-workers.md:333-356` |
| Worker 响应默认不进 CDN；Workers Cache 需 `cache.enabled` | 显式开启；缓存键含 path+query，不含 hostname | `docs/research/cloudflare-workers.md:153-189` |
| 内存 128 MB/isolate；响应体无硬上限 | 流式读取 + 单 source/总量上限 | `docs/research/cloudflare-workers.md:53-72` |
| `wrangler deploy --dry-run` 不需要登录 | CI 可做打包校验 | `docs/research/cloudflare-workers.md:441-469` |
| `compatibility_date >= 2026-08-04` 默认开 `nodejs_compat` | 不写 `compatibility_flags: ["nodejs_compat"]` | `docs/research/cloudflare-workers.md:390-398` |
| `global_fetch_strictly_public` 可收紧出站 | 本项目开启，作为 SSRF 纵深防御 | 兼容 flag，见下文 |

### 2.1 部署基线

- Cloudflare Workers **Paid**（$5/月起），`limits.cpu_ms: 5000`。
- 无 KV/D1/R2/DO 绑定；v1 无状态，部署不需要创建任何命名空间。
- `wrangler.jsonc`：

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "subconverter-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-09",
  "compatibility_flags": ["global_fetch_strictly_public"],
  "workers_dev": true,
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "cache": { "enabled": true },
  "limits": { "cpu_ms": 5000 },
  "vars": {
    "UPSTREAM_TIMEOUT_MS": "8000",
    "REQUEST_DEADLINE_MS": "10000",
    "PER_HOP_TIMEOUT_MS": "5000",
    "MAX_UPSTREAM_BYTES": "8388608",
    "MAX_TOTAL_UPSTREAM_BYTES": "16777216",
    "MAX_INLINE_BYTES": "8192",
    "MAX_INLINE_SOURCE_CHARS": "12000",
    "MAX_NODES": "10000",
    "MAX_RULES": "50000",
    "MAX_GROUPS": "128",
    "MAX_REDIRECTS": "3",
    "ALLOW_HTTP_UPSTREAM": "false",
    "UPSTREAM_ALLOWED_PORTS": "80,443",
    "PUBLIC_SUBSCRIPTION_CACHE": "false",
    "SUBSCRIPTION_CACHE_TTL": "60",
    "RULESET_CACHE_TTL": "300",
    "PUBLIC_ORIGIN": "",
    "ENVIRONMENT": "production",
    "ALLOW_TEST_UPSTREAM_HOSTS": ""
  }
}
```

> 该配置已用 `npx --yes wrangler@4.158.0 deploy --dry-run --outdir dist` 在临时目录验证通过（见 PARITY §12）。注意：这验证的是**配置可打包**，不是项目实现或真实部署。`ENVIRONMENT=test` / `ALLOW_TEST_UPSTREAM_HOSTS` 只由 E2E 脚本在本地 `wrangler dev` 覆盖；生产配置必须保持 `production`/空。`PUBLIC_ORIGIN` 为空时 providers 模式禁止公开缓存（SPEC §9.5）。
>
> `wrangler.test.jsonc` 是 E2E 专用配置：与 `wrangler.jsonc` 相同的 `main`/`compatibility_date`/`cache`/`limits`，但**没有 `compatibility_flags: ["global_fetch_strictly_public"]`**（避免本地 fixture fetch 被平台层阻断），并设置 `ENVIRONMENT=test`、`ALLOW_HTTP_UPSTREAM=true`、`UPSTREAM_ALLOWED_PORTS=80,443,8790`、`ALLOW_TEST_UPSTREAM_HOSTS=127.0.0.1:8790`。它不得用于生产部署。

### 2.2 环境变量契约

| 变量 | 默认 | 解析/校验 |
|---|---|---|
| `UPSTREAM_TIMEOUT_MS` | 8000 | 500..20000 |
| `REQUEST_DEADLINE_MS` | 10000 | 1000..30000；必须 ≥ `PER_HOP_TIMEOUT_MS` |
| `PER_HOP_TIMEOUT_MS` | 5000 | 500..10000 |
| `MAX_UPSTREAM_BYTES` | 8388608 | 1 KiB..32 MiB |
| `MAX_TOTAL_UPSTREAM_BYTES` | 16777216 | ≥ `MAX_UPSTREAM_BYTES`，≤64 MiB |
| `MAX_INLINE_BYTES` | 8192 | 1 KiB..8 KiB；8,192 解码后 base64url 为 10,923 字符，16 KiB 解码会到 21,846，必然超 URL |
| `MAX_INLINE_SOURCE_CHARS` | 12000 | 4,096..16,000；只对 inline/data source 生效；远程 URL 固定 ≤4,096 |
| `MAX_NODES` | 10000 | 1..50000 |
| `MAX_RULES` | 50000 | 1..200000 |
| `MAX_GROUPS` | 128 | 1..512 |
| `MAX_REDIRECTS` | 3 | 0..5 |
| `ALLOW_HTTP_UPSTREAM` | `false` | bool |
| `UPSTREAM_ALLOWED_PORTS` | `80,443` | 逗号列表，支持 `a-b` 范围；空 = 只允许 80/443 |
| `PUBLIC_SUBSCRIPTION_CACHE` | `false` | bool |
| `SUBSCRIPTION_CACHE_TTL` | 60 | 0..3600 |
| `RULESET_CACHE_TTL` | 300 | 0..86400 |
| `PUBLIC_ORIGIN` | 空 | 绝对 `https://host[:port]`，无 path/query；providers 模式的 canonical origin；为空则 providers 模式禁止 public cache |
| `ENVIRONMENT` | `production` | `production` \| `test`；只有 `test` 才读取测试夹具白名单 |
| `ALLOW_TEST_UPSTREAM_HOSTS` | 空 | 逗号分隔的精确 `host:port`；仅 `ENVIRONMENT=test` 生效；生产配置必须为空；只用于本地 E2E fixture server |

- `env.ts` 在模块级只解析一次常量（不解析大文件），非法值 → 启动时抛错（fail-fast），但在 `fetch` 内捕获并返回 500，避免整个 Worker 不可用。
- `PUBLIC_ORIGIN` 必须是绝对 `https://host[:port]`（无 path/query）；非法 → 启动错误。`ENVIRONMENT` 只接受 `production|test`；`ALLOW_TEST_UPSTREAM_HOSTS` 只接受精确 `host:port` 列表，且仅 `test` 生效。
- 所有 vars 在 `wrangler.jsonc` 中以字符串给出；Workers 环境变量没有数字类型。

---

## 3. 信任边界与数据流

```
                    ┌─────────────────────────────────────────────┐
  Client GET ──────▶│ integration: router → params → pipeline     │
                    └───────────────┬─────────────────────────────┘
                                    │ source refs (inline/http)
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │ links: url-guard → fetch → decode → detect   │
                    │        → uri parsers / clash-input → nodes   │
                    └───────────────┬─────────────────────────────┘
                                    │ ProxyNode[] + Warnings
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │ rules: dialects → parse → validate → target  │
                    │        → groups / providers / INI            │
                    └───────────────┬─────────────────────────────┘
                                    │ Rule[] + ResolvedGroup[] + providers
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │ emitter: template sanitize → nodes/groups/   │
                    │          rules/providers → YAML → readback   │
                    └───────────────┬─────────────────────────────┘
                                    │ YAML string
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │ integration: diagnostics/headers/cache/CORS  │
                    └─────────────────────────────────────────────┘
```

信任级别：

- **完全不可信**：上游订阅、规则集、config、template、Clash YAML 输入、HTTP 头。
- **半可信**：query 参数（用户可控，但属于本服务 API）。
- **可信**：内置默认模板、注册表、代码常量。
- **输出**：只由经过校验的结构化对象生成；不允许把不可信字符串直接拼进 YAML 文本（规则也不例外，必须经过 `Scalar`）。

---

## 4. 模块与 owner

| 模块 | owner | 职责 | 允许依赖 |
|---|---|---|---|
| `links` | `links` | 共享类型、base64/text/IP 原语、SSRF、fetch、输入检测、5 种 URI 解析、Clash YAML 节点解析、节点过滤/重命名/命名分配 | 仅 `yaml` 与标准 Web API（纯函数不依赖 Worker） |
| `rules` | `rules` | 规则类型注册表、方言解析、字段拆分、payload 校验、目标解析、组 DSL、ACL4SSR INI 子集、provider 规格 | `links` 的纯原语与类型 |
| `emitter` | `emitter` | 模板清洗/合并、ProxyNode/Group/Rule/provider → YAML、规则引号、读回校验、默认模板 | `links`、`rules` |
| `integration` | `integration` | Worker 入口、路由、参数、env、编排、source 解析、HTTP/CORS/缓存/诊断/帮助、E2E 脚本、配置与文档 | 全部模块 |

**依赖方向**：`links → rules → emitter`；`integration` 在顶层。`rules` 对 `links` 的依赖仅限 `contracts.ts` / `text.ts` / `ip.ts` / `protocols.ts` 等纯函数；`emitter` 对 `rules` 的依赖仅限类型与注册表/校验函数。不得出现反向运行时依赖。

---

## 5. 文件清单（单文件单 owner）

> 除特别说明外，路径相对于项目根。`# owner` 是唯一 owner。`tests/fixtures/<owner>/` 为目录级归属，内部文件不得跨 owner 共享。
> 现有 `docs/research/*.md` 是架构输入材料（只读证据，不参与实现）；`docs/SPEC.md`、`docs/ARCHITECTURE.md`、`docs/PARITY.md` 是架构产物。为满足“每个文件一个 owner”的记账要求，它们都归入 `integration`，但实现者不得修改 `docs/research/*`。

### 5.1 根与构建

```
package.json                         # integration
package-lock.json                    # integration
tsconfig.json                        # integration
wrangler.jsonc                       # integration
wrangler.test.jsonc                  # integration（E2E 专用，不含 global_fetch_strictly_public）
vitest.config.ts                     # integration
vitest.integration.config.ts         # integration
ownership.json                       # integration
.gitignore                           # integration
README.md                            # integration
docs/SPEC.md                         # integration（架构产物）
docs/ARCHITECTURE.md                 # integration（架构产物）
docs/PARITY.md                       # integration（架构产物）
docs/research/*.md                   # integration（只读取证材料，不修改）
scripts/check-ownership.ts           # integration
scripts/e2e-acceptance.ts            # integration
```

### 5.2 `src/`

```
src/index.ts                         # integration
src/links/contracts.ts               # links
src/links/base64.ts                  # links
src/links/text.ts                    # links
src/links/ip.ts                      # links
src/links/url-guard.ts               # links
src/links/fetch.ts                   # links
src/links/protocols.ts               # links
src/links/yaml.ts                    # links
src/links/detect.ts                  # links
src/links/subscription.ts            # links
src/links/clash-input.ts             # links
src/links/node-ops.ts                # links
src/links/name-allocator.ts          # links
src/links/uri/index.ts               # links
src/links/uri/ss.ts                  # links
src/links/uri/ssr.ts                 # links
src/links/uri/vmess.ts               # links
src/links/uri/trojan.ts              # links
src/links/uri/vless.ts               # links
src/rules/types.ts                   # rules
src/rules/registry.ts                # rules
src/rules/payload.ts                 # rules
src/rules/split.ts                   # rules
src/rules/parse.ts                   # rules
src/rules/dialects.ts                # rules
src/rules/truncation.ts              # rules
src/rules/providers.ts               # rules
src/rules/groups.ts                  # rules
src/rules/ini.ts                     # rules
src/rules/validate.ts                # rules
src/rules/index.ts                   # rules
src/emitter/nodes.ts                 # emitter
src/emitter/groups.ts                # emitter
src/emitter/rules.ts                 # emitter
src/emitter/providers.ts             # emitter
src/emitter/template.ts              # emitter
src/emitter/serialize.ts             # emitter
src/emitter/config.ts                # emitter
src/emitter/default-template.ts      # emitter
src/emitter/index.ts                 # emitter
src/integration/router.ts            # integration
src/integration/params.ts            # integration
src/integration/env.ts               # integration
src/integration/pipeline.ts          # integration
src/integration/sources.ts           # integration
src/integration/handlers/sub.ts      # integration
src/integration/handlers/ruleset.ts  # integration
src/integration/handlers/meta.ts     # integration
src/integration/http.ts              # integration
src/integration/diagnostics.ts       # integration
src/integration/cache.ts             # integration
src/integration/help.ts              # integration
src/integration/version.ts           # integration
src/integration/errors.ts            # integration
```

### 5.3 `test/`

```
tests/unit/links/**                   # links
tests/fixtures/links/**               # links
tests/unit/rules/**                   # rules
tests/fixtures/rules/**               # rules
tests/unit/emitter/**                 # emitter
tests/fixtures/emitter/**             # emitter
tests/integration/**                  # integration
tests/fixtures/integration/**         # integration
```

具体测试文件（全部落在上述目录内）：

| 文件 | owner |
|---|---|
| `tests/unit/links/base64.test.ts` | links |
| `tests/unit/links/ip.test.ts` | links |
| `tests/unit/links/url-guard.test.ts` | links |
| `tests/unit/links/fetch.test.ts` | links |
| `tests/unit/links/uri.test.ts` | links |
| `tests/unit/links/clash-input.test.ts` | links |
| `tests/unit/links/subscription.test.ts` | links |
| `tests/unit/links/name-allocator.test.ts` | links |
| `tests/unit/rules/registry.test.ts` | rules |
| `tests/unit/rules/payload.test.ts` | rules |
| `tests/unit/rules/dialects.test.ts` | rules |
| `tests/unit/rules/truncation.test.ts` | rules |
| `tests/unit/rules/groups.test.ts` | rules |
| `tests/unit/rules/ini.test.ts` | rules |
| `tests/unit/rules/validate.test.ts` | rules |
| `tests/unit/rules/doma-regression.test.ts` | rules |
| `tests/unit/rules/fuzz.test.ts` | rules |
| `tests/unit/emitter/nodes.test.ts` | emitter |
| `tests/unit/emitter/groups.test.ts` | emitter |
| `tests/unit/emitter/rules.test.ts` | emitter |
| `tests/unit/emitter/template.test.ts` | emitter |
| `tests/unit/emitter/golden.test.ts` | emitter |
| `tests/unit/emitter/invariants.test.ts` | emitter |
| `tests/integration/router.test.ts` | integration |
| `tests/integration/sub.test.ts` | integration |
| `tests/integration/ruleset.test.ts` | integration |
| `tests/integration/security.test.ts` | integration |
| `tests/integration/provider-cache.test.ts` | integration |
| `tests/integration/e2e.test.ts` | integration |

### 5.4 归属强制

- `ownership.json` 是唯一事实来源：`{ "paths": { "src/links/": "links", ... } }` 或显式文件列表；不得一个路径命中两个 owner。
- `scripts/check-ownership.ts`：
  - 遍历 `src/`、`test/`、`scripts/`、根配置文件、`docs/SPEC.md|ARCHITECTURE.md|PARITY.md` 与 `docs/research/*.md`（只读输入也记账）；
  - 对每个文件做最长前缀匹配；必须恰好命中一个 owner；
  - 发现未归属、重复归属、owner 不在四值内 → 非零退出；
  - 在 CI 的 `npm test` 前执行。
- 代码评审规则：新增文件必须先更新 `ownership.json`；跨 owner 修改需要该 owner 的评审。

---

## 6. 核心数据模型

```ts
// src/links/contracts.ts
export type Severity = 'info' | 'warning' | 'error';
export type Stage = 'request' | 'fetch' | 'decode' | 'yaml' | 'nodes' | 'rules' | 'groups' | 'template' | 'emit';
export type WarningCode = string; // 运行时以 SPEC §10.2 的常量表为准

export interface Warning {
  code: WarningCode;
  severity: Severity;
  stage: Stage;
  message: string;
  source?: string;
  line?: number;
  raw?: string;
  hint?: string;
}

export type NodeKind = 'ss' | 'ssr' | 'vmess' | 'trojan' | 'vless';

export interface NodeBase {
  kind: NodeKind;
  name: string;
  server: string;
  port: number;
  sourceGroup?: string;
  udp?: boolean;
  tfo?: boolean;
  skipCertVerify?: boolean;
}

export interface SsNode extends NodeBase {
  kind: 'ss';
  cipher: string;
  password: string;
  plugin?: 'obfs' | 'v2ray-plugin';
  pluginOpts?: Record<string, string | boolean>;
}

export interface SsrNode extends NodeBase {
  kind: 'ssr';
  cipher: string;
  password: string;
  protocol: string;
  protocolParam?: string;
  obfs: string;
  obfsParam?: string;
}

export interface VmessNode extends NodeBase {
  kind: 'vmess';
  uuid: string;
  alterId: number;
  cipher: 'auto';
  tls: boolean;
  servername?: string;
  network: 'tcp' | 'ws' | 'grpc';
  ws?: { path?: string; host?: string };
  grpc?: { serviceName?: string };
}

export interface TrojanNode extends NodeBase {
  kind: 'trojan';
  password: string;
  sni?: string;
  alpn?: string[];
  network: 'tcp' | 'ws' | 'grpc';
  ws?: { path?: string; host?: string };
  grpc?: { serviceName?: string };
}

export interface VlessNode extends NodeBase {
  kind: 'vless';
  uuid: string;
  tls: boolean;
  servername?: string;
  network: 'tcp' | 'ws' | 'grpc';
  flow?: 'xtls-rprx-vision';
  clientFingerprint?: string;
  reality?: { publicKey: string; shortId?: string };
  ws?: { path?: string; host?: string };
  grpc?: { serviceName?: string };
}

export type ProxyNode = SsNode | SsrNode | VmessNode | TrojanNode | VlessNode;

export type SourceRef =
  | { kind: 'inline'; value: string; label: string; bytes: number }
  | { kind: 'http'; value: string; label: string; sourceGroup?: string };
```

```ts
// src/rules/types.ts
export type SupportedDialect =
  | 'clash-classical' | 'clash-domain' | 'clash-ipcidr' | 'surge' | 'domain' | 'base64';
// 注意：'clash-classic' 是对外别名，detectDialect 在进入本类型前归一化为 'clash-classical'。

export interface Rule {
  type: string;         // 归一化后的精确 mihomo 类型
  payload: string;
  target: string;
  params: string[];     // 目前只允许 'no-resolve'
  raw: string;
  line: number;
  sourceId: string;
}

export type GroupType = 'select' | 'url-test' | 'fallback' | 'load-balance';

export interface GroupSpec {
  name: string;
  type: GroupType;
  matchers: Matcher[];
  url?: string;
  interval?: number;
  tolerance?: number;
  strategy?: 'round-robin' | 'consistent-hashing';
}

export type Matcher =
  | { kind: 'literal'; value: string }
  | { kind: 'name-regex'; pattern: string }
  | { kind: 'node-type'; pattern: string }
  | { kind: 'source-group'; pattern: string }
  | { kind: 'server'; pattern: string }
  | { kind: 'port-range'; range: string };

export interface ResolvedGroup {
  name: string;
  type: GroupType;
  members: string[];
  url?: string;
  interval?: number;
  tolerance?: number;
  strategy?: 'round-robin' | 'consistent-hashing';
}

export interface RuleProviderSpec {
  name: string;
  behavior: 'domain' | 'ipcidr' | 'classical';
  source: { raw: string; dialect: SupportedDialect };
  interval: number;
  url?: string;       // 由 integration 在知道 origin 后补全
}
```

```ts
// src/emitter/index.ts
export interface EmitInput {
  template: Record<string, unknown>;
  nodes: ProxyNode[];
  groups: ResolvedGroup[];
  rules: Rule[];
  providers: RuleProviderSpec[];
  origin: string;
  version: string;
  options: { ruleMode: 'inline' | 'providers'; defaultGroup: string };
}

export interface EmitResult {
  yaml: string;
  stats: { nodes: number; groups: number; rules: number; providers: number; bytesOut: number };
  warnings: Warning[];
}
```

---

## 7. 模块契约

### 7.1 `links`

#### 7.1.1 `contracts.ts`

- 只放类型与常量（节点类型、`WarningCode` 常量、限制名）；无运行时依赖。
- `Warning` 是跨模块唯一通信结构；`links/rules/emitter` 只返回/追加 Warning，不抛用户可见错误字符串。

#### 7.1.2 `base64.ts`

```ts
export function decodeBase64Strict(input: string): { ok: true; bytes: Uint8Array } | { ok: false; reason: 'charset' | 'length' | 'padding' };
export function encodeBase64Url(text: string): string;
export function isProbablyBase64(input: string): boolean;
```

- 严格字母表；支持标准/URL-safe；允许无 padding；不做“非法字符原样复制”（与 tindy 的宽松 base64 相反，`docs/research/original-subconverter.md:327-339`）。
- 解码后 UTF-8 校验由 `text.ts` 负责。

#### 7.1.3 `text.ts`

```ts
export function stripBom(s: string): string;
export function normalizeNewlines(s: string): string;
export function hasNul(s: string): boolean;
export function splitLines(s: string): string[];
export function truncateForWarning(s: string, max?: number): string;
export function fnv1a32(s: string): string;   // 8 hex
export function fnv1a64(s: string): string;   // 16 hex，BigInt
export function hashHost(host: string): string;
```

- `truncateForWarning` 必须转义控制字符；不得输出 CR/LF。

#### 7.1.4 `ip.ts`

```ts
export type IpAddress = { version: 4; bytes: [number, number, number, number] } | { version: 6; bytes: Uint8Array };
export function parseIpLiteral(host: string): IpAddress | null;
export function parseCidr(s: string): { ip: IpAddress; prefix: number; canonical: string } | null;
export function isPublicIp(ip: IpAddress): boolean;
export function isIpInCidr(ip: IpAddress, cidr: string): boolean;
```

- 纯 TS，覆盖 IPv4（含 0x/十进制变体由 `new URL()` 先归一化）与 IPv6（含 `::` 压缩、IPv4-mapped）。
- `isPublicIp` 实现 SPEC §9.2 的拒绝表；CIDR 解析供规则校验复用。
- 不得使用 `node:net`（尽管 workerd 可用 `isIP`，但纯 TS 更可测、可移植）。

#### 7.1.5 `url-guard.ts`

```ts
export interface UrlPolicy {
  allowHttp: boolean;
  allowedPorts: Array<{ from: number; to: number }>;
  environment: 'production' | 'test';
  testHosts: Set<string>; // exact host:port; only honored when environment === 'test'
}
export type UrlGuardResult =
  | { ok: true; url: URL }
  | { ok: false; code: 'invalid_url' | 'blocked_upstream'; reason: string };
export function validateUpstreamUrl(raw: string, policy: UrlPolicy): UrlGuardResult;
```

- 严格按 SPEC §9.2 顺序；任何解析异常 → fail-closed。
- 不含 DNS 查询；hostname 拒绝表是常量。
- `environment === 'test'` 且 `new URL().host` 精确命中 `testHosts` 时，跳过 IP/hostname 私网拒绝（仍校验协议/端口/userinfo）；生产模式忽略 `testHosts`。AC-33 覆盖正/负例。
- 单测覆盖十进制/十六进制/八进制/短写 IPv4、`[::ffff:7f00:1]`、`localhost.`、`nip.io`、userinfo、`%2f`、端口越界、测试白名单隔离。

#### 7.1.6 `fetch.ts`

```ts
export interface FetchDeps { fetch: typeof globalThis.fetch; now: () => number; }
export interface FetchPolicy extends UrlPolicy {
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  deadline: number;       // epoch ms
  perHopTimeoutMs: number;
  userAgent: string;
}
export type FetchResult =
  | { ok: true; text: string; bytes: number; effectiveUrl: string; contentType: string | null; status: number; redirects: number; userInfo?: string }
  | { ok: false; code: 'E_FETCH_STATUS' | 'E_FETCH_TIMEOUT' | 'E_FETCH_TOO_LARGE' | 'E_FETCH_NETWORK' | 'E_FETCH_REDIRECT_LIMIT' | 'E_FETCH_HTML' | 'E_FETCH_ERROR_PAGE' | 'E_FETCH_EMPTY' | 'E_UTF8_INVALID'; message: string; status?: number };
export async function fetchSource(source: SourceRef, policy: FetchPolicy, deps: FetchDeps): Promise<FetchResult>;
```

- `SourceRef.kind === 'inline'`：直接校验字节数/UTF-8，不调用 fetch。
- HTTP：每跳 `validateUpstreamUrl` → `fetch(url, { redirect:'manual', headers, signal })` → 状态/重定向/内容类型/流式限长。
- 请求头只允许：`User-Agent`、`Accept`、`Accept-Encoding: identity`。不转发用户头。
- 流式读取：`reader.read()` 累计 `Uint8Array`；超限 `reader.cancel()`；结束后 `TextDecoder('utf-8', {fatal:true})`。
- 记录 `Subscription-UserInfo`（若存在且通过正则/长度校验）到 `userInfo`。
- `deps.fetch` 可注入，纯 Node 单测无需 workerd。

#### 7.1.7 `protocols.ts`

- 常量：SS cipher 表、SSR protocol/obfs 表、UUID 正则、端口/服务器/名称校验、传输集合、`safeRegex` 启发式。
- `compileUserRegex(pattern, context): { ok: true; regex: RegExp } | { ok: false; reason }`：
  - 长度 ≤256；
  - 拒绝嵌套量词/反向引用/过大重复（SPEC §11 AC-26）；
  - 供 include/exclude/rename/组 matcher 使用。
- `compileRuleRegex(pattern)`：只编译不执行，长度 ≤512；允许 `(?i)` 前缀翻译。

#### 7.1.8 `yaml.ts`

```ts
export type YamlParseResult = { ok: true; value: unknown } | { ok: false; code: 'E_YAML_PARSE' | 'E_YAML_MULTI_DOC' | 'E_YAML_TAG'; message: string };
export function parseYamlSingle(text: string, maxBytes: number): YamlParseResult;
```

- 使用 `yaml` 2.9.x：`parseAllDocuments`，`schema:'core'`，`merge:false`，`maxAliasCount:50`，`uniqueKeys:true`，`customTags:[]`。
- 拒绝多文档；扫描 AST 拒绝非 core tag（`!!js/*` 等）。
- 大小预检；解析异常只返回错误码，不泄漏原文。
- 供 Clash 输入、规则 YAML、template 三处复用。

#### 7.1.9 `detect.ts`

```ts
export type InputKind = 'base64' | 'plain-links' | 'clash-yaml' | 'unsupported';
export function detectInput(text: string): { kind: InputKind; decoded?: string };
```

- 顺序见 SPEC §3.1；base64 递归最多 1 层；不得把明文 URI 当 base64。

#### 7.1.10 `subscription.ts`

```ts
export interface ParseNodesResult { nodes: ProxyNode[]; warnings: Warning[]; stats: { lines: number; accepted: number; dropped: number } }
export function parseSubscriptionText(text: string, sourceId: string): ParseNodesResult;
```

- 调用 `detectInput` → `clash-input` 或 `uri/index`。
- 逐行 try/catch；每行失败一个 Warning；继续。
- 不在这里做 include/exclude/rename（交给 `node-ops`）。

#### 7.1.11 `clash-input.ts`

```ts
export function parseClashNodes(value: unknown, sourceId: string): ParseNodesResult;
```

- 输入已由 `yaml.ts` 解析；只读 `proxies`/`Proxy`。
- 每个 proxy 按 type 分派到 `uri/*` 的字段映射器或本地映射器；字段白名单；未知字段聚合 Warning。
- 只接受 5 种协议；其它 `W_NODE_UNSUPPORTED_PROTOCOL`。

#### 7.1.12 `uri/*`

```ts
export type UriParseResult = { ok: true; node: ProxyNode } | { ok: false; code: WarningCode; message: string };
export function parseSs(uri: string): UriParseResult;
export function parseSsr(uri: string): UriParseResult;
export function parseVmess(uri: string): UriParseResult;
export function parseTrojan(uri: string): UriParseResult;
export function parseVless(uri: string): UriParseResult;
```

- `uri/index.ts` 做 scheme 分派与大小写归一化；未知 scheme → `E_NODE_SCHEME_UNSUPPORTED`。
- 所有解析器必须返回 `WarningCode`，不得抛异常（内部可 throw，由 index 捕获并转 Warning）。

#### 7.1.13 `node-ops.ts`

```ts
export function applyFilters(nodes: ProxyNode[], include: string[], exclude: string[], warnings: Warning[]): ProxyNode[];
export function applyRenames(nodes: ProxyNode[], renames: Array<{ pattern: string; replacement: string }>, warnings: Warning[]): ProxyNode[];
export function applySourceGroup(nodes: ProxyNode[], group?: string): void;
export function sortNodes(nodes: ProxyNode[]): ProxyNode[];
```

- `include`/`exclude`/`rename` 用 `protocols.compileUserRegex`；不安全/非法 → 向上抛 `AppError('invalid_regex')`（integration 捕获为 400），而不是静默忽略。
- 过滤先于重命名（SPEC §3.6）。

#### 7.1.14 `name-allocator.ts`

```ts
export function allocateNames(nodes: ProxyNode[], reserved: Set<string>, warnings: Warning[]): void;
```

- 保留名 + 组名 + 已出现节点名；大小写不敏感比较；后缀 `" 2"`、`" 3"`。
- 空名 → `server:port`；>128 截断；控制字符剔除。
- 原地修改 `node.name`（或返回新数组；实现择一并在测试中固定）。

### 7.2 `rules`

#### 7.2.1 `types.ts`

- 见 §6；另含 `RuleStats`、`RuleSource`、`ValidationContext`。
- `ValidationContext`：`{ sourceId, wrapperGroup?, mode: 'ruleset'|'template'|'inline'|'provider', knownTargets: Set<string>, knownProviders: Set<string>, allowMatch: boolean }`。`provider` 模式不要求 target，供 `/getruleset` 使用；该模式下去掉 target 输出，并拒绝 MATCH/RULE-SET/SUB-RULE。

#### 7.2.2 `registry.ts`

- 37 个类型的单一事实来源：`RULE_REGISTRY: Record<string, { group; payloadKind; emit: boolean; aliases?: string[] }>`。
- 与 mihomo `rules/parser.go` 对齐；升级 mihomo 时只改这一个文件 + 测试。
- 导出 `normalizeType(raw): string | null`、`resolveAlias(type): string | null`。
- 不在此文件实现 payload 校验（见 `payload.ts`）。

#### 7.2.3 `payload.ts`

```ts
export function validatePayload(type: string, payload: string): { ok: true; normalized: string } | { ok: false; code: WarningCode; message: string };
```

- 按 SPEC §5.1 表实现；CIDR 复用 `links/ip.ts`；正则复用 `protocols.compileRuleRegex`。
- 返回归一化 payload（小写域名、去掉 `+.`、压缩 CIDR、`NETWORK` 小写）。
- 纯函数，表驱动测试。

#### 7.2.4 `split.ts`

```ts
export type SplitRule = { type: string; payload: string; target: string; params: string[]; targetPresent: boolean };
export function splitRuleLine(line: string, type: string, opts: { wrapperGroup?: string; knownTargets?: Set<string> }): SplitRule | { ok: false; code: WarningCode; message: string };
```

- 按 SPEC §5.3 的类型组分派；逻辑规则先做括号配对（返回结构或错误）。
- `opts.wrapperGroup` 存在时，target 由 GROUP 提供：普通类型的第 3 字段只允许 `no-resolve`；payload 可含逗号类型的最后一个字段若命中 `knownTargets`/wrapper/内置目标，先剥离并 `W_RULE_SOURCE_TARGET_IGNORED`，再把剩余字段重组成 payload（避免 P5 的 `DOMAIN-REGEX`/`AND` 把 `,GROUP` 留在 payload）。
- 不负责类型白名单；调用方先 `normalizeType`。

#### 7.2.5 `parse.ts`

```ts
export function parseRuleLine(line: string, ctx: ValidationContext): { ok: true; rule: Rule } | { ok: false; warnings: Warning[] };
export function parseRuleLines(lines: string[], ctx: ValidationContext): { rules: Rule[]; warnings: Warning[]; stats: { accepted: number; dropped: number } };
```

- 流程：trim → 注释 → **字段数预检（单字段且非 MATCH/FINAL → `E_RULE_NO_TARGET`；单字段 MATCH/FINAL 且有 wrapper group → 合法）** → 类型 → 别名 → split → target 策略 → payload 校验 → target 存在性 → `Rule`。
- 规则集来源：target 由 wrapperGroup 提供；普通类型第三字段只接受 `no-resolve`；comma-bearing 类型在重组 payload 前，若最后字段命中 wrapper/knownTargets/内置目标则剥离并 `W_RULE_SOURCE_TARGET_IGNORED`，否则保留并 `W_RULE_SOURCE_TARGET_AMBIGUOUS`（评审 P0-5）。
- 模板来源：缺 target → `E_RULE_NO_TARGET`。
- `MATCH` 在 provider 上下文不允许（`allowMatch=false` → `W_RULE_MATCH_IN_SOURCE_IGNORED`）。
- 每条失败返回 Warning 数组（可能多条：类型 + payload + target），但只输出一次聚合。

#### 7.2.6 `dialects.ts`

```ts
export type DialectContent = { dialect: SupportedDialect; value: unknown };
export function detectDialect(content: string, explicit?: SupportedDialect, contentType?: string | null): { dialect: SupportedDialect } | { error: Warning };
export function extractRuleLines(content: string, dialect: SupportedDialect, sourceId: string): { lines: string[]; warnings: Warning[] };
```

- `clash-classic` 是 `clash-classical` 的别名（`W_DIALECT_ALIAS`）；`quanx:` 显式 `W_DIALECT_UNSUPPORTED` 并跳过 source（评审 P0-4）。
- 负责 YAML 解析（调用 `links/yaml`）、BOM/CRLF、`payload:`/`rules:` 提取、`clash-domain`/`clash-ipcidr` 裸条目映射、`domain` 前缀映射、base64 递归、Surge 行切分。
- 不负责类型/ payload 校验；只产出“待校验的行”。
- 对 `clash-classical` 数组元素非字符串 → Warning + 丢弃。
- 对 `domain` 的 `# TOTAL` 计数检查调用 `truncation.ts`。

#### 7.2.7 `truncation.ts`

```ts
export function checkTail(input: { rawText: string; lines: string[]; hadFinalNewline: boolean; dialect: SupportedDialect; sourceId: string }): Warning[];
export function checkTemplateTail(rawText: string, sourceId: string): Warning[];
export function checkDeclaredCount(originalText: string, actual: number, sourceId: string): Warning[];
```

- 实现 SPEC §6.2；必须同时拿到原始文本、行数组与最终换行标志；只给 `lines[]` 无法判断截断（评审 P0-3）。
- `checkTemplateTail` 在 YAML 解析前对原始模板文本运行，产生 `E_TRUNCATED_TAIL`（stage=`template`）；`truncation.ts` 不修改 `lines`。
- 只产生 Warning；是否丢弃最后一行由 `parse.ts`/`validate.ts` 根据 `E_TRUNCATED_TAIL` 决定。

#### 7.2.8 `validate.ts`

```ts
export interface RuleBuildInput {
  sources: RuleSource[];
  templateRules?: string[];
  overwriteOriginalRules: boolean;
  mode: 'inline' | 'providers';
  knownTargets: Set<string>;
  knownProviders: Set<string>;
  defaultGroup: string;
  maxRules: number;
  sourceId: string;
}
export interface RuleBuildResult {
  rules: Rule[];
  warnings: Warning[];
  providers: RuleProviderSpec[];
  stats: { input: number; accepted: number; dropped: number; byCode: Record<string, number> };
  extraGroups: string[];   // 由规则 target 自动创建、待 integration 展开的组名
}
export function buildRules(input: RuleBuildInput): RuleBuildResult;
```

- 汇总 `parseRuleLines`；执行 `MAX_RULES` 截断；执行 MATCH 策略；保证最终一条 MATCH；生成 provider 规格（若 mode=providers）。
- **不做**节点/组展开；`extraGroups` 交给 integration/rules.groups 处理后再调用一次 target 检查（或由 integration 先把已知组集合补全）。
- 目标存在性需要组展开后的名称；integration 必须按 §9 的编排顺序调用。

#### 7.2.9 `providers.ts`

```ts
export function decideBehavior(rules: Rule[]): 'domain' | 'ipcidr' | 'classical';
export function canBeProvider(rules: Rule[], source: RuleSource, providerUrlLength: number): { ok: boolean; reason?: string };
export function providerName(sourceRaw: string, dialect: SupportedDialect): string;
export function buildProviderSpec(...): RuleProviderSpec;
```

- provider 名 = `rs_<fnv1a32(dialect + '\0' + sourceRaw)>_<slug>`；冲突时 12 hex。
- `canBeProvider`：无 MATCH/RULE-SET/SUB-RULE；URL 长度 ≤12,000；否则回退内联。
- 只生成规格；实际 provider URL 由 integration 在知道 `origin` 后补全（`url` 字段）。

#### 7.2.10 `groups.ts`

```ts
export function parseCustomGroupLine(line: string, ctx: { maxGroups: number; warnings: Warning[] }): GroupSpec | null;
export function parseGroupsParam(text: string, warnings: Warning[]): GroupSpec[];
export function expandGroups(specs: GroupSpec[], nodes: ProxyNode[], warnings: Warning[]): ResolvedGroup[];
export function defaultGroups(nodes: ProxyNode[]): ResolvedGroup[];
```

- `custom_proxy_group` 与 `groups=` 共用一个解析器。
- ELEM 解析、matcher 编译（`compileUserRegex`）、展开顺序、空组补 DIRECT、去重、自引用检查。
- `defaultGroups`：`PROXY` select + `AUTO` url-test。
- 组名去重/保留名在此处理（调用 `name-allocator` 的组版本或本地实现）。

#### 7.2.11 `ini.ts`

```ts
export interface AcL4ssrConfig {
  groups: string[];
  rulesets: string[];
  rename: string[];
  include: string[];
  exclude: string[];
  template?: string;
  overwriteOriginalRules?: boolean;
  enableRuleGenerator: boolean;
}
export function parseAcL4ssrIni(text: string): { ok: true; config: AcL4ssrConfig; warnings: Warning[] } | { ok: false; code: 'invalid_config'; message: string };
```

- 实现 SPEC §8；只解析 `[custom]`；重复键累积；未知键告警。
- 不执行 inja；`{%` 行按普通值处理。
- `ruleset` 行保留原文，由 `dialects/parse` 继续解析。

#### 7.2.12 `index.ts`

- 公共 API：`buildRules`、`parseGroupsParam`、`parseAcL4ssrIni`、`expandGroups`、`defaultGroups`、`decideBehavior`。
- 不导出内部可变状态；无模块级缓存（保证确定性/并发安全）。

### 7.3 `emitter`

#### 7.3.1 `nodes.ts`

```ts
export function toMihomoProxy(node: ProxyNode, options: { udp?: boolean; tfo?: boolean; scv?: boolean }): Record<string, unknown>;
```

- 按协议映射字段；只输出白名单；`port` 强制整数；未定义字段不输出。
- 字符串不做手工转义，交给 YAML emitter。
- 抛内部错误仅用于“不可达的非法 IR”；正常路径节点已由 links 校验。

#### 7.3.2 `groups.ts`

```ts
export function toMihomoGroup(group: ResolvedGroup): Record<string, unknown>;
```

- 输出 `name/type/proxies`，按类型补 `url/interval/tolerance/strategy`。
- 成员必须非空；`proxies` 中不得含自身（防御性断言）。

#### 7.3.3 `rules.ts`

```ts
export function toRuleScalars(rules: Rule[]): Scalar[];
```

- 每条 `Rule` 组装为 `TYPE,PAYLOAD,TARGET[,no-resolve]`；用 `yaml` 的 `Scalar` 并设置 `QUOTE_DOUBLE`（已实测：`Doc.toString()` 输出 `- "DOMAIN,a.com,PROXY"`）。
- 断言最后一条是 `MATCH`；否则抛 `E_EMIT_INVALID`。

#### 7.3.4 `providers.ts`

```ts
export function toRuleProviders(providers: RuleProviderSpec[], providerOrigin: string): Record<string, unknown> | undefined;
```

- 生成 `type/behavior/format/url/path/interval`；`url` 用 `providerOrigin + '/getruleset?...'`；`path` 只允许安全字符。
- `providerOrigin` 由 integration 选择：`PUBLIC_ORIGIN` 非空则用它，否则用 request origin 并产生 `W_PROVIDER_ORIGIN_UNPINNED`；后者禁止 public cache（SPEC §9.5）。
- 空数组 → 不输出该键。

#### 7.3.5 `template.ts`

```ts
export interface TemplateResult { template: Record<string, unknown>; templateRules: string[]; warnings: Warning[] }
export function sanitizeTemplate(value: unknown): TemplateResult;
```

- 顶层必须是普通对象；按 SPEC §7.1 允许/拒绝键清洗；核心键抽取 `rules` 后移除；未知键丢弃 + Warning。
- `clash_rule_base` 的裸路径由 integration 先做内置名映射：`base/all_base.tpl|.yml|.conf` → `DEFAULT_TEMPLATE` + `W_BUILTIN_TEMPLATE_MAPPED`；其它裸路径由 integration 返回 `invalid_template`，不进入 `sanitizeTemplate`（评审 P0-7）。
- 模板 tail 检查由 `rules/truncation.checkTemplateTail` 在 YAML 解析前完成（评审 P0-3）。
- 不递归清洗 `dns/tun/hosts`（只要求是普通对象/数组/标量，拒绝函数/自定义 tag）。
- 模板大小在 integration 解析前已限制。

#### 7.3.6 `serialize.ts`

```ts
export function stringifyConfig(doc: Record<string, unknown>): string;
export function parseForReadback(yaml: string): { ok: true; value: unknown } | { ok: false; message: string };
```

- `yaml.stringify(doc, { indent: 2, lineWidth: 0, sortMapEntries: false })`；规则用 `Scalar`。
- 读回用 `links/yaml` 同一选项；断言单文档。
- 文件末尾恰好一个 `\n`。

#### 7.3.7 `config.ts`

```ts
export interface AssembleInput extends EmitInput {}
export function assembleConfig(input: AssembleInput): { yaml: string; warnings: Warning[]; stats: EmitResult['stats'] };
```

- 合并顺序：模板允许键 → `proxies` → `proxy-groups` → `rule-providers` → `rules`。
- 读回校验（评审 P0-2）：`proxies`/`proxy-groups`/`rules` 类型；**对每条 rules 字符串重新调用 `rules.parseRuleLine`（mode='template'，knownTargets/knownProviders 全量，strict=true）**；任何 `E_*` → `E_EMIT_INVALID`。`DOMAIN,,PROXY`、缺 target、坏 CIDR、括号不平衡的 `AND` 都在此被拒绝。
- 额外独立不变量：恰好一条末尾 MATCH；无空 target/payload；无 `DOMA`/`NaN`/null 端口；端口/CIDR/逻辑括号合法；最终换行。
- `tests/unit/emitter/invariants.test.ts` + `tests/unit/rules/fuzz.test.ts` 做 seeded 属性测试；发布门禁另跑真实 mihomo `-t`（AC-24）。
- 读回失败 → 抛 `E_EMIT_INVALID`（integration 返回 500）。
- 统计 `bytesOut`。

#### 7.3.8 `default-template.ts`

- 导出 `DEFAULT_TEMPLATE: Record<string, unknown>`（SPEC §12.2）。
- 不使用外部 YAML 文件，避免 wrangler 额外 `rules` 配置与启动时解析。

#### 7.3.9 `index.ts`

```ts
export function emitClash(input: EmitInput): EmitResult;
```

- 组合 `template → nodes/groups/rules/providers → config`；不进行网络/参数解析。

### 7.4 `integration`

#### 7.4.1 `index.ts`

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>
};
```

- 模块顶层只创建常量；不做 YAML 解析/大对象初始化。
- `fetch` 内：`const started = Date.now()` → `route(request, env, ctx)` → 兜底 `internal_error`。
- 不把异常堆栈返回给客户端；日志只记录 code/stage。

#### 7.4.2 `router.ts`

- 路由表：`/`、`/version`、`/sub`、`/clash`、`/getruleset`。
- 方法检查、OPTIONS、404/405、`Allow` 头。
- 返回 `Route` 对象，不直接写响应；handler 在 `handlers/*`。

#### 7.4.3 `params.ts`

```ts
export interface SubParams {
  urls: SourceSpec[];
  target: 'clash';
  config?: SourceSpec;
  rulesets: RuleSourceSpec[];
  groupsB64?: string;
  template?: SourceSpec;
  rulesMode: 'inline' | 'providers';
  diagnostics: 'none' | 'json';
  include: string[];
  exclude: string[];
  rename: Array<{ pattern: string; replacement: string }>;
  sort: boolean;
  udp: boolean;
  tfo: boolean;
  scv: boolean;
  group?: string;
  interval: number;
  appendInfo: boolean;
  filename?: string;
}
export function parseSubParams(url: URL): { ok: true; params: SubParams; warnings: Warning[] } | { ok: false; error: AppError };
```

- 严格解析布尔/整数/重复参数/上限；未知参数 Warning；已知不支持参数 Warning。
- `url` 的 `|` 拆分与 `tag:` 解析；`ruleset` 的 `GROUP,SOURCE` 解析（source 交给 integration/sources 解析）。
- `config` 存在时忽略 `groups`/`ruleset`（Warning）。
- 不解析 inline/base64 内容；只产生 `SourceSpec`。

#### 7.4.4 `sources.ts`

```ts
export type SourceSpec = { raw: string; label: string; sourceGroup?: string };
export function resolveSource(spec: SourceSpec, policy: EnvPolicy): SourceRef | { error: AppError };
export async function loadSources(specs: SourceSpec[], policy: EnvPolicy, deps: PipelineDeps): Promise<{ texts: Array<{ ref: SourceRef; text: string; bytes: number; userInfo?: string }>; warnings: Warning[] }>;
```

- 解析 `inline:`/`data:`/http(s)；inline 严格 base64 + UTF-8 + 大小；http 调用 `links/fetch`。
- 多 source 并发上限 4（Workers 同时在途连接限制 6）；总 deadline 共享；每个失败产生 Warning，不抛出（除非全部失败）。
- 返回文本 + 来源标签；后续 links 解析。

#### 7.4.5 `pipeline.ts`

```ts
export interface PipelineDeps { fetch: typeof fetch; now: () => number; }
export async function runSub(params: SubParams, env: Env, deps: PipelineDeps, origin: string): Promise<SubResult>;
```

顺序（固定）：

1. 解析 `config`（若有）→ `AcL4ssrConfig`；决定 groups/ruleset/filters/template/overwrite。`clash_rule_base` 的裸路径先做内置名映射（`base/all_base.tpl|.yml|.conf` → 默认模板 + `W_BUILTIN_TEMPLATE_MAPPED`），其它裸路径 → `invalid_template`（评审 P0-7）。
2. 解析 query `groups`/`ruleset`（若 config 未覆盖）。
3. 加载所有节点 source 文本 → `links/parseSubscriptionText` → 节点 + Warnings。
4. `applyFilters` → `applyRenames` → `applySourceGroup`。
5. 解析组 specs（config/query/default）→ `expandGroups`（需要节点名）。
6. `allocateNames` 需要先知道组名：实现顺序为：先解析组名（不展开），分配组名/保留名，再分配节点名，再展开组。
7. 规则：`buildRules`（先传已知组名/节点名；对 `extraGroups` 自动创建组并重新展开/再次校验 target）。
8. 模板：在 YAML 解析前先 `checkTemplateTail(rawText)`（若提供 template），再做 YAML 解析/`sanitizeTemplate`；模板规则逐条校验（默认丢弃）。
9. `emitter/emitClash`；providerOrigin = `PUBLIC_ORIGIN` 或 request origin（后者 + `W_PROVIDER_ORIGIN_UNPINNED`）。
10. 汇总 stats/warnings；若节点为 0 → `no_nodes`。
11. 返回 `{ yaml, warnings, stats, userInfo }`。

- 所有阶段共享 `WarningCollector`（上限 200，真实计数）。
- 任何阶段抛 `AppError` → handler 映射状态码；其它异常 → `internal_error`。

#### 7.4.6 `handlers/sub.ts`

- 解析 params → `runSub` → 设置头/Content-Type/Cache-Control/`Subscription-UserInfo`/`profile-update-interval`/`Content-Disposition`。
- `diagnostics=json` → JSON 包络。
- 错误 → `http.errorResponse`。

#### 7.4.7 `handlers/ruleset.ts`

- 解析 `type`/`src|url`/`dialect|diagnostics`；加载 source；`rules/dialects` + `rules/validate`；按 SPEC §2.7 的精确 type→payload 表过滤/转换；生成 `payload` YAML；空结果占位。
- type 3 只输出裸域名/`+.domain`（不得出现 `DOMAIN-SUFFIX,`）；type 4 只输出 CIDR；type 6 输出无 target 的 `TYPE,PAYLOAD[,no-resolve]`；其它类型丢弃 + `W_RULESET_TYPE_FILTERED`（评审 P0-8）。
- 复用 `link/fetch` 策略与 `WarningCollector`。
- `url`（b64url）解码后作为 source；`src` 原样。
- 输出头：`X-Subconverter-Placeholder`、`X-Subconverter-Warnings`、缓存。

#### 7.4.8 `handlers/meta.ts`

- `/`：`help.ts` HTML；`/version`：`version.ts` 文本。
- HEAD 支持；缓存头。

#### 7.4.9 `http.ts`

- `yamlResponse`, `jsonResponse`, `textResponse`, `errorResponse`, `noContent`.
- 统一 CORS/安全头/Cache-Control；不在这里做业务判断。
- `AppError` → status map（SPEC §2.9）；未知异常 → 500 + `internal_error`。

#### 7.4.10 `diagnostics.ts`

```ts
export class WarningCollector {
  add(w: Warning): void;
  addAll(ws: Warning[]): void;
  get count(): number;
  codes(): string[];
  toJSON(): Warning[];
}
export function warningHeaders(collector: WarningCollector): Headers;
```

- 去重键 `(code, source, line, raw)`；上限 200；超出追加 `W_WARNING_LIMIT`；`count` 保持真实。
- `codes()` 排序 unique；header 最多 20 个。
- 不把 warning 原文放进 header。

#### 7.4.11 `cache.ts`

```ts
export function cacheControlFor(endpoint: 'sub'|'ruleset'|'meta'|'error', env: Env, opts: { rulesMode: 'inline'|'providers'; publicOrigin: string }): string;
```

- 实现 SPEC §9.5；订阅默认 `private, no-store`；`PUBLIC_SUBSCRIPTION_CACHE` 才公开缓存。
- providers 模式且 `PUBLIC_ORIGIN` 为空 → 强制 `private, no-store`（即使 `PUBLIC_SUBSCRIPTION_CACHE=true`），并产生 `W_PROVIDER_ORIGIN_UNPINNED`；`PUBLIC_ORIGIN` 非空才允许 public cache（provider URL 已 canonical）。
- 不实现上游响应缓存；不使用 Cache API 共享 key。

#### 7.4.12 `help.ts` / `version.ts`

- `help.ts`：自包含 HTML（无外部 CSS/JS/字体），含端点、参数、示例、Warning 说明；所有动态值转义；CSP `default-src 'none'; style-src 'unsafe-inline'`。
- `version.ts`：`VERSION` 常量 + `versionText()`；`package.json` 版本在 CI 中用测试断言一致（避免漂移）。

#### 7.4.13 `errors.ts`

```ts
export type ErrorCode = ...; // SPEC §2.9
export class AppError extends Error { code: ErrorCode; status: number; }
export function toAppError(e: unknown): AppError;
```

- 只允许已知 code；未知 → `internal_error`。
- 不把底层 `fetch` 错误文本透给客户端。

#### 7.4.14 `env.ts`

- `Env` 类型 + `parseEnv(env): EnvPolicy`；所有数值/布尔校验；启动只解析一次（模块级 `let cached`），但 `fetch` 捕获错误。
- `EnvPolicy` 包含：limits、timeouts、ports、cache flags、UA/version。

---

## 8. 编排顺序（关键：名称/目标解析）

组名与节点名共享 mihomo 的引用命名空间，规则 target 又依赖组名。固定顺序：

```
1. 解析 config/groups → GroupSpec[]（只解析名称与 matcher，不展开）
2. 为组名分配唯一名称（去重、保留名检查）→ groupNames
3. 解析节点 → 过滤/重命名
4. allocateNames(nodes, reserved = groupNames ∪ BUILTINS)
5. expandGroups(specs, nodes) → ResolvedGroup[]
6. buildRules(knownTargets = groupNames ∪ nodeNames ∪ BUILTINS)
7. 对 extraGroups（规则引用的未定义组）：创建 select 组（全部节点 + DIRECT），
   若未超 MAX_GROUPS，则回到 5/6 重新展开/校验；否则丢弃相关规则
8. 确保最终 MATCH / defaultGroup
9. emit + readback
```

- 组名先于节点名分配，避免节点占用组名后组被改名导致规则 target 失效。
- `extraGroups` 去重、排序稳定；一次最多创建 `MAX_GROUPS - groupCount` 个。
- 任何名称变更都要同步更新规则 target 的引用（规则 target 用最终组名）。

---

## 9. 错误与 Warning 传播

```
parser/validator ──Warning──▶ WarningCollector ──▶ headers + diagnostics JSON
       │
       └──fatal──▶ AppError ──▶ http.errorResponse (status/code)
```

- 非致命：单条节点/规则/配置键/source 失败 → Warning；请求继续。
- 致命：请求参数非法、全部 source 失败、零节点、输出读回失败、内部异常。
- `E_*` 在 Warning 中表示“该条目失败”，不自动升级为 HTTP 错误；只有 §2.9 的顶层条件才升级。
- Warning 必须可操作：带 `code`、`stage`、`line`、`source`；`raw` 只保留诊断所需的最短文本。
- 不允许 `console.log` 用户内容；日志记录 `code/stage/hostHash/line/counts`。

---

## 10. 测试架构

### 10.1 单元（Node + Vitest）

- 环境：Node 24，`vitest.config.ts`，`environment: 'node'`，只跑 `tests/unit/**`。
- 覆盖：
  - `links`：base64 严格性、IP/CIDR、URL guard 表驱动、fetch 假实现（重定向/超时/大小/HTML）、五协议 URI、Clash YAML 输入、名称分配。
  - `rules`：37 类型 × 合法/非法 payload、拆分规则、别名、逻辑递归、截断、provider 判定、组 DSL、INI。
  - `emitter`：字段映射、组字段、规则引号、模板清洗、golden YAML、读回。
- 不访问网络；`fetcher` 通过 `deps.fetch` 注入。
- `tests/unit/rules/doma-regression.test.ts` 必须包含 20,675 条规则 + 第 20,675 条 `DOMA` 的用例（AC-06）。

### 10.2 集成（workerd + `@cloudflare/vitest-plugin`）

- `vitest.integration.config.ts`：

```ts
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: { include: ['tests/integration/**/*.test.ts'] },
});
```

- 使用 `SELF.fetch('https://example.com/...')` 走真实 Worker 路由；所有成功路径用 `inline:` source，**不需要网络**。
- 覆盖：路由/方法/CORS、参数错误、诊断 JSON、SSRF 拒绝（在 fetch 前返回）、`/getruleset`、头/缓存、providers 两 host 缓存（覆盖评审 P0-6）。
- 出站 fetch 的细粒度行为单元测试覆盖；集成测试不依赖真实机场。
- 注意：`@cloudflare/vitest-plugin@1.6.0` 依赖 beta miniflare；本架构阶段未实际跑通（见 PARITY §12），实现阶段第一步验证。

### 10.3 E2E 验收脚本

- `scripts/e2e-acceptance.ts`，Node 24 直接运行（type stripping），只依赖内置模块：
  1. 启动本地 fixture HTTP server（`127.0.0.1:8790`），提供 `tests/fixtures/rules/doma-20675.txt` 等大文件；再启动 `npx wrangler dev --config wrangler.test.jsonc --local --port <port> --ip 127.0.0.1`（`child_process.spawn`）。`wrangler.test.jsonc` 复用生产配置但**去掉 `global_fetch_strictly_public`**（否则本地 fixture 可能被平台层阻断），并设置 `ENVIRONMENT=test`、`ALLOW_HTTP_UPSTREAM=true`、`UPSTREAM_ALLOWED_PORTS=80,443,8790`、`ALLOW_TEST_UPSTREAM_HOSTS=127.0.0.1:8790`。
  2. 轮询 `/version` 直到 ready（超时 60s）。
  3. 用 `fetch` 发请求，断言 §11 AC-06/07/08/09/13/14/15/16/19/21/22/29/31/32/33 等。大规则源走 fixture server，不塞 inline。
  4. 终止子进程与 fixture server；失败时打印响应体摘要（不含 token）。
  5. `--require-mihomo`（即 `npm run test:mihomo`）：要求 `MIHOMO_BIN` 存在，把 `/sub` 输出写到临时目录，执行 `<bin> -t -f <file>`，断言退出 0；未设置时**非零退出**，不得打印 SKIP 当作通过。
  6. 不带 `--require-mihomo` 的 `npm run test:e2e` 允许打印 `SKIP mihomo validation`，但该结果不计入发布门禁。
- 脚本不登录、不使用真实订阅；inline source + 本地 fixture server 覆盖全部功能。

### 10.4 归属检查

- `npm run check:ownership` 运行 `scripts/check-ownership.ts`；CI 必须通过。
- 根 `package.json` scripts：

```json
{
  "typecheck": "tsc --noEmit",
  "test:unit": "vitest run --config vitest.config.ts",
  "test:integration": "vitest run --config vitest.integration.config.ts",
  "test": "npm run check:ownership && npm run test:unit && npm run test:integration",
  "test:e2e": "node scripts/e2e-acceptance.ts",
  "test:mihomo": "node scripts/e2e-acceptance.ts --require-mihomo",
  "check:ownership": "node scripts/check-ownership.ts",
  "deploy:dry": "wrangler deploy --dry-run --outdir dist"
}
```

---

## 11. 性能预算

| 阶段 | 预算 | 说明 |
|---|---|---|
| 启动 | < 50 ms CPU | 模块顶层只建常量；不解析 YAML/规则 |
| 参数/路由 | < 1 ms | |
| YAML 解析 | O(n)，上限 8 MiB | `yaml` 2.9.x，`maxAliasCount:50`，`merge:false` |
| 节点解析 | 10k 节点 < 200 ms | 逐行/逐对象 |
| 规则校验 | 50k 规则 < 2.5 s | 表驱动；正则只编译不执行（规则） |
| 组展开 | 128 组 × 10k 节点 < 500 ms | 最坏 1.28M 次匹配；对 matcher 结果缓存 |
| 发射 | 50k 规则 < 500 ms | 字符串构建 + YAML |
| 总计 | `limits.cpu_ms: 5000` | 留 20% 余量；E2E 打印实际耗时 |

- 组 matcher 对每个节点只计算一次，缓存 `(matcherId, nodeName) -> boolean`；避免 O(groups×nodes×rules) 爆炸。
- 正则安全：用户正则必须通过 `compileUserRegex`（长度/嵌套量词/反向引用检查）；规则正则只编译不执行。
- 大输入优先在字节层拒绝；不在内存里保留多份全文（decode 后释放 bytes）。

---

## 12. 扩展点

### 12.1 新增协议

1. `links/contracts.ts`：新增 IR 接口并加入 `ProxyNode` union。
2. `links/protocols.ts`：新增 cipher/transport 校验表。
3. `links/uri/<kind>.ts`：实现 URI 解析；在 `uri/index.ts` 注册 scheme。
4. `links/clash-input.ts`：增加 Clash YAML 字段映射。
5. `emitter/nodes.ts`：增加 mihomo 字段映射。
6. 测试：`tests/unit/links/uri.test.ts`、`clash-input.test.ts`、`tests/unit/emitter/nodes.test.ts`。

### 12.2 新增规则类型

1. `rules/registry.ts`：注册类型、分组、payloadKind、`emit`。
2. `rules/payload.ts`：实现校验/归一化。
3. `rules/split.ts`：若 payload 可含逗号，加入特殊组。
4. `emitter/rules.ts`：无需改动（统一组装）。
5. 测试：`registry.test.ts` / `payload.test.ts` / `doma-regression.test.ts`。

### 12.3 新增 target

v1 不计划。若未来支持 sing-box/Surge：新增 `emitter/<target>.ts` 与 `integration/handlers` 分支；`target` 白名单扩展；必须独立维护“target 能力矩阵”，不得把 mihomo 专属字段写进其它格式。

---

## 13. 架构决策记录（ADR）

| ADR | 决策 | 理由 | 代价 |
|---|---|---|---|
| ADR-01 | v1 只输出 `target=clash` | 用户优先级是 Clash/mihomo；避免“clash/clash-meta 同物”的伪兼容（参考实现的问题，`docs/research/reference-audit.md:118-120`） | 其它 tindy target 用户不能直接迁移 |
| ADR-02 | 规则 fail-closed，未知/缺 target 一律丢弃 + Warning | 彻底消除 `DOMA`/`MATCHBOX`/`FINAL` 类非法规则 | 老配置里依赖 `[]` 透传的规则会消失，但有 Warning |
| ADR-03 | 不复制 tindy C++/base；清洁室实现 | GPL-3.0 合规；行为规格已足够 | 需自行维护注册表/模板 |
| ADR-04 | 唯一生产依赖 `yaml@2.9.x` | 避免 js-yaml DoS；Workers 无 Node YAML 内置 | bundle 增加约 100 KiB |
| ADR-05 | 无 KV/鉴权/短链 | 部署简单、无最终一致性坑；v1 专注转换 | 公开部署需外部 WAF/Access |
| ADR-06 | `redirect:'manual'` + 逐跳 SSRF + `global_fetch_strictly_public` | 平台默认跟随会转发头/可能跳到私网 | 多一跳代码；平台 flag 行为需监控 |
| ADR-07 | 警告不失败，致命才 4xx/5xx | 单个坏节点/规则不应毁掉整份订阅 | 客户端可能忽略 Warning；需头/诊断可见 |
| ADR-08 | provider 模式指向本 Worker 的 `/getruleset`，不指向上游原文 | 保证 mihomo 拉到的内容也经过校验 | 依赖 Worker 公网可达；URL 长度限制 |
| ADR-09 | 模板核心键一律由生成器覆盖；默认丢弃模板规则 | 修复 tindy P1 base 透传 | 模板作者不能自定义 proxies/rules |
| ADR-10 | `overwrite_original_rules` 默认 true | 降低 DOMA 风险；与 tindy 示例相反 | ACL4SSR 若要保留 base 规则需显式 false |
| ADR-11 | 默认 HTTPS-only + 端口 80/443 | 订阅 token 不应明文传输；降低 SSRF 面 | 自定义端口/HTTP 源需显式配置 |
| ADR-12 | 规则输出强制双引号标量 | 防止 `#`/`:`/YAML 特殊字符破坏规则 | 输出与 tindy 的裸文本不同，diff 会变 |

---

## 14. 风险与未决项（实现前必读）

1. **生产 SSRF 未实测**：`global_fetch_strictly_public` + 平台 egress 的逐跳重定向行为未在真实 Cloudflare 验证；本地 workerd 与生产可能不同（`docs/research/cloudflare-workers.md:591-601`）。
2. **无 DNS 解析**：`localtest.me` 这类域名在应用层无法识别；已用拒绝表 + 平台 flag 缓解，但 DNS rebinding 的残余风险存在。
3. **`@cloudflare/vitest-plugin@1.6.0` 未跑通**：依赖 beta miniflare；实现阶段先做最小测试，失败则回退 `@cloudflare/vitest-pool-workers` 或把纯核心测试留在 Node。
4. **TypeScript 7**：本架构阶段用 TS 7.0.2 + workers-types 5.20261109.1 对最小样例 `tsc --noEmit` 通过；全项目可能有类型兼容问题。
5. **mihomo 版本漂移**：注册表钉在 Alpha@478af2a；升级内核需重新生成注册表并跑 AC-11。
6. **正则语义差异**：JS RegExp 与 mihomo regexp2 不等价；`DOMAIN-REGEX` 可能在本服务通过但客户端失败。缓解：保守校验 + `W_REGEX_ENGINE_DIFF` + **发布必过**的 `mihomo -t` 门禁（AC-24）。
7. **ACL4SSR 子集**：inja、`!!PROVIDER`、`script:`、emoji 等不支持；使用这些特性的配置会降级（PARITY 矩阵）。
8. **无鉴权/限速**：公开部署可能被滥用；上线前配置 WAF/Cloudflare Access。
9. **缓存隐私**：`PUBLIC_SUBSCRIPTION_CACHE=true` 会把含 token 的订阅放进 CDN 缓存；默认关闭。providers 模式还必须配置 `PUBLIC_ORIGIN`，否则强制 private（评审 P0-6）。
10. **provider 模式依赖公网可达**：若 Worker 在 Cloudflare Access 后面，mihomo 拉 provider 会失败；部署时需排除 `/getruleset` 或不用 provider 模式。
11. **inline 容量有限**：8,192 解码字节 / 12,000 source 字符；20,675 条规则的文件（评审 3 字段样例 319,678 B；本项目 fixture 2 字段 278,330 B）只能通过远程 fixture/订阅提供，不能塞 inline（评审 P0-1）。生产用户大规则集必须用远程 URL。
12. **评审意见不完整**：输入在 P1 “Config…” 处截断；无法处理不可见条目，已在本文件末尾记录并请求完整文本。

---

## 15. 部署清单

1. `npm ci`
2. `npm run check:ownership`
3. `npm run typecheck`
4. `npm test`
5. `npx wrangler deploy --dry-run --outdir dist`
6. `npm run test:e2e`
7. **发布门禁（必过）**：`MIHOMO_BIN=/path/to/mihomo npm run test:mihomo`；未设置 `MIHOMO_BIN` 时该脚本非零退出。CI 使用 pinned mihomo release + checksum。
8. `npx wrangler deploy`
9. 生产检查：
   - `curl -I https://<worker>/version` → 200，缓存头；
   - `curl 'https://<worker>/sub?url=inline:...'` → 200 YAML；
   - `curl 'https://<worker>/sub?url=http://127.0.0.1/'` → 400 `blocked_upstream`；
   - 用真实 mihomo 客户端加载输出；
   - 观察 CPU/错误率/Warning 计数；配置 WAF 速率限制；
   - 如需 provider 模式，确认 `/getruleset` 可被客户端访问且缓存生效。

---

## 16. 评审处理记录（2026-11-09）

> 输入为方案评审意见（verdict=revise）。可见部分为 8 个 P0 + 第 9 条 P1 的开头“Config…”，之后文本被截断。以下逐条记录处理；不可见部分无法臆测，见 §16.3。所有修订保持 `links`/`rules`/`emitter`/`integration` 四 owner、文件不重叠；新增文件已在 §5 与 `ownership.json` 登记。

### 16.1 P0 处理

| # | 评审问题 | 处理 | 落点/验收 |
|---|---|---|---|
| P0-1 | AC-06 用 `ruleset=GROUP,inline:...` 喂 20,675 行不可执行：inline 上限 8,192 解码字节/4,096 source 字符/16 KiB URL；评审实测 3 字段 `DOMAIN,xN,G` 为 319,678 B → 426,238 base64url 字符（104x/52x/26x） | 拆分：规则语义用单元 `buildRules` 直接测 20,675 行；HTTP 端到端用本地 fixture server `127.0.0.1:8790` 提供 `tests/fixtures/rules/doma-20675.txt`（2 字段 `DOMAIN,xN` 行，278,330 B / 371,107 base64url，仍远超 inline）；新增仅测试的 `ENVIRONMENT=test` + `UPSTREAM_ALLOWED_PORTS=80,443,8790` + `ALLOW_TEST_UPSTREAM_HOSTS=127.0.0.1:8790`（生产忽略/默认空）；inline 上限明确为 8,192 解码字节、12,000 source 字符、远程 4,096；新增 AC-32 边界测试 | SPEC §2.5/§9.2/§9.4/AC-06/AC-32；ARCHITECTURE §2.1/§2.2；本 ask 用 Node 复核：3 字段 `rule_file_bytes 319678`/`base64url_chars 426238`，2 字段 `278330`/`371107`；`8192 -> 10923 chars`、`16384 -> 21846 chars` |
| P0-2 | “绝不输出非法规则”未被验收证明：AC-24 可选、readback 只做“逗号+前缀”快检、无 fuzz/property/differential | readback 改为对每条输出规则重新调用 `rules.parseRuleLine`（mode=template，全量 targets/providers，strict）；新增独立不变量；新增 seeded fuzz/property（`tests/unit/rules/fuzz.test.ts`、`tests/unit/emitter/invariants.test.ts`，≥10,000 组合法/非法样例）；新增 `npm run test:mihomo` 为**发布必过**门禁（未设置 `MIHOMO_BIN` 非零退出）；AC-24b 明确 E2E SKIP 不计 pass；措辞从“绝不”改为“设计上不输出 + 发布门禁独立验证” | SPEC §6.3/AC-24/AC-24b/AC-28/AC-34；ARCHITECTURE §7.3.7/§10.3/§15 |
| P0-3 | AC-07 的 template 半不可实现：`checkTail(lines,...)` 拿不到原始文本/最终换行；模板规则来自已解析 YAML；AC-07 还缺 `url` | `checkTail` 改为 `{rawText, lines, hadFinalNewline, dialect, sourceId}`；新增 `checkTemplateTail(rawText, sourceId)` 在 YAML 解析前检查；AC-07 补 `url=inline:<small node sub>`，ruleset 与 template 两个子用例均给可执行输入 | SPEC §6.2/AC-07；ARCHITECTURE §7.2.7 |
| P0-4 | `clash-classic` vs `clash-classical`：tindy 文档写 `clash-classic`，SPEC 只接受 `clash-classical`，迁移指南会 400 | `clash-classic` 作为别名接受并产生 `W_DIALECT_ALIAS`；规范化后同解析器；`quanx:` 显式 `W_DIALECT_UNSUPPORTED` + `invalid_source`；AC-31 覆盖两种拼写与 `quanx:` | SPEC §4.1/§4.3/§10.2/AC-31；ARCHITECTURE §7.2.6 |
| P0-5 | 规则集来源的 comma-bearing 类型会把 `,GROUP` 留在 payload，重新引入 P5 破坏 | 规则集来源重组 payload 前，若最后一个逗号字段等于 wrapper/已知 target/内置目标，先剥离并 `W_RULE_SOURCE_TARGET_IGNORED`；新增 `W_RULE_SOURCE_TARGET_AMBIGUOUS`（疑似 target 但未知，保留 payload 并警告）；AC-10/AC-13 覆盖 `DOMAIN-REGEX,^a{1,3}$,G` 与 `AND,(...),G` 的 Surge/classical 源 | SPEC §4.3/§5.3/§10.2；ARCHITECTURE §7.2.4/§7.2.5 |
| P0-6 | providers URL 嵌 request origin，Workers Cache key 不含 hostname；两 host 会串 provider URL | 新增 `PUBLIC_ORIGIN`：非空时 provider URL 恒用 canonical origin，缓存安全；为空时 providers 模式强制 `private, no-store` + `W_PROVIDER_ORIGIN_UNPINNED`，即使 `PUBLIC_SUBSCRIPTION_CACHE=true`；`/getruleset` payload 只依赖 query，可 public cache；AC-29 两 host 测试 | SPEC §5.7/§9.5/§10.2/AC-29；ARCHITECTURE §2.1/§2.2/§7.3.4/§7.4.11 |
| P0-7 | `clash_rule_base=base/all_base.tpl` 本地路径在 SPEC 中被当 source，必然 `invalid_source` | 已知内置路径 `base/all_base.tpl|.yml|.conf` 映射内置默认模板 + `W_BUILTIN_TEMPLATE_MAPPED`；其它裸本地路径 `400 invalid_template` 且 message 给出迁移建议（inline/URL/内置名）；AC-30 | SPEC §7.1/§8.2/§10.2/AC-30；ARCHITECTURE §7.3.5 |
| P0-8 | `/getruleset` type 3/4/6 的 payload 转换未定义；domain provider 可能混入 typed 字符串 | 新增精确映射表：type 3 只输出裸域名/`+.domain`；type 4 只输出 CIDR；type 6 输出无 target 的 `TYPE,PAYLOAD[,no-resolve]`；其它丢弃 + `W_RULESET_TYPE_FILTERED`；明确“domain provider 不得含 `DOMAIN-SUFFIX,`”；AC-13 非空内容、AC-14 占位项 | SPEC §2.7/§10.2/AC-13/AC-14；ARCHITECTURE §7.4.7 |
| P1-9 | 评审输入在 “Config…” 处截断，后续内容不可见 | **未处理**：没有完整文本，不能用猜测填充；已知的 `clash_rule_base` 本地路径问题（P0-7）与方言问题（P0-4）已独立修复 | §16.3；请提供完整 P1 文本 |

### 16.2 新增/调整的测试与文件

- 新增 `tests/unit/rules/fuzz.test.ts`（rules）：seeded 规则生成器 + 输出不变量；≥10,000 组合法/非法输入。
- 新增 `tests/unit/emitter/invariants.test.ts`（emitter）：**不 import `rules/parse`**，用测试内独立的最小行解析器检查 emitter 输出（类型/字段数/target/括号/CIDR/端口/末尾 MATCH）；并注入 `DOMAIN,,PROXY`、不平衡 `AND`、坏 CIDR、缺 target 验证 `E_EMIT_INVALID`。独立客户端证据仍以 AC-24 的真实 mihomo `-t` 为准。
- 新增 `tests/integration/provider-cache.test.ts`（integration）：两 host 的 provider URL/缓存头测试。
- 新增 `wrangler.test.jsonc`（integration）：E2E 专用，去掉 `global_fetch_strictly_public`，设置测试 vars；生产 `wrangler.jsonc` 不变。
- `tests/fixtures/rules/doma-20675.txt` 同时供单元与 E2E fixture server 使用。
- `scripts/e2e-acceptance.ts` 增加 `--require-mihomo`；`package.json` 增加 `test:mihomo`。
- 以上文件均已在 `layout`/`modules`/`ownership.json` 中登记；没有跨 owner 文件。

### 16.3 未能处理的部分

- 评审输入在第 9 条 P1 的 “Config…” 处截断；**无法读取完整内容**，因此没有逐条处理，也没有用猜测填充。请提供完整 P1 文本后，再按同一表格补充。
- 本 ask 没有实现代码，因此没有运行 `npm test`、`test:unit`、`test:integration`、`test:e2e`、`test:mihomo`；也没有真实 Cloudflare 部署或生产 SSRF 实测。已运行的检查仅限：读取四份取证；`npm view` 版本；`yaml@2.9.1` 行为（alias limit/merge/Scalar quoting）；临时目录 `wrangler@4.158.0 deploy --dry-run`（生产 `wrangler.jsonc` 与测试 `wrangler.test.jsonc` 两套配置）；最小 `tsc --noEmit`（TS 7.0.2）；以及本记录 P0-1 的 Node 尺寸复核。AC-24 的 mihomo 门禁在当前环境**未运行**（无二进制/无实现），不能报告为通过。
