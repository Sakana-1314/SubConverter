import { describe, expect, it } from 'vitest';
import {
  detectDialect,
  extractRuleLines,
  buildRules,
  buildRulesetDocument,
  canBeProvider,
  decideBehavior,
  parseRuleLine,
  parseRuleLines,
  providerName,
  serializeRulesetPayload,
  splitRuleLine,
  toRulesetPayload,
  type ValidationContext,
} from '../../../src/rules/index';
import type { Rule } from '../../../src/types';

function ctx(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    sourceId: 'url#1',
    mode: 'template',
    knownTargets: new Set(['PROXY', 'G', 'AUTO']),
    knownProviders: new Set(['rs_ok']),
    allowMatch: true,
    ...overrides,
  };
}

function failureCode(result: ReturnType<typeof parseRuleLine>): string | undefined {
  if (result.ok) return undefined;
  const error = result.warnings.find((warning) => warning.code.startsWith('E_'));
  return error?.code ?? result.warnings[0]?.code;
}

function codes(warnings: ReadonlyArray<{ code: string }>): string[] {
  return warnings.map((warning) => warning.code);
}

describe('split: field splitting by type group (SPEC §5.3)', () => {
  it('splits normal template rules and preserves no-resolve only for IP types', () => {
    const rule = splitRuleLine('IP-CIDR,1.2.3.0/24,PROXY,no-resolve', 'IP-CIDR', {
      mode: 'template',
    });
    expect(rule).toMatchObject({
      ok: true,
      type: 'IP-CIDR',
      payload: '1.2.3.0/24',
      target: 'PROXY',
      params: ['no-resolve'],
      targetPresent: true,
    });

    const ignored = splitRuleLine('DOMAIN,x,PROXY,no-resolve', 'DOMAIN', { mode: 'template' });
    expect(ignored.ok).toBe(true);
    if (ignored.ok) {
      expect(ignored.params).toEqual([]);
      expect(codes(ignored.warnings)).toEqual(['W_RULE_PARAM_IGNORED']);
    }
  });

  it('splits comma-bearing payloads using the last field as target', () => {
    const regex = splitRuleLine('DOMAIN-REGEX,^a{1,3}$,PROXY', 'DOMAIN-REGEX', {
      mode: 'template',
    });
    expect(regex).toMatchObject({
      ok: true,
      payload: '^a{1,3}$',
      target: 'PROXY',
    });

    const logic = splitRuleLine(
      'AND,((DOMAIN,a.com),(NETWORK,tcp)),PROXY',
      'AND',
      { mode: 'template' },
    );
    expect(logic).toMatchObject({
      ok: true,
      payload: '((DOMAIN,a.com),(NETWORK,tcp))',
      target: 'PROXY',
    });
  });

  it('takes the target from the wrapper for ruleset sources', () => {
    const result = splitRuleLine('DOMAIN,example.com,OTHER', 'DOMAIN', {
      mode: 'ruleset',
      wrapperGroup: 'G',
      knownTargets: new Set(['G', 'OTHER']),
    });
    expect(result).toMatchObject({ ok: true, payload: 'example.com', target: 'G' });
    if (result.ok) expect(codes(result.warnings)).toEqual(['W_RULE_SOURCE_TARGET_IGNORED']);
  });

  it('strips known wrapper targets from comma-bearing payloads (P0-5)', () => {
    const result = splitRuleLine('DOMAIN-REGEX,^a{1,3}$,G', 'DOMAIN-REGEX', {
      mode: 'ruleset',
      wrapperGroup: 'G',
      knownTargets: new Set(['G']),
    });
    expect(result).toMatchObject({ ok: true, payload: '^a{1,3}$', target: 'G' });
    if (result.ok) expect(codes(result.warnings)).toEqual(['W_RULE_SOURCE_TARGET_IGNORED']);
  });

  it('keeps an unknown target-like last field as payload and warns ambiguous', () => {
    const result = splitRuleLine('DOMAIN-REGEX,^a{1,3}$,UNKNOWN', 'DOMAIN-REGEX', {
      mode: 'ruleset',
      wrapperGroup: 'G',
      knownTargets: new Set(['G']),
    });
    expect(result).toMatchObject({
      ok: true,
      payload: '^a{1,3}$,UNKNOWN',
      target: 'G',
    });
    if (result.ok) expect(codes(result.warnings)).toEqual(['W_RULE_SOURCE_TARGET_AMBIGUOUS']);
  });

  it('splits MATCH and ignores extra fields', () => {
    const match = splitRuleLine('MATCH,PROXY,EXTRA', 'MATCH', { mode: 'template' });
    expect(match).toMatchObject({ ok: true, payload: '', target: 'PROXY' });
    if (match.ok) expect(codes(match.warnings)).toEqual(['W_RULE_PARAM_IGNORED']);

    const ruleset = splitRuleLine('MATCH,PROXY', 'MATCH', {
      mode: 'ruleset',
      wrapperGroup: 'G',
    });
    expect(ruleset).toMatchObject({ ok: true, target: 'G' });
    if (ruleset.ok) expect(codes(ruleset.warnings)).toEqual(['W_RULE_SOURCE_TARGET_IGNORED']);
  });

  it('supports provider context without a target', () => {
    const result = splitRuleLine('DOMAIN,example.com,LegacyPolicy', 'DOMAIN', {
      mode: 'provider',
      knownTargets: new Set(['G']),
    });
    expect(result).toMatchObject({ ok: true, payload: 'example.com', target: '' });
    if (result.ok) expect(codes(result.warnings)).toEqual(['W_RULE_SOURCE_TARGET_IGNORED']);
  });

  it('rejects empty lines and missing targets', () => {
    expect(splitRuleLine('', 'DOMAIN')).toMatchObject({ ok: false });
    const missing = splitRuleLine('DOMAIN,example.com', 'DOMAIN', { mode: 'template' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issue.code).toBe('E_RULE_NO_TARGET');
  });
});

describe('parse: normalization, aliases and fail-closed matrix (AC-10)', () => {
  it('normalizes case, BOM and full-width commas', () => {
    const lower = parseRuleLine('domain,Example.COM,PROXY', ctx(), 12);
    expect(lower.ok).toBe(true);
    if (lower.ok) {
      expect(lower.rule).toMatchObject({ type: 'DOMAIN', payload: 'example.com', target: 'PROXY' });
      expect(lower.rule.line).toBe(12);
      expect(lower.rule.sourceId).toBe('url#1');
    }

    const bom = parseRuleLine('\uFEFFDOMAIN,a.com,PROXY', ctx());
    expect(bom.ok).toBe(true);

    const fullWidth = parseRuleLine('DOMAIN，example.com，PROXY', ctx());
    expect(fullWidth.ok).toBe(true);
    if (fullWidth.ok) expect(fullWidth.rule).toMatchObject({ payload: 'example.com', target: 'PROXY' });
  });

  it('strips inline comments for normal types but not regex types', () => {
    const commented = parseRuleLine('DOMAIN,example.com,PROXY # comment', ctx());
    expect(commented.ok).toBe(true);
    if (commented.ok) {
      expect(commented.rule.target).toBe('PROXY');
      expect(codes(commented.warnings)).toEqual(['W_RULE_INLINE_COMMENT']);
    }

    const commentWithoutTarget = parseRuleLine('DOMAIN,x #c,G', ctx());
    expect(failureCode(commentWithoutTarget)).toBe('E_RULE_NO_TARGET');
    if (!commentWithoutTarget.ok) {
      expect(codes(commentWithoutTarget.warnings)).toEqual(['W_RULE_INLINE_COMMENT', 'E_RULE_NO_TARGET']);
    }

    const regex = parseRuleLine('DOMAIN-REGEX,^a#b$,PROXY', ctx());
    expect(regex.ok).toBe(true);
    if (regex.ok) expect(regex.rule.payload).toBe('^a#b$');
  });

  it('intercepts DOMA variants before the type whitelist (the AC-06 path)', () => {
    for (const line of ['DOMA', 'DOMA,example.com', 'DOMAIN-SUFFI,example.com']) {
      const result = parseRuleLine(line, ctx());
      expect(failureCode(result), line).toBe('E_RULE_NO_TARGET');
    }
    expect(failureCode(parseRuleLine('MATCHBOX,DIRECT', ctx()))).toBe('E_RULE_UNKNOWN_TYPE');
    expect(failureCode(parseRuleLine('DOMAIN-FOO,x,G', ctx()))).toBe('E_RULE_UNKNOWN_TYPE');
  });

  it('translates aliases and rejects Surge-only types', () => {
    const final = parseRuleLine('FINAL,DIRECT', ctx());
    expect(final.ok).toBe(true);
    if (final.ok) {
      expect(final.rule.type).toBe('MATCH');
      expect(codes(final.warnings)).toEqual(['W_RULE_TYPE_ALIAS']);
    }

    const host = parseRuleLine('HOST,example.com,PROXY', ctx());
    expect(host.ok).toBe(true);
    if (host.ok) expect(host.rule.type).toBe('DOMAIN');

    expect(failureCode(parseRuleLine('URL-REGEX,^a$,PROXY', ctx()))).toBe(
      'W_RULE_TYPE_UNSUPPORTED',
    );
    expect(failureCode(parseRuleLine('SUB-RULE,child,PROXY', ctx()))).toBe(
      'W_RULE_SUB_RULE_UNSUPPORTED',
    );
  });

  it('handles the conditional SRC-IP alias', () => {
    const good = parseRuleLine('SRC-IP,10.0.0.0/8,PROXY', ctx());
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.rule.type).toBe('SRC-IP-CIDR');
      expect(codes(good.warnings)).toEqual(['W_RULE_TYPE_ALIAS']);
    }

    const bad = parseRuleLine('SRC-IP,example.com,PROXY', ctx());
    expect(failureCode(bad)).toBe('W_RULE_TYPE_UNSUPPORTED');
  });

  it('enforces payload and target rules', () => {
    expect(failureCode(parseRuleLine('DOMAIN,,PROXY', ctx()))).toBe('E_RULE_EMPTY_PAYLOAD');
    expect(failureCode(parseRuleLine('DOMAIN,example.com', ctx()))).toBe('E_RULE_NO_TARGET');
    expect(failureCode(parseRuleLine('DOMAIN,example.com,,' , ctx()))).toBe('E_RULE_NO_TARGET');
    expect(failureCode(parseRuleLine('DOMAIN,example.com,NOPE', ctx()))).toBe(
      'E_RULE_TARGET_NOT_FOUND',
    );
    expect(failureCode(parseRuleLine('IP-CIDR,999.0.0.0/99,PROXY', ctx()))).toBe(
      'E_RULE_BAD_CIDR',
    );
    expect(failureCode(parseRuleLine('AND,((DOMAIN,a.com),PROXY', ctx()))).toBe(
      'E_RULE_BAD_LOGIC',
    );
  });

  it('keeps no-resolve only on IP-family rules', () => {
    const ip = parseRuleLine('IP-CIDR,1.2.3.0/24,PROXY,no-resolve', ctx());
    expect(ip.ok).toBe(true);
    if (ip.ok) expect(ip.rule.params).toEqual(['no-resolve']);

    const geo = parseRuleLine('GEOIP,CN,PROXY,no-resolve', ctx());
    expect(geo.ok).toBe(true);
    if (geo.ok) expect(geo.rule.params).toEqual(['no-resolve']);
  });

  it('rejects over-long lines', () => {
    const long = `DOMAIN,${'x'.repeat(4100)},PROXY`;
    expect(failureCode(parseRuleLine(long, ctx()))).toBe('E_RULE_TOO_LONG');
  });

  it('validates RULE-SET provider references', () => {
    expect(parseRuleLine('RULE-SET,rs_ok,PROXY', ctx()).ok).toBe(true);
    expect(failureCode(parseRuleLine('RULE-SET,rs_missing,PROXY', ctx()))).toBe(
      'E_RULE_TARGET_NOT_FOUND',
    );
  });

  it('filters MATCH/RULE-SET in provider context', () => {
    const provider = ctx({ mode: 'provider', wrapperGroup: undefined });
    expect(failureCode(parseRuleLine('MATCH,PROXY', provider))).toBe('W_RULESET_TYPE_FILTERED');
    expect(failureCode(parseRuleLine('RULE-SET,rs_ok,PROXY', provider))).toBe(
      'W_RULESET_TYPE_FILTERED',
    );
  });

  it('supports [] inline rules and rejects !!import:', () => {
    const inline = parseRuleLine(
      '[]DOMAIN-SUFFIX,example.com',
      ctx({ mode: 'ruleset', wrapperGroup: 'G' }),
    );
    expect(inline.ok).toBe(true);
    if (inline.ok) {
      expect(inline.rule).toMatchObject({
        type: 'DOMAIN-SUFFIX',
        payload: 'example.com',
        target: 'G',
      });
    }
    expect(
      failureCode(
        parseRuleLine('[]DOMA', ctx({ mode: 'ruleset', wrapperGroup: 'G' })),
      ),
    ).toBe('E_RULE_NO_TARGET');
    expect(failureCode(parseRuleLine('!!import:other.list', ctx()))).toBe(
      'W_RULESET_IMPORT_UNSUPPORTED',
    );
  });

  it('parses many lines with isolated failures and 1-based line numbers', () => {
    const result = parseRuleLines(
      ['DOMAIN,a.com,PROXY', 'DOMA', 'IP-CIDR,1.2.3.0/24,PROXY'],
      ctx(),
    );
    expect(result.rules.map((rule) => rule.type)).toEqual(['DOMAIN', 'IP-CIDR']);
    expect(result.stats).toEqual({ input: 3, accepted: 2, dropped: 1 });
    expect(result.warnings[0]).toMatchObject({
      code: 'E_RULE_NO_TARGET',
      line: 2,
      raw: 'DOMA',
      source: 'url#1',
    });

    const withNumbers = parseRuleLines(
      [
        { text: 'DOMAIN,a.com,PROXY', line: 10 },
        { text: 'DOMA', line: 20 },
      ],
      ctx(),
    );
    expect(withNumbers.rules[0].line).toBe(10);
    expect(withNumbers.warnings[0].line).toBe(20);
  });
});

describe('buildRules: inline mode (SPEC §5.5 / §5.6)', () => {
  it('keeps source order, applies ruleset groups and appends a default MATCH', () => {
    const result = buildRules({
      sources: [
        {
          sourceId: 'url#1',
          text: 'DOMAIN,a.com,OTHER\nIP-CIDR,1.2.3.0/24,no-resolve',
          dialect: 'surge',
          group: 'PROXY',
        },
        { sourceId: 'url#2', text: 'DOMAIN-SUFFIX,b.com,G', dialect: 'surge', group: 'AUTO' },
      ],
      mode: 'inline',
      knownTargets: new Set(['PROXY', 'AUTO']),
      defaultGroup: 'PROXY',
    });
    expect(result.rules.map((rule) => `${rule.type},${rule.payload},${rule.target}`)).toEqual([
      'DOMAIN,a.com,PROXY',
      'IP-CIDR,1.2.3.0/24,PROXY',
      'DOMAIN-SUFFIX,b.com,AUTO',
      'MATCH,,PROXY',
    ]);
    expect(result.rules.at(-1)?.type).toBe('MATCH');
    expect(codes(result.warnings)).toEqual([
      'W_RULE_SOURCE_TARGET_IGNORED',
      'W_RULE_SOURCE_TARGET_IGNORED',
      'W_DEFAULT_MATCH_ADDED',
    ]);
    expect(result.stats).toMatchObject({ input: 3, accepted: 3, dropped: 0 });
    expect(result.stats.byCode).toMatchObject({
      W_RULE_SOURCE_TARGET_IGNORED: 2,
      W_DEFAULT_MATCH_ADDED: 1,
    });
  });

  it('creates extra group names from ruleset wrappers', () => {
    const result = buildRules({
      sources: [
        { sourceId: 'url#1', text: 'DOMAIN,a.com', dialect: 'surge', group: 'NEW' },
      ],
      mode: 'inline',
      knownTargets: new Set(['PROXY']),
      defaultGroup: 'PROXY',
    });
    expect(result.extraGroups).toEqual(['NEW']);
    expect(result.rules[0]).toMatchObject({ type: 'DOMAIN', target: 'NEW' });
    expect(codes(result.warnings)).toContain('W_GROUP_AUTO_CREATED');
  });

  it('drops rules whose auto-created group exceeds maxNewGroups', () => {
    const result = buildRules({
      sources: [
        { sourceId: 'url#1', text: 'DOMAIN,a.com', dialect: 'surge', group: 'NEW' },
      ],
      mode: 'inline',
      knownTargets: new Set(['PROXY']),
      defaultGroup: 'PROXY',
      maxNewGroups: 0,
    });
    expect(result.extraGroups).toEqual([]);
    expect(result.rules.map((rule) => rule.type)).toEqual(['MATCH']);
    expect(codes(result.warnings)).toContain('E_RULE_TARGET_NOT_FOUND');
    expect(result.stats.accepted).toBe(0);
    expect(result.stats.dropped).toBe(1);
  });

  it('keeps only the last MATCH and moves it to the end', () => {
    const result = buildRules({
      sources: [
        {
          sourceId: 'url#1',
          text: 'MATCH,PROXY\nDOMAIN,a.com,G\nMATCH,AUTO',
          dialect: 'surge',
          group: 'G',
        },
      ],
      mode: 'inline',
      knownTargets: new Set(['G', 'PROXY', 'AUTO']),
      defaultGroup: 'PROXY',
    });
    expect(result.rules.map((rule) => `${rule.type},${rule.target}`)).toEqual([
      'DOMAIN,G',
      'MATCH,G',
    ]);
    expect(codes(result.warnings)).toEqual([
      'W_RULE_SOURCE_TARGET_IGNORED',
      'W_RULE_SOURCE_TARGET_IGNORED',
      'W_RULE_SOURCE_TARGET_IGNORED',
      'W_RULE_DUPLICATE_MATCH',
    ]);
  });

  it('truncates at MAX_RULES but always keeps the final MATCH', () => {
    const text = Array.from({ length: 5 }, (_, index) => `DOMAIN,d${index}.com`).join('\n');
    const result = buildRules({
      sources: [{ sourceId: 'url#1', text, dialect: 'surge', group: 'G' }],
      mode: 'inline',
      knownTargets: new Set(['G']),
      defaultGroup: 'G',
      maxRules: 2,
    });
    expect(result.rules).toHaveLength(3);
    expect(result.rules.map((rule) => rule.payload)).toEqual(['d0.com', 'd1.com', '']);
    expect(result.rules.at(-1)?.type).toBe('MATCH');
    expect(codes(result.warnings)).toContain('W_RULE_LIMIT');
    expect(result.stats).toMatchObject({ input: 5, accepted: 2, dropped: 3 });
  });

  it('handles template rules only when overwrite_original_rules=false', () => {
    const base = {
      sources: [
        {
          sourceId: 'url#1',
          text: 'DOMAIN,a.com',
          dialect: 'surge' as const,
          group: 'G',
        },
      ],
      mode: 'inline' as const,
      knownTargets: new Set(['G', 'DIRECT']),
      defaultGroup: 'G',
      templateRules: ['DOMAIN,template.com,G', 'DOMA'],
    };
    const ignored = buildRules({ ...base, overwriteOriginalRules: true });
    expect(ignored.rules.map((rule) => rule.payload)).toEqual(['a.com', '']);
    expect(codes(ignored.warnings)).not.toContain('E_RULE_NO_TARGET');

    const appended = buildRules({ ...base, overwriteOriginalRules: false });
    expect(appended.rules.map((rule) => rule.payload)).toEqual(['a.com', 'template.com', '']);
    expect(codes(appended.warnings)).toContain('E_RULE_NO_TARGET');
    expect(appended.stats).toMatchObject({ input: 3, accepted: 2, dropped: 1 });
  });

  it('drops template rules with unknown targets', () => {
    const result = buildRules({
      sources: [],
      mode: 'inline',
      knownTargets: new Set(['G']),
      defaultGroup: 'G',
      templateRules: ['DOMAIN,x.com,UNKNOWN'],
      overwriteOriginalRules: false,
    });
    expect(result.rules.map((rule) => rule.type)).toEqual(['MATCH']);
    expect(codes(result.warnings)).toContain('E_RULE_TARGET_NOT_FOUND');
  });

  it('handles BOM/CRLF sources end-to-end', () => {
    const result = buildRules({
      sources: [
        {
          sourceId: 'url#1',
          text: '\uFEFFDOMAIN,a.com\r\nDOMAIN,b.com\r\n',
          dialect: 'surge',
          group: 'G',
        },
      ],
      mode: 'inline',
      knownTargets: new Set(['G']),
      defaultGroup: 'G',
    });
    expect(result.rules.map((rule) => rule.payload)).toEqual(['a.com', 'b.com', '']);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['W_DEFAULT_MATCH_ADDED']);
  });
});

describe('buildRules: providers mode (SPEC §5.7)', () => {
  it('generates providers + RULE-SET rules and decides behavior', () => {
    const result = buildRules({
      sources: [
        {
          sourceId: 'url#1',
          text: 'payload:\n  - example.com\n  - .suffix.com\n',
          dialect: 'clash-domain',
          group: 'G',
          rawSource: 'https://x.test/domestic.yaml',
        },
        {
          sourceId: 'url#2',
          text: 'DOMAIN,a.com\nIP-CIDR,1.2.3.0/24',
          dialect: 'surge',
          group: 'H',
          rawSource: 'https://x.test/mixed.list',
        },
      ],
      mode: 'providers',
      knownTargets: new Set(['G', 'H']),
      defaultGroup: 'G',
    });
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0]).toMatchObject({
      behavior: 'domain',
      source: { raw: 'https://x.test/domestic.yaml', dialect: 'clash-domain' },
      interval: 86_400,
    });
    expect(result.providers[1]).toMatchObject({ behavior: 'classical' });
    expect(result.rules.map((rule) => `${rule.type},${rule.target}`)).toEqual([
      'RULE-SET,G',
      'RULE-SET,H',
      'MATCH,G',
    ]);
    expect(result.rules[0].payload).toBe(result.providers[0].name);
    expect(result.rules[1].payload).toBe(result.providers[1].name);
  });

  it('falls back to inline rules when a source contains MATCH', () => {
    const result = buildRules({
      sources: [
        {
          sourceId: 'url#1',
          text: 'DOMAIN,a.com\nMATCH,DIRECT',
          dialect: 'surge',
          group: 'G',
          rawSource: 'inline:abc',
        },
      ],
      mode: 'providers',
      knownTargets: new Set(['G']),
      defaultGroup: 'G',
    });
    expect(result.providers).toEqual([]);
    expect(result.rules.map((rule) => `${rule.type},${rule.target}`)).toEqual([
      'DOMAIN,G',
      'MATCH,G',
    ]);
    expect(codes(result.warnings)).toContain('W_PROVIDER_INLINE_FALLBACK');
  });

  it('falls back when the provider URL is too long', () => {
    const result = buildRules({
      sources: [
        {
          sourceId: 'url#1',
          text: 'DOMAIN,a.com',
          dialect: 'surge',
          group: 'G',
          rawSource: 'https://x.test/a.list',
        },
      ],
      mode: 'providers',
      knownTargets: new Set(['G']),
      defaultGroup: 'G',
      providerUrlLength: () => 12_001,
    });
    expect(result.providers).toEqual([]);
    expect(result.rules[0].type).toBe('DOMAIN');
    expect(codes(result.warnings)).toContain('W_PROVIDER_INLINE_FALLBACK');
  });

  it('reuses one provider for multiple groups and de-duplicates source+group', () => {
    const result = buildRules({
      sources: [
        {
          sourceId: 'url#1',
          text: 'DOMAIN,a.com',
          dialect: 'surge',
          group: 'G',
          rawSource: 'https://x.test/a.list',
        },
        {
          sourceId: 'url#2',
          text: 'DOMAIN,b.com',
          dialect: 'surge',
          group: 'H',
          rawSource: 'https://x.test/a.list',
        },
        {
          sourceId: 'url#3',
          text: 'DOMAIN,c.com',
          dialect: 'surge',
          group: 'G',
          rawSource: 'https://x.test/a.list',
        },
      ],
      mode: 'providers',
      knownTargets: new Set(['G', 'H']),
      defaultGroup: 'G',
    });
    expect(result.providers).toHaveLength(1);
    expect(result.rules.filter((rule) => rule.type === 'RULE-SET')).toHaveLength(2);
    expect(result.rules.filter((rule) => rule.type === 'RULE-SET').map((rule) => rule.target)).toEqual([
      'G',
      'H',
    ]);
  });

  it('expands provider names on collision', () => {
    const used = new Set<string>();
    const first = providerName('https://a.test/x.list', 'domain', used);
    const second = providerName('https://a.test/x.list', 'domain', used);
    expect(first).toMatch(/^rs_[0-9a-f]{8}_x$/);
    expect(second).toMatch(/^rs_[0-9a-f]{12}_x$/);
    expect(second).not.toBe(first);
  });

  it('decides provider behavior from validated rules', () => {
    const rule = (type: Rule['type']): Rule => ({
      type,
      payload: 'x',
      target: 'G',
      params: [],
      raw: '',
      line: 1,
      sourceId: 's',
    });
    expect(decideBehavior([])).toBe('classical');
    expect(decideBehavior([rule('DOMAIN'), rule('DOMAIN-SUFFIX')])).toBe('domain');
    expect(decideBehavior([rule('IP-CIDR'), rule('IP-CIDR6')])).toBe('ipcidr');
    expect(decideBehavior([rule('DOMAIN'), rule('IP-CIDR')])).toBe('classical');
  });

  it('rejects provider eligibility for empty/blocking sources', () => {
    const rule = (type: Rule['type']): Rule => ({
      type,
      payload: 'x',
      target: 'G',
      params: [],
      raw: '',
      line: 1,
      sourceId: 's',
    });
    const source = { sourceId: 's', dialect: 'surge' as const, rawSource: 'https://x.test/a' };
    expect(canBeProvider([], source, 10)).toMatchObject({ ok: false });
    expect(canBeProvider([rule('MATCH')], source, 10)).toMatchObject({ ok: false });
    expect(canBeProvider([rule('DOMAIN')], source, 10)).toEqual({ ok: true });
    expect(canBeProvider([rule('DOMAIN')], source, 12_001)).toMatchObject({ ok: false });
  });
});

describe('getruleset payload mapping (SPEC §2.7 / AC-13 / AC-14)', () => {
  const rule = (type: Rule['type'], payload: string, params: Rule['params'] = []): Rule => ({
    type,
    payload,
    target: 'G',
    params,
    raw: `${type},${payload}`,
    line: 1,
    sourceId: 's',
  });

  it('type 3 outputs bare domains and +.suffix only', () => {
    const mapped = toRulesetPayload(
      [
        rule('DOMAIN', 'a.com'),
        rule('DOMAIN-SUFFIX', 'b.com'),
        rule('IP-CIDR', '1.2.3.0/24'),
      ],
      3,
    );
    expect(mapped.items).toEqual(['a.com', '+.b.com']);
    expect(mapped.filtered).toBe(1);
    expect(codes(mapped.warnings)).toEqual(['W_RULESET_TYPE_FILTERED']);
    expect(mapped.items.join('\n')).not.toContain('DOMAIN-SUFFIX,');
  });

  it('type 4 outputs CIDRs only', () => {
    const mapped = toRulesetPayload(
      [rule('IP-CIDR', '1.2.3.0/24'), rule('IP-CIDR6', '2001:db8::/32'), rule('DOMAIN', 'a.com')],
      4,
    );
    expect(mapped.items).toEqual(['1.2.3.0/24', '2001:db8::/32']);
    expect(mapped.filtered).toBe(1);
  });

  it('type 6 outputs TYPE,PAYLOAD[,no-resolve] without a target', () => {
    const mapped = toRulesetPayload(
      [
        rule('IP-CIDR', '1.2.3.0/24', ['no-resolve']),
        rule('MATCH', ''),
        rule('RULE-SET', 'rs_x'),
        rule('SUB-RULE', 'child'),
      ],
      6,
    );
    expect(mapped.items).toEqual(['IP-CIDR,1.2.3.0/24,no-resolve']);
    expect(mapped.filtered).toBe(3);
    for (const item of mapped.items) {
      expect(item.split(',')).not.toContain('G');
    }
  });

  it('produces legal placeholders for empty results', () => {
    expect(buildRulesetDocument([], 3)).toMatchObject({
      yaml: 'payload:\n  - "+.placeholder.invalid"\n',
      placeholder: true,
    });
    expect(buildRulesetDocument([], 4)).toMatchObject({
      yaml: 'payload:\n  - "0.0.0.0/32"\n',
      placeholder: true,
    });
    expect(buildRulesetDocument([], 6)).toMatchObject({
      yaml: 'payload:\n  - "DOMAIN,placeholder.invalid"\n',
      placeholder: true,
    });
    for (const type of [3, 4, 6] as const) {
      const empty = buildRulesetDocument([], type);
      expect(empty.placeholder).toBe(true);
      expect(codes(empty.warnings)).toContain('W_RULESET_EMPTY');
    }
  });

  it('serializes a payload document with double quotes and a final newline', () => {
    expect(serializeRulesetPayload(['+.a.com', 'b.com'])).toBe(
      'payload:\n  - "+.a.com"\n  - "b.com"\n',
    );
    expect(serializeRulesetPayload([])).toBe('payload: []\n');
  });
});

describe('buildRules: dialect integration', () => {
  it('parses a clash-classical payload end-to-end and re-parses every output rule', () => {
    const text = 'payload:\n  - DOMAIN,a.com\n  - DOMAIN-SUFFIX,b.com\n  - IP-CIDR,10.0.0.0/8,no-resolve\n';
    const detected = detectDialect(text);
    expect(detected).toMatchObject({ dialect: 'clash-classical' });
    if ('error' in detected) throw new Error('unexpected detection error');

    const extracted = extractRuleLines(text, detected.dialect, 'url#1');
    expect(extracted.lines).toHaveLength(3);

    const result = buildRules({
      sources: [{ sourceId: 'url#1', text, dialect: detected.dialect, group: 'G' }],
      mode: 'inline',
      knownTargets: new Set(['G']),
      defaultGroup: 'G',
    });
    expect(result.rules.map((rule) => rule.type)).toEqual([
      'DOMAIN',
      'DOMAIN-SUFFIX',
      'IP-CIDR',
      'MATCH',
    ]);

    for (const rule of result.rules) {
      const line =
        rule.type === 'MATCH'
          ? `MATCH,${rule.target}`
          : `${rule.type},${rule.payload},${rule.target}${
              rule.params.length > 0 ? `,${rule.params.join(',')}` : ''
            }`;
      const reparsed = parseRuleLine(line, ctx({ knownTargets: new Set(['G', 'DIRECT']) }), 1);
      expect(reparsed.ok, line).toBe(true);
    }
  });
});
