# EdgeOne 兼容

同一套转换逻辑同时支持：

- **Cloudflare Workers**：`wrangler deploy`，入口 `src/index.ts`
- **EdgeOne Pages Cloud Functions**：`cloud-functions/`，入口 `src/edgeone.ts`

## 为什么是 Cloud Functions

EdgeOne 有两类函数，限制完全不同：

| 类型 | 目录 | 运行时 | CPU/时长 | 请求/响应 | 适合本项目？ |
|---|---|---|---|---|---|
| Edge Functions | `edge-functions/` | JavaScript | 200 ms CPU | 1 MB 请求体 | 否：20k+ 规则会超时 |
| Cloud Functions | `cloud-functions/` | Node.js / TypeScript | 默认 30 s，最长 120 s | 6 MB | **是** |

完整 ACL4SSR 模板会生成约 2.4 MB 配置、处理数万条规则，必须使用 Cloud Functions。

## 目录

```text
src/edgeone.ts                 EdgeOne 适配器（onRequest -> handleRequest）
scripts/build-edgeone.mjs      用 esbuild 生成自包含 bundle
scripts/check-edgeone.mjs      Node 冒烟测试（/version + /sub）
cloud-functions/
  index.js                     EdgeOne 路由：/
  [[default]].js               EdgeOne 路由：其他所有路径
  _subconverter.js             生成的自包含 bundle（含 yaml，无运行时依赖）
edgeone.json                   EdgeOne Pages 构建/输出/函数配置
public/.gitkeep                EdgeOne 静态输出目录占位
```

`cloud-functions/index.js` 与 `[[default]].js` 只是薄包装：

```js
import { handleEdgeOne } from './_subconverter.js';
export const onRequest = handleEdgeOne;
```

`_subconverter.js` 由 `npm run build:edgeone` 生成，已提交到仓库以保证 EdgeOne 直接部署可用；CI 会重建并校验没有漂移。

## 部署（EdgeOne Pages）

1. 将仓库推送到 GitHub，在 EdgeOne Pages 导入 Git 仓库。
2. 构建配置由 `edgeone.json` 提供：
   - 安装：`npm ci`
   - 构建：`npm run build:edgeone`
   - 输出目录：`./public`
   - Node：`22.11.0`
3. 在 Pages 控制台「项目设置 → 环境变量」配置：
   - `REQUEST_DEADLINE_MS=30000`
   - `UPSTREAM_TIMEOUT_MS=20000`
   - `PER_HOP_TIMEOUT_MS=10000`
   - `MAX_RULES=50000`（emitter 上限；完整 96k 模板用 `rules_mode=providers`）
   - `PUBLIC_ORIGIN=https://<你的 EdgeOne 域名>`（仅 providers 模式需要）
   - `ENVIRONMENT=production`
   - `ALLOW_HTTP_UPSTREAM=false`
4. 部署后用 `/version`、`/sub` 验证；`cloudFunctions.maxDuration` 已设为 120 s，如果控制台有同名设置请保持一致。

## 本地验证

```bash
npm ci
npm run build:edgeone
npm run check:edgeone
```

`check:edgeone` 会直接加载生成的 bundle，调用 `/version` 与一条 inline `ss` 订阅，断言 `/sub` 返回 200 且包含 `proxies:`。

## 限制与注意

- Cloud Functions 请求/响应体上限 6 MB；50k 规则输出约 2.4 MB，仍在范围内。
- 单次最长 120 s；`REQUEST_DEADLINE_MS` 默认按 30 s 控制，超时返回结构化错误而不是半截 YAML。
- 不使用 `edge-functions/`，因为 200 ms CPU 无法覆盖 20k+ 规则；如果只转换很小的订阅，可以另外生成 Edge Functions 版本，但不属于当前支持路径。
- 本仓库未在真实 EdgeOne 账户上执行部署；本机已验证 bundle 构建与 Node 冒烟。上线前请先用 EdgeOne 预览环境跑 `/version` 与一次真实订阅。
- `cloud-functions/_subconverter.js` 是生成物；修改 `src/edgeone.ts` 或 `src/` 后必须执行 `npm run build:edgeone` 并提交生成结果，CI 会检查。
