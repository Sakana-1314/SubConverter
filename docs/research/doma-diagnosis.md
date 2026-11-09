# `rules[20674] [DOMA] error: format invalid` 取证与修复报告

> 结论先行：**`[DOMA]` 是 mihomo 打印的“原始规则行”，不是它解析出的规则类型。**  
> 这条错误只在 `target == ""` 时打印，也就是这条规则**没有第三个逗号字段（没有目标/策略组）**。  
> 对字面量 `DOMA`（只有一个字段）而言，tindy2013/subconverter 的**正常规则集展开路径不会产出它**（类型前缀过滤会直接丢弃），因此最可能是**生成后的配置在末尾被截断**（`rules:` 恰好是最后一个块，YAML 允许最后一行只写 `- DOMA`），其次是 **base 配置原样透传**。如果实际原始行是 `DOMA,GROUP`（报告里只写了首段），则对应 `[]DOMA` 这类内联规则。
>
> 本文把“直接原因（已证实）”“生成端可复现的非法类型路径（已实验）”“用户现场最可能的来源（推断）”严格分开，末尾给出置信度与未决项。

---

## 0. 取证环境与可复现性

### 0.1 仓库与提交

| 项目 | 使用的版本/提交 | 说明 |
| --- | --- | --- |
| mihomo（Go 内核） | `Alpha@478af2a57c48bdb8e85f6ed93b2c3735e90ceabd`（2026-11-06，`fix: auto route rules for tun`） | 规则解析、错误文本、provider 行为均以此为准 |
| mihomo 文档 | `MetaCubeX/Meta-Docs@2a6ba6b04a9eecdbe5c88c4e4a09776659c0878b`，页面 <https://wiki.metacubex.one/config/rules/> | 规则类型清单与示例 |
| tindy2013/subconverter | `v0.9.0` 源码 tag，以及官方 `subconverter_win64.7z` 发行版 | 源码行号与发行版二进制行为均已核对；本文引用的关键段落在 v0.9.0 与当前 master 一致 |
| Clash Party（客户端） | `mihomo-party-org/clash-party@364578f21007cdea0a5b4304acebfa7cf5655b1f` | 只用于核对“订阅如何落盘/如何启动内核”，不把客户端当作规则解析权威 |
| 抽样规则集 | ACL4SSR `bdc102fc…`、blackmatrix7 `0b6897dc…`、Loyalsoldier `release@9590a9fb…`、v2fly/domain-list-community `e8d7a10a…` | 具体 URL 见 §3 |

> **一个必须说明的仓库异常**：在本次取证环境的 GitHub 上，`MetaCubeX/mihomo` 的**默认分支 `main`** 返回的是一个同名的 Python Pydantic 模型仓库（`README.md`、`pyproject.toml`、`mihomo/`），并不是 Go 内核。Go 源码在 **`Alpha` 分支**。我用 `git clone --depth 1 --branch Alpha` 取得源码，`git log -1` 为上述提交。因此本文所有 mihomo 链接都钉在该提交上，避免 `main` 分支漂移。  
> 复现命令与 API 证据见 §8.1/§8.2。

### 0.2 运行环境

- Windows 10（win32 10.0.26100），Git Bash。
- Go `go1.27.2 windows/amd64`；用真实 mihomo 源码包运行了 `go test`（不是重写逻辑）。
- Python `3.15.0`；扫描脚本只做字节/行/token 统计。
- subconverter 官方 `v0.9.0` Windows 64 位发行版：  
  `subconverter_win64.7z` SHA-256 `e97d100b2e1cdd1daba863307ad05a6d7f785783d17a3c2df897bcefabaf5d4d`，  
  `subconverter.exe` SHA-256 `959dfe30e91f30ba06a491f21033202ba9ec5b8d4141918ab8d0f8891a043ee5`。
- 本地起了一个回环 HTTP 服务（`127.0.0.1:8010`）提供测试订阅/规则集；subconverter 监听 `127.0.0.1:25500`。所有测试文件都在临时目录，未写入本仓库。

### 0.3 证据等级

- **【证实】**：本次直接读到源码/文档，或直接运行程序/测试得到输出。
- **【推断】**：由已证实事实推出，但没有用户现场文件/链路抓包。
- **【未验证】**：本次无法验证，明确标注，不当作结论。

---

## 1. mihomo 侧：类型全集、解析流程、错误条件

### 1.1 真实规则类型全集

mihomo 的权威类型清单是 `rules/parser.go` 的 `switch tp`，不是文档示例的“全集”，也不是 subconverter 的列表。当前 Alpha 提交共有 **37 个类型名**（`IP-CIDR` 与 `IP-CIDR6` 共用同一个 case）：

| # | 类型 | `rules/parser.go` 行 | 备注 |
| --- | --- | --- | --- |
| 1 | `DOMAIN` | 18 | 完整域名 |
| 2 | `DOMAIN-SUFFIX` | 20 | 域名后缀 |
| 3 | `DOMAIN-KEYWORD` | 22 | 域名关键字 |
| 4 | `DOMAIN-REGEX` | 24 | payload 允许包含逗号（特殊解析） |
| 5 | `DOMAIN-WILDCARD` | 26 | `*`/`?` |
| 6 | `GEOSITE` | 28 | |
| 7 | `GEOIP` | 30 | |
| 8 | `SRC-GEOIP` | 33 | |
| 9 | `IP-ASN` | 35 | |
| 10 | `SRC-IP-ASN` | 38 | |
| 11 | `IP-CIDR` | 40 | |
| 12 | `IP-CIDR6` | 40 | 与 `IP-CIDR` 同一 case，**别名** |
| 13 | `SRC-IP-CIDR` | 43 | |
| 14 | `IP-SUFFIX` | 45 | |
| 15 | `SRC-IP-SUFFIX` | 48 | |
| 16 | `SRC-PORT` | 50 | |
| 17 | `DST-PORT` | 52 | |
| 18 | `IN-PORT` | 54 | |
| 19 | `DSCP` | 56 | |
| 20 | `PROCESS-NAME` | 58 | |
| 21 | `PROCESS-PATH` | 60 | |
| 22 | `PROCESS-NAME-REGEX` | 62 | payload 允许包含逗号 |
| 23 | `PROCESS-PATH-REGEX` | 64 | payload 允许包含逗号 |
| 24 | `PROCESS-NAME-WILDCARD` | 66 | |
| 25 | `PROCESS-PATH-WILDCARD` | 68 | |
| 26 | `NETWORK` | 70 | |
| 27 | `UID` | 72 | |
| 28 | `IN-TYPE` | 74 | |
| 29 | `IN-USER` | 76 | |
| 30 | `IN-NAME` | 78 | |
| 31 | `REMATCH-NAME` | 80 | |
| 32 | `SUB-RULE` | 82 | 逻辑/子规则 |
| 33 | `AND` | 84 | 逻辑规则，payload 含逗号与括号 |
| 34 | `OR` | 86 | 同上 |
| 35 | `NOT` | 88 | 同上 |
| 36 | `RULE-SET` | 90 | 引用 rule-provider |
| 37 | `MATCH` | 93 | 不需要 payload，但仍需要目标 |

源码：<https://github.com/MetaCubeX/mihomo/blob/478af2a57c48bdb8e85f6ed93b2c3735e90ceabd/rules/parser.go#L12-L98>  
官方文档示例与逐类型说明：<https://wiki.metacubex.one/config/rules/>，源文件 `docs/config/rules/index.md:3-56`（<https://github.com/MetaCubeX/Meta-Docs/blob/2a6ba6b04a9eecdbe5c88c4e4a09776659c0878b/docs/config/rules/index.md#L3-L56>）。

**文档没有 `DOMA`，parser 没有 `DOMA`；我抽查的 v1.15.0 / v1.16.0 / v1.17.0 / v1.18.0 / v1.19.33 五个 tag 的 `rules/parser.go` 也没有 `DOMA` 分支。**【证实】  
（检查命令见 §8.2 的版本核对；`DOMA` 不是这些版本里的别名。未逐一遍历所有历史 tag。）

### 1.2 规则解析流程（从 YAML 到错误）

1. YAML 的 `rules:` 被解码成 `RawConfig.Rule []string`：  
   `Rule []string \`yaml:"rules" json:"rule"\``  
   `config/config.go:456`。
2. `UnmarshalRawConfig` 用 `yaml.Unmarshal` 解码：`config/config.go:608-622`。
3. `ParseRawConfig` 先解析 `rule-providers`（`config.go:693`）、`sub-rules`（`config.go:699`），再调用  
   `parseRules(rawCfg.Rule, proxies, ruleProviders, subRules, "rules")`：`config.go:705`。
4. `parseRules` 以 **0 基**下标遍历 `[]string`：  
   `for idx, line := range rulesConfig`：`config.go:1102`。
5. 每条先调用 `RC.ParseRulePayload(line, true)`：`config.go:1103`。
6. `ParseRulePayload` 的实现：`rules/common/base.go:47-79`。关键行为：
   - `item := trimArr(strings.Split(ruleRaw, ","))`（第 48 行）：按逗号split，并对每段 `strings.Trim(e, " ")`；
   - `tp = strings.ToUpper(item[0])`（第 49 行）：**类型大小写不敏感**；
   - 对 `MATCH`：`target = item[1]`（第 52-54 行）；
   - 对 `NOT/OR/AND/SUB-RULE/DOMAIN-REGEX/PROCESS-NAME-REGEX/PROCESS-PATH-REGEX`：按“payload 可含逗号”处理，**目标取最后一个字段**（第 55-62 行）；
   - 其它类型：`payload = item[1]`；只有 `len(item) > 2` 时才把 `item[2]` 当作 `target`（第 63-74 行）。
7. 回到 `parseRules`：  
   ```go
   if target == "" {
       return nil, fmt.Errorf("%s[%d] [%s] error: format invalid", format, idx, line)
   }
   ```
   `config/config.go:1104-1105`。  
   **这就是用户看到的错误；它在任何类型校验之前发生。**
8. 目标存在性检查：`proxies[target]`，不存在则 `proxy [...] not found`；`SUB-RULE` 另查 `subRules`：`config.go:1108-1113`。
9. 调用 `R.ParseRule(tp, payload, target, params, subRules)`：`config.go:1116`；`ParseRule` 的 switch 在 `rules/parser.go:12-98`，未知类型在 `:96-97` 报 `unsupported rule type: %s`。
10. 顶层规则再包一层 `RuleWrapper`：`config.go:1127-1128`。

### 1.3 `format invalid` 的精确条件

因为第 7 步先于第 9 步，**只要 `target` 为空就一定报 `format invalid`**，不管 `tp` 是不是合法类型。对普通类型（非 `MATCH`、非“payload 可含逗号”类型）来说，`target` 为空等价于：

- 整行只有 1 个字段：`DOMA`；
- 整行只有 2 个字段：`DOMA,example.com`、`DOMAIN,GROUP`、`DOMA,`；
- 空行/纯空白行（`strings.Split("", ",")` 得到 `[""]`，`item[0]` 为空）。

对照表（`ParseRulePayload(line, true)` 的实际输出，已用真实源码测试）：

| `line` | `tp` | `payload` | `target` | 结果 |
| --- | --- | --- | --- | --- |
| `DOMA` | `DOMA` | `""` | `""` | **`format invalid`**，消息 `[DOMA]` |
| `DOMA,example.com` | `DOMA` | `example.com` | `""` | **`format invalid`**，消息 `[DOMA,example.com]` |
| `DOMA,example.com,PROXY` | `DOMA` | `example.com` | `PROXY` | 先查代理；若 `PROXY` 存在，`unsupported rule type: DOMA` |
| `DOMAIN,example.com` | `DOMAIN` | `example.com` | `""` | **`format invalid`**，消息 `[DOMAIN,example.com]` |
| `DOMAIN,example.com,PROXY` | `DOMAIN` | `example.com` | `PROXY` | 合法（代理存在时） |
| `MATCH` | `MATCH` | `""` | `""` | **`format invalid`**，消息 `[MATCH]` |
| `MATCH,PROXY` | `MATCH` | `""` | `PROXY` | 合法 |
| `""` | `""` | `""` | `""` | **`format invalid`**，消息 `[]` |

### 1.4 直接实验：真实 mihomo 函数复现用户错误

我没有重写解析逻辑，而是在 mihomo 源码包内加了临时测试文件，直接调用真实函数。

**（a）`rules/common/base.go` 的真实 `ParseRulePayload`**

命令：
```bash
cd /tmp/mihomo-go
GOPROXY=https://goproxy.cn,direct go test ./rules/common -run TestParseRulePayloadDiag -count=1 -v
```

输出（节选）：
```text
IN="DOMA" => tp="DOMA" payload="" target="" params=[]
IN="DOMA,example.com" => tp="DOMA" payload="example.com" target="" params=[]
IN="DOMA,example.com,PROXY" => tp="DOMA" payload="example.com" target="PROXY" params=[]
IN="" => tp="" payload="" target="" params=[]
IN="DOMAIN,,PROXY" => tp="DOMAIN" payload="" target="PROXY" params=[]
IN="DOMAIN,example.com" => tp="DOMAIN" payload="example.com" target="" params=[]
IN="DOMAIN,example.com,PROXY" => tp="DOMAIN" payload="example.com" target="PROXY" params=[]
IN="MATCH,PROXY" => tp="MATCH" payload="" target="PROXY" params=[]
IN="MATCH" => tp="MATCH" payload="" target="" params=[]
```

**（b）真实 `ParseRule` 对 `DOMA` 的反应**

命令：
```bash
GOPROXY=https://goproxy.cn,direct go test ./rules -run TestParseRuleDiag -count=1 -v
```

输出：
```text
tp="DOMA" payload="" target="" => err="missing subsequent parameters: DOMA"
tp="DOMA" payload="example.com" target="PROXY" => err="unsupported rule type: DOMA"
tp="DOMAIN" payload="example.com" target="PROXY" => ok type=Domain
tp="DOMAIN" payload="" target="PROXY" => err="missing subsequent parameters: DOMAIN"
```

**（c）真实 `config.parseRules` 复现完整错误字符串**

命令：
```bash
GOPROXY=https://goproxy.cn,direct go test ./config -run TestParseRulesDiag -count=1 -v
```

输出：
```text
rules=["DOMA"] => err=rules[0] [DOMA] error: format invalid
rules=["DOMA,example.com"] => err=rules[0] [DOMA,example.com] error: format invalid
rules=["DOMA,example.com,PROXY"] => err=rules[0] [DOMA,example.com,PROXY] error: proxy [PROXY] not found
rules=["DOMAIN,example.com"] => err=rules[0] [DOMAIN,example.com] error: format invalid
rules=["DOMAIN,example.com,PROXY"] => err=rules[0] [DOMAIN,example.com,PROXY] error: proxy [PROXY] not found
```

> 说明：最后两条的 `proxy [...] not found` 是因为测试传入了空代理表；若代理表里有 `PROXY`，`DOMA` 那条会进入 `ParseRule` 并报 `unsupported rule type: DOMA`（见 b）。这正好证明：**三字段 `DOMA` 不会报 `format invalid`**。

**（d）YAML 是否接受“最后一行只有 `- DOMA`”**

命令：
```bash
GOPROXY=https://goproxy.cn,direct go test ./config -run TestUnmarshalTruncatedDiag -count=1 -v
```

输入：
```yaml
rules:
  - DOMAIN,a.com,PROXY
  - DOMA
```

输出：
```text
unmarshal err=<nil> rules=["DOMAIN,a.com,PROXY" "DOMA"]
```

这说明：**一个在最后一条规则处被截断的配置文件，仍然是语法合法的 YAML，且会带着 `DOMA` 进入 `parseRules`。** 这是后文“输出截断”假设的关键技术前提。

### 1.5 结论：`[DOMA]` 不是“类型解析结果”

错误格式串是 `"%s[%d] [%s] error: format invalid", format, idx, line`（`config.go:1105`），第四个参数是 **`line` 原始字符串**，不是 `tp`。因此：

- 看到 `[DOMA]`，说明**原始规则行就是 `DOMA`**（除非终端把不可见字符显示掉了）；
- 如果原始行是 `DOMA,GROUP`，消息会是 `[DOMA,GROUP]`；
- 如果原始行有三字段 `DOMA,x,GROUP`，则不会走到这条错误（会先查代理，或报 `unsupported rule type: DOMA`）；
- 用户所说“类型解析成 DOMA”是**把方括号里的原始行误当成了类型**；实际类型解析（`strings.ToUpper(item[0])`）确实也会得到 `DOMA`，但错误原因不是“未知类型”，而是“没有 target”。

---

## 2. tindy2013/subconverter 侧：规则集解析与 Clash 生成

### 2.1 生成管线（Clash 内联规则模式）

```text
读取 pref/config
  └─ refreshRulesets()                       src/handler/settings.cpp:248-282
       └─ fetchFileAsync()                   src/handler/multithread.cpp:61-77
            └─ webGet() / curl               src/handler/webget.cpp
  └─ proxyToClash()                          src/generator/config/subexport.cpp
       ├─ YAML::Load(base_conf)
       ├─ proxyToClash(...) 填 proxies/groups
       └─ rulesetToClashStr(...)             src/generator/config/ruleconvert.cpp:193-257
            ├─ 复制 base 配置里的 rules（不校验）       :201-205
            ├─ 展开 [] 内联规则（不校验类型）           :220-229
            └─ 展开规则集：convertRuleset → 逐行过滤/补 group → 字符串拼接  :230-254
       └─ output = YAML::Dump(yamlnode) + rules 文本   src/generator/config/subexport.cpp:630-631
```

### 2.2 规则集类型识别：`convertRuleset`

`src/generator/config/ruleconvert.cpp:20-96`：

- `RULESET_SURGE`（默认/`surge:`）：**原样返回**，不做任何语法校验（`:28-29`）。
- 其余类型先判断内容里是否存在 `^payload:\r?\n`（`:31`，PCRE2 多行模式，因此 `payload:` 不必在第一行）。
  - 是 Clash payload：去掉 `payload:` 行和 YAML 列表装饰（`:33`）；`RULESET_CLASH_CLASSICAL` 直接返回去装饰后的文本（`:34-35`）；`clash-domain`/`clash-ipcidr` 还会给裸域名/IP 加类型前缀（`:36-88`）。
  - 不是 Clash payload：按 QuanX 处理，只做 `host→DOMAIN`、`ip6-cidr→IP-CIDR6` 和去 group 的正则（`:90-94`）。

规则集类型前缀映射在 `src/handler/settings.cpp:22`：
```cpp
const std::map<std::string, ruleset_type> RulesetTypes = {
    {"clash-domain:", RULESET_CLASH_DOMAIN}, {"clash-ipcidr:", RULESET_CLASH_IPCIDR},
    {"clash-classic:", RULESET_CLASH_CLASSICAL}, {"quanx:", RULESET_QUANX},
    {"surge:", RULESET_SURGE}};
```

`ruleset=` 的语法与各 type 的语义见 `README-cn.md:893-915`、`:1186-1198`。

### 2.3 行过滤与 `transformRuleToCommon`

`rulesetToClashStr` 的关键段（v0.9.0 `ruleconvert.cpp:236-254`）：

```cpp
while(getline(strStrm, strLine, delimiter))
{
    if(global.maxAllowedRules && total_rules > global.maxAllowedRules)
        break;
    strLine = trimWhitespace(strLine, true, true);
    lineSize = strLine.size();
    if(!lineSize || strLine[0] == ';' || strLine[0] == '#' ||
       (lineSize >= 2 && strLine[0] == '/' && strLine[1] == '/'))
        continue;                                  // 空行/整行注释跳过
    if(std::none_of(ClashRuleTypes.begin(), ClashRuleTypes.end(),
        [strLine](const std::string& type){ return startsWith(strLine, type); }))
        continue;                                  // 类型前缀不在白名单 → 静默丢弃
    if(strFind(strLine, "//")) {                   // 行内 // 截断
        strLine.erase(strLine.find("//"));
        strLine = trimWhitespace(strLine);
    }
    strLine = transformRuleToCommon(temp, strLine, rule_group);
    output_content += "  - " + strLine + "\n";      // 不加引号
    total_rules++;
}
```

- 白名单 `ClashRuleTypes`：`ruleconvert.cpp:12-13`，共 13 个前缀：
  `DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `IP-CIDR`, `SRC-IP-CIDR`, `GEOIP`, `MATCH`, `FINAL`, `IP-CIDR6`, `SRC-PORT`, `DST-PORT`, `PROCESS-NAME`。
- `startsWith` 是**字节前缀**匹配（`src/utils/string.h:59-62`，C++20 `starts_with`），不是“精确类型匹配”，也**大小写敏感**。
- `transformRuleToCommon`：`ruleconvert.cpp:98-123`
  - `split(temp, input, ',')`（`src/utils/string.cpp:28-38`）是**朴素逗号分割**，不识别引号、括号、正则里的逗号；
  - `temp.size() < 2` 时输出 `temp[0] + "," + group`；
  - 否则输出 `temp[0] + "," + temp[1] + "," + group`；若还有 `temp[2]`，再追加 `"," + temp[2]`（不校验它是不是 `no-resolve`）；
  - 因此**正常路径总会补一个 `,group`**，不会输出单字段行（除非后面讨论的 base 透传/空输入 UB/下游截断）。
- 输出行是 `"  - " + strLine + "\n"`，**不做 YAML 引号/转义**（`:252`）。

### 2.4 能产出“非法类型”或“半截行”的路径（逐项）

下表把“代码机制”和“本次实验结果”分开。实验均使用官方 v0.9.0 二进制，输入订阅是同一个本地 Clash YAML（只含一个 `Test` ss 节点），规则集通过 `ruleset=` 注入；输出只截取 `rules:` 段。

| # | 路径 | 代码位置 | 本次实验输入 | 生成结果 | mihomo 侧后果 |
| --- | --- | --- | --- | --- | --- |
| P1 | **base 配置原样透传** | `ruleconvert.cpp:201-205`：`!overwrite_original_rules` 时直接 `"  - " + safe_as<string>(base_rule[field_name][i])`，不过滤、不补 group | base 配置 `rules: [DOMA, DOMAIN,base.example.com]`，`overwrite_original_rules=false` | `- DOMA`（**唯一复现出裸 DOMA 的路径**） | `format invalid`，消息正是 `[DOMA]` |
| P2 | **`[]` 内联规则透传** | `ruleconvert.cpp:220-229`：`substr(2)` 后只做 `transformRuleToCommon`，不查 `ClashRuleTypes` | `ruleset=GROUP,[]DOMA` | `- DOMA,GROUP`（2 字段） | `format invalid`，消息 `[DOMA,GROUP]`；若 group 为空则 `[DOMA,]` |
| P3 | **`FINAL` 未被转成 `MATCH`（普通规则集路径）** | `ClashRuleTypes` 含 `FINAL`（`:12`）；只有 `[]` 路径在 `:223-224` 把 `FINAL` 替换成 `MATCH`，普通逐行路径没有 | 规则集 `FINAL,DIRECT` | `- FINAL,DIRECT,GROUP` | `unsupported rule type: FINAL`（代理存在时） |
| P4 | **前缀白名单不是精确匹配** | `startsWith(strLine, type)` + `ClashRuleTypes` 含 `MATCH`/`DOMAIN` 等 | 规则集 `MATCHBOX,DIRECT` | `- MATCHBOX,DIRECT,GROUP` | `unsupported rule type: MATCHBOX` |
| P5 | **朴素逗号分割破坏 payload** | `transformRuleToCommon` 的 `split` + 只保留 `temp[2]`（`:98-123`） | 规则集 `DOMAIN-REGEX,^a{1,3}$,GROUP`（`DOMAIN-REGEX` 因以 `DOMAIN` 开头而通过前缀过滤） | `- DOMAIN-REGEX,^a{1,GROUP,3}$` | payload 变成 `^a{1,GROUP`，正则语义被破坏（mihomo 的 `DOMAIN-REGEX` 还允许逗号，但这里已被切错） |
| P6 | **行内 `#` 不剥离 + 输出不加引号** | 只处理 `//`（`:246-250`），输出 `"  - " + strLine`（`:252`） | 规则集 `DOMAIN,hash.example.com #comment` | `- DOMAIN,hash.example.com #comment,GROUP` | YAML 把 `" #comment,GROUP"` 当注释，规则变成 `DOMAIN,hash.example.com`（2 字段）→ **`format invalid`**，消息 `[DOMAIN,hash.example.com]` |
| P7 | **规则集下载在“完整类型 token”处被截断** | 过滤按前缀；`DOMAIN` 通过，`transform` 补 `,group` | 规则集最后一行 `DOMAIN`（或 `DOMAIN,`） | `- DOMAIN,GROUP` | `format invalid`，消息 `[DOMAIN,GROUP]` |
| P8 | **规则集下载在 `DOMA` 处被截断** | `DOMA` 不匹配任何白名单前缀 | 规则集最后一行 `DOMA` | **不输出**（被过滤） | 不会产生这条错误 |
| P9 | **BOM 紧贴 `payload:`** | `removeUTF8BOM` 从未被调用（`string.cpp:316-320` 只有定义）；`^payload:` 多行匹配但仍要求该行以 `payload:` 开头 | `\xEF\xBB\xBFpayload:\n  - DOMAIN,bom.example.com`，`clash-classic:` | `rules:` 为空（整段规则集被丢） | 无规则，不会产生 DOMA；**静默丢规则** |
| P10 | **BOM 在注释行、`payload:` 在后面** | 同上；多行模式下 `payload:` 仍能匹配 | `\xEF\xBB\xBF# comment\npayload:\n  - DOMAIN,bom2.example.com` | `- DOMAIN,bom2.example.com,GROUP` | 正常；说明 BOM 只在“同一行”时致命 |
| P11 | **小写类型** | `startsWith` 大小写敏感 | 规则集 `domain,lower.example.com` | `rules:` 为空 | 静默丢规则；mihomo 自身是 `ToUpper` 大小写不敏感的，但 subconverter 先丢了 |
| P12 | **CRLF** | `getLineBreak` 选 `\n`；`trimWhitespace` 去尾部 `\r` | 规则集 `DOMAIN,crlf.example.com\r\n...` | 正常输出 | 无影响 |
| P13 | **空行/整行注释** | `:242-243` 跳过 | `# comment` / 空行 | 跳过 | 无影响 |
| P14 | **空 `[]` 内联** | `transformRuleToCommon` 对空输入走 `temp.size()<2` 后访问 `temp[0]`，是未定义行为（`split` 对空串返回空 vector） | `ruleset=GROUP,[]` | `- ,GROUP`（实测） | `format invalid`，消息 `[,GROUP]`；属于 UB，不保证跨平台稳定 |
| P15 | **HTTP 200 的 HTML 错误页** | `webGet` 只按状态码/curl 错误清空（`webget.cpp:266-270`），不检查 Content-Type；HTML 行随后被前缀过滤丢弃 | `<html><p>DOMA</p></html>` | `rules:` 为空 | 不会产生 DOMA；但会静默丢整段规则 |
| P16 | **HTTP 非 200** | `status_code != 200` → `data->clear()` | 请求不存在的 `/missing.list` | `rules:` 为空，日志 `Failed to fetch ruleset or ruleset is empty` | 不会产生 DOMA；整段规则集被丢 |
| P17 | **`max_allowed_rules` 截断** | `:238-239` 在**行边界** `break` | 设 `max_allowed_rules` 小于规则总数 | 输出到第 N 条完整规则为止 | **不会**产生半截行/`DOMA`；这是“完整前缀”截断 |
| P18 | **`max_allowed_download_size` / 15s 超时** | `settings.h:33` 默认 1 MiB；`webget.cpp:134` `CURLOPT_TIMEOUT 15`；超限/超时 → curl 错误 → 清空 | 大/慢规则集 | 整段规则集被跳过 | 不会产生半截行；静默丢规则 |

**实验证据（关键输出）**：

```text
# P1 base 透传
rules:
  - DOMA
  - DOMAIN,base.example.com
  - DOMAIN,good.example.com,GROUP
  - DOMAIN-SUFFIX,ok.example.com,GROUP

# P2 []DOMA
rules:
  - DOMA,GROUP

# P3 FINAL
rules:
  - FINAL,DIRECT,GROUP
  - DOMAIN,ok.example.com,GROUP

# P4 MATCHBOX
rules:
  - MATCHBOX,DIRECT,GROUP

# P5 DOMAIN-REGEX 含逗号
rules:
  - DOMAIN-REGEX,^a{1,GROUP,3}$
  - DOMAIN-WILDCARD,*.wild.example.com,GROUP

# P6 行内 #
rules:
  - DOMAIN,hash.example.com #comment,GROUP

# P7 截断在完整类型 token
rules:
  - DOMAIN,good4.example.com,GROUP
  - DOMAIN,GROUP

# P8 截断在 DOMA
rules:
  - DOMAIN,good3.example.com,GROUP

# P9 BOM 紧贴 payload:
rules:

# P12 CRLF
rules:
  - DOMAIN,crlf.example.com,GROUP
  - DOMAIN-SUFFIX,crlf2.example.com,GROUP

# P11 小写
rules:
```

> P6 的 YAML 二次解析实验（真实 mihomo `UnmarshalRawConfig` + `parseRules`）：
> ```text
> unmarshal err=<nil> rules=["DOMAIN,hash.example.com"]
> parseRules err=rules[0] [DOMAIN,hash.example.com] error: format invalid
> ```
> 这说明“输出不加引号 + 行内 `#`”可以独立制造 `format invalid`，但它的方括号内容是 `DOMAIN,hash.example.com`，不是 `DOMA`。

### 2.5 下载截断/错误页的真实细节

`webget.cpp` 的下载流程（v0.9.0）：

- `CURLOPT_TIMEOUT 15`（`:134`），整次传输 15 秒；
- 可选 `CURLOPT_MAXFILESIZE` + 进度回调 `size_checker`（`:138-141`）；默认 `maxAllowedDownloadSize = 1048576`（`settings.h:33`），示例 pref 设为 0（不限）（`pref.example.ini:283`、`pref.example.toml:341`）；
- 传输结束：
  ```cpp
  if(data && !argument.keep_resp_on_fail) {
      if(retVal != CURLE_OK || *result.status_code != 200)
          data->clear();
      data->shrink_to_fit();
  }
  ```
  `webget.cpp:266-270`；`keep_resp_on_fail` 默认 `false`（`webget.h:27`），全仓库没有地方把它设为 true（grep 仅命中定义）。
- **结论**：curl 层面的“传输失败/超时/大小超限/非 200”会导致整段内容被清空，而不是“半截内容继续用”。【证实】
- **但是**：如果上游/中间层返回一个**语法完整但内容短**的 200 响应（例如被缓存截断、被 CDN 以短 body + 匹配的 Content-Length 返回、或源站自己就返回短内容），curl 视为 `CURLE_OK`，内容会被保留；代码没有 Content-Length/尾行完整性/Content-Type 校验。【证实代码；现场是否发生未验证】
- **缓存读取不做校验**：`webGet` 命中缓存时直接 `return fileGet(path, true)`（`webget.cpp:317-328`）；如果缓存文件本身是截断的（进程崩溃、磁盘问题、旧的错误写入），会被原样使用。另外缓存写入条件是 `return_code == 200`（`:336-344`），即使 curl 失败后 `content` 已被清空，也可能把空内容写进缓存（取决于 `return_code` 是否仍为 200）。【证实代码；未构造缓存损坏实验】

我在本机用 curl 拉取 Loyalsoldier 的 `reject.txt` 时，真实遇到了 HTTP 层截断：

```text
curl: (28) Operation timed out after 120003 milliseconds with 15158 out of 5787426 bytes received
-rw-r--r--  ... 15158 ... loyalsoldier-reject.txt
```

文件末尾是 `...\n  `（只写下了下一行的两个空格），没有最终换行。这是“下载可能被截断”的直接现场证据；但注意：**这是 curl 的失败（CURLE_OPERATION_TIMEDOUT），subconverter 会按 §2.5 把内容清空，不会拿它去展开规则**。它说明的是网络层截断的形态，不是“subconverter 会接受这段半截内容”。

---

## 3. 真实流行规则集抽检

### 3.1 方法

- 用 `git clone --depth 1` 拉取 ACL4SSR、Loyalsoldier（master；release 文件用 raw URL 单独下载）。
- 用 `curl` 拉取 blackmatrix7 的单文件规则集、v2fly 的 `data/google`。
- 用 Python 脚本按**行**扫描：
  - 去掉 YAML 列表前缀 `- ` 和成对引号；
  - 取第一个逗号前的 token；
  - 统计 `token == "DOMA"`、`token.startswith("DOMA")` 但非 `DOMAIN`；
  - 对“typed 文件”（多数行以已知类型开头）统计未知 token；
  - 统计 BOM、CRLF、最终换行、NUL、UTF-8 合法性。
- 扫描脚本在临时目录，不在规则集目录内运行；`python -I` 隔离。

### 3.2 结果总表

| 来源 | 具体 URL | 版本/提交 | 字节/行数 | 带类型行数 | `DOMA` | 单字段类型行 | 其它观察 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ACL4SSR `Clash/*.list` + `Clash/Ruleset/*.list`（182 个文件） | 例：<https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaDomain.list> | `bdc102fc54ba64f6ecaf3c73248100fd7af32559` | — | 114,878 | **0** | **0** | 182/182 个文件是 CRLF；0 个 BOM；18 行 `URL-REGEX`（非 mihomo 类型） |
| ACL4SSR `Clash/ChinaDomain.list` | 同上 | 同上 | 17,977 / 726 | 635 | 0 | 0 | 大量 2 字段行（如第 3 行 `DOMAIN-SUFFIX,13th.tech`），subconverter 会补 group |
| ACL4SSR `Clash/ChinaIp.list` | <https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaIp.list> | 同上 | 267,053 / 7,461 | 7,456 | 0 | 0 | 全 `IP-CIDR`，带 `,no-resolve` |
| blackmatrix7 `Advertising_Classical.yaml` | <https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Advertising/Advertising_Classical.yaml> | `0b6897dc17e0c513d25449c935a9694818e32f0c` | 10,768,487 / 291,170 | **291,159** | **0** | **0** | 文件头声明 TOTAL 291,159；LF；无 BOM；全部 2 字段（无 target） |
| blackmatrix7 `Advertising.yaml` | <https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Advertising/Advertising.yaml> | 同上 | 23,869 / 778 | 767 | 0 | 0 | 文件头写 domain/ip 统计，但内容含 278 条 `DOMAIN-KEYWORD`、486 条 `IP-CIDR`、3 条 `IP-CIDR6`；说明“流行集”自身也不总是纯 domain 行为 |
| Loyalsoldier `direct.txt` | <https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/direct.txt> | `release@9590a9fbcc0bc43b7522013bad31eda091a63aaf` | 2,276,753 / 110,189 | 0（域名列表） | **0** | 0 | `payload:` + `- '+.domain'`，纯域名行为 |
| Loyalsoldier `proxy.txt` | <https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/proxy.txt> | 同上 | 623,205 / 27,347 | 0 | 0 | 0 | 同上 |
| Loyalsoldier `gfw.txt` | <https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/gfw.txt> | 同上 | 95,434 / 4,453 | 0 | 0 | 0 | 同上 |
| Loyalsoldier `reject.txt`（**本次被截断**） | <https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/reject.txt> | 同上 | 15,158 / 584（应为 5,787,426） | 0 | 0 | 0 | 第 584 行只有 `  `，无最终换行；见 §2.5 |
| v2fly/domain-list-community `data/google` | <https://raw.githubusercontent.com/v2fly/domain-list-community/master/data/google> | `e8d7a10a15bf662c927a40a3aa680bae86379608` | 12,516 / 709 | 0（domain-list 语法） | **0** | 0 | `include:`/`full:`/`@cn` 等指令，不是 Clash typed 规则 |

**结论**：
- 抽检的 ACL4SSR（182 文件、11.5 万 typed 行）、blackmatrix7（29.1 万 typed 行）、Loyalsoldier（14 万+ 域名行）、v2fly（709 行）中，**没有任何一行是 `DOMA`**。`DOMA` 不是这些流行集的合法写法，也不是 mihomo 的类型。**【证实（抽样范围内）】**
- 流行集确实存在**非 mihomo 类型**：ACL4SSR 有 18 行 `URL-REGEX`。具体行号：
  - `Clash/ChinaMedia.list:40`
  - `Clash/ProxyMedia.list:92`
  - `Clash/Ruleset/Amazon.list:43`
  - `Clash/Download.list:15,16,17,18,20,23,29`
  - `Clash/Ruleset/Download.list:18,19,20,21,22,23,24`
  - `Clash/Ruleset/Iqiyi.list:25`
  这些行在 subconverter 输出 Clash 时会被 `ClashRuleTypes` 前缀过滤**静默丢弃**（`URL-REGEX` 不在列表，也不以任何列表项开头），不会进入 mihomo；如果它们通过 base 配置原样透传，mihomo 会报 `unsupported rule type: URL-REGEX`（前提是 3 字段）或 `format invalid`（如果只有 2 字段）。**【证实代码 + 文件扫描；未逐条做端到端转换】**
- ACL4SSR 大量 typed 行只有 2 字段（`DOMAIN-SUFFIX,13th.tech`），这是它作为“规则集源”的正常形态；subconverter 的 `transformRuleToCommon` 会补 `,group`，所以不是错误。**只有 base 配置/内联规则/下游截断才可能让 2 字段行直接进入 mihomo。**

### 3.3 抽检的局限

- 只抽了上述仓库的代表性文件；没有遍历 blackmatrix7 全部 669 个目录，也没有扫描 `.mrs`/`geosite.dat` 二进制。
- “0 个 DOMA”只对本次下载到的字节成立；不能证明整个互联网没有某个规则集包含 `DOMA`。
- 版本是 2026-11-09 的快照；上游后续可能变化。

---

## 4. 根因分析

### 4.1 直接原因（确定）

第 20675 条（0 基 20674）规则是一个**没有目标字段**的字符串。mihomo 在 `config/config.go:1104-1105` 因 `target == ""` 直接返回：

```text
rules[20674] [DOMA] error: format invalid
```

方括号里是原始行 `DOMA`，不是解析出的类型。这个结论由源码、真实 `ParseRulePayload`/`parseRules` 测试、以及错误格式串三方面证实。

### 4.2 为什么“正常规则集展开”不会产出字面量 `DOMA`

三条独立证据：

1. **类型前缀过滤**：`rulesetToClashStr` 对每一行做 `none_of(ClashRuleTypes, startsWith)`；`DOMA` 不是任何白名单项的前缀，直接 `continue`（`ruleconvert.cpp:242-245`）。实验 P8 证明：规则集最后一行 `DOMA` 被丢弃，输出里没有它。
2. **正常路径必补 group**：`transformRuleToCommon` 对任何通过过滤的行都会输出 `...,<group>`（`ruleconvert.cpp:98-123`）；即使输入是 1 字段的 `DOMAIN`，也会变成 `DOMAIN,GROUP`，而不是裸 `DOMAIN`。实验 P7 证明。
3. **输出器按整行拼接**：`output_content += "  - " + strLine + "\n"`（`ruleconvert.cpp:252`），没有 `substr`/截断逻辑；`std::string` 也不会在中间截断。要出现裸 `DOMA`，只能是**输入本身就是裸 `DOMA` 且绕过了过滤器**（base 复制/`[]` 路径），或者**输出在传输/落盘时被截断**。

### 4.3 场景 A：生成后的配置在末尾被截断（最符合“裸 DOMA”的解释）

**机制**：
- subconverter 的 Clash 输出是 `YAML::Dump(yamlnode)` + `rulesetToClashStr(...)` 字符串拼接（`subexport.cpp:630-631`），所以**在标准内联展开路径**（未走 `managed_config_prefix`/`clash_script` 的 `renderClashScript` 分支）里，**`rules:` 是最后一个顶层块**，规则按顺序排在文件末尾。
- 生成器最后一条规则如果是 `DOMAIN,...`，下游在某个字节处切断，恰好切在 `DOMA` 后，文件就以：

  ```yaml
  ...
    - DOMA
  ```

  结束。
- YAML 解析器接受“最后一行是 `- DOMA`”（实验 d：`unmarshal err=<nil> rules=[... "DOMA"]`）；Clash Party 的 `yaml.parse`/`yaml.stringify` 也会把它保留下来（`factory.ts:27-46`），最后由 mihomo `parseRules` 报错。
- 如果文件在第 20674 条处被切断，且总共只有 20675 条规则，那么 `rules[20674]` 正好是**最后一条**；这与“方括号里只有 `DOMA`、没有后续内容”吻合。

**为什么会截断**（候选，按可能性）：
1. 订阅从 subconverter 到 Clash Party 的链路被中间层（反代/CDN/代理）以“短 body + 完整 HTTP 语义”返回；
2. 客户端把响应写到 `profiles/<id>.yaml` 时被截断/磁盘问题；
3. 用户手工编辑/脚本处理时在 `DOMA` 处截断；
4. subconverter 侧读到的是被截断的 **base 配置**（`clash_rule_base` 远程文件），`YAML::Load` 仍成功，且 `overwrite_original_rules=false` 把 `DOMA` 原样复制（见场景 B）。

**支持证据**：
- `rules:` 在末尾（源码 + 实测输出：`/tmp/sc-out-*.yaml` 的 `rules:` 都是最后一个块）；
- YAML 允许最后一行是 `- DOMA`（实验 d）；
- 本项目既有取证记录了 subconverter 的输出截断问题：issue [#178](https://github.com/tindy2013/subconverter/issues/178)（“订阅转换数据会在某个部位截断”，维护者回复“默认对最大规则数进行了限制”）与 [#537](https://github.com/tindy2013/subconverter/issues/537)（“订阅返回配置会在某个部位截断”，维护者回复“网络问题”）。**注意**：这两个 issue 的截断通常是“完整规则的边界”或网络失败，不直接证明“切在 `DOMA` 中间”；它们只证明“输出可能不完整”这一现象存在。
- 我在本机 curl 拉取 Loyalsoldier `reject.txt` 时真实遇到 15,158/5,787,426 字节的截断（§2.5），说明当前网络环境下 HTTP 截断并非理论问题。

**不支持/反证**：
- subconverter v0.9.0 的响应带 `Content-Length`（实测：`HTTP/1.1 200 OK`、`Content-Length: 1949`），规范的 HTTP 客户端在短读时通常会报错；Clash Party 使用 axios（`profile.ts:143-155`），若底层 Node http 检测到 Content-Length 不匹配，会 reject，`setProfileStr` 不会执行。因此，若用户是“直连自建 subconverter + 规范客户端”，场景 A 需要中间层改写/缓存或落盘损坏才能成立。**【推断】**
- 如果用户使用公共转换服务/反向代理/Sub-Store，这一反证不成立；具体要看其链路。**【未验证】**

**置信度**：中（约 0.55）。它是“字面量 `DOMA`”最简洁的解释，但缺少用户现场文件的尾部字节/HTTP 抓包。

### 4.4 场景 B：base 配置原样透传（已复现，但对 20674 需要 2 万+ 条 base 规则）

`rulesetToClashStr` 在 `!overwrite_original_rules` 时把 base 配置的 `rules` 原样复制（`ruleconvert.cpp:201-205`），**不检查类型、不补 group、不加引号**。实验 P1 用 base 配置 `rules: [DOMA, DOMAIN,base.example.com]` 精确复现了输出 `- DOMA`。

成立条件：
- 外部配置/偏好里 `overwrite_original_rules=false`；
- `clash_rule_base` 指向的 YAML 的 `rules` 列表里有 `DOMA`，或该 base 文件在 `DOMA` 处被截断且 `YAML::Load` 仍成功；
- 该 `DOMA` 在最终 rules 数组中的下标恰好是 20674。

**评估**：
- 机制置信度高（实验复现）；
- 作为用户现场原因置信度低（约 0.15）：base 配置通常是 `rules: ~` 或少量规则（subconverter 自带 `all_base.tpl:17` 就是 `rules: ~`；ACL4SSR 的 `.ini` 设置 `overwrite_original_rules=true`，见 `Clash/config/ACL4SSR_Online_Full.ini:83`），要有 20,674 条 base 规则才会把 `DOMA` 顶到该下标。除非用户把一整套完整 Clash 配置当作 `clash_rule_base` 使用。

### 4.5 场景 C：如果实际原始行是 `DOMA,GROUP`（报告里只写了首段）

`[]` 内联路径不做类型校验（`ruleconvert.cpp:220-229`）。实验 P2：

```text
ruleset=GROUP,[]DOMA  →  rules: [ "DOMA,GROUP" ]
```

mihomo 对 2 字段 `DOMA,GROUP` 同样报 `format invalid`，消息是 `[DOMA,GROUP]`。如果用户在报告/日志里只截取了“类型”部分（`DOMA`），这会是**生成端可复现、且下标可以在末尾**的解释：
- ACL4SSR 等配置把 `[]GEOIP,CN`、`[]FINAL` 放在所有规则集之后（`ACL4SSR_Online_Full.ini:46-47`），内联规则天然靠近 rules 数组末尾，容易落在 20674；
- 一个把 `DOMAIN` 误写成 `DOMA` 的内联规则（`[]DOMA`）会产生**同一类** `format invalid`（只是消息为 `[DOMA,GROUP]`，多了 group 字段）；
- 若 group 为空，`[]DOMA` 产生 `DOMA,`，消息 `[DOMA,]`，不是 `[DOMA]`。

**置信度**：机制 0.99；作为现场原因取决于实际消息是否含 `,GROUP`。如果用户看到的确实是 `[DOMA]`（无逗号），场景 C 不成立；如果是转述时省略了 `,GROUP`，场景 C 的可能性高于场景 A/B。**建议第一步就看原始日志/配置的十六进制。**

### 4.6 场景 D：手工编辑/Clash Party override 脚本

- 用户手工把最后一条规则删成 `DOMA`；
- Clash Party 的 override JS/YAML 脚本修改了 `rules`（`factory.ts:69-91`），例如字符串截断/错误替换；
- 这类路径没有证据，置信度低（<0.1），但排查时应确认是否有 override。

### 4.7 已排除/不太可能的解释

| 解释 | 结论 | 依据 |
| --- | --- | --- |
| mihomo 把 `DOMA` 当合法别名 | **排除** | `rules/parser.go` 无 `DOMA`；v1.15.0～v1.19.33 无；文档无 |
| 流行规则集里本来就有 `DOMA` | **抽样范围内排除** | ACL4SSR/blackmatrix7/Loyalsoldier/v2fly 共 40 万+ 行，0 命中 |
| 规则集下载在 `DOMA` 处截断，subconverter 原样输出 | **排除（字面量 DOMA）** | 前缀过滤器丢弃 `DOMA`（实验 P8）；只有完整 token（`DOMAIN`）才会变成 `DOMAIN,GROUP`（P7） |
| BOM 导致 `DOMA` | **排除为直接来源** | BOM 只会让“紧贴 `payload:`”的整段规则集被丢（P9）；不会生成 `DOMA` |
| CRLF 导致半截行 | **排除** | CRLF 被 `getLineBreak`/`trimWhitespace` 正常处理（P12；ACL4SSR 182/182 文件 CRLF 且转换正常） |
| 行内注释/空行 | **部分排除** | 整行注释/空行被跳过；行内 `#` + 不加引号会制造 `format invalid`，但方括号是 `[DOMAIN,hash.example.com]`，不是 `[DOMA]`（P6） |
| 大小写 | **排除为直接来源** | 小写行被 subconverter 静默丢弃（P11），不会输出 |
| 超长行 | **无证据** | 没有行长度上限；`max_allowed_download_size`/`max_allowed_rules` 是整段/整行边界截断（P17/P18） |
| HTTP 错误页 | **不太可能** | 非 200 被清空；200 HTML 页的行会被前缀过滤（P15/P16） |

### 4.8 现场判定树（按顺序，1 分钟）

1. 找到 Clash Party 的 profile 文件：`<dataDir>/profiles/<id>.yaml`（`src/main/utils/dirs.ts:83-93`）。
2. 看尾部字节：
   ```bash
   tail -c 80 profiles/<id>.yaml | xxd
   wc -c profiles/<id>.yaml
   ```
   - 若最后一行就是 `- DOMA` 且**没有最终换行** → **场景 A（截断）**，高概率。  
   - 若文件正常以 `MATCH,...`/`#`/换行结束 → 场景 A 不成立，进入 3。
3. 取第 20674 条（0 基）原始行：
   ```bash
   sed -n '/^rules:/,$p' profiles/<id>.yaml | grep '^  - ' | sed -n '20675p' | cat -A
   ```
   - 输出 `- DOMA$` → 裸 `DOMA`；结合“文件是否完整”判断 A/B/D。  
   - 输出 `- DOMA,GROUP$` → 场景 C（`[]DOMA` 或 base 行）。  
   - 输出 `- DOMA,...`（≥3 字段）→ 不可能是这条错误，重新核对日志/下标。
4. 搜索生成端：
   ```bash
   grep -RIn --exclude-dir=.git -E '(^|,)\[\]DOMA(,|$)|DOMA' <subconverter配置目录>
   ```
   - 命中 `[]DOMA` → 改配置；命中 base `rules` 里的 `DOMA` → 场景 B。
5. 对比 HTTP：
   ```bash
   curl -sS -D /tmp/h.txt -o /tmp/body.yaml '<订阅URL>'
   grep -i '^content-length' /tmp/h.txt
   wc -c /tmp/body.yaml
   tail -c 80 /tmp/body.yaml | xxd
   ```
   - `Content-Length` 与实际字节不一致 → 传输截断；一致但文件仍以 `DOMA` 结尾 → 源站/缓存本身就短（场景 A 的变体）。
6. 若使用代理/公共转换服务：禁用 Clash Party 的 `useProxy`、换直连/自建、加随机 query 绕过缓存，再重复 5。

---

## 5. 修复策略

### 5.1 立即处置（用户侧）

1. **先判断是不是截断**：按 §4.8 看 profile 尾部。若最后一行是 `DOMA` 且无换行，**不要手工补**；重新下载/重新生成，并确认 `Content-Length` 一致、最后一行完整。
2. **换链路验证**：用 `curl` 直接拉订阅（不经 Clash Party 的代理），对比字节数；若直连正常、经代理截断，问题在代理/中间层。
3. **换转换后端**：若使用公共 subconverter，换自建实例或加 `?noCache=...`/随机参数；公共服务的反代/缓存是截断高发点。
4. **检查配置源**：`grep` 配置里的 `[]DOMA`、base `rules` 里的 `DOMA`、手工编辑残留；修掉后重新生成。
5. **临时绕过**：如果只想先启动，删除 profile 中第 20675 条 `- DOMA`（若它确实是最后一条且后面没有内容）；但如果文件被截断，删除后仍缺少后续规则，**不推荐**作为长期修复。

### 5.2 转换端：规则校验器（核心修复）

在“生成 YAML 之后、返回响应之前”增加一层**语义校验**。校验器必须和 mihomo 的解析规则一致，而不是只做字符串匹配。

#### 5.2.1 类型白名单（精确匹配，不前缀）

```text
TYPES = {
  DOMAIN, DOMAIN-SUFFIX, DOMAIN-KEYWORD, DOMAIN-REGEX, DOMAIN-WILDCARD,
  GEOSITE, GEOIP, SRC-GEOIP, IP-ASN, SRC-IP-ASN,
  IP-CIDR, IP-CIDR6, SRC-IP-CIDR, IP-SUFFIX, SRC-IP-SUFFIX,
  SRC-PORT, DST-PORT, IN-PORT, DSCP,
  PROCESS-NAME, PROCESS-PATH, PROCESS-NAME-REGEX, PROCESS-PATH-REGEX,
  PROCESS-NAME-WILDCARD, PROCESS-PATH-WILDCARD,
  NETWORK, UID, IN-TYPE, IN-USER, IN-NAME, REMATCH-NAME,
  SUB-RULE, AND, OR, NOT, RULE-SET, MATCH
}
```

- **不要**用 `startsWith` 做白名单；`MATCHBOX`、`DOMAIN-FOO`、`DOMAIN-REGEX` 这类前缀会漏过。
- 类型先 `strip().upper()`，与 mihomo 的 `ToUpper` 对齐。
- 维护“核心版本 → 类型表”；升级 mihomo 时从 `rules/parser.go` 的 `case` 重新生成。
- 对 `FINAL` 显式处理：输出 Clash 时转成 `MATCH`，不要透传（见 P3）。
- 对 `URL-REGEX`/`USER-AGENT`/`HOST*`/`DEST-PORT`/`SRC-IP` 等 Surge/QuanX 类型：要么翻译成 mihomo 等价类型，要么丢弃并告警；不要原样输出。

#### 5.2.2 逗号分割：按类型区分

不能所有类型都用 `line.split(",")`：

- 普通类型（`DOMAIN`、`DOMAIN-SUFFIX`、`IP-CIDR`、`GEOIP`、`PORT` 等）：`tp,payload,target[,params...]`；
- `MATCH`：`tp,target`；
- payload 可含逗号的类型：`DOMAIN-REGEX`、`PROCESS-NAME-REGEX`、`PROCESS-PATH-REGEX`、`AND`、`OR`、`NOT`、`SUB-RULE`：**目标取最后一个字段，payload 是中间全部**（与 `base.go:52-62` 一致）；
- 逻辑规则：先做括号配对，再递归校验每个子规则（见 5.2.4）。

#### 5.2.3 payload 语法校验（至少覆盖 mihomo 构造器会拒绝的）

校验器不要求比 mihomo 更严，但至少不能把 mihomo 构造器会拒绝的值放过去：

- `IP-CIDR` / `IP-CIDR6` / `SRC-IP-CIDR`：用 `netip.ParsePrefix` 校验（mihomo `rules/common/ipcidr.go:58-64` 就是用它，失败返回 `errPayload`）。
- `DOMAIN-REGEX` / `PROCESS-NAME-REGEX` / `PROCESS-PATH-REGEX`：用 `regexp2.Compile(regex, regexp2.IgnoreCase)` 预编译（`rules/common/domain_regex.go:33-37`）；不要只用 Go `regexp`，两者语法不完全一样。
- `DOMAIN` / `DOMAIN-SUFFIX` / `DOMAIN-KEYWORD`：非空；不含空白、换行、NUL；不含 `/`（domain provider 还会显式拒绝 `/`，见 `domain_strategy.go:41-47`）；大小写统一转小写（mihomo 构造器会 `strings.ToLower`）。
- `DOMAIN-WILDCARD`：只允许 `*`/`?` 通配（mihomo 文档明确限制），不要把正则元字符当通配。
- `SRC-PORT` / `DST-PORT` / `IN-PORT`：整数 0–65535 或合法范围；`GEOIP`/`GEOSITE`/`IP-ASN`/`UID`/`DSCP`：非空、格式/范围合法；`NETWORK`：`tcp`/`udp`。
- `MATCH`：只允许 `MATCH,<target>`；多写的字段会被 `ParseRulePayload` 忽略（`base.go:52-54`），容易造成“以为指向 A、实际指向 B”的语义错误。
- `RULE-SET`：`payload` 必须是已存在的 rule-provider 名；`SUB-RULE`/`AND`/`OR`/`NOT`：走 5.2.4 的递归校验。

#### 5.2.4 逻辑规则递归校验（对齐 mihomo）

mihomo 的实现：`rules/logic/logic.go:77-86`、`:146-173`。

- 最外层 payload 必须是 `(...)`（`:147-149`）；
- 括号必须平衡（`:88-118`）；
- 每个子规则用 `ParseRulePayload(subPayload, false)` 解析（`:78`）；
- 子规则不允许 `MATCH`/`SUB-RULE`（`:79-81`）；
- 子规则类型不能为空（`:82-83`）；
- 递归校验每个子规则（`parseRule` 会继续解析）。
- `SUB-RULE` 要求恰好一条子规则（`NewSubRule`，`logic.go:31-33`）；`NOT` 也要求恰好一条（`:42-44`）。

#### 5.2.5 逐行告警格式与原因码

建议输出 JSON Lines / 表格，至少包含：

```text
rules[20674] line=20675 raw="DOMA" code=E_FORMAT_NO_TARGET
  target=""; expected "DOMAIN,<payload>,<proxy-group>"; hint="line may be truncated"
```

原因码建议：

| 代码 | 含义 | 处理 |
| --- | --- | --- |
| `E_FORMAT_NO_TARGET` | 缺 target（普通类型 <3 字段；MATCH <2 字段） | 严格模式失败；宽松模式丢弃 |
| `E_FORMAT_EMPTY` | 空行/纯空白 | 跳过（通常无害） |
| `E_UNKNOWN_TYPE` | 不在精确白名单 | 失败/丢弃；提示最接近的类型 |
| `E_EMPTY_PAYLOAD` | payload 为空（非 MATCH） | 失败/丢弃 |
| `E_BAD_REGEX` | `DOMAIN-REGEX`/`PROCESS-*-REGEX` 编译失败 | 失败/丢弃 |
| `E_BAD_CIDR` / `E_BAD_PORT` / `E_BAD_ASN` | 值语法错误 | 失败/丢弃 |
| `E_TARGET_NOT_FOUND` | target 不在 proxy-groups/proxies/rule-providers | 失败/告警（mihomo 会直接失败） |
| `E_LOGIC_UNBALANCED` | 逻辑规则括号不配对 | 失败/丢弃 |
| `E_LOGIC_NESTED_MATCH` | 逻辑规则内出现 MATCH/SUB-RULE | 失败/丢弃 |
| `E_TRUNCATED_TAIL` | 文件最后一行不完整/无最终换行/最后一行是类型前缀 | 失败（高优先级） |
| `E_TRUNCATED_HTTP` | Content-Length 与实际字节不一致 | 失败 |
| `E_BOM` | 文件以 BOM 开头且 `payload:` 在同一条行首 | 告警；剥离 BOM |
| `W_CRLF` | CRLF（通常无害） | 信息 |
| `W_INLINE_HASH` | 行内 `#`（可能被 YAML 当注释） | 告警；输出时加引号 |
| `W_PREFIX_TYPE` | 类型是 `DOMAIN`/`MATCH` 等的前缀但非精确值 | 告警/失败 |

#### 5.2.6 严格/宽松模式

- **严格（转换服务默认）**：发现任何 `E_*` 就**不返回配置**，返回 422 + 校验报告（含行号、原始行、原因码、建议）。这样错误在转换端暴露，而不是在客户端内核启动时暴露。
- **宽松（迁移/兼容期）**：丢弃无效行并计数，保留合法行；同时返回 `X-Invalid-Rules: N` 响应头和 sidecar 报告。**绝不能把无效行原样写进输出**。
- **不要指望 mihomo 宽松**：`parseRules` 是 fail-fast（第一条无效就返回）。真正的“宽松”只能在生成端或 rule-provider 层实现。
- 兼容开关：老配置里可能依赖 `[]` 自定义规则/`RULE-SET` 引用；严格模式要提供 `--strict-rules=false` 回退，避免一刀切。

### 5.3 YAML 输出加固

1. **每条规则加引号**：`  - 'DOMAIN,...'` 或 `  - "DOMAIN,..."`。这能消除 `#`、`: `、前导 `*`/`&`/`!` 等 YAML 语义问题；mihomo 解析后会得到同样的字符串。P6 的 `#` 截断问题会消失。
2. **用真正的 YAML emitter 生成 `rules`**，而不是字符串拼接；至少对 `strLine` 做 YAML 标量转义。
3. **保留最终换行**：最后一条规则后必须有 `\n`。
4. **加 EOF/校验哨兵**：在 `rules:` 之后追加一行 `# EOF` 或一个 `x-rule-count: N`/`x-rule-sha256` 头；下游若在 `DOMA` 处截断，哨兵/计数缺失，校验器可判定截断。
5. **剥离 BOM**：在 `convertRuleset` 入口调用 `removeUTF8BOM`（目前是死代码），或至少在 `^payload:` 检测前去掉 BOM。
6. **不要静默丢弃**：对 `none_of(ClashRuleTypes)` 的行记录原因码/行号；否则用户只会看到“规则少了”，无法排障。

### 5.4 截断/错误页检测（HTTP + 客户端）

转换服务端：

- 下载规则集/订阅时：
  - 检查 HTTP 状态码（非 200 直接失败，保留错误原因）；
  - 检查 `Content-Type`（拒绝 `text/html` 冒充规则集）；
  - 检查 `Content-Length` 与实际接收字节；
  - 检查最终换行/最后一行完整性；
  - gzip 解压后检查流是否完整（curl 通常会暴露 `CURLE_PARTIAL_FILE`，但要显式记录）；
  - 对缓存文件做长度/哈希 sidecar，读取时校验；不要把失败的空内容写入缓存（`webget.cpp:336-344` 的 `return_code==200` 判断需要结合 `retVal`）。
- 生成配置后：
  - 重新用 YAML 解析器读回输出（`yaml.Unmarshal`），确认 `rules` 是 `[]string` 且每条可解析；
  - 计算规则数/哈希，写入响应头（`X-Rule-Count`、`X-Rule-SHA256`）；
  - 若校验失败，返回 500/422，而不是把坏配置发给客户端。

Clash Party 客户端（建议上游改进）：

- `createProfile` 拿到 `res.data` 后（`profile.ts:158-174`）先做：
  - `Content-Length` 与实际字符串字节数比较；
  - 最后一行/最终换行检查；
  - 规则白名单/格式校验（可复用上面的校验器）；
  - 失败时不要 `setProfileStr`，提示“订阅被截断/含非法规则”，保留旧 profile。
- `generateProfile`（`factory.ts:27-46`）在 `yaml.stringify` 前再校验一次 `profile.rules`，避免 override 脚本引入非法行。

### 5.5 大规则集改用 `rule-providers`

当规则数超过阈值（建议 10,000 条或 ~1 MiB），不要把规则内联进 `rules:`，改用 rule-provider：

```yaml
rule-providers:
  big-classical:
    type: http
    behavior: classical
    format: yaml
    url: https://example.com/big.yaml
    path: ./providers/big.yaml
    interval: 86400

rules:
  - RULE-SET,big-classical,PROXY
```

要点：

- `behavior: classical` 的 provider 内容按行解析；**单行错误只记 warning 并跳过**（mihomo `rules/provider/classical_strategy.go:40-50`：`log.Warnln("parse classical rule [%s] error: %s", ...)`），不会像顶层 `rules` 那样让整个配置启动失败。这是“失败隔离”的最大收益。
- 纯域名/纯 IP 集用 `behavior: domain`/`ipcidr` + `format: yaml/text/mrs`，更省内存；domain provider 对非法域名也是跳过并 warning（`domain_strategy.go:41-47`）。
- provider 的 `path`/`url` 要可访问；`RULE-SET` 的 provider 名必须存在（mihomo `config.go:1121-1124` 会检查 `ruleProviders[name]`）。
- 如果转换服务仍要展开（`expand=true`），至少在展开前后做 5.2 的校验；`expand=false` + provider 是更稳的架构。

### 5.6 建议的落地顺序

1. **止血**：用户按 §4.8 判断是否截断；换直连/自建/禁用代理；修掉 `[]DOMA`/base `DOMA`。
2. **转换端**：加“YAML 读回 + 精确白名单 + 缺 target 检查 + 逻辑递归 + 行号/原因码”；严格模式默认开启，宽松模式可配置。
3. **传输端**：Content-Length/最终换行/Content-Type/缓存哈希校验；加 `X-Rule-Count`/EOF 哨兵。
4. **架构**：大规则集切 `rule-providers`，利用 provider 的逐行 warning 隔离。
5. **客户端**：Clash Party/其他 GUI 在落盘前做同一套校验，避免“坏配置延迟到内核启动才暴露”。

---

## 6. 结论置信度与不确定性

| # | 结论 | 置信度 | 依据 | 不确定性/反证 |
| --- | --- | --- | --- | --- |
| 1 | `format invalid` 在 `target == ""` 时打印，先于类型校验 | **0.99** | `config.go:1104-1105`；真实 `parseRules` 测试 | 无 |
| 2 | `[DOMA]` 是原始行，不是类型 | **0.98** | 格式串用 `line`；测试输出 `rules[0] [DOMA] ...` | 若终端吞掉不可见字符，原始行可能是 `DOMA\r`/`DOMA `；仍是缺 target |
| 3 | 三字段 `DOMA,x,GROUP` 不会报 `format invalid` | **0.99** | `ParseRulePayload` + `ParseRule` 测试 | 若代理表缺 `PROXY`，会先报 proxy not found；有代理则 unsupported type |
| 4 | mihomo 没有 `DOMA` 别名 | **0.99** | `rules/parser.go`；抽查 v1.15.0/v1.16.0/v1.17.0/v1.18.0/v1.19.33 五个 tag；wiki | 未逐一遍历所有历史 tag；极老版本未查 |
| 5 | 正常规则集展开不会产出裸 `DOMA` | **0.98** | `ruleconvert.cpp:244-245` + 实验 P8；`transformRuleToCommon` 总补 group | 若用户版本改过白名单/有插件，结论可能变 |
| 6 | base 配置透传可产出裸 `DOMA` | **0.95（机制）** | 实验 P1；`ruleconvert.cpp:201-205` | 作为现场原因仅 ~0.15（需要 base 有 2 万+ 规则/被截断） |
| 7 | `[]DOMA` 可产出 `DOMA,GROUP` | **0.99（机制）** | 实验 P2；`ruleconvert.cpp:220-229` | 作为现场原因取决于实际消息是否含 `,GROUP`（~0.4–0.6） |
| 8 | 用户现场是“输出在 `DOMA` 处截断” | **0.55（推断）** | `rules:` 在末尾；YAML 接受 `- DOMA`；截断现象有 issue/curl 证据 | 未看到用户文件尾部/HTTP 头；若响应带 Content-Length 且客户端严格，需中间层/落盘损坏 |
| 9 | BOM 可导致整段 Clash payload 规则集被丢 | **0.9（条件性）** | 实验 P9；`removeUTF8BOM` 死代码；`^payload:` 多行匹配 | 仅当 BOM 与 `payload:` 同一行；典型“先注释后 payload”的文件不受影响（P10） |
| 10 | `FINAL` 普通路径会产出非法类型 | **0.95** | 实验 P3；`ClashRuleTypes` 含 FINAL；只有 `[]` 路径替换 | 抽样流行集未发现 `FINAL` 行；属于潜在 bug |
| 11 | 前缀白名单可产出 `MATCHBOX` 等非法类型 | **0.95** | 实验 P4；`startsWith` | 取决于源规则集是否有这类行 |
| 12 | 行内 `#` + 不加引号可制造 `format invalid` | **0.95** | 实验 P6；YAML 解析测试 | 方括号内容不是 `DOMA`；不是用户这条错误的直接解释 |
| 13 | 规则集下载在 `DOMA` 处截断不会进入输出 | **0.95** | 实验 P8；前缀过滤 | 若用户版本白名单含 `DOMA`（未发现）则例外 |
| 14 | 抽样流行集不含 `DOMA` | **0.9（抽样）** | 40 万+ 行扫描；0 命中 | 未穷举所有仓库/二进制；不能证明全网 |
| 15 | ACL4SSR 有 18 行 `URL-REGEX` | **1.0** | 文件扫描；行号见 §3.2 | 这些行会被 subconverter 丢弃，不会进入 mihomo |
| 16 | 当前 subconverter 响应带 Content-Length | **1.0** | 本地 v0.9.0 `curl -D -` | 公共反代/缓存可能改写；用户链路未验证 |
| 17 | 客户端落盘前没有规则/截断校验 | **0.9** | `profile.ts:158-174` 直接 `setProfileStr`；`factory.ts` 只做 YAML parse/merge | 未审计 Clash Party 全部代码路径/插件 |

### 6.1 仍未验证/无法验证的事项

- **没有拿到用户的 profile 文件、订阅 URL、subconverter 版本/配置、HTTP 响应头**，因此无法确定场景 A/B/C 哪一个真实发生；本文给出判定树。
- **没有在 Clash Party 客户端里复现**（未运行其 Electron 应用）；只核对了源码中的订阅落盘/配置生成逻辑。
- **没有对公共转换服务/中间代理做抓包**；“短 200 响应”是机制推断，不是现场观测。
- **没有穷举所有规则集/历史版本**；“0 个 DOMA”只对本次抽样成立。
- **没有验证 `max_allowed_download_size=0` 在某些版本仍不生效**（既有取证提到 issue #770）；本文只按 v0.9.0 代码说明“0=不限”。
- **没有构造缓存损坏实验**；“缓存截断会被原样使用”是代码阅读结论（`webget.cpp:317-328`），未实际制造损坏缓存。
- **没有验证 `[]` 空输入的 UB 在不同编译器/优化级别下的行为**；实验只代表 v0.9.0 官方 Windows 二进制。

---

## 7. 附录：文件/行号索引

### 7.1 mihomo（`Alpha@478af2a`）

| 内容 | 文件:行 | 链接 |
| --- | --- | --- |
| `RawConfig.Rule []string` | `config/config.go:456` | <https://github.com/MetaCubeX/mihomo/blob/478af2a57c48bdb8e85f6ed93b2c3735e90ceabd/config/config.go#L456> |
| YAML 解码 | `config/config.go:608-622` | <https://github.com/MetaCubeX/mihomo/blob/478af2a57c48bdb8e85f6ed93b2c3735e90ceabd/config/config.go#L608-L622> |
| `ParseRawConfig` 调 `parseRules` | `config/config.go:693-709` | <https://github.com/MetaCubeX/mihomo/blob/478af2a57c48bdb8e85f6ed93b2c3735e90ceabd/config/config.go#L693-L709> |
| `parseRules` 0 基循环 + `format invalid` | `config/config.go:1098-1119` | <https://github.com/MetaCubeX/mihomo/blob/478af2a57c48bdb8e85f6ed93b2c3735e90ceabd/config/config.go#L1098-L1119> |
| `ParseRulePayload` | `rules/common/base.go:47-79` | <https://github.com/MetaCubeX/mihomo/blob/478af2a57c48bdb8e85f6ed93b2c3735e90ceabd/rules/common/base.go#L47-L79> |
| `ParseRule` 类型 switch + unknown type | `rules/parser.go:12-105` | <https://github.com/MetaCubeX/mihomo/blob/478af2a57c48bdb8e85f6ed93b2c3735e90ceabd/rules/parser.go#L12-L105> |
| 逻辑规则递归 | `rules/logic/logic.go:77-86,146-173` | <https://github.com/MetaCubeX/mihomo/blob/478af2a57c48bdb8e85f6ed93b2c3735e90ceabd/rules/logic/logic.go#L77-L173> |
| classical provider 逐行 warning | `rules/provider/classical_strategy.go:40-50` | <https://github.com/MetaCubeX/mihomo/blob/478af2a57c48bdb8e85f6ed93b2c3735e90ceabd/rules/provider/classical_strategy.go#L40-L50> |
| domain provider 跳过非法域名 | `rules/provider/domain_strategy.go:41-47` | <https://github.com/MetaCubeX/mihomo/blob/478af2a57c48bdb8e85f6ed93b2c3735e90ceabd/rules/provider/domain_strategy.go#L41-L47> |
| 官方规则文档 | `Meta-Docs/docs/config/rules/index.md:3-56` | <https://github.com/MetaCubeX/Meta-Docs/blob/2a6ba6b04a9eecdbe5c88c4e4a09776659c0878b/docs/config/rules/index.md#L3-L56> |
| 官方 wiki 页面 | — | <https://wiki.metacubex.one/config/rules/> |

### 7.2 subconverter（`v0.9.0`）

| 内容 | 文件:行 | 链接 |
| --- | --- | --- |
| `ClashRuleTypes` / 方言类型列表 | `src/generator/config/ruleconvert.cpp:12-18` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/generator/config/ruleconvert.cpp#L12-L18> |
| `convertRuleset` / `payload:` 检测 / BOM | `src/generator/config/ruleconvert.cpp:20-96` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/generator/config/ruleconvert.cpp#L20-L96> |
| `transformRuleToCommon` | `src/generator/config/ruleconvert.cpp:98-123` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/generator/config/ruleconvert.cpp#L98-L123> |
| base rules 原样复制 | `src/generator/config/ruleconvert.cpp:201-205` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/generator/config/ruleconvert.cpp#L201-L205> |
| `[]` 内联规则 | `src/generator/config/ruleconvert.cpp:220-229` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/generator/config/ruleconvert.cpp#L220-L229> |
| 逐行过滤/补 group/不加引号 | `src/generator/config/ruleconvert.cpp:236-254` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/generator/config/ruleconvert.cpp#L236-L254> |
| `rules:` 追加在 YAML dump 之后 | `src/generator/config/subexport.cpp:630-631` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/generator/config/subexport.cpp#L630-L631> |
| 15s 超时 / 大小限制 | `src/handler/webget.cpp:134,138-141` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/handler/webget.cpp#L134-L141> |
| 失败清空内容 | `src/handler/webget.cpp:266-270` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/handler/webget.cpp#L266-L270> |
| 缓存命中直接读文件 | `src/handler/webget.cpp:317-328` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/handler/webget.cpp#L317-L328> |
| `keep_resp_on_fail=false` | `src/handler/webget.h:27` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/handler/webget.h#L27> |
| `startsWith` 前缀语义 | `src/utils/string.h:59-62` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/utils/string.h#L59-L62> |
| `split` 朴素逗号分割 | `src/utils/string.cpp:28-38` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/utils/string.cpp#L28-L38> |
| `removeUTF8BOM` 定义（无调用） | `src/utils/string.cpp:316-320` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/utils/string.cpp#L316-L320> |
| 默认限制 | `src/handler/settings.h:33,66` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/handler/settings.h#L33-L66> |
| 规则集类型前缀 | `src/handler/settings.cpp:22` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/handler/settings.cpp#L22> |
| `refreshRulesets` | `src/handler/settings.cpp:248-282` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/handler/settings.cpp#L248-L282> |
| `fetchFileAsync` | `src/handler/multithread.cpp:61-77` | <https://github.com/tindy2013/subconverter/blob/v0.9.0/src/handler/multithread.cpp#L61-L77> |

### 7.3 Clash Party（`main@364578f`）

| 内容 | 文件:行 | 链接 |
| --- | --- | --- |
| 订阅下载（axios，`responseType: text`） | `src/main/config/profile.ts:142-155` | <https://github.com/mihomo-party-org/clash-party/blob/364578f21007cdea0a5b4304acebfa7cf5655b1f/src/main/config/profile.ts#L142-L155> |
| 直接 `setProfileStr(res.data)` | `src/main/config/profile.ts:158-174` | <https://github.com/mihomo-party-org/clash-party/blob/364578f21007cdea0a5b4304acebfa7cf5655b1f/src/main/config/profile.ts#L158-L174> |
| `yaml.parse` 但不校验规则 | `src/main/config/profile.ts:200-204` | <https://github.com/mihomo-party-org/clash-party/blob/364578f21007cdea0a5b4304acebfa7cf5655b1f/src/main/config/profile.ts#L200-L204> |
| `yaml.stringify` 生成运行时配置 | `src/main/config/factory.ts:27-46` | <https://github.com/mihomo-party-org/clash-party/blob/364578f21007cdea0a5b4304acebfa7cf5655b1f/src/main/config/factory.ts#L27-L46> |
| override JS/YAML | `src/main/config/factory.ts:69-91` | <https://github.com/mihomo-party-org/clash-party/blob/364578f21007cdea0a5b4304acebfa7cf5655b1f/src/main/config/factory.ts#L69-L91> |
| profile 路径 | `src/main/utils/dirs.ts:83-93` | <https://github.com/mihomo-party-org/clash-party/blob/364578f21007cdea0a5b4304acebfa7cf5655b1f/src/main/utils/dirs.ts#L83-L93> |

### 7.4 规则集 URL

| 文件 | URL |
| --- | --- |
| ACL4SSR ChinaDomain | <https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaDomain.list> |
| ACL4SSR ChinaIp | <https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaIp.list> |
| ACL4SSR Download | <https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Download.list> |
| ACL4SSR ChinaMedia | <https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ChinaMedia.list> |
| ACL4SSR ProxyMedia | <https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ProxyMedia.list> |
| ACL4SSR Ruleset/Iqiyi | <https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/Ruleset/Iqiyi.list> |
| blackmatrix7 Advertising_Classical | <https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Advertising/Advertising_Classical.yaml> |
| blackmatrix7 Advertising | <https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Advertising/Advertising.yaml> |
| Loyalsoldier direct | <https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/direct.txt> |
| Loyalsoldier proxy | <https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/proxy.txt> |
| Loyalsoldier gfw | <https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/gfw.txt> |
| Loyalsoldier reject | <https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/reject.txt> |
| v2fly data/google | <https://raw.githubusercontent.com/v2fly/domain-list-community/master/data/google> |

---

## 8. 附录：可复现命令与测试代码

### 8.1 克隆与版本

```bash
# mihomo：注意 main 不是 Go 源码，使用 Alpha
git clone --depth 1 --branch Alpha https://github.com/MetaCubeX/mihomo.git /tmp/mihomo-go
git -C /tmp/mihomo-go log -1 --format='%H %ci %s'

# subconverter v0.9.0 源码
git clone --depth 1 https://github.com/tindy2013/subconverter.git /tmp/subconverter-src

# 规则集
git clone --depth 1 https://github.com/ACL4SSR/ACL4SSR.git /tmp/acl4ssr
git clone --depth 1 https://github.com/Loyalsoldier/clash-rules.git /tmp/clash-rules
```

### 8.2 关键 Go 测试（真实源码函数）

`/tmp/mihomo-go/rules/common/zz_diag_test.go`：

```go
package common

import (
    "fmt"
    "testing"
)

func TestParseRulePayloadDiag(t *testing.T) {
    cases := []string{
        "DOMA", "DOMA,example.com", "DOMA,example.com,PROXY", "",
        "DOMAIN,,PROXY", "DOMAIN,example.com", "DOMAIN,example.com,PROXY",
        "DOMAIN-SUFFIX,example.com,PROXY", "MATCH,PROXY", "MATCH",
        "DOMAIN-REGEX,^abc.*\\.com$,PROXY",
        "AND,((DOMAIN,baidu.com),(NETWORK,udp)),DIRECT",
    }
    for _, c := range cases {
        tp, payload, target, params := ParseRulePayload(c, true)
        fmt.Printf("IN=%q => tp=%q payload=%q target=%q params=%q\n",
            c, tp, payload, target, params)
    }
}
```

运行：

```bash
cd /tmp/mihomo-go
GOPROXY=https://goproxy.cn,direct go test ./rules/common -run TestParseRulePayloadDiag -count=1 -v
GOPROXY=https://goproxy.cn,direct go test ./rules -run TestParseRuleDiag -count=1 -v
GOPROXY=https://goproxy.cn,direct go test ./config -run TestParseRulesDiag -count=1 -v
```

> 说明：本机默认 `GOPROXY=https://proxy.golang.org,direct` 因 IPv6 路由失败，改用 `https://goproxy.cn` 才拉到依赖；这只影响依赖下载，不影响被测代码。

历史 tag 的 `DOMA` 核对：

```bash
for tag in v1.15.0 v1.16.0 v1.17.0 v1.18.0 v1.19.33; do
  echo "== $tag"
  curl -sS "https://raw.githubusercontent.com/MetaCubeX/mihomo/$tag/rules/parser.go" \
    | grep -n '"DOMA"\|"DOMAIN"'
done
```

本次输出只命中 `"DOMAIN"`（各 tag 行号略有差异），没有 `"DOMA"`。

### 8.3 subconverter 端到端最小实验

```bash
# 1) 启动 subconverter（官方 v0.9.0 发行版）
cd /tmp/sc-run/subconverter
./subconverter.exe          # 监听 127.0.0.1:25500

# 2) 启动一个本地 HTTP 服务提供测试文件
python -m http.server 8010 --bind 127.0.0.1 \
  --directory 'C:\Users\admin\AppData\Local\Temp\sc-test'

# 3) 订阅（只含一个 ss 节点）
cat > sub.yaml <<'EOF'
proxies:
  - name: Test
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-256-gcm
    password: test
EOF

# 4) 规则集：包含裸 DOMA
cat > bad.list <<'EOF'
# comment
DOMAIN,good.example.com
DOMA
DOMAIN-SUFFIX,ok.example.com
EOF

# 5) 调 subconverter（ruleset 参数是 "GROUP,URL" 的 urlsafe base64）
RS=$(python -c "import base64;print(base64.urlsafe_b64encode(b'GROUP,http://127.0.0.1:8010/bad.list').decode())")
curl -sS -G http://127.0.0.1:25500/sub \
  --data-urlencode 'target=clash' \
  --data-urlencode 'url=http://127.0.0.1:8010/sub.yaml' \
  --data-urlencode "ruleset=$RS" \
  -o out.yaml
sed -n '/^rules:/,$p' out.yaml
```

输出：

```yaml
rules:
  - DOMAIN,good.example.com,GROUP
  - DOMAIN-SUFFIX,ok.example.com,GROUP
```

`DOMA` 被丢弃；正常规则都补了 `,GROUP`。  
把 `bad.list` 换成 §2.4 的其他样例，即可复现 P1–P19 的对应输出。

### 8.4 抽样扫描（无 YAML 依赖的版本）

```python
# 简化版：按行统计 token；完整脚本见本次取证记录
import sys, collections

KNOWN = {...}  # 37 个 mihomo 类型
for path in sys.argv[1:]:
    raw = open(path, "rb").read()
    text = raw.decode("utf-8", "replace")
    lines = text.splitlines()
    doma = 0; typed = 0; one = 0; unknown = collections.Counter()
    for i, line in enumerate(lines, 1):
        s = line.strip().lstrip("\ufeff")
        if s.startswith("- "):
            s = s[2:].strip()
        if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"":
            s = s[1:-1]
        if not s or s[0] in ";#" or s.startswith("//"):
            continue
        tok = s.split(",", 1)[0].strip()
        up = tok.upper()
        if up == "DOMA":
            doma += 1
            print(f"{path}:{i}: {line!r}")
        if up in KNOWN:
            typed += 1
            if "," not in s:
                one += 1
                print(f"ONE-FIELD {path}:{i}: {line!r}")
        else:
            unknown[up] += 1
    print(path, "lines", len(lines), "typed", typed, "DOMA", doma,
          "one-field", one, "unknown", unknown.most_common(5))
```

### 8.5 本次未能执行的检查

- 没有运行 Clash Party 客户端本身（Electron 应用），只读源码。
- 没有用 `mihomo -t` 跑完整配置文件；用的是 `go test` 直接调用 `parseRules`/`ParseRulePayload`/`ParseRule`。
- 没有对用户的具体订阅 URL 做抓包/HTTP 头对比（没有用户的 URL）。
- 没有扫描 blackmatrix7 全部 669 个目录、`.mrs`、`geosite.dat`。
- 没有构造“短 200 响应 + Content-Length 匹配”的中间层实验；该场景是代码/协议层推断。

---

## 9. 一句话给用户

先看你的 `profiles/<id>.yaml` 最后一行：**如果文件真的在 `- DOMA` 处结束，就是订阅被截断了，重新下载/换直连/换转换后端；如果文件正常结束，就在配置源里搜 `[]DOMA` 或 base `rules` 的 `DOMA`。** 这条错误的方括号里是整行原文，不是类型；`DOMA` 本身不是 mihomo 的合法类型，也不是任何流行规则集的写法。
