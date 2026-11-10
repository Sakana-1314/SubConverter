# Acceptance report

- Generated at: 2026-11-10T00:37:40.367Z
- Command: `npm.cmd run acceptance` (runs `tsx scripts/acceptance.ts`)
- Platform: win32 x64; Node v24.21.0
- Workspace: `C:\Users\admin\Documents\ZCode Projects\订阅转换`
- Result: **PASS** — 28/28 checks passed
- Exit code: 0

## Fixtures

| Fixture | Size | Shape |
|---|---:|---|
| `tests/fixtures/e2e/subscription.txt` | 1485 B | base64 of 1113-char URI list; 5 supported URIs + 1 bad hysteria2 link; decoded 1113 B |
| `tests/fixtures/e2e/rules-big.txt` | 526435 B | 20676 lines; 20,674 legal DOMAIN rules; line 20675=DOMA,example.com; line 20676=DOMA (no final newline) |
| `tests/fixtures/e2e/rules-bom-crlf.txt` | 59 B | BOM=true; CRLF=true; 2 typed rules |
| `tests/fixtures/e2e/error-page.html` | 202 B | HTML error page served as text/html |
| `tests/fixtures/e2e/acl4ssr.ini` | 644 B | ACL4SSR subset: 4 custom_proxy_group + 3 inline ruleset + rename + clash_rule_base |

The 20k-rule fixture is intentionally oversized for `inline:` (526,435 B > 8,192 B decoded limit), so it is served by a loopback fixture server through the documented `ENVIRONMENT=test` / `ALLOW_TEST_UPSTREAM_HOSTS` escape hatch. Its layout is:

- lines 1..20674: `DOMAIN,x<N>.example.com` (20,674 legal rules)
- line 20675 (0-based 20674): `DOMA,example.com`
- line 20676 (0-based 20675): `DOMA`, with no final newline (truncated tail)
- `tests/fixtures/e2e/rules-bom-crlf.txt`: UTF-8 BOM + CRLF rules
- `tests/fixtures/e2e/error-page.html`: HTML error page, must fail the source only

## Conversion

- Main request: `/sub?url=inline%3ASXlCbE1tVWdZV05qWlhCMFlXNWpaU0J6ZFdKelkzSnBjSFJwYjI0NklITnpJQ2hUU1ZBd01ESXBMQ0J6YzNJc0lIWnRaWE56TENCMGNtOXFZVzRzSUhac1pYTnpJQ3NnTVNCaVlXUWdiR2x1YXk0S0l5QlVhR2x6SUdacGJHVWdhWE1nWW1GelpUWTBMV1Z1WTI5a1pXUWdLSE4wWVc1a1lYSmtJR0ZzY0doaFltVjBMQ0J3WVdSa2FXNW5LU0J3WlhJZ1UxQkZReUF6TGpFdUNuTnpPaTh2V1ZkV2VreFVTVEZPYVRGdVdUSXdObU16VFhSalIwWjZZM2RBTVM0eUxqTXVORG80TXpnNEkxTlRKVEl3VG05a1pRcHpjM0k2THk5ak0wNTVURzFXTkZsWE1YZGlSMVYxV1RJNWRFOXFaM3BQUkdjMldWaFdNR0ZHT1dwaFIwWndZbXc1YUU5dFJteGplVEI1VGxSWmRGa3lXbWxQYldnd1pFaENabU15YkhSalIzaHNUMjFOZWxSdWJFMVhSVXB2V1hwT1RreDZPWGxhVnpGb1kyMTBlbEJXVlhoVWJFNUt…(2205 chars)`
- Generated config: `C:\Users\admin\Documents\ZCode Projects\订阅转换\out\generated.yaml` (776547 B)
- Stats: `{"nodes":5,"groups":2,"rules":20677,"providers":0,"sources":1,"bytesIn":527978,"bytesOut":776547,"warnings":8,"warningCodes":["E_FETCH_HTML","E_NODE_SCHEME_UNSUPPORTED","E_RULE_NO_TARGET","E_RULE_UNKNOWN_TYPE","E_TRUNCATED_TAIL","W_DEFAULT_MATCH_ADDED","W_GROUP_DEFAULT_ADDED","W_INPUT_BASE64_DETECTED"]}`
- INI config: `C:\Users\admin\Documents\ZCode Projects\订阅转换\out\generated-ini.yaml` (2413 B)
- INI stats: `{"nodes":5,"groups":4,"rules":4,"providers":0,"sources":1,"bytesIn":2128,"bytesOut":2413,"warnings":6,"warningCodes":["E_NODE_SCHEME_UNSUPPORTED","W_BUILTIN_TEMPLATE_MAPPED","W_CONFIG_KEY_UNSUPPORTED","W_CONFIG_SECTION_IGNORED","W_DEFAULT_MATCH_ADDED","W_INPUT_BASE64_DETECTED"]}`
- Loopback fixture requests served: /rules-big.txt, /rules-bom-crlf.txt, /error-page.html, /rules-big.txt, /rules-bom-crlf.txt, /error-page.html

## Checks

| # | Check | Result | Evidence |
|---:|---|---|---|
| 1 | `fixtures_shape` | PASS | subscription.txt (5 URIs + 1 bad), rules-big.txt (20,676 lines, 20,674 legal), BOM/CRLF, HTML, INI all match the documented shape |
| 2 | `http_200_diagnostics_json` | PASS | status=200 content-type=application/json; charset=utf-8 diagnostics=true elapsedMs=876 |
| 3 | `diagnostics_stats_match_output` | PASS | stats={"nodes":5,"groups":2,"rules":20677,"providers":0,"sources":1,"bytesIn":527978,"bytesOut":776547,"warnings":8,"warningCodes":["E_FETCH_HTML","E_NODE_SCHEME_UNSUPPORTED","E_RULE_NO_TARGET","E_RULE_UNKNOWN_TYPE","E_TRUNCATED_TAIL","W_DEFAULT_MATCH_ADDED","W_GROUP_DEFAULT_ADDED","W_INPUT_BASE64_DETECTED"]} warnings=8 |
| 4 | `generated_yaml_parses` | PASS | yaml.parse OK; proxies/proxy-groups/rules arrays present |
| 5 | `proxies_count_and_protocol_types` | PASS | 5 proxies: ss(SIP002), ssr, vmess, trojan, vless; fields verified (ss aes-256-gcm, ssr auth_chain_a/http_simple, vmess ws+tls, trojan ws, vless tcp+reality) |
| 6 | `doma_dropped_from_output` | PASS | no rule starts with DOMA and no ,DOMA, appears in generated YAML |
| 7 | `doma_warnings_with_line_numbers` | PASS | E_RULE_UNKNOWN_TYPE=["E_RULE_UNKNOWN_TYPE@line=20675 raw=\"DOMA,example.com\" source=ruleset#1"]; E_RULE_NO_TARGET=["E_RULE_NO_TARGET@line=20676 raw=\"DOMA\" source=ruleset#1"]; E_TRUNCATED_TAIL=["E_TRUNCATED_TAIL@line=20676 raw=\"DOMA\" source=ruleset#1"] |
| 8 | `bad_link_is_warning_not_fatal` | PASS | HTTP 200 with 8 warnings; bad link -> ["E_NODE_SCHEME_UNSUPPORTED@line=8 raw=\"hysteria2://[redacted]\" source=url#1"] |
| 9 | `html_error_page_source_rejected` | PASS | E_FETCH_HTML=["E_FETCH_HTML@line=- raw=\"\" source=ruleset#3"]; conversion still returned 200 |
| 10 | `fixture_server_served_all_sources` | PASS | served=["/rules-big.txt","/rules-bom-crlf.txt","/error-page.html"] |
| 11 | `20k_rules_and_bom_crlf_kept` | PASS | legal DOMAIN rules=20674/20674; total rules=20677; BOM rule=true; CRLF rule=true; first=DOMAIN,x0.example.com,PROXY; last=MATCH,PROXY |
| 12 | `main_yaml_readback` | PASS | yaml.parse OK; proxies=5 groups=2 rules=20677 |
| 13 | `main_proxy_fields` | PASS | all 5 proxies have valid name/type/integer port |
| 14 | `main_group_references_exist` | PASS | 2 groups; all members resolve to proxies/groups/builtins |
| 15 | `main_project_rule_revalidation` | PASS | 20677 emitted rules re-parsed with rules.parseRuleLine (mode=template, knownTargets+knownProviders) |
| 16 | `main_independent_whitelist_validation` | PASS | 20677 rules: all types in the independent 37-type whitelist; targets resolve; exactly one trailing MATCH |
| 17 | `main_rule_targets_exist` | PASS | all 20677 rule targets are generated groups, proxies or builtins |
| 18 | `deterministic_output` | PASS | two identical /sub calls produced byte-identical output (sha256=db79b6253e68069e17631779ed9fb8f210ff2a76d746b33989e0f4bbfc4fbb2a) |
| 19 | `ini_conversion_http_200` | PASS | status=200 stats={"nodes":5,"groups":4,"rules":4,"providers":0,"sources":1,"bytesIn":2128,"bytesOut":2413,"warnings":6,"warningCodes":["E_NODE_SCHEME_UNSUPPORTED","W_BUILTIN_TEMPLATE_MAPPED","W_CONFIG_KEY_UNSUPPORTED","W_CONFIG_SECTION_IGNORED","W_DEFAULT_MATCH_ADDED","W_INPUT_BASE64_DETECTED"]} |
| 20 | `ini_config_applied` | PASS | 5 proxies (SS Node renamed), groups=["PROXY","AUTO","Fallback","LB"], rules=["DOMAIN-SUFFIX,example.org,PROXY","DOMAIN-KEYWORD,example,PROXY","DOMAIN,ads.example.com,DIRECT","MATCH,PROXY"], AUTO url-test fields + Fallback interval + LB !!TYPE=^SS$ verified, built-in template mixed-port=7890 |
| 21 | `ini_config_warnings` | PASS | warnings=["E_NODE_SCHEME_UNSUPPORTED","W_BUILTIN_TEMPLATE_MAPPED","W_CONFIG_KEY_UNSUPPORTED","W_CONFIG_SECTION_IGNORED","W_DEFAULT_MATCH_ADDED","W_INPUT_BASE64_DETECTED"] missing=[] |
| 22 | `ini_yaml_readback` | PASS | yaml.parse OK; proxies=5 groups=4 rules=4 |
| 23 | `ini_proxy_fields` | PASS | all 5 proxies have valid name/type/integer port |
| 24 | `ini_group_references_exist` | PASS | 4 groups; all members resolve to proxies/groups/builtins |
| 25 | `ini_project_rule_revalidation` | PASS | 4 emitted rules re-parsed with rules.parseRuleLine (mode=template, knownTargets+knownProviders) |
| 26 | `ini_independent_whitelist_validation` | PASS | 4 rules: all types in the independent 37-type whitelist; targets resolve; exactly one trailing MATCH |
| 27 | `ini_rule_targets_exist` | PASS | all 4 rule targets are generated groups, proxies or builtins |
| 28 | `mihomo_-t_accepts_generated_config` | PASS | exit=0; command=tools/mihomo/mihomo.exe -t -d tools/mihomo -f out/generated.yaml; asset=mihomo-windows-amd64-v1.19.33.zip sha256=6ab2180875f9f6fff8b19386d760daec257f66b45f72b3afc650634272fa837a |

## mihomo client validation

- Command: `tools/mihomo/mihomo.exe -t -d tools/mihomo -f out/generated.yaml`
- Binary cached: yes
- Acquisition: curl from official MetaCubeX/mihomo GitHub release (cached binary reused)
- Official release: `v1.19.33`
- Asset: `mihomo-windows-amd64-v1.19.33.zip`
- URL: https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33/mihomo-windows-amd64-v1.19.33.zip
- Asset size (GitHub API): 22512121 B; downloaded: 22512121 B
- SHA-256 (computed locally): `6ab2180875f9f6fff8b19386d760daec257f66b45f72b3afc650634272fa837a`
- Checksum: official release publishes no SHA-256 checksum asset (only version.txt)
- Exit code: 0
- stderr: empty (0 bytes)
- stdout (tail):
```text
time="2026-11-10T08:37:40.234612300+08:00" level=info msg="Start initial configuration in progress"
time="2026-11-10T08:37:40.235138400+08:00" level=info msg="Geodata Loader mode: memconservative"
time="2026-11-10T08:37:40.235138400+08:00" level=info msg="Geosite Matcher implementation: succinct"
time="2026-11-10T08:37:40.350808600+08:00" level=info msg="Initial configuration complete, total time: 116ms"
configuration file C:\Users\admin\Documents\ZCode Projects\订阅转换\out\generated.yaml test is successful

```
- Verdict: PASS (`mihomo -t` exit 0)

## Not covered

- official mihomo v1.19.33 release publishes no SHA-256 checksum asset (only version.txt); local SHA-256 6ab2180875f9f6fff8b19386d760daec257f66b45f72b3afc650634272fa837a is recorded in tools/mihomo/source.json but could not be verified against an official checksum

