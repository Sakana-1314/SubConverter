# AGENTS.md

SubConverter（订阅转换 Cloudflare Worker）。事实标准以代码与各目录内文档为准，本文件不重复实现细节与历史决策。

## 唯一约定

**禁止未经明确授权修改 AGENTS.md。** 未获得用户明确授权，任何智能体不得增删改本文件。

## 目录

- `src/` - Worker 源码（HTTP、订阅解析、规则校验、Clash 生成）
- `tests/` - 单元与集成测试
- `fixtures/e2e/` - 验收夹具
- `scripts/` - 本地验收脚本
- `docs/` - SPEC / ARCHITECTURE / PARITY / research / REPORT
- `test/` - 大型规则回归夹具
- `.github/workflows/` - CI

根目录只放 `AGENTS.md`、`README.md`、`LICENSE`（如添加）、`package.json`、`package-lock.json`、`tsconfig.json`、`wrangler.toml`、`vitest.config.ts`、`.gitignore`、`.editorconfig`；文档与脚本放进所属目录内部。

## 隐私与密钥

- `.private/`、`.zcode/`、`out/`、`dist/`、`.wrangler/`、`node_modules/` 不得进入 git。
- `tools/mihomo/` 只提交 `source.json`；可执行文件、压缩包、GeoIP 数据库不提交。
- 严禁把订阅 URL、token、节点密码、UUID、Cookie、内部域名写进源码、测试夹具、日志或文档。
- 生产配置一律用 `wrangler` secrets / 环境变量；仓库内不提交 `.dev.vars`。

## 协作与提交

- 作者与提交者统一使用当前 GitHub 账号的名称和邮箱，SSH 私钥或 GPG 私钥签名：

  ```bash
  git config user.name "Sakana"
  git config user.email "admin@yangrucheng.top"
  git config user.signingkey "C:/Users/admin/.ssh/private.key"
  git config gpg.format ssh
  git config commit.gpgsign true
  ```

- 必须走 PR：`gh pr create` → 等 `测试` workflow → `gh pr checks` 全绿后 `gh pr merge --squash --delete-branch` 并删除 head 分支；禁止本地 merge 后直推 `main`（会把 PR 关成 CLOSED 而非 MERGED）。
- 空仓库首次初始化允许直接推 `main` 建立基线；基线之后所有改动必须走 PR。
- 分支前缀 `feat/`、`fix/`、`refactor/`、`docs/`、`chore/`；提交信息中文，格式 `type(scope): 描述`。
- 测试由 GitHub Actions `测试` 执行；未绿不得合并。本地最低检查：`npm run typecheck`、`npm test`、`npm run build`。
- 工作流 `name` 用中文（专有名词除外）；严禁硬编码 IP、密钥与内部域名，一律 `${{ secrets.* }}`。
- PR 描述用 `## 改动`、`## 验证` 两节；有风险或未覆盖项时加 `## 已知限制`。

## 部署

- `npm run deploy` 前先 `npm run typecheck && npm test && npm run build`。
- 真实 ACL4SSR 全模板需要 `REQUEST_DEADLINE_MS=30000`、`UPSTREAM_TIMEOUT_MS=20000`、`PER_HOP_TIMEOUT_MS=10000`（`wrangler.toml` 已设）。
- 公开部署最低要求：`workers_dev=false` 或 Cloudflare Access/WAF；限制 `MAX_UPSTREAM_BYTES`/`MAX_RULES`/`MAX_NODES`；不要匿名暴露 `/getruleset`。
- 已知残余风险与真实订阅验收见 `docs/REAL-SUBSCRIPTION-ACCEPTANCE.md`、`docs/REPORT.md` §7/§9。
