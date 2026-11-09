# 迁移报告：tindy subconverter → Cloudflare Worker

- 项目：`subconverter-worker` 1.0.0
- 迁移目标：把 tindy2013/subconverter 的**行为**迁移到 Cloudflare Workers，输出 mihomo/Clash YAML
- 兼容基线：tindy2013/subconverter `a0d4eab28cb8b6c782d4ce5c3a918de4829b4a72`（v0.9.0）
- 报告日期：2026-11-09
- 依据文档：`docs/SPEC.md`、`docs/ARCHITECTURE.md`、`docs/PARITY.md`、`docs/research/*.md`、`docs/acceptance.md`

> **证据标记**：本文用 `【实测·本次】` 表示撰写报告时在本机实际执行的命令；`【实测·验收】` 表示工作流运行的 `npm run acceptance` 记录（`docs/acceptance.md`）；`【代码】` 表示当前仓库源码；`【取证】` 表示 `docs/research/` 的取证结论；`【推断】` 表示未被直接观测、只能给出置信度的判断。

---

## 1. 结论

### 1.1 迁移完成度

**v1 范围内的迁移已完成，但它不是 tindy 的全功能克隆，而是“对 mihomo 用户有用的行为兼容”。**（`docs/PARITY.md:28`）

当前实现覆盖：

| 维度 | 状态 |
|---|---|
| HTTP 端点 | `/`、`/version`、`/sub`、`/clash`、`/getruleset` 共 5 个（`src/http/routes.ts:35`、`:333-346`） |
| 输出 target | `/sub` 仅接受 `clash`，其它 target → 400；`/clash` 上显式传非 clash target 会被忽略并产生 `W_PARAM_IGNORED`（200），不是 400（`src/http/params.ts:330-347`、`docs/SPEC.md:139-143`） |
| 输入 | Base64 订阅、纯文本 URI 列表、Clash YAML（只取 `proxies`/`Proxy`）、`inline:`/`data:` |
| 协议 | SS、SSR、VMess、Trojan、VLESS 共 5 种；VLESS 是相对 tindy 的新增能力（`docs/PARITY.md:90-103`） |
| 规则 | 注册表识别 37 个 mihomo 精确类型，其中 36 个可输出；`SUB-RULE` 识别但丢弃并告警（`docs/SPEC.md:462-473`、`src/rules/registry.ts:131-134`） |
| ACL4SSR INI | 子集：组、规则集、rename、include/exclude、`clash_rule_base`（`docs/SPEC.md:729-793`） |
| 测试 | 27 个测试文件、542 个测试全部通过【实测·本次】 |
| 本地验收 | 28/28 通过，退出码 0；只覆盖 `/sub` + INI + mihomo，不含 `/getruleset`、`/clash`、`/version`、`/`【实测·验收：`docs/acceptance.md:39-68`】 |
| 真实 mihomo 校验 | 仅主配置 `out/generated.yaml` 跑 `mihomo -t`，退出码 0；该文件规则为 20,675 条 DOMAIN + 1 条 DOMAIN-SUFFIX + 1 条 MATCH，INI 配置未跑 mihomo【实测·本次；`docs/acceptance.md:68-92`】 |

未完成的是“tindy 全兼容”：多 target、更多协议、inja 模板、脚本、provider/relay 组、配置写接口、本地文件读取等都不在 v1 范围，逐项登记在 `docs/PARITY.md:371-393` 的 Gap Register。

### 1.2 能否部署

**可以构建并部署，但当前证据只到“本地检查通过”，不是“已在真实 Cloudflare 账户上线验证”，也不是“干净机器/Free 计划验证”。**

支持部署的证据：

1. `npm run typecheck` 退出 0【实测·本次】。
2. `npm test`：27 个测试文件、542 个测试全部通过，退出 0【实测·本次】。
3. 工作流回归记录：`typecheck=0`、`test=0`、`build=0`。其中 `build` 为 `wrangler deploy --dry-run --outdir=dist` 的打包校验，本报告未复跑（`package.json:12`）。
4. `npm run acceptance` 退出 0，28/28 检查通过【实测·验收：`docs/acceptance.md:7`】。该验收只覆盖 `/sub`、INI 和主配置 mihomo 检查；28/28 是本机记录，不是发布门禁（mihomo 检查 `required=false`，失败时仍 exit 0，见 §5.2）。
5. 生成的 `out/generated.yaml` 被真实 mihomo v1.19.33 接受：`mihomo.exe -t ...` 退出 0、stderr 0 字节【实测·本次】。

必须同时说明的部署前提与风险：

- **运行时按 Cloudflare Workers Paid 设计**。Free 计划每次请求只有 10 ms CPU，不足以完成 YAML/规则处理；`wrangler.toml` 显式设置 `limits.cpu_ms = 5000`，这是 Paid 配置（`docs/ARCHITECTURE.md:28`、`:41`、`wrangler.toml:18-19`）。**Free 账户部署/运行时的具体错误文案未实测**：可能表现为部署拒绝或运行期 CPU 超限（具体错误码未验证）。
- **未在真实账户部署，也未实测生产 SSRF/egress、重定向逐跳行为、CDN 缓存行为**。`docs/PARITY.md:292`、`docs/PARITY.md:349-367`、`docs/ARCHITECTURE.md:1234-1247` 均把这一点列为未验证。
- **默认没有鉴权、限速和 KV 短链**，且 `workers_dev = true`（`wrangler.toml:9`）。公开部署前必须自行加 Cloudflare WAF/速率限制或 Access（`docs/SPEC.md:884-887`）。
- **本报告的复跑范围**：只复跑了 `npm run typecheck`、`npm test`、`mihomo -t` 和几组 `handleRequest` 探针；没有运行 `npm ci`、`npm run dev`、`npm run build`、`npm run acceptance`、`npx wrangler login` 或 `npx wrangler deploy`。

### 1.3 DOMA 问题如何被根治

一句话：**不是“把 DOMA 加进黑名单”，而是取消了所有“未校验直通”路径，让任何来源的每一条规则都必须经过同一套“类型 → 字段拆分 → payload → target”校验；非法行只丢弃并告警，永不进入输出。**

具体有六层：

1. **精确类型注册表**：37 个类型先 `trim().toUpperCase()` 再**精确匹配**，不用 `startsWith`；`DOMA`、`MATCHBOX`、`DOMAIN-FOO` 都不在表内（`src/rules/registry.ts:90-140`、`docs/SPEC.md:427`）。
2. **缺 target 预检**：单字段非空行（如 `DOMA`）在类型白名单之前就判 `E_RULE_NO_TARGET`；模板/内联来源中以已知类型或类型前缀开头的“类型,payload”两字段行同样在类型判断前判缺 target（`src/rules/parse.ts:178-247`、`docs/SPEC.md:508-512`）。这直接对应 mihomo 在 `target == ""` 时打印的 `format invalid`。
3. **规则集来源必须由 GROUP 提供 target**；未知类型丢弃并报 `E_RULE_UNKNOWN_TYPE`；target 必须存在于生成的组/节点/内置目标中（`docs/SPEC.md:501-527`、`src/rules/validate.ts:81-...`）。
4. **尾部截断检测**：对 typed 方言，文件无最终换行且最后一行是类型/别名、严格类型前缀或以逗号结尾时，报 `E_TRUNCATED_TAIL`（`src/rules/truncation.ts:96-...`、`docs/SPEC.md:602-609`）。
5. **输出加固**：规则强制双引号 YAML 标量；生成后重新解析 YAML，并对每条规则再次调用 `parseRuleLine`（mode=template，全量 targets/providers），读回失败直接 500，不下发坏配置（`src/emitter/config.ts:195-264`、`:362-...`；`src/services/pipeline.ts:531-548`；`docs/SPEC.md:615-627`）。
6. **默认 `overwrite_original_rules=true`**：模板/base 里的规则默认整段丢弃；只有显式设为 `false` 时才逐条校验后追加（`docs/SPEC.md:651-653`、`docs/SPEC.md:790-793`、`docs/ARCHITECTURE.md:1228`）。这条移除了 tindy P1 的 base 透传温床。

验收证据（20k 规则 + 末尾 `DOMA` 的复现场景）：

- 输出中没有以 `DOMA` 开头的规则，也没有 `,DOMA,`【实测·验收：检查 6】。
- 第 20675 行 `DOMA,example.com` → `E_RULE_UNKNOWN_TYPE`；第 20676 行 `DOMA`（无最终换行）→ `E_RULE_NO_TARGET` + `E_TRUNCATED_TAIL`，均带准确行号【实测·验收：检查 7】。
- 20,674 条合法规则全部保留，加 2 条 BOM/CRLF 规则和 1 条最终 `MATCH`，共 20,677 条【实测·验收：检查 11】。
- 20,677 条输出规则全部通过项目自身的 `parseRuleLine` 重校验，也通过独立维护的 37 类型白名单校验【实测·验收：检查 15、16】。
- 真实 `mihomo -t` 接受该配置，退出 0【实测·本次；实测·验收：检查 28】。

---

## 2. DOMA 根因分析

> 本节区分**已经证实的机制**和**对用户现场场景的推断**。`docs/research/doma-diagnosis.md` 的 §4、§6 给出了逐项置信度，本节引用其结论，不把推断写成事实。

### 2.1 错误消息的确切含义（确定）

`rules[20674] [DOMA] error: format invalid` 不是“mihomo 不认识 DOMA 这个类型”，而是：

- mihomo 在 `config/config.go:1104-1105` 先检查 `target == ""`，为空就直接返回 `format invalid`；
- 方括号里的 `DOMA` 是**原始规则行**，不是解析后的类型；
- 因此真正的问题是：第 20,675 条（0 基 20,674）规则**没有目标字段**。

置信度：0.99（源码 + 真实 `ParseRulePayload`/`parseRules` 测试 + 错误格式串三方面一致，`docs/research/doma-diagnosis.md:477-485`、`:787-788`）。

### 2.2 根因不是“某个类型映射写错”，而是“缺少统一校验边界”

tindy 的规则处理存在多条**不校验就输出**的路径，加上“前缀白名单”和“无截断检测”，导致一条非法行可以到达客户端。`DOMA` 只是最显眼的症状。共同根因可以归纳为四件事：

1. **前缀白名单**：tindy 的 `ClashRuleTypes` 只有 13 个前缀，用 `startsWith` 匹配，`MATCHBOX`、`DOMAIN-FOO` 会混过（`docs/PARITY.md:143-151`、`docs/research/doma-diagnosis.md:301-320`）。
2. **直通路径**：base 规则原样复制、`[]RULE` 只 `substr(2)` 后补 group、Surge 规则集直接 `return content` 等（`docs/PARITY.md:155-163`）。
3. **无统一 target 检查**：普通路径会补 group，但直通路径不会；因此“缺 target”的行可以原样落进 YAML。
4. **无尾部截断检测**：下载/传输在任意字节处截断时，YAML 仍可能解析成功（最后一行 `- DOMA` 是合法 YAML），错误被推迟到 mihomo 启动时才暴露。

### 2.3 tindy 侧可能产出裸 `DOMA` 的路径（证据 vs 推断）

| 路径 | 机制 | 是否能产出**裸** `DOMA` | 证据与置信度 |
|---|---|---|---|
| P1 base 配置原样透传 | `overwrite_original_rules=false` 时 `ruleconvert.cpp:201-205` 直接复制 base 的 `rules`，不校验、不补 group | **是**（实验 P1 复现） | 机制置信度 0.95；作为“用户现场原因”仅约 0.15（需要 base 自己就有 20,674 条规则或被截断）【取证：`doma-diagnosis.md:528-539`、`:792`】 |
| P2 `[]` 内联规则 | `[]DOMA` 只去掉 `[]` 再补 group，不校验类型（`ruleconvert.cpp:220-229`） | 产出 `DOMA,GROUP`，不是裸 `DOMA` | 机制置信度 0.99；若日志只截取了首段，现场可能是这个【取证：`doma-diagnosis.md:541-554`、`:793`】 |
| 输出被截断 | `rules:` 是最后一个顶层块；YAML 接受最后一行 `- DOMA`；文件在 `DOMA` 后结束 | **是**（最符合“裸 DOMA 且是最后一条”的解释） | 置信度约 0.55，属于**推断**；但工作区 `.private` 中确有截断痕迹，见下文【取证：`doma-diagnosis.md:495-526`、`:794`】 |
| 手工编辑 / 客户端 override 脚本 | 用户或脚本把最后一条规则改成 `DOMA` | 可能 | 无证据，置信度 <0.1【取证：`doma-diagnosis.md:556-560`】 |

已排除或基本排除的解释【取证：`doma-diagnosis.md:562-574`】：

- mihomo 把 `DOMA` 当合法别名（排除，置信度 0.99）；
- 流行规则集原本就含 `DOMA`（抽样 40 万+ 行，0 命中；只能说明抽样范围）；
- BOM、CRLF、大小写、行内注释、HTTP 错误页作为**直接**来源（均不能单独解释裸 `DOMA`）；
- 规则集下载在 `DOMA` 处截断后被原样输出（排除：前缀过滤器会丢弃 `DOMA`）。

**工作区内的现场材料（本次核对发现）**：`.private/user-subscription/failing-conversion.yaml` 是一份 196,099 B、4,097 行（4,096 个换行 + 末行无换行）的文件，顶层使用旧式 `Proxy:`（第 7 行）和 `Rule:`（第 556 行），最后一行是 `  - DOMAI`，在一个完整类型 `DOMAIN-SUFFIX` 的中间被切断。它看起来是一份旧式字段名的转换输出，表明至少有一次输出被截断，为“输出被截断”路径提供了旁证；但它是否就是原始报错文件**未证实**。

但它**不是**原始 `rules[20674] [DOMA]` 的精确现场：

- 它只有 4,097 行，远少于 20,675 条规则的场景；
- 它使用旧式 `Proxy:`/`Rule:` 字段名，而原始错误消息里的 20,674 下标要求 `rules:` 数组有 20,675 条；
- 它的末尾是 `DOMAI`，没有裸 `DOMA`；
- `mihomo -t` 对这份文件退出 0，但该文件用的是旧式 `Proxy:`/`Rule:`，而 mihomo 的配置字段是新式 `proxies`/`rules`；因此 `-t` 没有校验到这份规则段，**不能证明其内容有效**（本次实测：exit 0、stderr 0 字节）。

因此它只能证明“截断发生过”，不能唯一确定原始错误就来自这份文件。

**仍未证实的关键点**：工作区没有原始 20,675 条规则的 profile 文件、订阅 URL、subconverter 版本/配置和对应 HTTP 响应头，因此无法判定现场到底是 A（输出截断）、B（base 透传）还是 C（`[]DOMA` 且日志省略了 `,GROUP`）。`docs/research/doma-diagnosis.md:805-813` 明确列出了这些未验证项。**本文不把任何一个场景当成已发生的事实。**

### 2.4 本项目如何从结构上消除

| 层 | 机制 | 代码/规格 |
|---|---|---|
| 1 | 37 类型精确注册表，未知类型丢弃 + `E_RULE_UNKNOWN_TYPE` | `src/rules/registry.ts:90-140`；`docs/SPEC.md:425-473` |
| 2 | 类型感知拆分：普通类型、`MATCH`、payload 可含逗号类型、逻辑规则分别处理；规则集来源先把“最后一个像 target 的字段”剥离再重组 payload | `docs/SPEC.md:490-514`；`docs/PARITY.md:169-185` |
| 3 | 单字段/缺 target 预检**先于**类型判断，给出与 mihomo 一致的“缺 target”原因 | `src/rules/parse.ts:178-247` |
| 4 | target 存在性：必须是已生成组、已解析节点或 `DIRECT`/`REJECT`/`REJECT-DROP`/`PASS` | `docs/SPEC.md:516-527` |
| 5 | 尾部截断：typed 方言用“无最终换行 + 类型/前缀/逗号结尾”；domain 方言用声明计数/空白尾部启发式 | `src/rules/truncation.ts:96-...`；`docs/SPEC.md:594-613` |
| 6 | 输出：规则双引号、YAML 读回、每条规则 `parseRuleLine` 全量重校验、恰好一条末尾 `MATCH` | `src/emitter/config.ts:195-264`、`:362-...`；`docs/SPEC.md:615-627`、`:679-695` |
| 7 | 客户端校验：真实 mihomo `-t` 加载生成配置 | `docs/SPEC.md:1046`（AC-24）要求“发布必过”；但当前 `scripts/acceptance.ts:1285-1300` 的 mihomo 检查 `required=false`，失败时 acceptance 仍 exit 0（见 §5.2、§5.6） |
| 8 | 模板/base 规则默认丢弃（`overwrite_original_rules=true`），显式 `false` 时也必须逐条校验 | `docs/SPEC.md:651-653`；`docs/PARITY.md:169` |

关键点：**tindy 的所有直通路径在本项目中被删除**，包括 `RULESET_SURGE` 直接返回、`[]` 行内直通、base 规则原样复制（`docs/ARCHITECTURE.md:16`、`docs/PARITY.md:155-163`）。因此 `DOMA` 不是“被过滤掉”，而是**根本没有任何路径能把一个未知类型写进输出**。

### 2.5 验收证据（20k 规则场景）

见 §5.3 的逐项记录。核心结果：

```text
legal DOMAIN rules = 20674 / 20674
total rules        = 20677
last rule          = MATCH,PROXY
output DOMA        = 0 条
E_RULE_UNKNOWN_TYPE @line=20675 raw="DOMA,example.com"
E_RULE_NO_TARGET    @line=20676 raw="DOMA"
E_TRUNCATED_TAIL    @line=20676 raw="DOMA"
mihomo -t          = exit 0
```

【实测·验收：`docs/acceptance.md:41-68`】

### 2.6 残余边界：两处“DOMA 不会复发、但语义仍需注意”的地方

这两点是评审记录中的“unconfirmed”项，**不是** `format invalid` 的复发；本次撰写报告时实际复现了它们：

1. **纯域名列表里的单个 `DOMA`**。`/getruleset?type=6&src=inline:<base64("DOMA")>` 返回 HTTP 200、`payload: ["DOMAIN-SUFFIX,doma"]`、0 条 Warning。原因：按 SPEC §4.2，单 token 内容会被判定为 `domain` 方言；`doma` 在这里是**域名数据**，不是类型，输出的是结构合法的规则。它不会造成 mihomo `format invalid`，但会让“误写成 DOMA 的一行”被当成域名接受。【实测·本次；评审记录：`src/rules/dialects.ts:414-476`、`src/rules/truncation.ts:83-100`】
2. **`/getruleset` 不做尾部截断检测**。typed 源 `DOMAIN,a.com\nDOMAIN`（无最终换行）只报 `E_RULE_NO_TARGET`，不报 `E_TRUNCATED_TAIL`；输出仍是合法的 `DOMAIN,a.com`。`/sub` 的 `buildRules` 会调用 `checkTail`，`/getruleset` 的 `runGetRuleset` 没有调用（`src/services/ruleset.ts:42-100` vs `src/rules/validate.ts:129-145`）。这是**告警缺失**，不是非法输出。【实测·本次；评审记录】

### 2.7 仍未证实的事项

- 用户现场的 `DOMA` 到底来自输出截断、base 透传还是 `[]DOMA`，**未证实**；工作区 `.private` 的截断文件支持“截断发生过”，但不是 20,675 条 `rules:` 场景，仍需原始 profile 尾部字节和 HTTP `Content-Length` 对照（`docs/research/doma-diagnosis.md:576-606` 给出判定树）。
- “流行规则集不含 `DOMA`”是抽样结论，不是穷举（`docs/research/doma-diagnosis.md:800`）。
- 本项目无法验证生产链路上的中间代理/CDN 截断行为；它只能保证“自己生成的 YAML 完整、可读回、可被 mihomo 接受”。

---

## 3. 架构与目录

### 3.1 设计原则

来自 `docs/ARCHITECTURE.md:11-20` 与 `docs/SPEC.md:14-23`：

1. **行为优先、独立实现**：以取证文档为输入重新设计，不逐行翻译 tindy C++。
2. **单一规则边界**：远程规则集、模板规则、内联规则、INI 规则都必须经过同一个 `parse → validate → target resolve`；`emitter` 不接受未校验的规则字符串。
3. **失败隔离**：单个节点/规则/配置键失败只产生 Warning；只有“零节点、全部 source 失败、输出读回失败、内部异常”才让请求失败。
4. **不原样透传**：下游看不到未校验的远端文本。
5. **最小依赖**：生产依赖只有 `yaml@2.9.x`（`package.json:15-17`）。
6. **确定性**：同一输入 + 同一版本 + 同一配置 → 逐字节相同的 YAML；不写时间戳/随机数。
7. **纯核心可测试**：links/rules/emitter 不依赖 Worker API。

### 3.2 实际目录

> 注意：`docs/ARCHITECTURE.md:237-250` 规划的是 `src/integration/*` 与 `test/`；当前实现把这些职责落到了 `src/http/*` + `src/services/*` 和 `tests/`。职责划分不变，只是目录名不同。

```text
src/
  index.ts                  Worker 入口：fetch → handleRequest
  types.ts                  共享类型、Env、常量、内置目标
  http/
    routes.ts               路由、方法/CORS、帮助页、/sub 与 /getruleset 处理器
    params.ts               query 解析与校验（source、bool、limits、groups/ruleset）
    responses.ts            响应头、Cache-Control、错误体
  services/
    env.ts                  环境变量解析（启动一次，非法值 fail-fast）
    fetch.ts                SourceLoader：SSRF、重定向、超时、流式限长、HTML 检测
    pipeline.ts             runSub：/sub 与 /clash 的完整编排
    ruleset.ts              runGetRuleset：/getruleset 管线
    warnings.ts             WarningCollector
    errors.ts               AppError → HTTP 状态/错误码
  links/                    base64、text、IP、url-guard、YAML、输入检测、
                            URI 解析（ss/ssr/vmess/trojan/vless）、Clash 输入、
                            节点过滤/重命名/名称分配
  rules/                    registry（37 类型）、payload、split、parse、dialects、
                            truncation、providers、groups、ini、validate
  emitter/                  template、nodes、groups、rules、providers、
                            config（组装 + 读回）、serialize、default-template
tests/
  unit/                     links / rules / emitter
  integration/              路由、fetch service、内存上限
fixtures/e2e/               验收夹具（订阅、20k 规则、BOM/CRLF、HTML、INI）
scripts/acceptance.ts       本地验收脚本
docs/                       SPEC / ARCHITECTURE / PARITY / research / acceptance / 本报告
tools/mihomo/               验收用 mihomo 二进制与 source.json
```

### 3.3 请求流程

`/sub` 与 `/clash`：

```text
GET /sub?...
  → handleRequest（src/http/routes.ts:304）
      路由/方法/CORS 检查，识别 diagnostics=json
  → parseSubParams（src/http/params.ts:333）
      解析 url/target/config/template/ruleset/groups/布尔参数/limits
  → parseEnv（src/services/env.ts）
      数值、端口、缓存、PUBLIC_ORIGIN、测试白名单
  → runSub（src/services/pipeline.ts:252）
      1. 加载 config（INI，可选）
      2. 并发加载订阅 source（最多 4 并发；单 source 失败 → Warning）
      3. detect → 解析节点（Base64 / 纯文本 / Clash YAML）
      4. include/exclude/rename/sort、名称分配（组名优先占用）
      5. 解析组 spec → 展开成员
      6. 加载 template（query > config > 内置）；尾部检测 + YAML parse + sanitize
      7. 构建规则源 → buildRules（src/rules/validate.ts:81）
           extract（方言）→ checkTail → parse → payload/target 校验
           → providers 规划 → MATCH 策略 → MAX_RULES 截断
      8. emitClash（src/emitter/config.ts:272）
           sanitize template → proxies/groups/rules/providers
           → YAML 序列化 → YAML 读回 → 每条规则 parseRuleLine 重校验
  → 响应：text/yaml + X-Subconverter-* 头 + Cache-Control
```

`/getruleset`：

```text
GET /getruleset?type=3|4|6&src=... 或 &url=<base64url(source 字符串)>
  → parseRulesetParams（src/http/params.ts:495）
  → runGetRuleset（src/services/ruleset.ts:42）
      SourceLoader → detectDialect → extractRuleLines → parseRuleLines
      → buildRulesetDocument（type 3/4/6 的 payload 映射）
      → 源非空但全部行非法/被过滤 → 200 + 占位项 + X-Subconverter-Placeholder: 1
      → 源为空（inline: 后为空、空正文等）→ 400 invalid_source / 502 upstream_status
  → 响应：text/yaml，public cache（payload 只依赖 path+query）
```

### 3.4 规则管线（DOMA 防线的核心）

```text
source text
  → detectDialect        显式前缀 > payload:/rules: YAML > typed token > base64 > domain
  → extractRuleLines     方言 → 规则行（BOM/CRLF/注释/空行处理）
  → checkTail            无最终换行 + 类型/前缀/逗号结尾 → E_TRUNCATED_TAIL
  → parseRuleLine        精确类型 → 字段拆分 → payload 校验 → target 校验
  → buildRules           规则集 target 由 GROUP 提供；MATCH 唯一且末尾；
                         MAX_RULES=50,000 截断；providers 规划
  → emit + readback      每条规则重新 parseRuleLine；失败 → 500
```

### 3.5 错误与 Warning

- **非致命**：单条节点、单条规则、单个配置键、单个 source 失败 → Warning，请求继续（`docs/ARCHITECTURE.md:1093-1105`）。
- **致命**：参数非法、全部 source 失败、零节点、模板/配置不可解析、输出读回失败、内部异常 → `AppError` + HTTP 状态（`docs/SPEC.md:218-249`）。
- Warning 通过 `X-Subconverter-Warnings`、`X-Subconverter-Warn-Codes` 和 `diagnostics=json` 暴露；最多 200 条，超出聚合（`src/types.ts:63`、`docs/SPEC.md:214`）。
- 错误响应不泄漏堆栈、完整 URL、token；日志只允许错误码/阶段/host hash/行号/计数（`docs/SPEC.md:878-882`）。

### 3.6 资源限制（默认值）

| 限制 | 默认 | 来源 |
|---|---:|---|
| 总 deadline | 10,000 ms | `wrangler.toml:23` |
| 单跳超时 | 5,000 ms | `wrangler.toml:24` |
| 单 source 上游 | 8 MiB | `wrangler.toml:25` |
| 总上游 | 16 MiB | `wrangler.toml:26` |
| inline 解码后 | 8,192 B | `wrangler.toml:27` |
| inline/data source 字符串 | 12,000 字符（含 `inline:`/`data:` 前缀，是**编码后**的 source 字符串长度，不是解码后字符数） | `wrangler.toml:28`、`docs/SPEC.md:133`、`src/services/env.ts:185-192` |
| 节点数 | 10,000 | `wrangler.toml:29` |
| 规则数 | 50,000 | `wrangler.toml:30` |
| 组数 | 128 | `wrangler.toml:31` |
| 重定向 | 3 跳 | `wrangler.toml:32` |
| 输出 | 16 MiB | `docs/SPEC.md:850` |

---

## 4. 与 tindy subconverter 的兼容矩阵

> 完整矩阵见 `docs/PARITY.md`；本节给用户决策所需的最小集，并明确“不支持”而不是“看起来支持”。

### 4.1 总览

| 维度 | tindy v0.9.0 | 本项目 v1 | 判定 |
|---|---|---|---|
| 端点 | 11 个 API + 别名 + `/get`、`/getlocal` | 5 个 | 有意收窄 |
| target | 15 个 + `auto` | 仅 `clash` | 有意收窄 |
| 协议 | SS/SSR/VMess/Trojan/Snell/HTTP/SOCKS5/WireGuard/Hysteria/Hysteria2/AnyTLS（无 VLESS） | SS/SSR/VMess/Trojan/VLESS | 5 种；VLESS 新增 |
| 规则 | 13 前缀白名单 + 多条直通/静默丢弃 | 37 类型精确校验 + 丢弃 + Warning | 更严格 |
| Clash 输出 | 可切新旧字段名；rules 字符串拼接不加引号 | 永远新字段名；rules 强制双引号；读回校验 | 更安全 |
| ACL4SSR INI | 完整 `[custom]` + inja + 完整 DSL | 子集 | 部分兼容 |
| 下载 | 15 s 硬超时；关闭 TLS 校验；非 200 清空 | 10 s deadline；TLS 必须有效；错误可区分 | 有意改变 |

（`docs/PARITY.md:14-28`）

### 4.2 端点

| 端点 | 本项目 | 说明 |
|---|---|---|
| `/sub` | ✅ | 主转换端点，参数为 tindy 子集 |
| `/clash` | ✅ | 真实路由；正常输入下等价 `/sub?target=clash`。**例外**：显式传非 clash target 时，`/clash` 忽略该参数并返回 200 + `W_PARAM_IGNORED`，而 `/sub` 返回 400 `unsupported_target`（`src/http/params.ts:330-347`、`tests/integration/routes.test.ts:167-175`）。tindy 里它是 302 别名 |
| `/getruleset` | ✅（type 3/4/6） | 只服务 mihomo provider |
| `/version` | ✅ | 文本形态兼容，内容为 `subconverter-worker 1.0.0 target=clash` |
| `/` | ✅ | 帮助页；tindy 返回 404 |
| `/sub2clashr`、`/surge2clash`、`/getprofile`、`/render`、`/refreshrules`、`/readconf`、`/updateconf`、`/flushcache`、`/get`、`/getlocal`、`/surge`、`/ss`、`/v2ray` 等 | ❌ | 不存在；安全收窄或无本地 FS/无状态 |

（`docs/PARITY.md:32-47`）

### 4.3 target

- ✅ `clash`（唯一）。缺省 `target` 默认为 `clash`（比 tindy 宽松；tindy 必填）。
- ❌ 其它 target 在 `/sub` 上一律 400（`clashr`、`surge`、`surfboard`、`loon`、`quan`、`quanx`、`mellow`、`singbox`、`ss`、`ssr`、`v2ray`、`trojan`、`mixed`、`ssd`、`sssub`、`auto`、`clash-meta`）。
- ⚠️ `/clash?target=<非 clash>` 是例外：返回 200，忽略 target 并产生 `W_PARAM_IGNORED`；不要把它当作 `/sub` 的严格等价物（本次实测：`/clash?target=surge` → 200，`/sub?target=surge` → 400）。
- 特别说明：`clash-meta` 不是合法别名；避免“clash 与 clash-meta 同物”的伪兼容（`docs/PARITY.md:55-66`）。

### 4.4 输入与协议

| 输入/协议 | 本项目 |
|---|---|
| Base64 订阅 | ✅ 严格解码、UTF-8 fatal |
| 纯文本 URI 列表 | ✅ 显式检测，明文优先 |
| Clash YAML | ✅ 只读 `proxies`/`Proxy`；组/规则段忽略 + `W_CLASH_SECTION_IGNORED` |
| `inline:` / `data:text/plain;base64,` | ✅ |
| `\|` 多订阅 | ✅ 最多 8 个 |
| `tag:<label>,<source>` | ✅ |
| Surge/Loon/QuanX/SSD/SIP008/v2rayN/SSTap/Netch/SSAndroid | ❌ `unsupported_input_format` |
| 本地文件路径 | ❌ |
| `script:` / `nullnode` | ❌ |
| SS / SSR / VMess / Trojan / VLESS | ✅ |
| Snell / WireGuard / Hysteria v1 / Hysteria2 / AnyTLS / SOCKS5 / HTTP(S) / TUIC / SSD | ❌，节点丢弃并 `W_NODE_UNSUPPORTED_PROTOCOL` |

（`docs/PARITY.md:72-105`）

### 4.5 参数

**支持**：`url`、`target`、`config`、`ruleset`、`groups`、`template`、`rules_mode`/`expand`、`diagnostics`、`include`、`exclude`、`rename`、`sort`、`udp`、`tfo`、`scv`、`group`、`interval`、`append_info`、`filename`。

**已知但不支持**（忽略 + `W_PARAM_UNSUPPORTED`，不 400）：`new_name`、`ver`、`sort_script`、`script`、`list`、`insert`、`prepend`、`fdn`、`append_type`、`emoji`、`add_emoji`、`remove_emoji`、`dev_id`、`token`、`upload`、`upload_path`、`profile_data`、`filter_script`、`strict`、`surge`。

**语义差异（重要）**：

- `include`/`exclude` 非法正则 → 400 `invalid_regex`（tindy 逐条丢弃）。
- `rename` 用重复参数，每个 `pattern@replacement`（tindy 用反引号分隔多条）。
- `config` 存在时 query 的 `groups`/`ruleset` 被忽略并告警。
- `target` 缺省为 `clash`。
- 无值布尔（`?udp`）视为 `true`（tindy 视为未设置）。

（`docs/PARITY.md:109-137`、`docs/SPEC.md:96-122`）

### 4.6 规则

| 行为 | 本项目 |
|---|---|
| 类型匹配 | 注册表识别 37 个精确类型（大小写不敏感，先 `toUpperCase`）；其中 36 个可输出，`SUB-RULE` 识别但丢弃并告警 |
| 未知类型 | 丢弃 + `E_RULE_UNKNOWN_TYPE` |
| `FINAL` | 归一化为 `MATCH` + `W_RULE_TYPE_ALIAS` |
| 行内 `#` | 非正则 payload 截断 + `W_RULE_INLINE_COMMENT`；正则类型不截断 |
| 缺 target | 规则集由 GROUP 提供；模板/内联 → `E_RULE_NO_TARGET` |
| 多 `MATCH` | 只保留最后一个，其余 `W_RULE_DUPLICATE_MATCH` |
| `no-resolve` | 仅 IP 类允许；其它第 4 字段丢弃 + 告警 |
| 规则上限 | 50,000；超出在完整行边界截断 + `W_RULE_LIMIT` |
| 输出引号 | 强制双引号 |
| 读回 | 必须读回并逐条重校验 |
| `SUB-RULE` | 唯一明确不输出的类型（`W_RULE_SUB_RULE_UNSUPPORTED`） |
| `RULE-SET` | 仅 providers 模式；payload 必须是本次生成的 provider 名 |

（`docs/SPEC.md:425-547`、`docs/PARITY.md:189-203`）

### 4.7 `/getruleset`

| type | tindy | 本项目 |
|---|---|---|
| 1（Surge） | 前缀过滤、不校验 | ❌ 400 |
| 2（QuanX） | 需 group | ❌ 400 |
| 3（domain） | 空结果 `--placeholder--` | ✅ typed `DOMAIN`→裸域名、`DOMAIN-SUFFIX`→`+.domain`；其它丢弃；源非空但全被过滤 → `+.placeholder.invalid` |
| 4（ipcidr） | 空结果 `0.0.0.0/32` | ✅ 只接受可产出 CIDR 的来源：YAML `payload:` 数组或 typed `IP-CIDR`/`IP-CIDR6` 行；源非空但全被过滤 → `0.0.0.0/32` |
| 5（Surge DOMAIN-SET） | ✅ | ❌ 400 |
| 6（classical） | 整行透传 | ✅ 逐条校验，输出无 target 的 `TYPE,PAYLOAD[,no-resolve]`；源非空但全被过滤 → `DOMAIN,placeholder.invalid` |
| `url` 编码 | urlsafe-base64 | `url` 是 **base64url(source 字符串)**（例如 `base64url("https://...")` 或 `base64url("inline:...")`），不是规则内容；`src` 直接放明文 source；二者互斥（`src/http/params.ts:509-525`、`tests/integration/routes.test.ts:438-451`） |
| 多 URL | `\|` 拼接 | v1 只接受一个 source |
| 空结果 | 200 + 占位 | **仅当 source 非空**（内容为空行/纯注释/全部行非法/全部被类型过滤）时 200 + 占位 + `X-Subconverter-Placeholder: 1`；`src=inline:`（空）→ 400 `invalid_source`；空上游 → 502 `upstream_status`（`src/services/fetch.ts:95-99`、`:127-131`、`:180-185`、`src/http/params.ts:526-528`） |
| 非 200 上游 | 清空 → 空结果/400 | 502/504，不伪装成空集 |

**`/getruleset` 的输入形态很关键（本次实测）：**

- **type=3 + 纯域名列表**：`example.com\nads.example.com` 自动判定为 `domain` 方言，输出 `+.example.com`、`+.ads.example.com`（suffix）。若要得到裸 `example.com`，要用 YAML `payload: [example.com]` 或 typed `DOMAIN,example.com` 行。
- **type=4 + 纯 CIDR 列表**：`1.2.3.0/24\n2001:db8::/32` 会被自动判定为 `domain` 方言，返回 **200 但 payload 是 `0.0.0.0/32` 占位**（auto 时还会报 `E_RULE_BAD_DOMAIN` + `W_RULESET_EMPTY`）；即使加 `dialect=clash-ipcidr` 仍是占位，因为 `clash-ipcidr` 方言要求 YAML `payload:`（`src/rules/dialects.ts:878-899`，auto 回退 domain 在 `:488`）。可用的两种形态是：
  - `payload:\n  - 1.2.3.0/24\n  - 2001:db8::/32`；
  - `IP-CIDR,1.2.3.0/24` / `IP-CIDR6,2001:db8::/32` 行。
- **type=6**：plain domain list 输出 `DOMAIN-SUFFIX` 行（无 target）；typed 行按原类型输出。若要 `DOMAIN,` 行，请用 typed 或 YAML domain payload。

（`docs/PARITY.md:207-221`、`docs/SPEC.md:145-175`）

### 4.8 ACL4SSR INI 子集

**可用**：`custom_proxy_group`（`select`/`url-test`/`fallback`/`load-balance`，`[]组`、`!!TYPE`、`!!GROUP`、`!!SERVER`、`!!PORT`、普通正则）、`ruleset`/`surge_ruleset`（`GROUP,SOURCE`）、`clash_rule_base`（source 或 `base/all_base.tpl|.yml|.conf` 内置映射）、`rename`、`include_remarks`、`exclude_remarks`、`overwrite_original_rules`、`enable_rule_generator`。

**明确降级/不支持**：inja/`[template]` 变量、`emoji`/`add_emoji`/`remove_old_emoji`、`filter_script`/`sort_script`/`script:`、`relay`/`ssid`/`smart` 组、`!!PROVIDER`/`!!GROUPID`/`!!INSERT`、`!!import:`、多 URL `|`、`quanx:` 规则集、除 `base/all_base.*` 外的本地路径。注意：`clash_rule_base` 的**其它本地路径是 400 `invalid_template`**（不是告警忽略），只有 source/URL 和 `base/all_base.tpl|.yml|.conf` 可用（`src/services/pipeline.ts:417-438`、`docs/SPEC.md:642-645`）。

（`docs/PARITY.md:245-270`、`docs/SPEC.md:729-793`）

### 4.9 下载/安全行为

| 项 | tindy | 本项目 |
|---|---|---|
| 连接超时 | 15 s 硬编码 | 总 10 s / 单跳 5 s |
| TLS 校验 | 关闭 | 必须有效 |
| 非 200 | 清空内容 | 502 `upstream_status` |
| 大小超限 | 清空整段 | 413 `upstream_too_large` |
| 重定向 | 跟随 | `manual`，最多 3 跳，每跳 SSRF 复检 |
| 上游头 | 大量转发 | 只发固定 UA/Accept，不转发用户头 |
| SSRF | 无 | 协议/端口/IP 网段/主机名/重定向/平台 flag |
| 日志 | 可能记录 URL/配置 | 只记录 code/stage/host hash/行号/计数 |
| 本地文件/脚本/写配置 | 有 | 无 |

（`docs/PARITY.md:274-292`）

### 4.10 明确不支持项（用户视角清单）

如果你的用法依赖以下任意一项，本项目**不是 drop-in replacement**：

1. 非 `clash` 的 target（Surge、Sing-box、Loon、QuanX、V2Ray、SSD 等）。
2. Snell、WireGuard、Hysteria/Hysteria2、AnyTLS、SOCKS5、HTTP(S)、TUIC 节点。
3. Surge/Loon/QuanX/SSTap/Netch/SSD 等输入格式。
4. `/getprofile`、`/render`、`/updateconf`、`/readconf`、`/flushcache` 等管理端点。
5. inja 模板、`[template]` 变量、`script:`/`filter_script`/`sort_script`。
6. `emoji`、`add_emoji`、`append_type`、`new_name` 等名称装饰/字段切换参数。
7. `relay`、`ssid`、`smart` 组，`proxy-providers`/`!!PROVIDER`，`!!GROUPID`/`!!INSERT`。
8. `/getruleset` type 1/2/5。
9. 本地文件读取、任意 URL 代理、Gist 上传、鉴权 token。
10. ACL4SSR 完整配置（只支持 §4.8 的子集）。

### 4.11 从 tindy 迁移的建议

`docs/PARITY.md:396-406` 给出了完整步骤，最重要的六条：

1. `target` 固定 `clash`，删除其它 target 调用。
2. 订阅放 `url=`；多个用重复 `url` 或 `|`，最多 8 个。
3. tindy 的 base64 多行 `ruleset=` 改成重复的 `ruleset=GROUP,SOURCE`。
4. `custom_proxy_group` 里的 `relay`/`ssid`/`smart`/`!!PROVIDER`/`script:` 改成 select/url-test/fallback/load-balance + 正则/`[]`。
5. `expand=false` 改成 `rules_mode=providers`；配置 `PUBLIC_ORIGIN`，否则 providers 模式强制 private。
6. 依赖 base 规则时显式 `overwrite_original_rules=false`，并确保 base 规则能通过校验（`DOMA` 会被丢弃并告警）。

---

## 5. 验证记录

### 5.1 本次报告实际复跑的命令

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck`（即 `tsc --noEmit`） | 退出 0【实测·本次】 |
| 测试 | `npm test`（即 `vitest run`） | 27 个测试文件、542 个测试全部通过，退出 0【实测·本次】 |
| mihomo 客户端 | `./tools/mihomo/mihomo.exe -t -d tools/mihomo -f out/generated.yaml` | 退出 0；stderr 0 字节；stdout 末尾 `configuration file ... test is successful`【实测·本次】 |

> 说明：上表的 `npm run typecheck`、`npm test`、`mihomo -t out/generated.yaml` 是在本次报告工作期间（初版撰写时）执行的；本轮评审修订**没有重跑整套测试**，只额外执行了 `.private` 文件的 `mihomo -t` 和多组 `handleRequest` 探针（见 §4.7、§5.4、§7.3）。

`npm test` 的关键输出：

```text
Test Files  27 passed (27)
     Tests  542 passed (542)
  Duration  8.30s
```

其中与 DOMA 直接相关的用例：`tests/unit/rules/doma-regression.test.ts` 的 “intercepts the final DOMA, keeps 20,674 valid rules and reports exact warnings” 通过（420 ms）；`tests/unit/rules/fuzz.test.ts` 的“≥10,000 组合法/非法组合”通过（1,094 ms）。

### 5.2 工作流提供、本报告未复跑的检查

| 检查 | 命令 | 结果 |
|---|---|---|
| 回归 typecheck | `npm run typecheck` | 退出 0（工作流记录） |
| 回归 test | `npm test` | 退出 0（工作流记录） |
| 回归 build | `npm run build`（`wrangler deploy --dry-run --outdir=dist`） | 退出 0（工作流记录；本报告未复跑） |
| 本地验收 | `npm.cmd run acceptance`（`tsx scripts/acceptance.ts`） | 退出 0；28/28 通过【`docs/acceptance.md:3-8`】 |

> **验收边界**：`scripts/acceptance.ts` 在 Node 中**直接调用** Worker 入口 `handleRequest`，用构造的 `Request` 走完整路由和管线；超内联上限的夹具由本地 `127.0.0.1` fixture server 提供，使用 `ENVIRONMENT=test` + `ALLOW_TEST_UPSTREAM_HOSTS` 的测试白名单。它**没有**启动 wrangler/workerd，也**没有**部署到 Cloudflare（脚本头注释，`scripts/acceptance.ts:1-24`）。因此“验收通过”应理解为“本机进程内端到端 + 本地夹具”，不是“生产环境实测”。

> **覆盖范围**：28 项检查全部围绕 `/sub`（含 diagnostics JSON、20k 规则、BOM/CRLF、HTML、INI）和 `out/generated.yaml` 的 mihomo 检查；**没有**调用 `/getruleset`、`/clash`、`/version`、`/`，也没有 providers 模式（本次 stats `providers:0`）。`/getruleset` 的覆盖只在 `tests/integration/routes.test.ts:362-452` 等集成测试中。

> **mihomo 检查不是发布门禁**：脚本头注释明确写 “The mihomo download + `-t` check is best-effort … never fails the acceptance run itself”（`scripts/acceptance.ts:18-19`）；检查以 `required=false` 加入（`scripts/acceptance.ts:1285-1300`），`requiredFailure` 只统计 `required=true` 的检查（`scripts/acceptance.ts:143-146`）。因此 mihomo 下载/执行失败时 acceptance 仍 exit 0，结果可能是 27/28 或 `notCovered`；28/28 是本次记录，不等于“客户端校验已强制通过”。

### 5.3 20k 规则验收（AC-06）

夹具与请求：

- `fixtures/e2e/rules-big.txt`：526,435 B，20,676 行；前 20,674 行是合法 `DOMAIN,x<N>.example.com`；第 20,675 行 `DOMA,example.com`；第 20,676 行 `DOMA` 且无最终换行【`docs/acceptance.md:15`】。
- 主请求：`/sub?url=inline:<5 协议订阅>&ruleset=GROUP,http://127.0.0.1:8790/rules-big.txt`；大文件超过 inline 8,192 字节上限，必须走 fixture server（`docs/acceptance.md:20`）。

结果【实测·验收】：

| 项 | 结果 |
|---|---|
| HTTP | 200 `application/json; charset=utf-8`（diagnostics=json），`diagnostics=true`，耗时约 0.4 s |
| stats | `{"nodes":5,"groups":2,"rules":20677,"providers":0,"sources":1,"bytesIn":527978,"bytesOut":776547,"warnings":8,...}` |
| 合法规则 | 20,674 / 20,674 保留 |
| BOM 规则 | 保留 |
| CRLF 规则 | 保留 |
| 第一条 / 最后一条 | `DOMAIN,x0.example.com,PROXY` / `MATCH,PROXY` |
| 输出中的 DOMA | 0 条 |
| 警告行号 | `E_RULE_UNKNOWN_TYPE@line=20675`；`E_RULE_NO_TARGET@line=20676`；`E_TRUNCATED_TAIL@line=20676` |
| 项目解析器重校验 | 20,677 条全部通过 `parseRuleLine`（mode=template，knownTargets+knownProviders） |
| 独立白名单校验 | 20,677 条全部在独立维护的 37 类型白名单内；target 可解析；恰好一条末尾 MATCH |
| 确定性 | 两次相同 `/sub` 请求字节相同，sha256=`db79b6253e68069e17631779ed9fb8f210ff2a76d746b33989e0f4bbfc4fbb2a` |

本次报告另外计算了 `out/generated.yaml` 的 sha256，与验收记录的 `db79b625...` 一致【实测·本次】。对 `out/generated.yaml` 的规则类型统计：**20,675 条 `DOMAIN` + 1 条 `DOMAIN-SUFFIX` + 1 条 `MATCH`**，共 20,677 条（本次用 `grep`/`cut` 统计）；因此这次 mihomo `-t` 主要覆盖 DOMAIN 形态，不能证明其余 35 个输出类型都被客户端接受。

> 为什么两条 DOMA 的 code 不同：规则集来源的“两字段”行是合法的（target 由 `ruleset=GROUP,...` 的 GROUP 提供），所以 `DOMA,example.com` 走到类型判断后报 `E_RULE_UNKNOWN_TYPE`；裸 `DOMA` 是单字段行，先触发 `E_RULE_NO_TARGET`，同时被尾部检测记为 `E_TRUNCATED_TAIL`。

坏数据隔离与错误页隔离：

- 5 条好 URI + 1 条坏 `hysteria2://` → HTTP 200，8 条 Warning；坏链接为 `E_NODE_SCHEME_UNSUPPORTED@line=8`，其余节点完整【`docs/acceptance.md:48`】。
- HTML 错误页规则源 → `E_FETCH_HTML@line=- source=ruleset#3`，转换仍 200，不把 HTML 当规则【`docs/acceptance.md:49`】。

INI 场景：

- `fixtures/e2e/acl4ssr.ini`（644 B）：4 个 `custom_proxy_group`、3 个内联 ruleset、rename、`clash_rule_base`。
- `/sub` 返回 200；5 个节点（SS Node 被 rename）；组 `["PROXY","AUTO","Fallback","LB"]`；规则 4 条；`AUTO` 的 url-test 字段、`Fallback` 的 interval、`LB` 的 `!!TYPE=^SS$`、内置模板 `mixed-port=7890` 均验证；输出 YAML 读回通过【`docs/acceptance.md:59-68`】。

### 5.4 mihomo 客户端校验

- 版本：Mihomo Meta v1.19.33（windows amd64）。
- 来源：官方 release `https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33/mihomo-windows-amd64-v1.19.33.zip`；GitHub API 报告 asset 22,512,121 B；实际下载 22,512,121 B；本地 SHA-256 `6ab2180875f9f6fff8b19386d760daec257f66b45f72b3afc650634272fa837a`（`tools/mihomo/source.json`）。
- 命令：`tools/mihomo/mihomo.exe -t -d tools/mihomo -f out/generated.yaml`
- 结果：退出码 0；stderr 空（0 字节）；stdout 末尾：

```text
configuration file C:\Users\admin\Documents\ZCode Projects\订阅转换\out\generated.yaml test is successful
```

- 本报告复跑同一条命令，退出 0，`Initial configuration complete, total time: 16ms`，stderr 0 字节【实测·本次】。
- **证据范围**：只验证了 `out/generated.yaml`（20,675 DOMAIN + 1 DOMAIN-SUFFIX + 1 MATCH）；`out/generated-ini.yaml` 的 4 条规则没有跑 mihomo；providers 模式（`providers:0`）也没有 mihomo 校验。
- **`-t` 不是充分条件**：工作区 `.private/user-subscription/failing-conversion.yaml` 在 `DOMAI` 处截断，但 `mihomo -t` 仍退出 0；该文件使用旧式 `Proxy:`/`Rule:`，而 mihomo 配置字段是新式 `proxies`/`rules`，所以这次 `-t` 并未校验该规则段（本次实测）。因此 `-t` 通过只能说明“mihomo 能接受它认识的字段”，不能证明配置内容完整。
- **平台**：`tools/mihomo/mihomo.exe` 是 Windows amd64 二进制；macOS/Linux 用户需要从官方 release 下载对应平台二进制后运行 `mihomo -t -f out/generated.yaml`（未在本环境验证其他平台）。

**校验和缺口**：官方 v1.19.33 release 只发布 `version.txt`，没有 SHA-256 checksum 资产；本地 SHA-256 无法与官方值对照，只能记录在 `tools/mihomo/source.json` 中。这是 `docs/acceptance.md:96` 明确列出的“未覆盖”项。

### 5.5 确定性

- 验收检查 18：两次相同 `/sub` 调用输出逐字节一致，sha256 `db79b6253e68069e17631779ed9fb8f210ff2a76d746b33989e0f4bbfc4fbb2a`【实测·验收】。
- 本次报告对仓库中 `out/generated.yaml` 重新计算 sha256，得到相同值【实测·本次】。
- 设计约束：不写时间戳/随机数/不稳定 Map 顺序（`docs/ARCHITECTURE.md:18`、`docs/SPEC.md:715`）。

### 5.6 未覆盖 / 不能当成通过的事项

1. **没有真实 Cloudflare 部署**；生产 SSRF、egress、重定向、缓存行为未实测（`docs/PARITY.md:349-367`、`docs/ARCHITECTURE.md:1234-1247`）。
2. **没有用真实机场订阅/反爬/TLS 场景测试**。
3. **mihomo release 没有官方 checksum**，无法验证二进制来源完整性（`docs/acceptance.md:96`）。
4. **没有复现用户原始 `DOMA` 现场**：工作区 `.private/user-subscription/failing-conversion.yaml` 是截断旁证（末尾 `- DOMAI`、旧式 `Proxy:`/`Rule:`、4,097 行），但不是 20,675 条 `rules:` 场景；原始 profile/HTTP 头仍缺失（§2.3）。
5. **`npm run build` 未在本报告复跑**；结果来自工作流回归记录。
6. **`npm run acceptance` 未在本报告复跑**；结果来自 `docs/acceptance.md` 与工作流记录。
7. **文档与脚本不一致（不止 `test:mihomo`）**：`package.json:7-14` 只有 `dev`/`deploy`/`test`/`typecheck`/`build`/`acceptance`；而 `docs/SPEC.md:1025-1026`、`:1045`、`:1048`、`:1062-1071` 和 `docs/ARCHITECTURE.md:1154-1166`、`:1254-1259` 还要求 `test:unit`、`test:integration`、`test:e2e`、`test:mihomo`、`check:ownership`、`deploy:dry`。照文档的发布清单执行，`npm run check:ownership` 等会 Missing script。
8. **验收覆盖不等于全端点**：28 项检查只走 `/sub`（diagnostics JSON、20k 规则、BOM/CRLF、HTML、INI）和 `out/generated.yaml` 的 mihomo 检查；没有 `/getruleset`、`/clash`、`/version`、`/`，也没有 providers 模式；INI 的 4 条规则未跑 mihomo。
9. **“mihomo 检查”不是发布门禁**：`scripts/acceptance.ts:1285-1300` 以 `required=false` 加入，mihomo 失败时 acceptance 仍 exit 0（脚本头 `:18-19` 明说 best-effort）。
10. **干净机器/其他平台/Free 计划未验证**：本报告只复跑 `typecheck`、`test`、`mihomo -t` 和 `handleRequest` 探针；没有运行 `npm ci`、`npm run dev`、`npm run build`、`npm run acceptance`、`wrangler login/deploy`。Free 账户的具体部署/运行错误文案、macOS/Linux 的 mihomo 校验、代理网络下的 `npm ci` 都未验证。

---

## 6. 部署

### 6.1 前置条件

- Node.js **>= 24**（`package.json:25-27`；本次环境 Node v24.21.0）。
- 一个 Cloudflare 账户；**按 Workers Paid 设计**（`docs/SPEC.md:5`、`docs/ARCHITECTURE.md:41`）。Free 的 10 ms CPU 不足以处理大规则集；`limits.cpu_ms = 5000` 是 Paid 配置（`wrangler.toml:18-19`）。**Free 账户下部署/运行的具体错误文案未验证**，可能表现为部署拒绝或运行期 CPU 超限（具体错误码未确认）。
- 如需自定义域名：该域名已托管在 Cloudflare（同一账户的 zone）。
- 依赖：`wrangler@^4.158.0`（devDependency，`package.json:23`）；生产依赖只有 `yaml`。

### 6.2 安装与本地开发

```bash
cd "C:/Users/admin/Documents/ZCode Projects/订阅转换"
npm ci
npm run typecheck
npm test
npm run dev          # wrangler dev，本地 workerd
```

`npm run dev` 后默认监听本地端口（wrangler 会打印实际地址），可直接访问 `http://127.0.0.1:<port>/version`。

测试与构建：

```bash
npm test             # vitest run：unit + integration
npm run build        # wrangler deploy --dry-run --outdir=dist（不登录、不部署）
npm run acceptance   # 本地验收；生成 out/generated*.yaml 与 docs/acceptance.md
```

> `npm run acceptance` 会重写 `docs/acceptance.md` 与 `out/` 下的产物；如果不想改文档，不要在生产分支随手运行。

mihomo 客户端校验（可选但推荐）：

```bash
tools/mihomo/mihomo.exe -t -d tools/mihomo -f out/generated.yaml
```

`npm run acceptance` 会顺带尝试一次 `out/generated.yaml` 的 `mihomo -t`，但该检查是 **best-effort**：失败不会让 acceptance 失败（`scripts/acceptance.ts:18-19`、`:1285-1300` 的 `required=false`）。因此它不是发布门禁；发布前应自己显式跑上面的命令并断言退出 0。

> 注意 1：`docs/SPEC.md` 与 `docs/ARCHITECTURE.md` 中提到的 `npm run test:mihomo`、`test:e2e`、`check:ownership`、`test:unit`、`test:integration` 在当前 `package.json` 中**都没有定义**（`package.json:7-14` 只有 `dev`/`deploy`/`test`/`typecheck`/`build`/`acceptance`）。按 SPEC/ARCHITECTURE 的发布清单执行会在 `check:ownership` 等步骤 Missing script。
>
> 注意 2：`tools/mihomo/mihomo.exe` 是 Windows amd64 二进制；macOS/Linux 请从 mihomo 官方 release 下载对应平台二进制，运行 `mihomo -t -f out/generated.yaml`。其他平台未在本环境验证。
>
> 注意 3：本报告未运行 `npm ci`、`npm run dev`、`npm run build`、`npm run acceptance`、`wrangler login/deploy`；这些步骤在干净机器/代理网络/Free 账户下的可执行性未验证。

### 6.3 登录与部署

```bash
npx wrangler login
npx wrangler whoami          # 确认账户
npx wrangler deploy          # 或 npm run deploy
```

- `wrangler.toml` 已设置 `name = "subconverter-worker"`、`main = "src/index.ts"`、`compatibility_date = "2026-11-09"`、`compatibility_flags = ["global_fetch_strictly_public"]`（`wrangler.toml:5-8`）。
- `workers_dev = true`，部署后会得到 `https://subconverter-worker.<你的子域>.workers.dev`（`wrangler.toml:9`）。
- 不需要创建 KV/D1/R2/DO；`wrangler.toml` 没有任何 binding，v1 是无状态的（`docs/SPEC.md:876`）。

### 6.4 自定义域名

两种方式，任选其一：

1. **Dashboard（推荐，最少改配置）**：Cloudflare Dashboard → Workers & Pages → 选择 `subconverter-worker` → Settings → Domains & Routes → Add → Custom Domain → 输入例如 `sub.example.com`。
2. **写进 `wrangler.toml`**（Wrangler 4.x 支持 Workers Custom Domain）：

```toml
routes = [
  { pattern = "sub.example.com", custom_domain = true }
]
```

注意：

- 自定义域名后，若使用 `rules_mode=providers`，**必须**把 `PUBLIC_ORIGIN` 设为该 canonical origin（例如 `https://sub.example.com`），否则 provider URL 会跟随请求 origin，且 providers 模式响应被强制 `private, no-store`（`docs/SPEC.md:555-558`、`docs/SPEC.md:867-873`）。
- **设置 `PUBLIC_ORIGIN` 的两种方式（可照抄）**：
  1. `wrangler.toml` 的 `[vars]` 中把 `PUBLIC_ORIGIN = ""` 改成 `PUBLIC_ORIGIN = "https://sub.example.com"`，然后重新 `npx wrangler deploy`（当前该变量在 `wrangler.toml:38`）。
  2. Dashboard → Workers & Pages → `subconverter-worker` → Settings → Variables and Secrets → 添加/编辑 `PUBLIC_ORIGIN`（类型 Text）→ Save and Deploy。
- 如果 Worker 放在 Cloudflare Access 后面，mihomo 拉取 `/getruleset` 会失败；需要把 `/getruleset` 排除在 Access 之外，或不用 providers 模式（`docs/ARCHITECTURE.md:1245`）。可照做的做法：Zero Trust → Access → Applications，为 `/getruleset` 单独建一个应用并配置 Bypass 策略（或只把 `/sub` 纳入 Access 应用），然后从公网用 mihomo 验证 provider 能拉到。**该 Access 配置未在本环境验证。**

### 6.5 关键环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PUBLIC_ORIGIN` | 空 | providers 模式的 canonical origin；必须是绝对 `https://host[:port]`，无 path/query |
| `PUBLIC_SUBSCRIPTION_CACHE` | `false` | 是否允许 `/sub` 公开缓存；订阅 URL 常含 token，默认关闭 |
| `RULESET_CACHE_TTL` | `300` | `/getruleset` 的 public cache TTL |
| `ALLOW_HTTP_UPSTREAM` | `false` | 是否允许 http:// 上游；默认只允许 https |
| `UPSTREAM_ALLOWED_PORTS` | `80,443` | 允许的上游端口/范围 |
| `MAX_RULES` | `50000` | 规则上限 |
| `MAX_NODES` | `10000` | 节点上限 |
| `MAX_GROUPS` | `128` | 组上限 |
| `MAX_INLINE_BYTES` | `8192` | inline 解码字节上限 |
| `ENVIRONMENT` | `production` | 生产必须保持 `production` |
| `ALLOW_TEST_UPSTREAM_HOSTS` | 空 | 仅 `ENVIRONMENT=test` 生效；生产必须为空 |

完整表见 `docs/ARCHITECTURE.md:84-110` 与 `wrangler.toml:21-40`。所有值在 Workers 中都是字符串。

### 6.6 KV（可选，v1 不需要）

- v1 **不使用 KV/D1/R2**；`wrangler.toml` 中没有 `[[kv_namespaces]]`，代码里也没有 KV 读取（`docs/SPEC.md:876`）。
- 因此部署时**不需要**执行 `wrangler kv namespace create`，也不需要把 namespace id 写进配置。
- 如果你未来要加上游响应缓存、短链或统计，才需要新增 KV binding 并改代码；这属于扩展，不是当前部署步骤。
- 订阅响应默认 `private, no-store`；`/getruleset` 是 public cache，因为它只依赖 path+query（`docs/SPEC.md:857-876`）。

### 6.7 上线后冒烟检查

```bash
BASE=https://sub.example.com   # 或 https://subconverter-worker.<subdomain>.workers.dev

curl -i "$BASE/version"
# 200 text/plain; subconverter-worker 1.0.0 target=clash

curl -sS "$BASE/sub?url=inline:c3M6Ly9ZV1Z6TFRJMU5pMW5ZMjA2Y0dGemN3QDEuMi4zLjQ6ODM4OCNub2RlMQ" | head
# 200 text/yaml；proxies/proxy-groups/rules

curl -i "$BASE/sub?url=http://127.0.0.1/"
# 400 blocked_upstream（SSRF 防护）

curl -i "$BASE/getruleset?type=3&src=inline:ZXhhbXBsZS5jb20KYWRzLmV4YW1wbGUuY29tCg"
# 200 text/yaml；payload: ["+.example.com","+.ads.example.com"]
```

【实测·本次：上述 `/sub` 与 `/getruleset` 示例在本机通过 `handleRequest` 验证；`url=http://127.0.0.1/` 和 `url=https://127.0.0.1/` 均返回 400 `blocked_upstream`（message 分别为 `http upstreams are disabled` 和 `IP literal is not globally routable`）；`/version` 未单独复跑，行为来自 `src/http/routes.ts` 与 `docs/SPEC.md:803-823`】

再用真实 mihomo 加载一次输出：

```bash
curl -sS "$BASE/sub?url=<订阅>" -o /tmp/generated.yaml
mihomo -t -f /tmp/generated.yaml
```

### 6.8 安全加固（公开部署必读）

- v1 **没有鉴权、速率限制、KV 短链**（`docs/SPEC.md:884-887`）。公开部署前配置 Cloudflare WAF/速率限制，或使用 Cloudflare Access/自建网关。
- 不要把 `PUBLIC_SUBSCRIPTION_CACHE` 设为 `true`，除非你接受“订阅 URL 即凭据”被 CDN 缓存（`docs/SPEC.md:867`）。
- `/getruleset` 的 cache key 包含完整上游 URL（通常含 token）；`wrangler.toml` 的 observability 默认 `head_sampling_rate = 1`。如果上游 URL 含敏感 token，建议评估是否关闭/降采样 observability，或避免在 `/getruleset` 的 `src` 中直接放含 token 的 URL（评审发现，见 §7.2）。
- 生产环境保持 `ENVIRONMENT=production`、`ALLOW_TEST_UPSTREAM_HOSTS=""`、`ALLOW_HTTP_UPSTREAM=false`。

---

## 7. 已知限制与后续路线

### 7.1 产品范围限制（有意为之）

来自 `docs/PARITY.md:371-393` 的 Gap Register，用户最可能感知的：

| ID | 限制 | 影响 |
|---|---|---|
| G-01 | 只支持 `target=clash` | 非 mihomo 用户不能迁移 |
| G-02 | 只支持 5 种协议 | Snell/WireGuard/Hysteria2/TUIC 节点丢失 |
| G-03/G-04 | 无 inja 模板、无 script | 依赖模板变量/脚本的 ACL4SSR 配置降级 |
| G-05 | 无 proxy-providers/relay/ssid/smart | 高级组配置丢失 |
| G-06 | 无 emoji/append_type | 输出名称与 tindy 示例不同 |
| G-07 | 无 `/getprofile`、`/render`、配置写端点 | 管理型工作流不可用 |
| G-08 | 无 DNS 解析级 SSRF | 解析到私网的域名依赖平台兜底 |
| G-09 | 无鉴权/限速/KV 短链 | 公开部署需外部防护 |
| G-10 | ACL4SSR 仅子集 | 复杂配置需手工改 |
| G-13 | `DOMAIN-REGEX` 正则引擎差异 | 少数正则在客户端可能失败（`W_REGEX_ENGINE_DIFF`） |
| G-16 | inline 仅 8,192 字节 / 12,000 字符 | 20k+ 规则必须走远程 URL |
| G-17 | providers 模式需 `PUBLIC_ORIGIN` | 未配置时强制 private |

### 7.2 评审发现的未决项（status=unconfirmed）

以下为方案评审/探针记录中的发现。它们**未在本轮 28 项验收中覆盖**，且记录状态为 `unconfirmed`；列在这里是为了不让“验收通过”掩盖已知风险。

| # | 位置 | 发现 | 严重度 |
|---|---|---|---:|
| 1 | `src/http/responses.ts:36-37`；`src/http/params.ts:509-525`；`src/emitter/providers.ts:87-90`；`wrangler.toml:11-13` | `/getruleset` 的公开缓存键含完整上游 URL（通常含 token），providers 模式又把该 URL 嵌进 `rule-providers[].url`；缓存元数据、平台请求日志或转发配置会长期保存凭据。`/sub` 默认 `private, no-store` 是正确的。 | low |
| 2 | `src/links/url-guard.ts:137-148`；`src/links/ip.ts:221-235` | IPv4-compatible IPv6 字面量（`[::127.0.0.1]`、`[::ffff:0:127.0.0.1]`）返回 ALLOW，与“私网/回环 fail-closed”的声明不一致；拒绝表只有 `::/128`、`::1/128`。 | low |
| 3 | `src/rules/groups.ts:247-251`；`src/emitter/groups.ts:137-146`；`src/services/errors.ts:78-81` | config/groups 的组名未过滤控制字符，最终由 emitter 抛 `E_EMIT_INVALID` 并映射为 500 `internal_error`，而不是 400 或“丢弃该组 + 告警”。 | low |
| 4 | `src/rules/dialects.ts:84-114`；`src/services/fetch.ts:230-275` | base64 解码用 `number[]` 逐字节收集，4 MiB 源可放大到数十 MB；上游预算只按编码后字节计，未计解码/解析放大。未单独做 OOM 复现，属于已确认路径的内存放大器。 | low |
| 5 | `wrangler.toml:9`；`src/http/routes.ts:304-350`；`docs/SPEC.md:884-887` | `workers_dev=true` 且所有端点无鉴权、无限速；公开部署可被批量调用，放大 CPU/OOM 成本。 | low |
| 6 | `src/services/ruleset.ts:42-100` | `/getruleset` 不调用 `checkTail`，截断的 typed 规则源不会报 `E_TRUNCATED_TAIL`（本次已复现：只报 `E_RULE_NO_TARGET`）。 | low |
| 7 | `src/rules/dialects.ts:414-476`；`src/rules/truncation.ts:83-100` | 单个裸 `DOMA` 被自动检测为 domain 列表，输出 `DOMAIN-SUFFIX,doma` 且无 Warning；不是 `format invalid`，但该 DOMA 路径未被拦截（本次已复现）。 | low |
| 8 | `src/rules/registry.ts:136-138`；`src/rules/parse.ts:160-171` | `AND`/`OR`/`NOT` 被标记为 comment-sensitive，target 后的行内 `#`/`//` 会让合法逻辑规则的目标变成 `PROXY # comment`，导致 target 查找失败；SPEC §4.4 只豁免正则类型。 | low |
| 9 | `src/services/fetch.ts:95-99,152-155,169-189`；`src/services/ruleset.ts:50-59` | `/getruleset` 的空/纯空白本地 source 返回 400/502，而不是文档规定的 200 + 占位项；只有 source 字符串非空但无合法规则（如纯注释）时才得到占位。 | low |
| 10 | `src/http/params.ts:378-412,460-467`；`src/rules/groups.ts:311-324` | tindy 的多值编码未复刻：groups 只按换行拆分（tindy 还按 `@` 拆），include/exclude 不按反引号拆；PARITY 未记录这些差异。 | low |
| 11 | `src/rules/groups.ts:102-124` | `!!PORT=a-`（0 到 a 的范围）被当前组解析器拒绝，尽管 SPEC §8.3 列出了 `a-`；`100+`/`100-200` 正常。 | low |

> 评审输入在第 13 条（`src/emitter/config.ts:489-909`；`tests/unit/emitter/golden...`）处被截断，**本报告无法读取该条完整内容**，因此没有把它写成结论。需要完整评审文本后才能补充。

### 7.3 本轮评审后修正的文档口径

本轮评审指出了原报告/README 中若干“过度概括”或与实现不一致的说法；已在本版修正：

1. **`/getruleset` 空 source vs 空结果**：原 README/REPORT 把“空结果 200 + 占位”写成 blanket 规则；实际 `src=inline:`（空）→ 400 `invalid_source`，空上游 → 502，只有**源非空但全部行非法/被过滤**才 200 + 占位（本次实测；`src/services/fetch.ts:95-99`、`:127-131`、`:180-185`、`src/http/params.ts:526-528`）。
2. **`/clash` 与 `/sub` 的 target 行为不同**：`/clash?target=surge` → 200 + `W_PARAM_IGNORED`；`/sub?target=surge` → 400（本次实测；`src/http/params.ts:330-347`、`tests/integration/routes.test.ts:167-175`）。原文“等价”只在合法 clash 输入下成立。
3. **37 是识别数、36 是输出数**：`SUB-RULE` 在注册表中识别但 `emit:false`，会丢弃并告警（`src/rules/registry.ts:131-134`、`docs/SPEC.md:462-473`）。
4. **`url=` 的编码对象**：`url` 是 **base64url(source 字符串)**，不是规则内容；编码内容会 400（本次实测；`tests/integration/routes.test.ts:438-451`）。
5. **`/getruleset` 输入形态陷阱**：type=4 的纯文本 CIDR 列表会回退 domain 方言并返回占位（即使 `dialect=clash-ipcidr`）；type=3 纯域名列表输出 `+.domain`（suffix）。原文“仅 CIDR”“DOMAIN→裸域名”没有说明输入形态，已在本版 §4.7/README 补齐。
6. **acceptance 的 mihomo 检查不是门禁**：脚本明说 best-effort，检查 `required=false`（`scripts/acceptance.ts:18-19`、`:1285-1300`）。
7. **缺失的 npm scripts 不止 `test:mihomo`**：`check:ownership`、`test:unit`、`test:integration`、`test:e2e` 也不存在（`package.json:7-14`）。
8. **`.private` 现场材料**：`failing-conversion.yaml` 是截断旁证，但不是 20,675 条 `rules:` 场景（§2.3）。
9. **YAML 头注释的 warnings 口径**：`out/generated.yaml` 第一行是 `warnings=0`，同次 stats 是 `warnings: 8`；emitter 头注释只统计 emitter 阶段 warnings（`src/emitter/config.ts:276`、`:344-346`），stats 统计全管线 collector。**不影响配置有效性或 `mihomo -t`**；以 `X-Subconverter-Warnings` / `diagnostics=json.stats.warnings` 为准。

### 7.4 后续路线（建议优先级）

**P0（上线前）**

1. 在真实 Cloudflare 账户做 staging 部署；用 canary URL 验证生产 SSRF/egress、重定向逐跳、平台 flag 行为。
2. 配置 WAF/速率限制/Access；决定是否关闭或降采样 observability。
3. 若用 providers 模式，固定 `PUBLIC_ORIGIN` 并验证 `/getruleset` 对 mihomo 可达。

**P1（正确性/安全补强）**

1. `/getruleset` 接入 `checkTail`，补齐 `E_TRUNCATED_TAIL`（评审 #6）。
2. 对“单个 `DOMA` 被当域名”给出 `W_TRUNCATED_TAIL_SUSPECT` 或显式提示（评审 #7）。
3. 组名控制字符改为 400/丢弃 + Warning，避免 500（评审 #3）。
4. IPv4-compatible IPv6 字面量加入拒绝表（评审 #2）。
5. base64 解码改为预分配 `Uint8Array`，避免 `number[]` 放大（评审 #4）。
6. 统一 `/getruleset` 空 source 的契约：当前实现空 `inline:` 返回 400、空上游返回 502，而 `docs/SPEC.md:169-173` 写的是“源为空 → 200 + 占位”；需要决定改代码还是改文档（评审 #9）。
7. 为 `/getruleset` 的 type=3/type=4 输入形态补文档或在 `detectDialect` 层做更直观的 CIDR/domain 识别，避免“纯 CIDR 列表返回占位”的意外（本次实测）。

**P2（能力扩展，按用户需求）**

1. 新增协议（Hysteria2、WireGuard、Snell 等）按 `docs/ARCHITECTURE.md:1192-1199` 的扩展点实施。
2. 受限的模板变量替换（不做 inja）。
3. proxy-providers、更多组类型。
4. 可选的 KV 缓存/短链（需要改代码与配置，不属于 v1）。
5. `/getruleset` type 1/5（如果确实有 Surge 用户需求）。

---

## 8. 附录

### 8.1 证据索引

| 主题 | 文档/代码 |
|---|---|
| HTTP API、参数、错误码 | `docs/SPEC.md:46-249` |
| 输入检测、协议映射 | `docs/SPEC.md:253-364` |
| 规则注册表、拆分、target | `docs/SPEC.md:423-579` |
| 截断、错误页、读回 | `docs/SPEC.md:582-628` |
| 输出规格、YAML 序列化 | `docs/SPEC.md:631-726` |
| ACL4SSR INI 子集 | `docs/SPEC.md:729-793` |
| 安全与资源限制 | `docs/SPEC.md:797-887` |
| 验收标准 AC-01..AC-34 | `docs/SPEC.md:1017-1057` |
| 架构原则、模块、编排 | `docs/ARCHITECTURE.md:11-163`、`:1070-1105` |
| 部署清单 | `docs/ARCHITECTURE.md:1251-1267` |
| 兼容矩阵/Gap Register | `docs/PARITY.md:12-414` |
| tindy 行为取证 | `docs/research/original-subconverter.md` |
| DOMA 取证与置信度 | `docs/research/doma-diagnosis.md:475-813` |
| Cloudflare 平台约束 | `docs/research/cloudflare-workers.md:27-119`、`:441-503` |
| 参考实现审计 | `docs/research/reference-audit.md` |
| 验收实测 | `docs/acceptance.md` |
| 工作区现场材料 | `.private/user-subscription/failing-conversion.yaml`（截断旁证，不是 20,675 条 `rules:` 场景；详见 §2.3） |

### 8.2 术语

- **target**：输出格式；本项目只有 `clash`（mihomo 方言）。
- **ruleset**：规则来源；`ruleset=GROUP,SOURCE`，GROUP 为该来源规则的默认目标组。
- **provider**：mihomo 的 `rule-providers`；本项目的 provider URL 指向自己的 `/getruleset`，内容仍会重新校验。
- **fail-closed**：不确定/非法时拒绝或丢弃，而不是放行。
- **Warning 与 Error**：本项目把“单条数据失败”记为 Warning，请求仍 200；“请求级失败”才是 4xx/5xx。

## 9. 补充（2026-11-10）：真实订阅验收

> 本节在报告定稿后追加，用于修正 §3/§5 中“用户的实际订阅与规则集未提供”的旧口径。完整记录见 [`docs/REAL-SUBSCRIPTION-ACCEPTANCE.md`](REAL-SUBSCRIPTION-ACCEPTANCE.md)。

- 用户真实订阅的本地副本：46 个节点（`ss` 34、`vmess` 12）、128 个组、9,816 条规则；原始文件无 `DOMA`。
- **仅订阅**：`/sub` 200、63 ms、46 节点、`mihomo -t` 退出 0。
- **订阅 + ACL4SSR Full_AdblockPlus（本地 35 个 ruleset，30s deadline）**：200、1.3 s、50,001 条规则（`MAX_RULES=50000` 上限）、46 节点/33 组；0 条 `DOMA`、0 条非法类型；0 基第 **20,674** 条 = `DOMAIN-SUFFIX,katldpsrjggef.space,🆎 AdBlock`；`mihomo -t` 退出 0。
- **索引对应**：前 4 个 ruleset 共 1,672 条；`20,674 − 1,672 = 19,002`；`BanEasyList.list` 第 19,002 条是 `DOMAIN-SUFFIX,...`，前 4 个字符就是 `DOMA`。旧转换器/链路在该字节处截断即产出第 20,674 条裸 `DOMA`；我们抓到的失败输出末行是 `- DOMAI`，与截断模式一致。新 Worker 用 `E_TRUNCATED_TAIL` + 逐行校验拦截，不会输出该行。
- **默认 10s deadline 不够**：远程 ruleset + ACL4SSR 全模板在 10s 内只完成约 635 条规则（HTTP 200 但内容严重不完整）。`wrangler.toml` 已改为 `REQUEST_DEADLINE_MS=30000`、`UPSTREAM_TIMEOUT_MS=20000`、`PER_HOP_TIMEOUT_MS=10000`。远程拉取仍有 `E_FETCH_TIMEOUT` 波动（30s 下 50,001 / 13,860 两条记录），依赖缓存或 providers 提升稳定性。
- **high 级残余风险**：40k 节点 Clash YAML 与 200 万行 ruleset 的两条 OOM 已在修复阶段加上预算并写入 `tests/integration/limits.test.ts`（128 MB 子进程回归，542 个测试全部通过）；仍未修复的是 `(a|aa)+$` ReDoS、IP-SUFFIX 裸整数/掩码语义、IN-TYPE/IP-ASN 语义、解析层与读回层接受集不一致。逐条位置与影响见 [`docs/REAL-SUBSCRIPTION-ACCEPTANCE.md`](REAL-SUBSCRIPTION-ACCEPTANCE.md) §5；公开部署前必须加以限制或修复。
