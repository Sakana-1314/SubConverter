import { describe, expect, it } from 'vitest';
import type { Rule, RuleType, Warning } from '../../../src/types';
import {
  assertRuleLine,
  checkRuleLine,
  ensureTrailingMatch,
  formatRule,
  isValidCidrValue,
  toRuleScalars,
} from '../../../src/emitter/rules';
import { EmitterError, isEmitterError, parseForReadback, stringifyConfig } from '../../../src/emitter/serialize';

function makeRule(
  overrides: Partial<Rule> & Pick<Rule, 'type' | 'payload' | 'target'>,
): Rule {
  return {
    params: [],
    raw: `${overrides.type},${overrides.payload},${overrides.target}`,
    line: 1,
    sourceId: 'test',
    ...overrides,
  };
}

function matchRule(target: string, line = 99): Rule {
  return { type: 'MATCH' as RuleType, payload: '', target, params: [], raw: `MATCH,${target}`, line, sourceId: 'test' };
}

function emitError(fn: () => unknown): EmitterError {
  try {
    fn();
  } catch (error) {
    if (isEmitterError(error)) return error;
    throw error;
  }
  throw new Error('expected an EmitterError to be thrown');
}

describe('formatRule', () => {
  it('formats regular, no-resolve, RULE-SET and MATCH rules', () => {
    expect(formatRule(makeRule({ type: 'DOMAIN', payload: 'example.com', target: 'PROXY' })))
      .toBe('DOMAIN,example.com,PROXY');
    expect(formatRule(makeRule({
      type: 'IP-CIDR',
      payload: '10.0.0.0/8',
      target: 'DIRECT',
      params: ['no-resolve'],
    }))).toBe('IP-CIDR,10.0.0.0/8,DIRECT,no-resolve');
    expect(formatRule(makeRule({ type: 'RULE-SET', payload: 'rs_1234_dom', target: 'PROXY' })))
      .toBe('RULE-SET,rs_1234_dom,PROXY');
    expect(formatRule(matchRule('PROXY'))).toBe('MATCH,PROXY');
  });

  it('keeps commas inside comma-bearing payloads', () => {
    expect(formatRule(makeRule({ type: 'DOMAIN-REGEX', payload: '^a,b$', target: 'G' })))
      .toBe('DOMAIN-REGEX,^a,b$,G');
    expect(formatRule(makeRule({
      type: 'AND',
      payload: '((DOMAIN,a.com),(NETWORK,tcp))',
      target: 'G',
    }))).toBe('AND,((DOMAIN,a.com),(NETWORK,tcp)),G');
  });

  it.each([
    ['unknown type', makeRule({ type: 'DOMA' as unknown as RuleType, payload: 'a.com', target: 'G' })],
    ['SUB-RULE', makeRule({ type: 'SUB-RULE', payload: '(DOMAIN,a.com)', target: 'G' })],
    ['empty normal payload', makeRule({ type: 'DOMAIN', payload: '', target: 'G' })],
    ['comma in normal payload', makeRule({ type: 'DOMAIN', payload: 'a.com,b.com', target: 'G' })],
    ['empty target', makeRule({ type: 'DOMAIN', payload: 'a.com', target: '' })],
    ['target with comma', makeRule({ type: 'DOMAIN', payload: 'a.com', target: 'A,B' })],
    ['target with surrounding spaces', makeRule({ type: 'DOMAIN', payload: 'a.com', target: ' G ' })],
    ['no-resolve on a non-IP rule', makeRule({
      type: 'DOMAIN',
      payload: 'a.com',
      target: 'G',
      params: ['no-resolve'],
    })],
    ['unknown param', makeRule({
      type: 'IP-CIDR',
      payload: '10.0.0.0/8',
      target: 'G',
      params: ['bogus' as never],
    })],
    ['MATCH with payload', makeRule({ type: 'MATCH', payload: 'x', target: 'G' })],
  ])('rejects %s', (_label, rule) => {
    const error = emitError(() => formatRule(rule));
    expect(error.code).toBe('E_EMIT_INVALID');
  });
});

describe('toRuleScalars', () => {
  it('emits double-quoted YAML scalars that parse back to the same text', () => {
    const rules = [
      makeRule({ type: 'DOMAIN-SUFFIX', payload: 'example.com', target: 'PROXY' }),
      makeRule({ type: 'DOMAIN-KEYWORD', payload: 'tracker', target: 'DIRECT' }),
      matchRule('PROXY'),
    ];
    const scalars = toRuleScalars(rules);
    expect(scalars).toHaveLength(3);
    const yaml = stringifyConfig({ rules: scalars });
    expect(yaml).toContain('  - "DOMAIN-SUFFIX,example.com,PROXY"');
    expect(yaml).toContain('  - "MATCH,PROXY"');

    const readback = parseForReadback(yaml);
    expect(readback.ok).toBe(true);
    if (!readback.ok) return;
    expect((readback.value as { rules: string[] }).rules).toEqual([
      'DOMAIN-SUFFIX,example.com,PROXY',
      'DOMAIN-KEYWORD,tracker,DIRECT',
      'MATCH,PROXY',
    ]);
  });

  it('rejects empty lists, a missing trailing MATCH and duplicate MATCHes', () => {
    expect(emitError(() => toRuleScalars([])).code).toBe('E_EMIT_INVALID');
    expect(emitError(() => toRuleScalars([
      makeRule({ type: 'DOMAIN', payload: 'a.com', target: 'G' }),
    ])).code).toBe('E_EMIT_INVALID');
    expect(emitError(() => toRuleScalars([
      matchRule('G'),
      matchRule('G'),
    ])).code).toBe('E_EMIT_INVALID');
  });
});

describe('ensureTrailingMatch', () => {
  it('appends MATCH when none exists', () => {
    const warnings: Warning[] = [];
    const rules = ensureTrailingMatch([
      makeRule({ type: 'DOMAIN', payload: 'a.com', target: 'G' }),
    ], 'G', warnings);
    expect(rules).toHaveLength(2);
    expect(rules[1]?.type).toBe('MATCH');
    expect(rules[1]?.target).toBe('G');
    expect(warnings.map((warning) => warning.code)).toEqual(['W_DEFAULT_MATCH_ADDED']);
  });

  it('moves the last MATCH to the end and warns about duplicates', () => {
    const warnings: Warning[] = [];
    const rules = ensureTrailingMatch([
      matchRule('FIRST', 1),
      makeRule({ type: 'DOMAIN', payload: 'a.com', target: 'G' }),
      matchRule('LAST', 3),
    ], 'G', warnings);
    expect(rules.map((rule) => `${rule.type},${rule.target}`)).toEqual(['DOMAIN,G', 'MATCH,LAST']);
    expect(warnings.map((warning) => warning.code)).toEqual(['W_RULE_DUPLICATE_MATCH']);
  });

  it('replaces an empty MATCH target with the default group', () => {
    const warnings: Warning[] = [];
    const rules = ensureTrailingMatch([matchRule('')], 'PROXY', warnings);
    expect(rules[0]?.target).toBe('PROXY');
    expect(warnings.map((warning) => warning.code)).toEqual(['W_DEFAULT_MATCH_ADDED']);
  });

  it('truncates to the rule limit while preserving the final MATCH', () => {
    const warnings: Warning[] = [];
    const input = [
      makeRule({ type: 'DOMAIN', payload: 'a.com', target: 'G' }),
      makeRule({ type: 'DOMAIN', payload: 'b.com', target: 'G' }),
      makeRule({ type: 'DOMAIN', payload: 'c.com', target: 'G' }),
      matchRule('G'),
    ];
    const rules = ensureTrailingMatch(input, 'G', warnings, 2);
    expect(rules).toHaveLength(3);
    expect(rules.map((rule) => rule.payload)).toEqual(['a.com', 'b.com', '']);
    expect(rules[2]?.type).toBe('MATCH');
    expect(warnings.map((warning) => warning.code)).toEqual(['W_RULE_LIMIT']);
  });

  it('rejects an invalid default group', () => {
    expect(emitError(() => ensureTrailingMatch([], '', [])).code).toBe('E_EMIT_INVALID');
  });
});

describe('checkRuleLine', () => {
  const validLines = [
    'DOMAIN,example.com,PROXY',
    'DOMAIN-SUFFIX,sub.example.com,PROXY',
    'DOMAIN-KEYWORD,tracker,DIRECT',
    'DOMAIN-REGEX,^a{1,3}$,G',
    'DOMAIN-REGEX,^a,b$,G',
    'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR6,2001:db8::/32,DIRECT',
    'AND,((DOMAIN,a.com),(NETWORK,tcp)),G',
    'OR,((DOMAIN,a.com),(NETWORK,tcp)),G',
    'NOT,((DOMAIN,a.com)),G',
    'MATCH,PROXY',
    'RULE-SET,rs_x_dom,PROXY',
    'NETWORK,udp,G',
    'DST-PORT,1000-2000,G',
    'IP-ASN,AS13335,G',
    'GEOSITE,cn,G',
    'PROCESS-NAME,foo,G',
  ];

  it.each(validLines)('accepts %s', (line) => {
    expect(checkRuleLine(line)).toEqual({ ok: true });
    expect(() => assertRuleLine(line)).not.toThrow();
  });

  const invalidLines: Array<[string, string]> = [
    ['DOMA', 'no type separator'],
    ['DOMA,example.com', 'unknown rule type'],
    ['DOMAIN,example.com', 'missing a target'],
    ['DOMAIN,,PROXY', 'empty payload'],
    ['DOMAIN,example.com,', 'empty target'],
    ['IP-CIDR,999.1.1.1/24,PROXY', 'not a valid IPv4 CIDR'],
    ['IP-CIDR,10.0.0.0/33,PROXY', 'not a valid IPv4 CIDR'],
    ['AND,((DOMAIN,a.com),(NETWORK,tcp),G', 'unbalanced parentheses'],
    ['MATCHBOX,a.com,PROXY', 'unknown rule type'],
    ['SUB-RULE,(DOMAIN,a.com),PROXY', 'SUB-RULE is never emitted'],
    ['domain,example.com,PROXY', 'unknown rule type'],
    ['IP-CIDR,10.0.0.0/8,PROXY,bogus', 'unsupported fourth field'],
    ['MATCH,PROXY,EXTRA', 'exactly two fields'],
    ['DOMAIN,example.com,PROXY,no-resolve', 'does not accept no-resolve'],
    ['DOMAIN,exa mple.com,PROXY', 'not a valid domain'],
    ['NETWORK,quic,PROXY', 'must be tcp or udp'],
    ['DST-PORT,70000,PROXY', 'not a valid port/range'],
    ['DOMAIN-REGEX,[,PROXY', 'not a valid regular expression'],
    ['AND,((MATCH,PROXY),(NETWORK,tcp)),G', 'must not contain MATCH or SUB-RULE'],
    ['MATCH', 'no type separator'],
    [' DOMAIN,a.com,PROXY', 'leading or trailing whitespace'],
  ];

  it.each(invalidLines)('rejects %s', (line, message) => {
    const result = checkRuleLine(line);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(message);
    expect(() => assertRuleLine(line)).toThrowError(EmitterError);
  });
});

describe('isValidCidrValue', () => {
  it('validates IPv4 and IPv6 CIDRs', () => {
    expect(isValidCidrValue('10.0.0.0/8', 4)).toBe(true);
    expect(isValidCidrValue('10.0.0.0/33', 4)).toBe(false);
    expect(isValidCidrValue('2001:db8::/32', 6)).toBe(true);
    expect(isValidCidrValue('2001:db8::/129', 6)).toBe(false);
    expect(isValidCidrValue('::ffff:1.2.3.4/128', 6)).toBe(true);
    expect(isValidCidrValue('2001:db8::/32')).toBe(true);
    expect(isValidCidrValue('example.com/24')).toBe(false);
  });
});
