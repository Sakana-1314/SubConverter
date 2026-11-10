# 真实订阅验收记录（补充）

日期：2026-11-10。本文只记录本地验收，不包含订阅 URL、节点名、密码、UUID 或任何生成配置内容。

## 1. 输入

- 用户真实订阅的本地副本：`.private/user-subscription/subscription.raw`（仅本地，`.gitignore` 排除）。结构：Clash YAML，46 个节点（`ss` 34、`vmess` 12）、128 个策略组、9,816 条规则；无 `DOMA`、无缺逗号行。
- 公开模板：ACL4SSR `ACL4SSR_Online_Full_AdblockPlus.ini`，35 个远程 ruleset（本地保存副本共 96,345 条规则）。
- 运行方式：本地私有验收脚本（只读 `.private/`，不随仓库提交）用 loopback 提供订阅/模板/ruleset，直接调用 Worker 入口 `handleRequest`；生成的 YAML 用 `yaml` 读回，再由 `tools/mihomo/mihomo.exe -t` 加载。**全程没有重新下载订阅 URL。**

## 2. 结果

| 场景 | HTTP | 耗时 | 节点 | 组 | 规则 | 非法规则 | mihomo `-t` |
|---|---|---:|---:|---:|---:|---:|---:|
| 仅订阅（无 config） | 200 | 63 ms | 46 | 2（默认组） | 1（MATCH） | 0 | 退出 0 |
| 订阅 + ACL4SSR，本地 ruleset，30s deadline | 200 | 1.3 s | 46 | 33 | 50,001（MAX_RULES 上限） | 0 | 退出 0 |
| 订阅 + ACL4SSR，远程 ruleset，默认 10s deadline | 200 | 10.1 s | 46 | 33 | **635**（大量 `E_FETCH_TIMEOUT`） | 0 | 因缺 GeoIP 数据库失败（环境原因） |
| 订阅 + ACL4SSR，远程 ruleset，30s deadline | 200 | 11.9–20.9 s | 46 | 33 | 50,001 / 13,860（随 GitHub 拉取波动） | 0 | 一次退出 0；一次因缺 GeoIP 数据库失败 |

本地 ruleset、30s deadline 的确定性结果：

- 0 基第 **20,674** 条 = `DOMAIN-SUFFIX,katldpsrjggef.space,🆎 AdBlock`，是合法规则，**不是 `DOMA`**。
- `DOMA` 计数 0；非法类型计数 0。
- 规则类型：`DOMAIN-SUFFIX` 49,808、`IP-CIDR` 137、`IP-CIDR6` 4、`DOMAIN` 26、`DOMAIN-KEYWORD` 25、`MATCH` 1。
- 警告：`E_TRUNCATED_TAIL` 1（某公开 list 末行无换行，保守判定）、`W_RULE_LIMIT` 1（50,000 上限）、`W_RULE_TYPE_UNSUPPORTED` 9（`URL-REGEX` 无 mihomo 等价类型，已丢弃）、`W_GROUP_MATCHER_INVALID` 9（ACL4SSR 三段式 `interval,,tolerance` 只取前两段）、`W_PARAM_UNSUPPORTED` 1、`W_GROUP_EMPTY` 1、`W_CLASH_SECTION_IGNORED` 1、`W_RULE_TYPE_ALIAS` 1。

## 3. 与你报错索引的对应

- 模板前 4 个 ruleset 共 1,672 条；`20,674 − 1,672 = 19,002`。
- `BanEasyList.list` 的第 19,002 条（0 基）正好是 `DOMAIN-SUFFIX,...`，**前 4 个字符就是 `DOMA`**。
- 只要该列表/输出在传完 19,002 条后、下一行第 4 个字节处被截断，旧转换器就会把 `DOMA` 当作第 20,674 条输出；mihomo 在 `config/config.go:1104-1105` 因 `target == ""` 报 `format invalid`。
- 我们抓到的失败输出在 196,099 B 处被切断，末行是 `  - DOMAI`，与上述截断模式一致。
- 新 Worker 的处理：逐行校验；`E_TRUNCATED_TAIL` 检测无最终换行的末行；任何无 target/未知类型/半截行丢弃并告警；输出读回校验；最终 `mihomo -t` 通过。

## 4. 部署边界

- `wrangler.toml` 的 `REQUEST_DEADLINE_MS` 已从 `10000` 调到 `30000`，`UPSTREAM_TIMEOUT_MS=20000`、`PER_HOP_TIMEOUT_MS=10000`。否则真实 ACL4SSR 全模板在 10s 内只完成约 635 条规则（HTTP 200 但内容不完整，虽然规则合法）。
- 当前公开 ACL4SSR 模板已有约 96k 规则，而 emitter 的 `MAX_EMIT_RULES` 硬上限是 50,000；因此最多输出约 50k 条并给 `W_RULE_LIMIT`。你的历史失败配置是 20,674 条，50k 足够覆盖。若要完整 96k：用 `rules_mode=providers`，或修改 `src/emitter/rules.ts` 的 `MAX_EMIT_RULES` 并重新评估内存/CPU。
- 远程 ruleset 的拉取时间随网络波动；`RULESET_CACHE_TTL=300` 的缓存可让后续请求更快。首次冷请求可能仍有 `E_FETCH_TIMEOUT`，输出会如实带 warning，不会产出非法规则。
- 含 `GEOIP` 的输出在 `mihomo -t` 时需要本地 GeoIP 数据库（`Country.mmdb` / `geoip.metadb`）。本次 50k 输出在 `GEOIP` 之前就被 `MAX_RULES` 截断，所以 `-t` 不需要该库；完整 96k 输出需要先准备库，否则 `-t` 会因下载超时而失败（环境原因，不是规则错误）。

## 5. 残余 high 风险（独立评审确认）

评审后的修复阶段已经修掉两条大输入 OOM，并有 128 MB 子进程回归测试（`tests/integration/limits.test.ts` 的 4 个 memory-limit 用例在本次 `npm test` 中通过）：

- 40k 节点 Clash YAML 在 AST 物化前被节点/字节预算拦住；
- 2,000,000 行 domain ruleset 在规则对象物化前被条数/字节预算拦住。

以下风险**仍未修复**，不影响你当前 46 节点 / 2 万条规则的场景，但公开部署前必须知道：

1. **include/rename/组 matcher 的 ReDoS**：`(a|aa)+$` 这类“交替 + 外层量词”未被现有嵌套量词检查拦截，实测可在几十字符名字上跑 30s+（`src/links/protocols.ts`、`src/rules/groups.ts`）。
2. **IP-SUFFIX 语义**：接受裸整数 `24`（mihomo 会拒绝加载整份配置），且会把 `8.8.8.8/24` 掩码成 `8.8.8.0/24`，改变匹配集合（`src/rules/payload.ts`、`src/emitter/rules.ts`）。
3. **IN-TYPE / IP-ASN 语义**：`IN-TYPE,FOO`/`wifi` 会被接受但 mihomo 拒绝；`IP-ASN,AS13335` 会规范化成带 `AS` 前缀，mihomo 永远匹配不到（`src/rules/payload.ts`）。
4. **解析层与读回层接受集不一致**：例如 `DOMAIN-REGEX,\Afoo` 被解析接受、被 emitter 读回拒绝，整次 `/sub` 返回 500（`src/rules/payload.ts` vs `src/emitter/rules.ts`）。

公开部署最低要求：`workers_dev=false` 或 Cloudflare Access/WAF；限制 `MAX_UPSTREAM_BYTES`/`MAX_RULES`/`MAX_NODES`；不要匿名暴露 `/getruleset` 与大输入路径。细节见 `docs/REPORT.md` §7 与 `docs/ARCHITECTURE.md` §14/§15。
