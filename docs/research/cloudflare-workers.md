# Cloudflare Workers 现状调研（订阅转换服务架构约束）

> 调研日期：2026-11-09
> 调研方式：以 **官方文档原文**（developers.cloudflare.com）为准；关键结论用**本地实测**交叉验证（wrangler 4.158.0 + 本地 workerd）。
> 标注约定：
> - `[文档]` = 官方文档明示，附链接
> - `[实测]` = 本机运行命令/Worker 得到的真实输出，附命令
> - `[建议]` = 我基于上述事实给出的工程判断，非官方承诺
> - `[未验证]` = 没有查到或无法验证的项，**不猜测**

## 0. 版本基线（2026-11-09）

| 组件 | 当前版本 | 来源 |
| --- | --- | --- |
| wrangler | **4.158.0**（npm `latest` 标签） | `npm view wrangler dist-tags` → `{"latest":"4.158.0","legacy":"3.114.17",...}` `[实测]` |
| Node.js 要求 | **>= 22.0.0** | `npm view wrangler@4.158.0 engines` → `{"node":">=22.0.0"}` `[实测]`；本机 v24.21.0 |
| @cloudflare/workers-types | **5.20261109.1** | `npm view @cloudflare/workers-types version` `[实测]` |
| vitest | **5.1.0** | `npm view vitest version` `[实测]` |
| @cloudflare/vitest-plugin | **1.6.0**，peer `vitest ^4.1.0 \|\| ^5.0.0` | `npm view @cloudflare/vitest-plugin version peerDependencies` `[实测]` |
| @cloudflare/vitest-pool-workers（旧） | **0.23.0**（旧包；npm 未标 deprecated，但官方文档已引导迁移到 vitest-plugin） | `npm view @cloudflare/vitest-pool-workers version` `[实测]` + 迁移文档 |
| miniflare（被 vitest-plugin 依赖） | **5.20261104.0-beta**（注意是 beta） | `npm view miniflare dist-tags` 与 vitest-plugin 依赖表 `[实测]` |

官方文档页面更新时间：Limits = Oct 29, 2026；KV Limits = Oct 30, 2026；Workers Cache = Oct 30, 2026；Vitest 迁移指南 = Aug 20, 2026。

---

## 1. 运行时限制

### 1.1 账户/单次调用上限

来源：<https://developers.cloudflare.com/workers/platform/limits/>（原文表格，已用 `index.md` 原文核对）

| 项目 | Workers Free | Workers Paid |
| --- | --- | --- |
| 请求数 | 100,000/天（UTC 零点重置，超限返回 Error 1027） | 无上限（含 10M/月，之后 $0.30/百万） |
| **CPU 时间/HTTP 请求** | **10 ms** | **最大 5 分钟；默认 30 秒** |
| CPU 时间/Cron | 10 ms | 30 秒（间隔 <1h）／15 分钟（间隔 >=1h） |
| **内存** | **128 MB / isolate** | 128 MB / isolate |
| **子请求（subrequest）** | **50/请求** | **10,000/请求**（可配到 10M） |
| 子请求到内部服务（KV/R2/D1 等） | 1,000 | 与配置一致（默认 10,000） |
| **同时在途连接** | **6/请求** | 6/请求 |
| 环境变量 | 64/Worker，每个 5 KB | 128/Worker，每个 5 KB |
| Worker 体积（未压缩） | 64 MiB | 64 MiB |
| Worker 启动时间 | 1 秒 | 1 秒 |
| Worker 数量 | 100 | 500 |

**CPU 时间只算 CPU，不算等网络**：文档原文 "Waiting on network requests (such as `fetch()` calls, KV reads, or database queries) does **not** count toward CPU time."（同上）。这对订阅转换很关键：**拉取上游订阅的耗时几乎不消耗 CPU，解析 + 重排 + 序列化才消耗 CPU**。

同一页给出的经验值："The average Worker uses approximately 2.2 ms per request. Heavier workloads that handle authentication, server-side rendering, or parse large payloads typically use 10-20 ms."

> `[建议]` 订阅转换要解析 YAML/JSON、做节点过滤去重、再序列化 Clash/sing-box 输出，属于 "parse large payloads"，**Free 的 10 ms 必然不够**；生产必须 Workers Paid（最低 $5/月/账户），并用 `limits.cpu_ms` 显式设上限防"账单炸弹"：文档在定价页明确建议 "To prevent accidental runaway bills or denial-of-wallet attacks, configure the maximum amount of CPU time ... by defining limits in your Worker's Wrangler file"（<https://developers.cloudflare.com/workers/platform/pricing/>）。

### 1.2 请求/响应尺寸

| 限制 | 值 |
| --- | --- |
| URL 长度 | 16 KB |
| 请求头总大小 | 128 KB（total） |
| 响应头总大小 | 128 KB（total） |
| **响应体大小** | **No enforced limit（不强制限制）** |
| 入站请求体 | 取决于域名所在的 Cloudflare 套餐：Free/Pro 100 MB、Business 200 MB、Enterprise 最高 5 GB |

响应体不限制，但 CDN 缓存仍有 512 MB（Free/Pro/Business）/ 5 GB（Enterprise）的上限（同页）。文档未给出 header 数量上限，只给了总字节数。

> `[建议]` 订阅输出正常在几百 KB 到几 MB，不会撞响应体上限；真正的天花板是 **128 MB 内存**（见 1.3）。响应头 128 KB 意味着**绝不能把上游响应头原样回传**，尤其是 `Set-Cookie` 和一堆 `X-*`。

### 1.3 内存

128 MB **per isolate**（不是 per request）。文档明确 "This limit is per-isolate, not per-invocation. A single isolate can handle many concurrent requests." 超限报 Error 1102 / `exceededMemory`，并可能出现运行时错误 `Memory limit would be exceeded before EOF`（缓冲超大响应体时）。

> `[建议]` 并发高时同一 isolate 会同时处理多个请求，**每个请求可用的实际堆内存远小于 128 MB**。对订阅转换：不要 `await res.text()` 一个 50 MB 的上游订阅再整体 parse；应设上游体积上限（例如 8–16 MB）并尽早拒绝。

### 1.4 请求超时 / 持续时间

| 触发方式 | 持续时间上限 |
| --- | --- |
| **HTTP 请求** | **无限制（No limit）** |
| Cron Trigger | 15 分钟 |
| Durable Object Alarm | 15 分钟 |
| Queue Consumer | 15 分钟 |

文档原文："There is no hard limit on duration for HTTP-triggered Workers. As long as the client remains connected, the Worker can continue processing, making subrequests, and streaming a response body. When the client disconnects or the response is complete, tasks associated with that request may be canceled." `ctx.waitUntil()` 可在响应后延长最多 **30 秒**。

运行时升级期间，旧进程上的请求最多有 20 分钟收尾窗口。

> ⚠️ 关键结论 `[文档]`：**平台不会替你超时**。上游订阅源卡住 10 分钟，你的 Worker 就会挂 10 分钟（直到客户端断开）。订阅转换**必须自己实现超时**（见第 3 节 `AbortSignal.timeout`）。

### 1.5 流式响应

`[文档]` <https://developers.cloudflare.com/workers/runtime-apis/streams/>：

- 支持 `ReadableStream` / `ReadableStreamDefaultReader` / `ReadableStreamBYOBReader` / `WritableStream` / `WritableStreamDefaultWriter` / `TransformStream`。
- "Workers do not need to prepare an entire response body before returning a `Response`." 可以直接 `new Response(readable)`，数据"will be streamed to the client as it becomes available"。
- 官方推荐用流避免在 128 MB 内缓冲大体量数据；纯透传场景 `return new Response(response.body, response)` 就是最优。
- Streams API "is only available inside of the Request context"（handler 内）。

`[实测]` 用 TransformStream 返回分块响应：

```bash
curl -s -D - http://127.0.0.1:8799/stream
# HTTP/1.1 200 OK
# Transfer-Encoding: chunked
# Content-Type: text/plain; charset=utf-8
# chunk1
# chunk2
```

> `[建议]` 订阅转换的输出是"必须看完整份 YAML 才能收尾"的格式，流式收益有限（只有节点列表可以边转边吐）。**不要为了流式而流式**；真正该做的是限制上游体积 + 限制 CPU。

### 1.6 其他与订阅转换相关的小限制

- `url` 16 KB：订阅链接若把上游 URL 全量放在 query 里（`?url=https://...`），长 URL 会撞 16 KB（`[文档]` 上限值）。`[建议]` 用短链 token 存 KV 映射。
- 子请求 50/请求（Free）：订阅转换通常只拉 1 个上游，看似够用，但**重定向链每一跳都算子请求**（文档："Each subrequest in a redirect chain counts against this limit"）。
- 6 个同时在途连接：若要合并多个上游（多订阅聚合），并发**必须限制在 6 以内**，否则第 7 个会排队（文档："it is queued until one of the existing connections receives its response headers"）。
- Worker 启动 1 秒：**不要在模块顶层解析大规则库或做重初始化**，否则部署校验失败（`Script startup exceeded CPU time limit`，error code 10021）。

---

## 2. 存储 / 缓存

Cloudflare 现在有**三套互相独立**的缓存/存储，不要混为一谈：

1. **Cache API**：Worker 代码里读写"本数据中心"的 cache。
2. **Workers Cache（新）**：Worker 自己的 CDN 级缓存，命中时**不执行 Worker**。
3. **KV**：全球最终一致的键值存储。

### 2.1 Cache API

`[文档]` <https://developers.cloudflare.com/workers/runtime-apis/cache/>

**用法**

```js
const cache = caches.default;              // 单一全局 cache 对象
await cache.put(request, response);        // 以 request 为 key
const hit = await cache.match(request);    // 未命中返回 undefined
await cache.delete(request);               // 只清当前数据中心
const my = await caches.open("custom:cache"); // 也可开命名 cache
```

**范围与限制（原文）**

- "The Cache API is available globally but the contents of the cache do not replicate outside of the originating data center." → **只在单个 PoP 有效，不做全球复制**。
- "Workers deployed to custom domains have access to functional `cache` operations. So do Pages functions ... However, any Cache API operations in the Cloudflare Workers dashboard editor and Playground previews will have no impact. For Workers fronted by **Cloudflare Access**, the Cache API is **not currently available**." → ⚠️ 如果站点前面挂了 Cloudflare Access，Cache API 直接不可用。
- `cache.put` 会抛错的三种情况：请求方法不是 `GET`；响应 `status` 是 `206`；响应含 `Vary: *`。
- `cache.put` 在 `Cache-Control` 指示不缓存、或响应过大时返回 **413**（文档未给出"过大"的具体阈值，`[未验证]` 具体字节数）。
- **含 `Set-Cookie` 的响应永远不会被缓存**（除非删掉该头或设 `Cache-Control: private=Set-Cookie`）。
- `stale-while-revalidate` / `stale-if-error` **不被** `cache.put` / `cache.match` 支持 → 想要 SWR 必须自己实现。
- `cache.match` 未命中时底层是 504，但脚本侧只看到 `undefined`。
- `cache.put` 不与 **tiered caching** 兼容。
- 301/302 在"cache key 不含 query 且 Location 含 query"时会被静默拒绝（防缓存投毒）；`.workers.dev` 不受此限（默认把 query 纳入 key）。

### 2.2 Workers Cache（CDN 级，2026 年新形态）

`[文档]` <https://developers.cloudflare.com/workers/cache/>

⚠️ **这是本次调研最重要的"现状变化"**：Worker 的响应**默认不会被 CDN 缓存**，必须在 Wrangler 配置显式打开：

```jsonc
{ "cache": { "enabled": true } }
```

（`[实测]` 在 wrangler 4.158.0 下写入该字段并 `deploy --dry-run` 通过，无 schema 报错。）

行为要点（原文）：

- "With caching enabled, Cloudflare checks the cache before running your Worker. On a hit, the cached response is returned directly." 命中时 **Worker 不执行、不消耗 CPU**。
- **默认就是分层缓存（tiered by default）**：lower tier 在就近数据中心，upper tier 汇总全网，未命中才跑 Worker，回填两层。
- **请求合并（request collapsing）**：同一 cache key 并发未命中时，"Cloudflare runs your Worker **once**"。
- 只缓存 `GET`/`HEAD`；`GET` 与 `HEAD` 共用一条缓存；WebSocket upgrade、RPC 方法、Cron、Queue、DO、Email 一律绕过。
- 由**响应头 `Cache-Control`（RFC 9111）**决定是否缓存与 TTL；`Vary` 会分变体保存。
- 自动绕过：**响应带 `Set-Cookie`**、**请求带 `Authorization`**。
- **计费**：Workers Cache 无独立费用；文档原文 "Workers Cache has no separate pricing."、"**CPU time is only billed when your Worker runs** — cache hits do not consume CPU time."，但请求本身仍按标准费率计费（<https://developers.cloudflare.com/workers/cache/> 与 <https://developers.cloudflare.com/workers/platform/pricing/>）。
- 可用 `ctx.cache.purge()` / `cache.purge()` 按 tag/path 清理，`ctx.cache.invalidate()` 标记过期。

**Cache key 组成**（<https://developers.cloudflare.com/workers/cache/cache-keys/>，对订阅转换极其关键）：

| 参与 key | 不参与 key |
| --- | --- |
| 目标 entrypoint | HTTP 方法（GET/HEAD 共用） |
| **path + query string**（顺序敏感：`?a=1&b=2` ≠ `?b=2&a=1`；尾斜杠敏感） | **hostname**（"keyed by path and query string, not the full URL"） |
| Worker 版本（默认；可用 `cache.cross_version_cache` 去掉） | 请求体 |
| `ctx.props`（仅 service binding/RPC 调用时） | 普通头：`User-Agent`、`Accept-Language`、`Cookie`、`Authorization` |
| 一组反投毒头（`x-forwarded-host`、`x-host`、`x-original-url`、`forwarded` 等） | |

> ⚠️ `[建议]` 两个坑：
> 1. **hostname 不在 key 里**：同一 Worker 绑多个域名（如 `sub.example.com` 和 `sub.example.net`），同 path 会互相串缓存。多租户/多域名必须把租户标识放进 path 或 `ctx.props`。
> 2. **Cookie / Authorization 不在 key 里，但带 Authorization 会整请求 bypass**。如果将来做"登录后私有订阅"，靠 header 区分用户是不可行的，必须把身份信息放进 path/query。
> 3. 订阅 URL 里的 token 就是凭据：token 在 path/query 中 → 会进 CDN key 与日志，属于"URL 即密钥"的设计，要注意日志与分享泄露。

### 2.3 Workers KV

`[文档]` <https://developers.cloudflare.com/kv/concepts/how-kv-works/>、<https://developers.cloudflare.com/kv/platform/limits/>、<https://developers.cloudflare.com/kv/api/read-key-value-pairs/>、<https://developers.cloudflare.com/kv/api/write-key-value-pairs/>、<https://developers.cloudflare.com/kv/platform/pricing/>

**一致性（决定能不能拿它当缓存）**

- "KV achieves high performance by being eventually-consistent."
- "Changes may take up to 60 seconds or more to be visible in other global network locations as their cached versions of the data time out."
- 写入位置本地通常立即可见，但 "this is not guaranteed and therefore it is not advised to rely on this behaviour."
- **负缓存**：不存在的 key 也会被缓存（"Negative lookups indicating that the key does not exist are also cached."）→ 新建 key 后短时间内可能仍读到"不存在"。
- 不适合 "atomic operations or ... values must be read and written in a single transaction"；官方建议强一致用 Durable Objects。

**限制**

| 项目 | Free | Paid |
| --- | --- | --- |
| 读 | 100,000/天 | 无限（含 10M/月，+$0.50/百万） |
| 写不同 key | 1,000/天 | 无限（含 1M/月，+$5.00/百万） |
| **写同一 key** | **1 次/秒** | **1 次/秒** |
| 每次调用操作数 | 1,000 | 1,000 |
| 命名空间 | 1,000 | 默认 1,000，超出 $0.10/月/个 |
| 存储 | 1 GB/账户、1 GB/命名空间 | 无限（含 1 GB，+$0.50/GB-月） |
| key 大小 | 512 B | 512 B |
| metadata | 1024 B | 1024 B |
| **value 大小** | **25 MiB** | 25 MiB |
| `cacheTtl` 最小值 | **30 秒**（默认 60 秒） | 同 |

其他：单次批量读最多 **100 key**（返回 `Map`，不支持 `arrayBuffer`/`stream`）；批量写只能走 Wrangler/REST（**绑定不支持**），单请求最多 10,000 对、<100 MB；`expirationTtl` 最小 60 秒；并发写 "the last write will take precedence"，同一 key 超 1 次/秒会收到 **429**。

**读的代价**：`get()`/`getWithMetadata()` "may return stale values"；若某 key 刚在别处被读过，写入"may take up to 60 seconds (or the duration of the `cacheTtl`) to display"。

### 2.4 选型：KV vs Cache API vs Workers Cache vs 不缓存

| 需求 | 选择 | 理由（基于上述事实） |
| --- | --- | --- |
| 短链 token → 上游订阅 URL 映射 | **KV** | 读多写少、写每天千级以内、容忍 60 s 生效；这正是 KV 的典型场景（官方："suited to write-once or rarely written data"） |
| 规则模板 / 用户配置（改完要立刻生效） | **KV + 显式"保存后回显本地值"**，或 D1 | KV 60 s 内可能读到旧值；同一 key 1 写/秒，用户狂点保存会 429 |
| 渲染结果（同一订阅 URL 输出稳定） | **Workers Cache（`cache.enabled` + `Cache-Control: public, max-age=...`）** 优先；需要按 PoP 精控时再叠加 Cache API | Workers Cache 命中不跑 Worker、不计 CPU；Cache API 只覆盖单 PoP 且不持久 |
| 需要 stale-while-revalidate | **Workers Cache**（官方示例直接用 `Cache-Control: public, max-age=3600, stale-while-revalidate=300`）；Cache API 需自己实现 | Cache API 文档明确："`stale-while-revalidate` and `stale-if-error` directives are not supported" |
| 每次都要最新、或含用户私有数据 | **不缓存**（`Cache-Control: private, no-store`） | `Set-Cookie`/`Authorization` 会自动 bypass，但别依赖；显式 `private` 更安全 |
| 大对象（>25 MiB） | **R2**（KV 上限 25 MiB） | KV 硬上限 |

> ⚠️ `[建议]` **不要用 Cache API 缓存"用户提交的任意上游 URL"的拉取结果**。Cache API 是 PoP 内**所有租户共享**的，key 只由 request URL 决定；把用户可控 URL 当 key 会造成跨用户的缓存投毒/放大。要么在 key 里加入我们自己签发的 token，要么干脆不缓存上游原始响应。

---

## 3. `fetch()`：超时、重定向、Header、DNS/私有地址

### 3.1 AbortSignal 与超时（已验证）

`[实测]` 在本地 workerd 中（wrangler 4.158.0，`compatibility_date: 2026-11-09`）：

```
GET /caps → {"abortSignalTimeout":"function","abortSignalAny":"function","setTimeout":"function",
             "schedulerWait":"function","transformStream":"function","cryptoRandomUUID":"function",
             "process":"object","Buffer":"function","cachesDefault":"object","ua":"Cloudflare-Workers"}
```

- `AbortSignal.timeout(ms)` **可用**，且真的会触发：`GET /timeout?ms=150` → `aborted after 162ms reason=aborted:TimeoutError`。
- `AbortSignal.any([...])` **可用**（可组合"总超时"+"客户端断开"）。
- `setTimeout` 可用，但文档提醒 "Timers are only available inside of the Request Context."（<https://developers.cloudflare.com/workers/runtime-apis/web-standards/>）
- `scheduler.wait()` 可用（await 版 setTimeout）。

`[实测]` 用 signal 中断真实子请求：

```
GET /abort-fetch → aborted after 667ms: DOMException The operation was aborted due to timeout
```

（对 `https://httpbin.org/delay/5` 发起 fetch，`signal: AbortSignal.timeout(500)`，本机网络 RTT 使其在 ~667 ms 中断。）

**客户端断开信号** `[文档]`：`request.signal` 在 **compatibility_date >= 2026-11-17** 时才会在客户端断开时触发（或显式加 `enable_request_signal` flag）。当前基线 2026-11-09 **早于**该日期，所以默认拿不到 → 若要做"用户取消即停止上游拉取"，需把 compat date 提到 2026-11-17+ 或加 flag，并把 `request.signal` 显式传给 `fetch(..., { signal })`（文档："Pass `request.signal` explicitly to APIs that accept a signal"）。

### 3.2 重定向

`[文档]` <https://developers.cloudflare.com/workers/runtime-apis/request/>：

- 新建 `Request` 默认 `redirect: "follow"`；**incoming request 在 `FetchEvent` 中是 `manual`**。
- **`redirect: "error"` 不支持**，构造时直接抛 `TypeError`。
- `redirect: "follow"` 时 **"all headers will be forwarded to the redirect destination"**，包括 `Cookie` 与 `Authorization`，**跨域也转发**；官方建议改用 `manual` 自己处理。
- 缓解 flag：`strip_authorization_on_cross_origin_redirect` 自 **2025-09-01** 起默认开启，跨源重定向时会去掉 `Authorization`（<https://developers.cloudflare.com/workers/configuration/compatibility-flags/>）。

`[实测]`（wrangler dev）：

```
GET /redirect-error-mode → threw TypeError: Invalid redirect value, must be one of "follow" or "manual"
                            ("error" won't be implemented since it does not make sense at the edge;
                             use "manual" and check the response status code).
GET /ext-manual → {"status":302,"type":"default","loc":"https://example.com/"}
GET /ext-follow → {"status":200,"url":"https://example.com/","type":"default"}
GET /redir-default → status=302 loc=https://example.com/     # Response.redirect(url) 默认 302
```

> `[建议]` 订阅转换拉上游时统一用 **`redirect: "manual"` + 自己循环（最多 3 跳）**：
> - 每跳都重新做 SSRF 校验（否则 `https://evil.com` 302 到 `http://169.254.169.254/` 就绕过了你的白名单）；
> - 不把用户可控的 Cookie/Authorization 带过去；
> - 顺便控制子请求数量。

### 3.3 Header 限制与 User-Agent

- 请求头 / 响应头各 **128 KB total**（`[文档]`，limits 页）。
- Workers 对出站头限制很少："Workers impose very few restrictions on outgoing headers"，`Cookie` 与浏览器不同、按普通头处理（Request 文档）。
- 不能把 `Host` 设成自己 zone 之外的 host（"unless the request is actually being sent to that host"）。
- `Content-Length` 由运行时根据 body 源自动设置，手写值被忽略；需要精确长度用 `FixedLengthStream` 或字符串/TypedArray。
- `cf.vary` 对 header 名有单独限制（小写、<=128 字符、禁止 `cf-`/`cf_` 前缀、排除 `connection`/`host`/`range`/`x-forwarded-for`）——这是缓存变体配置的限制，不是普通 header 限制。

`[实测]` **User-Agent 可以自定义并且真的透传**：

```
GET /ua → status=200
          ...
          uag=cfw-probe/1.0        # 我在 fetch 里设置的 "User-Agent": "cfw-probe/1.0" 被边缘原样看到
          colo=SJC
```

（对照 `/caps`：不设置时运行时 UA 是 `Cloudflare-Workers`。）

> `[建议]` 出站请求**显式设置** `User-Agent`（例如 `subconv/1.0 (+https://your.domain)`）与 `Accept`；上游机场/订阅站常按 UA 返回不同格式（Clash YAML vs base64 vs sing-box）。同时**白名单式构造**出站头，绝不转发用户传入的头。

### 3.4 DNS 与私有地址（SSRF 的平台侧现状）

`[文档]` <https://developers.cloudflare.com/workers/reference/security-model/>：

- Worker 沙箱 "cannot connect directly to the network"；出站请求 "over a UNIX domain socket to a local proxy service"。
- 该代理 "verifies that the request is either addressed to a **public Internet service** or to the **Worker's zone's own origin server**."，从而避开 "internal services that might be visible on the local machine or network"。

→ **平台层已经阻断"直连内网 IP / 本机"**，这是很重要的第一道防线。但它**不覆盖**：

1. **本 zone 的 origin**：代理允许访问"自己 zone 的 origin server"。`[文档]`（compat flags）：未开启 `global_fetch_strictly_public` 时，对自家 zone 的请求 "are routed to the zone's origin server, ignoring any Workers mapped to the URL and also bypassing Cloudflare security settings."。若你的服务与内部系统同 zone，这就是一条可被利用的路径。
2. **重定向**：首跳公开、次跳内网，平台是否逐跳校验文档未明示 → `[未验证]`；按"必须自己逐跳校验"设计。
3. **DNS 解析**：Worker 内**拿不到解析结果**。`[实测]`：

```
GET /dns → {"hasDns":true,
            "lookupError":"DnsError: queryA ENOTFOUND example.com",
            "hasNet":true,"isIP_v4":4,"isIP_v6":6,"isIP_host":0}
```

即 `node:dns` 模块存在，但 `dns.promises.lookup("example.com")` 在 Worker 里**失败**（本地 workerd 实测；生产环境同样没有可用的 DNS API 是行业共识，但**生产未实测**，见第 7 节）。`node:net` 的 `isIP()` 可用（IPv4→4，IPv6→6，域名→0）。

> 结论 `[建议]`：**Worker 内无法做"先解析再判断 IP"的防护**，只能做 (a) 协议/主机名/IP 字面量层面的校验 + (b) 依赖平台代理对解析后地址的拦截 + (c) 手动重定向逐跳校验。

### 3.5 WHATWG URL 归一化（实测，直接影响 SSRF 过滤器写法）

`[实测]` `GET /urlnorm?u=...`（`new URL(input)` 后取 `hostname`）：

| 输入 | `hostname` 结果 |
| --- | --- |
| `http://2130706433/` | `127.0.0.1` |
| `http://0x7f000001/` | `127.0.0.1` |
| `http://0177.0.0.1/` | `127.0.0.1` |
| `http://127.1/` | `127.0.0.1` |
| `http://0/` | `0.0.0.0` |
| `http://169.254.169.254/latest/meta-data/` | `169.254.169.254` |
| `http://[::ffff:127.0.0.1]/` | **`[::ffff:7f00:1]`**（转成十六进制、带方括号） |
| `http://[::1]/` | `[::1]` |
| `http://[fd00:ec2::254]/latest/meta-data/` | `[fd00:ec2::254]` |
| `http://metadata.google.internal/computeMetadata/v1/` | `metadata.google.internal` |
| `http://localhost:8080/` | `localhost`（`port` = `8080`） |
| `http://user:pass@example.com@127.0.0.1/` | `127.0.0.1`（最后一个 `@` 之后才是 host） |
| `http://127.0.0.1%2f@example.com/` | `example.com`（`%2f` 在 userinfo 里） |

**两条硬结论**：
1. **先 `new URL()` 再校验**，可以免费干掉十进制/十六进制/八进制/短横线 IPv4 变体（前三行都被规范化为 `127.0.0.1`）。自己做字符串匹配必漏。
2. **IPv6 会被规范化成十六进制**：`::ffff:127.0.0.1` → `[::ffff:7f00:1]`。只匹配 `::ffff:127.0.0.1` 字面量的过滤器会**直接漏掉**。必须"去括号 → 解析 → 判断网段"，或用 `node:net` 的 `isIP()` 后做数值比较。

---

## 4. 工程脚手架

### 4.1 wrangler 主版本与配置文件

- 当前主版本 **4.x**，最新 **4.158.0**（`npm view wrangler dist-tags` `[实测]`）。3.x 为 `legacy`。
- Node **>= 22**（`engines` 实测）。
- `[文档]` <https://developers.cloudflare.com/workers/wrangler/configuration/>："Cloudflare recommends using `wrangler.jsonc` for new projects"，且 "some newer Wrangler features will only be available to projects using a JSON config file"。JSON/TOML 自 Wrangler **v3.91.0** 起都支持。
- 必填项：`name`、`main`、`compatibility_date`（"the `name`, `main` and `compatibility_date` keys are required to deploy a Worker"）。
- `name` 只能字母数字和连字符，"Do not use underscores"，<=255 字符；`workers.dev` 子域 <=63 且首尾不能是 `-`。

**本项目建议的 `wrangler.jsonc`** `[建议]`：

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "subconv",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-09",
  // 2026-08-04 起 nodejs_compat 默认开启，新项目不要再写 compatibility_flags
  "workers_dev": true,
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "cache": { "enabled": true },          // Workers Cache：命中不跑 Worker
  "limits": { "cpu_ms": 5000 },           // 防账单炸弹；默认 30s 太宽松
  "kv_namespaces": [
    { "binding": "SUB_LINKS", "id": "<KV_ID>" }
  ]
}
```

字段依据：`cache.enabled`（<https://developers.cloudflare.com/workers/cache/>，`[实测]` 4.158.0 dry-run 接受）；`limits.cpu_ms` 最大 300,000（配置文档）；`observability.head_sampling_rate` 0–1，默认 1；`kv_namespaces` 需 `binding` + `id`，`wrangler dev --remote` 还需 `preview_id`。

### 4.2 `compatibility_date` 与 `nodejs_compat`

- `[文档]`：不传（走 API）时 "defaults to the oldest compatibility date, before any flags took effect (**2021-11-02**)"；"When you start your project, you should always set `compatibility_date` to the current date."；"There is no need to update your `compatibility_date` if you do not want to."；旧日期会永久支持。
- `[文档]`（compat flags）：**`compatibility_date >= 2026-08-04` 时 `nodejs_compat` 与 `nodejs_compat_v2` 默认开启**，官方明确 "Omit them from new configurations"；要关闭需同时加 `no_nodejs_compat` + `no_nodejs_compat_v2`。

`[实测]` 验证：把 `wrangler.jsonc` 里 `compatibility_flags` 整段删掉，`compatibility_date: 2026-11-09`，`/caps` 仍返回 `process:"object"`、`Buffer:"function"` → **新 compat date 下不需要写 `nodejs_compat`**。

> `[建议]` 本项目用 `compatibility_date: "2026-11-09"`（建项目当天），**不写 compatibility_flags**。理由：2026-08-04 之后 Node 兼容默认开；少写 flag 少一处未来要清理的配置。
> 若确实想拿到 `request.signal`（客户端断开），把日期提到 `2026-11-17` 或显式加 `enable_request_signal`。

### 4.3 本地测试：普通 vitest vs Workers 专用插件

⚠️ **现状变化**：官方已把 `@cloudflare/vitest-pool-workers` 换成 **`@cloudflare/vitest-plugin`**。迁移文档（<https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/>，更新于 Aug 20, 2026）原文说新包 "replaces `@cloudflare/vitest-pool-workers`"，且 "The package API and Vitest configuration are unchanged"。

- 旧：`@cloudflare/vitest-pool-workers` **0.23.0**（npm 上未标 deprecated，但官方文档已引导迁移）
- 新：`@cloudflare/vitest-plugin` **1.6.0**，peer `vitest ^4.1.0 || ^5.0.0`（`[实测]` npm 元数据）
- 新包依赖 `miniflare@5.20261104.0-beta`（beta，注意）

**安装与配置**（<https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/>）：

```bash
npm i -D vitest@^4.1.0 @cloudflare/vitest-plugin
```

```ts
// vitest.config.ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } }),
  ],
});
```

前置条件（文档）：`compatibility_date` >= `2022-10-31`、必须 ES modules 格式、**Vitest >= 4.1**。TS 项目在 tsconfig 的 `types` 加 `"@cloudflare/vitest-plugin/types"`。

**两者怎么选** `[建议]`：

| 测试对象 | 环境 | 理由 |
| --- | --- | --- |
| 纯函数核心（节点解析、去重、规则重写、YAML/JSON 序列化、SSRF 判定函数） | **普通 Node + vitest**（最快） | 不依赖 Workers 运行时，毫秒级跑几千用例；SSRF 判定这类安全关键逻辑更需要大规模表驱动测试 |
| Worker 入口（`fetch` handler）、KV/Cache 绑定、上游 fetch 行为、兼容性差异 | **`@cloudflare/vitest-plugin`** | 只有真 workerd 才有 `caches.default`、KV 绑定、`AbortSignal`/Streams 的真实语义 |

`[未验证]` 我没有实际安装并跑通 `@cloudflare/vitest-plugin`（只核对了 npm 版本号与官方示例）；CI 里落地时需自行验证一次 `npx vitest run`。

另一个相关工具：官方推荐用 **`@msw/cloudflare`** mock 出站请求（迁移文档指向 "Mock outbound requests" 页面），对订阅转换很合适——不要在 CI 里真连机场。

---

## 5. 部署与 dry-run 验证（Windows）

### 5.1 不登录验证打包（已实测通过）

`[实测]` 环境：Windows 10 (win32 10.0.26100)，Git Bash，Node v24.21.0，wrangler 4.158.0，**无任何 `CLOUDFLARE_*` 环境变量**，`wrangler whoami` 明确显示未登录：

```bash
$ env | grep -i -E 'CLOUDFLARE|CF_'
no CLOUDFLARE_* env vars set

$ npx --yes wrangler@4.158.0 whoami
 ⛅️ wrangler 4.158.0
Getting User settings...
You are not authenticated. Please run `wrangler login`.
To deploy without logging in, run a command like `wrangler deploy --temporary` to use a temporary preview account.

$ npx --yes wrangler@4.158.0 deploy --dry-run --outdir dist
Total Upload: 1.69 KiB / gzip: 0.75 KiB
No bindings found.
--dry-run: exiting now.
EXIT=0

$ ls dist
README.md  index.js  index.js.map
```

**结论**：`wrangler deploy --dry-run` **不需要登录、不需要 API Token**，会完整走 esbuild 打包 + 配置校验，并把 bundle 写到 `--outdir`。这是 CI / 本地 pre-commit 最合适的"不登录验证"手段。

`--dry-run` 的官方定义（`npx wrangler deploy --help` 输出 `[实测]`）："Compile a project and run checks without actually uploading the Worker"；文档页写作 "Compile a project without actually deploying to live servers."

### 5.2 官方推荐的体积检查命令

`[文档]`（limits 页原文）直接给了：

```sh
wrangler deploy --outdir bundled/ --dry-run
# Total Upload: 259.61 KiB / gzip: 47.23 KiB
```

"`Total Upload` value is your uncompressed bundle size"，上限 64 MiB。

### 5.3 其他命令

| 目的 | 命令 | 说明 |
| --- | --- | --- |
| 只编译不部署 | `npx wrangler@4.158.0 deploy --dry-run --outdir dist` | **无需登录**（实测） |
| 上传版本但不切流量 | `npx wrangler versions upload --dry-run` / 去掉 dry-run | flags 含 `--tag`、`--message`、`--outdir`、`--upload-source-maps`（默认 true） |
| 本地跑 | `npx wrangler@4.158.0 dev --port 8799 --ip 127.0.0.1` | 本地 workerd，无需登录（实测） |
| 检查启动 CPU | `npx wrangler check startup` | limits 页提到，针对 1 s 启动限制生成 CPU profile |
| 查登录态 | `npx wrangler whoami` | 未登录会提示 |
| 登录 | `npx wrangler login` | 打开浏览器 OAuth |
| CI 认证 | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | `[文档]` <https://developers.cloudflare.com/workers/wrangler/system-environment-variables/>；`--env` 优先于 `CLOUDFLARE_ENV` |

`[文档]` 另一个选项：`wrangler deploy --temporary` —— 使用临时预览账户部署，**不需要登录**（来自 `whoami` 的提示文本 `[实测]`；具体配额/限制官方文档未在此处给出，`[未验证]`）。

### 5.4 Windows 注意事项 `[建议]`

- Git Bash 下路径用正斜杠即可；`--outdir dist` 相对路径没问题（实测）。
- PowerShell 里 `npx` 可能被执行策略拦，必要时 `npx.cmd`；或统一用 `npm exec`。
- 固定版本：`npx --yes wrangler@4.158.0`，不要依赖全局安装，避免 CI 与本地版本漂移（4.x 的 minor 也可能改行为）。
- `--autoconfig` 在 `deploy` 上默认 `true`（`--help` 实测），会自动做框架探测；CI 里若配置已确定，显式 `--autoconfig=false` 更可控。
- 行尾：`.gitattributes` 里把 `*.jsonc`、`*.toml` 设为 `text eol=lf`，避免 Windows CRLF 让配置 diff 噪音化（`[建议]`，非文档结论）。

---

## 6. 订阅转换：SSRF 防护与资源上限

### 6.1 威胁模型

订阅转换的核心功能就是"**替我请求一个用户给的 URL**"，这是教科书级 SSRF 入口。攻击者想要：

1. 读云元数据（`169.254.169.254` / `[fd00:ec2::254]`）拿临时凭据；
2. 打内网服务（RFC1918、CGNAT `100.64/10`、`*.internal`、`localhost`）；
3. 用你的 Worker 当"高信誉代理"去打第三方（滥用出口 IP、放大攻击）；
4. 用超大响应/超慢响应耗尽你的 CPU/内存/并发（DoS + 账单）。

### 6.2 平台已提供的防护（不要重复造，但要知道边界）

| 防护 | 依据 | 边界 |
| --- | --- | --- |
| 出站经本地代理，只允许"公网服务"或"本 zone origin" | <https://developers.cloudflare.com/workers/reference/security-model/> | 自家 zone 的 origin 是例外；重定向逐跳是否校验 `[未验证]` |
| 跨源重定向去 `Authorization`（默认 2025-09-01） | compat flags | 只去 `Authorization`，不阻止目标地址 |
| 出站无 `Host` 越权 | Request 文档 | 只针对 Host 头 |
| 无法访问本地文件系统 | security model | — |
| 无 DNS API（拿不到解析结果） | `[实测]` | 反过来说：你也**无法**自己做解析后校验 |

### 6.3 应用层 SSRF 校验清单（建议实现，按顺序）

1. **只允许 `http:` / `https:`**，其余（`file:`、`gopher:`、`data:`、`ftp:`、`ws:`）直接拒绝。
2. **先 `new URL()` 归一化**（`[实测]` 可干掉 `2130706433`、`0x7f000001`、`0177.0.0.1`、`127.1`、`0` 等变体）。
3. **拒绝带 userinfo 的 URL**（`u.username || u.password` 非空）。实测 `http://user:pass@example.com@127.0.0.1/` 的 host 是 `127.0.0.1`，URL 解析本身正确，但 userinfo 是钓鱼/混淆常用手法。
4. **主机名小写化后做拒绝表**（域名维度）：
   - `localhost`、`*.localhost`、`*.local`、`*.internal`、`*.home.arpa`
   - `metadata`、`metadata.google.internal`、`instance-data`、`metadata.azure.com`
   - 各云厂商元数据别名（`[建议]` 按黑名单维护，不追求穷尽）
5. **IP 字面量判定**：`node:net` 的 `isIP(host)`（`[实测]` 可用：v4→4、v6→6、域名→0）。
   - IPv4 拒绝网段：`0.0.0.0/8`、`10.0.0.0/8`、`100.64.0.0/10`、`127.0.0.0/8`、`169.254.0.0/16`、`172.16.0.0/12`、`192.0.0.0/24`、`192.168.0.0/16`、`198.18.0.0/15`、`224.0.0.0/4`、`240.0.0.0/4`。
     依据：IANA IPv4 Special-Purpose Address Registry（<https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml>）。`[已读]` 该页明确列出 `127.0.0.0/8` Loopback、`10/8`+`172.16/12`+`192.168/16` Private-Use、`169.254/16` Link Local、`100.64/10` Shared Address Space、`0/8` This network、`192.0.0.0/24` IETF Protocol Assignments、`198.18/15` Benchmarking、`240/4` Reserved；`224.0.0.0/4`（Multicast）为常识性补充，未在本次抓取片段中出现。
   - IPv6 拒绝网段：`::/128`（未指定）、`::1/128`（loopback）、`::ffff:0:0/96`（IPv4-mapped，**必须先还原成 IPv4 再按 v4 规则判**）、`64:ff9b::/96`（NAT64）、`100::/64`（discard）、`2001:db8::/32`、`fc00::/7`（ULA）、`fe80::/10`（link-local）、`ff00::/8`（multicast）。
   - ⚠️ **IPv6 写法归一化**：`[实测]` `new URL("http://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]"`。判定前必须 `host.replace(/^\[|\]$/g, "")`，并把 `::ffff:x` 形式展开/转 v4。**不要用字符串包含匹配**。
6. **端口限制**：只允许 80/443（或显式白名单）。非标准端口是内网探测的常见信号。
7. **重定向自己处理**：`redirect: "manual"`，最多 3 跳，**每跳回到第 1 步重新校验**，且每跳都换新 `AbortSignal.timeout()`（总预算别叠加成 3 倍）。实测 `manual` 能拿到 302 + `Location`。
8. **响应约束**：先看 `Content-Length`（可能缺失），再在流式读取时累计字节数，超限立即 `reader.cancel()` 并返回 413；不要 `await res.text()` 一个未知大小的响应。
9. **超时**：`AbortSignal.timeout(5000~10000)`；若要客户端取消，`AbortSignal.any([AbortSignal.timeout(t), request.signal])`（后者需 compat >= 2026-11-17 或 flag）。
10. **内容类型与编码**：只接受 `text/plain`、`text/yaml`、`application/json`、`application/yaml` 等白名单；不要根据上游 `Content-Type` 决定输出（防止 XSS/嗅探），输出统一 `text/plain; charset=utf-8` 或 `application/yaml; charset=utf-8`。
11. **不转发上游任何头**给客户端；出站也不转发用户头。
12. **出口身份**：显式 UA；若上游需要认证，凭据只来自我们自己的 KV，不接受用户传入的任意 header。

### 6.4 云元数据地址速查

| 云 | IPv4 | IPv6 / 其他 | 来源 |
| --- | --- | --- | --- |
| AWS EC2 IMDS | `169.254.169.254` | `[fd00:ec2::254]` | <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html> `[已读]` 原文给出两个地址 |
| GCP | `169.254.169.254` + `metadata.google.internal` | — | `[未验证]` 未读官方页；`metadata.google.internal` 已在第 3.5 节实测可被 URL 解析保留 |
| Azure | `169.254.169.254` | — | `[未验证]` 未读官方页 |
| 阿里云 | `100.100.100.200` | — | `[未验证]`；注意它落在 `100.64.0.0/10`，已被 CGNAT 规则覆盖 |
| 腾讯云 | `169.254.0.23` | — | `[未验证]`；落在 `169.254.0.0/16` |

> `[建议]` 不必背清单：**拒绝全部 link-local + 私有 + CGNAT + ULA + loopback + IPv4-mapped**，元数据地址自然被覆盖。清单只作为"域名维度"的补充（`metadata.google.internal` 这类名字解析后仍是 link-local，但域名黑名单能挡住"解析前"的请求并给出更清晰的错误）。

### 6.5 资源上限建议（订阅转换）

| 项 | 建议值 | 依据 |
| --- | --- | --- |
| 计费计划 | **Workers Paid** | Free 10 ms CPU 无法完成 YAML 解析+序列化（limits 页：重负载 10-20 ms 起） |
| `limits.cpu_ms` | **3000–5000**（3–5 s） | 默认 30 s 过宽；`cpu_ms` 上限 300,000；定价页建议显式设限防账单炸弹 |
| 上游总超时 | **5–10 s** | 平台无请求超时（limits 页 "No limit"），必须自己设 |
| 单跳重定向超时 | 3 s，最多 3 跳 | 子请求按跳计数（文档） |
| 上游响应体上限 | **8–16 MB** | 受 128 MB isolate 内存约束，且 isolate 并发复用 |
| 并发上游数 | **<= 6** | 文档硬限制 6 个"等待响应头"的连接 |
| 单次调用子请求数 | **<= 10**（付费 10,000 够用；Free 仅 50） | 文档 |
| 输出响应体 | 不缓冲超 20 MB；更大则流式 | 128 MB 内存 + "Memory limit would be exceeded before EOF" |
| 缓存 TTL（渲染结果） | 60–300 s，`Cache-Control: public, max-age=...` | 订阅内容分钟级变化足够；`Cache-Control: private` 用于私有订阅 |
| KV 写入 | 同一 key 间隔 >= 1 s，失败指数退避 | 文档：1 写/秒/key，超限 429 |
| 日志 | 不打印完整订阅 URL/token | token 即凭据；Workers Logs Free 200,000 条/天、保留 3 天；Paid 含 20M/月（+$0.60/百万）、保留 7 天（pricing 页；2026-12-01 起改用 Cloudflare Observability 计价） |

### 6.6 推荐的请求处理骨架（要点，不是完整实现）

```ts
// 1) 解析 + 归一化 + 拒绝表 → 得到 upstream: URL
// 2) redirect: "manual" 循环（<=3 跳），每跳重新校验 + 每跳独立 timeout
// 3) 读取时累计字节，超限 cancel
// 4) 交给纯函数核心做转换（可单测、无 IO）
// 5) 输出：Cache-Control: public, max-age=60（公开）/ private（私有）
```

> `[建议]` 把"URL 校验"做成**纯函数**（输入 string，输出 `{ok, reason}`），用普通 vitest 跑几百条恶意样例（十进制/十六进制/八进制/短写 IPv4、`[::ffff:7f00:1]`、userinfo、重定向链、`%2f` 混淆、超长 URL）。这是本项目最值得投入测试的地方，而且不需要 Workers 运行时。

---

## 7. 未验证 / 未知项（明确列出，避免被当成结论）

1. **生产环境的 SSRF 行为未实测**：本次没有部署到 Cloudflare（无凭据），"平台代理会阻断解析到私网的域名"仅来自 security-model 文档描述，未用真实部署验证。
2. **重定向到私网是否逐跳阻断**：文档未明示，`[未验证]`。
3. **`node:dns` 在生产的行为**：只在本地 workerd 实测 `lookup` 失败；生产未测。
4. **Cache API 的"响应过大"具体阈值**：文档只说返回 413，没给字节数。
5. **Cache API 在 `*.workers.dev` 上是否完全可用**：文档写 "Workers deployed to custom domains have access to functional `cache` operations"（并给 `.workers.dev` 的 query-string 特例），措辞含糊，`[未验证]`。
6. **Workers Cache 对响应体大小的上限**：文档未给出。
7. **`@cloudflare/vitest-plugin` 实际跑通**：只核对了版本与配置示例，未在本机 `npm i` 后执行测试。
8. **`wrangler deploy --temporary` 的配额与限制**：仅见 `whoami` 提示文本，未在官方文档中定位到对应页。
9. **KV 免费额度是否包含 delete/list 的具体计费**：limits 页给的是 reads/writes，pricing 页给的是 reads/writes/deletes/lists（1,000/天），两页口径略有差异，以 pricing 页为准更保守。

---

## 8. 参考链接（官方）

**Workers 运行时 / 限制**
- Limits: <https://developers.cloudflare.com/workers/platform/limits/>
- Pricing: <https://developers.cloudflare.com/workers/platform/pricing/>
- Security model: <https://developers.cloudflare.com/workers/reference/security-model/>
- Streams: <https://developers.cloudflare.com/workers/runtime-apis/streams/>
- Request: <https://developers.cloudflare.com/workers/runtime-apis/request/>
- Response: <https://developers.cloudflare.com/workers/runtime-apis/response/>
- Fetch: <https://developers.cloudflare.com/workers/runtime-apis/fetch/>
- Web standards（timers/AbortController）: <https://developers.cloudflare.com/workers/runtime-apis/web-standards/>
- Compatibility dates: <https://developers.cloudflare.com/workers/configuration/compatibility-dates/>
- Compatibility flags（`nodejs_compat`、`global_fetch_strictly_public`、`enable_request_signal`）: <https://developers.cloudflare.com/workers/configuration/compatibility-flags/>

**缓存 / 存储**
- Cache API: <https://developers.cloudflare.com/workers/runtime-apis/cache/>
- Workers Cache: <https://developers.cloudflare.com/workers/cache/>
- Workers Cache 配置: <https://developers.cloudflare.com/workers/cache/configuration/>
- Workers Cache key: <https://developers.cloudflare.com/workers/cache/cache-keys/>
- Workers Cache purge: <https://developers.cloudflare.com/workers/cache/purge/>
- KV 工作原理（一致性）: <https://developers.cloudflare.com/kv/concepts/how-kv-works/>
- KV 限制: <https://developers.cloudflare.com/kv/platform/limits/>
- KV 定价: <https://developers.cloudflare.com/kv/platform/pricing/>
- KV 读: <https://developers.cloudflare.com/kv/api/read-key-value-pairs/>
- KV 写: <https://developers.cloudflare.com/kv/api/write-key-value-pairs/>

**脚手架 / 部署**
- Wrangler 配置: <https://developers.cloudflare.com/workers/wrangler/configuration/>
- Wrangler 命令: <https://developers.cloudflare.com/workers/wrangler/commands/workers/>
- Wrangler 系统环境变量: <https://developers.cloudflare.com/workers/wrangler/system-environment-variables/>
- Vitest 集成: <https://developers.cloudflare.com/workers/testing/vitest-integration/>
- 迁移到 vitest-plugin: <https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/>
- 第一个测试: <https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/>

**外部标准**
- IANA IPv4 Special-Purpose Address Registry: <https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml>
- AWS EC2 IMDS 地址: <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html>
- RFC 9111（HTTP caching）: <https://www.rfc-editor.org/rfc/rfc9111>

---

## 附录 A：本次实测所用最小 Worker（可复现）

放在 `%TEMP%\cfw-research-195946\`（**不在本仓库内**），`wrangler.jsonc` 仅 `name/main/compatibility_date`，`src/index.js` 暴露 `/ping`、`/caps`、`/timeout`、`/ua`、`/dns`、`/urlnorm`、`/ext-manual`、`/ext-follow`、`/stream` 等探针端点。

复现命令（Git Bash）：

```bash
cd "$TEMP/cfw-research-195946"
npx --yes wrangler@4.158.0 deploy --dry-run --outdir dist       # 打包校验（无需登录）
npx --yes wrangler@4.158.0 whoami                               # 确认未登录
npx --yes wrangler@4.158.0 dev --port 8799 --ip 127.0.0.1 --local
curl -s http://127.0.0.1:8799/caps
curl -s "http://127.0.0.1:8799/timeout?ms=150"
curl -s "http://127.0.0.1:8799/urlnorm?u=http%3A%2F%2F%5B%3A%3Affff%3A127.0.0.1%5D%2F"
```

## 附录 B：本次改动的文件

- `docs/research/cloudflare-workers.md`（本文件，唯一写入仓库的文件）
