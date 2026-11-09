import { describe, expect, it } from 'vitest';
import { parseAcL4ssrIni } from '../../../src/rules/ini';

const CONFIG = [
  '\uFEFF# top comment',
  '[template]',
  'foo=bar',
  '[custom]',
  '; comment',
  '// another comment',
  'custom_proxy_group=PROXY`select`[]DIRECT',
  'custom_proxy_group=AUTO`url-test`[]n1`https://x.test/204`300,50',
  'ruleset=G,https://x.test/rules.list',
  'surge_ruleset=G2,https://y.test/list,3600',
  'enable_rule_generator=false',
  'overwrite_original_rules=0',
  'rename=^old@new',
  'rename=(a+)+$@x',
  'include_remarks=HK',
  'exclude_remarks=[',
  'clash_rule_base=base/all_base.tpl',
  'emoji=true',
  'unknown_key=x',
  '{% if x %}',
].join('\r\n');

function codes(warnings: ReadonlyArray<{ code: string }>): string[] {
  return warnings.map((warning) => warning.code);
}

describe('INI: [custom] parsing (SPEC §8)', () => {
  it('parses supported keys, accumulates repeated keys, defaults overwrite=true', () => {
    const result = parseAcL4ssrIni(CONFIG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.config.customProxyGroups).toEqual([
      'PROXY`select`[]DIRECT',
      'AUTO`url-test`[]n1`https://x.test/204`300,50',
    ]);
    expect(result.config.rulesets).toEqual([
      'G,https://x.test/rules.list',
      'G2,https://y.test/list,3600',
    ]);
    expect(result.config.enableRuleGenerator).toBe(false);
    expect(result.config.overwriteOriginalRules).toBe(false);
    expect(result.config.rename).toEqual(['^old@new']);
    expect(result.config.includeRemarks).toEqual(['HK']);
    expect(result.config.excludeRemarks).toEqual([]);
    expect(result.config.clashRuleBase).toBe('base/all_base.tpl');
    expect(result.config.ignoredSections).toEqual(['template']);
    expect(result.config.unsupportedKeys).toEqual(['emoji', 'unknown_key']);

    const warningCodes = codes(result.warnings);
    expect(warningCodes).toContain('W_CONFIG_SECTION_IGNORED');
    expect(warningCodes).toContain('W_CONFIG_KEY_UNSUPPORTED');
    expect(result.warnings.every((warning) => warning.stage === 'template')).toBe(true);
    expect(result.warnings.every((warning) => warning.source === 'config')).toBe(true);
  });

  it('defaults overwrite_original_rules to true', () => {
    const result = parseAcL4ssrIni('[custom]\nenable_rule_generator=1\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.overwriteOriginalRules).toBe(true);
    expect(result.config.enableRuleGenerator).toBe(true);
    expect(result.config.rename).toEqual([]);
  });

  it('keeps defaults and warns on invalid booleans', () => {
    const result = parseAcL4ssrIni(
      '[custom]\nenable_rule_generator=maybe\noverwrite_original_rules=maybe\n',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.enableRuleGenerator).toBe(true);
    expect(result.config.overwriteOriginalRules).toBe(true);
    expect(codes(result.warnings).filter((code) => code === 'W_CONFIG_KEY_UNSUPPORTED')).toHaveLength(2);
  });

  it('ignores invalid rename/remarks regexes with warnings', () => {
    const result = parseAcL4ssrIni(
      '[custom]\nrename=(a+)+$@x\nrename=@new\ninclude_remarks=[\nexclude_remarks=ok\n',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.rename).toEqual([]);
    expect(result.config.includeRemarks).toEqual([]);
    expect(result.config.excludeRemarks).toEqual(['ok']);
    expect(codes(result.warnings).filter((code) => code === 'W_CONFIG_KEY_UNSUPPORTED')).toHaveLength(3);
  });

  it('ignores keys in other sections and unsupported tolerated keys', () => {
    const result = parseAcL4ssrIni(
      '[custom]\nenable_rule_generator=true\n[template]\nrules=base\n[routing]\ninsert_url=x\n',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.ignoredSections).toEqual(['template', 'routing']);
    expect(codes(result.warnings).filter((code) => code === 'W_CONFIG_SECTION_IGNORED')).toHaveLength(2);
  });

  it('warns on empty clash_rule_base and non-key lines', () => {
    const result = parseAcL4ssrIni('[custom]\nclash_rule_base=\n{% if x %}\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.clashRuleBase).toBeUndefined();
    expect(codes(result.warnings).filter((code) => code === 'W_CONFIG_KEY_UNSUPPORTED')).toHaveLength(2);
  });
});

describe('INI: invalid config detection and limits', () => {
  it('rejects content without [custom] and without known keys', () => {
    for (const text of ['', 'hello world', 'hello=world\n']) {
      const result = parseAcL4ssrIni(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) expect(result.code).toBe('invalid_config');
    }
  });

  it('accepts a known key even without [custom]', () => {
    const result = parseAcL4ssrIni('enable_rule_generator=false\n');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.enableRuleGenerator).toBe(false);
  });

  it('accepts an empty [custom] section', () => {
    const result = parseAcL4ssrIni('[Custom]\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.customProxyGroups).toEqual([]);
    expect(result.config.overwriteOriginalRules).toBe(true);
  });

  it('enforces the byte size limit', () => {
    const result = parseAcL4ssrIni('[custom]\n', 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_config');
  });

  it('does not execute Jinja and treats it as an unsupported key', () => {
    const result = parseAcL4ssrIni('[custom]\nenable_rule_generator={% if x %}true{% endif %}\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.enableRuleGenerator).toBe(true);
    expect(codes(result.warnings)).toContain('W_CONFIG_KEY_UNSUPPORTED');
  });
});
