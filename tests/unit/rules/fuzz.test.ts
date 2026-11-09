import { describe, expect, it } from 'vitest';
import {
  buildRules,
  getAllRuleTypes,
  parseRuleLine,
  parseRuleLines,
  type ValidationContext,
} from '../../../src/rules/index';
import type { Rule } from '../../../src/types';

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const random = mulberry32(0x5eed_1234);

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

const TARGETS = ['G', 'PROXY', 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'AUTO'] as const;

const PAYLOAD: Record<string, (n: number) => string> = {
  DOMAIN: (n) => `d${n}.example.com`,
  'DOMAIN-SUFFIX': (n) => `s${n}.example.com`,
  'DOMAIN-KEYWORD': (n) => `kw${n}`,
  'DOMAIN-REGEX': (n) => `^r${n}[0-9]+$`,
  'DOMAIN-WILDCARD': (n) => `*.w${n}.example.com`,
  GEOSITE: (n) => `site${n}`,
  GEOIP: (n) => `C${n % 100}`,
  'SRC-GEOIP': (n) => `C${n % 100}`,
  'IP-ASN': (n) => `AS${n}`,
  'SRC-IP-ASN': (n) => `${n}`,
  'IP-CIDR': (n) => `10.${n % 256}.${(n * 7) % 256}.0/24`,
  'IP-CIDR6': (n) => `2001:db8:${(n % 65_535).toString(16)}::/48`,
  'SRC-IP-CIDR': (n) => `172.${16 + (n % 16)}.0.0/12`,
  'IP-SUFFIX': (n) => `${n % 33}`,
  'SRC-IP-SUFFIX': (n) => `10.0.0.0/8`,
  'SRC-PORT': (n) => `${n % 65_536}`,
  'DST-PORT': (n) => `${n % 65_536}-${(n % 65_536) + 1 > 65_535 ? 65_535 : (n % 65_536) + 1}`,
  'IN-PORT': (n) => `${n % 65_536}`,
  DSCP: (n) => `${n % 64}`,
  'PROCESS-NAME': (n) => `proc${n}.exe`,
  'PROCESS-PATH': (n) => `/usr/bin/p${n}`,
  'PROCESS-NAME-REGEX': (n) => `^proc${n}$`,
  'PROCESS-PATH-REGEX': (n) => `^/opt/p${n}$`,
  'PROCESS-NAME-WILDCARD': (n) => `proc${n}*`,
  'PROCESS-PATH-WILDCARD': (n) => `*p${n}*`,
  NETWORK: (n) => (n % 2 === 0 ? 'tcp' : 'udp'),
  UID: (n) => `${n}`,
  'IN-TYPE': (n) => `type${n}`,
  'IN-USER': (n) => `user${n}`,
  'IN-NAME': (n) => `if${n}`,
  'REMATCH-NAME': (n) => `name${n}`,
  AND: (n) => `((DOMAIN,d${n}.com),(NETWORK,tcp))`,
  OR: (n) => `((DOMAIN,d${n}.com),(DOMAIN,s${n}.com))`,
  NOT: (n) => `((DOMAIN,d${n}.com))`,
  'RULE-SET': () => 'rs_fuzz',
  MATCH: () => '',
};

const VALID_TYPES = getAllRuleTypes().filter((type) => type !== 'SUB-RULE');
const IP_TYPES = new Set([
  'GEOIP',
  'SRC-GEOIP',
  'IP-ASN',
  'SRC-IP-ASN',
  'IP-CIDR',
  'IP-CIDR6',
  'SRC-IP-CIDR',
  'IP-SUFFIX',
  'SRC-IP-SUFFIX',
]);

function makeValidLine(index: number): { line: string; type: string; payload: string; target: string } {
  const type = VALID_TYPES[index % VALID_TYPES.length];
  const payload = PAYLOAD[type](index);
  const target = pick(TARGETS);
  if (type === 'MATCH') {
    return { line: `MATCH,${target}`, type, payload: '', target };
  }
  const param = IP_TYPES.has(type) && random() < 0.3 ? ',no-resolve' : '';
  return { line: `${type},${payload},${target}${param}`, type, payload, target };
}

function mutate(line: string, type: string, payload: string, target: string): string {
  switch (Math.floor(random() * 13)) {
    case 0:
      return line.slice(0, Math.max(0, line.length - (1 + Math.floor(random() * 8))));
    case 1:
      return line.replace(/^[^,]*/, 'DOMA');
    case 2:
      return line.replace(/^[^,]*/, 'MATCHBOX');
    case 3:
      return type === 'MATCH' ? 'MATCH' : `${type},${payload}`;
    case 4:
      return type === 'MATCH' ? `MATCH,,${target}` : `${type},,${target}`;
    case 5:
      return `IP-CIDR,999.0.0.0/99,${target}`;
    case 6:
      return `SRC-PORT,70000,${target}`;
    case 7:
      return `AND,((DOMAIN,a.com),(NETWORK,tcp),${target}`;
    case 8:
      return line.replace(/,/g, '\uFF0C');
    case 9:
      return `\uFEFF${line}`;
    case 10:
      return `${line} # trailing comment`;
    case 11:
      return type === 'MATCH' ? `MATCH,${target},EXTRA,EXTRA` : `${type},${payload},${target},EXTRA,EXTRA`;
    case 12:
      return pick(['', '   ', '# comment', '; comment', '// comment', 'DOMA', 'DOMAIN', 'MATCH']);
    default:
      return line;
  }
}

function context(): ValidationContext {
  return {
    sourceId: 'fuzz',
    mode: 'template',
    knownTargets: new Set(['G', 'PROXY', 'AUTO', 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS']),
    knownProviders: new Set(['rs_fuzz']),
    allowMatch: true,
  };
}

function formatRule(rule: Rule): string {
  if (rule.type === 'MATCH') return `MATCH,${rule.target}`;
  return `${rule.type},${rule.payload},${rule.target}${
    rule.params.length > 0 ? `,${rule.params.join(',')}` : ''
  }`;
}

describe('fuzz: seeded rule properties (AC-28)', () => {
  it('parses >= 10,000 valid and invalid combinations without producing illegal rules', () => {
    const ctx = context();
    let valid = 0;
    let invalid = 0;

    for (let index = 0; index < 12_000; index += 1) {
      const base = makeValidLine(index);
      const line = index % 2 === 0 ? base.line : mutate(base.line, base.type, base.payload, base.target);
      const result = parseRuleLine(line, ctx, index + 1);

      if (result.ok) {
        valid += 1;
        const rule = result.rule;
        expect(getAllRuleTypes()).toContain(rule.type);
        expect(rule.type).not.toBe('SUB-RULE');
        expect(rule.type as string).not.toBe('DOMA');
        expect(rule.target).not.toBe('');
        for (const param of rule.params) expect(param).toBe('no-resolve');
        if (rule.type === 'MATCH') expect(rule.payload).toBe('');
        else expect(rule.payload.length).toBeGreaterThan(0);

        // Any accepted rule must survive a read-back parse.
        const reparsed = parseRuleLine(formatRule(rule), ctx, 1);
        expect(reparsed.ok, `${line} -> ${formatRule(rule)}`).toBe(true);
      } else {
        invalid += 1;
        expect(result.warnings.length).toBeGreaterThan(0);
        for (const warning of result.warnings) {
          expect(typeof warning.code).toBe('string');
          expect(warning.code.length).toBeGreaterThan(0);
          expect(warning.stage).toBe('rules');
        }
      }
    }

    // Both halves of the generator must be exercised (the ASK requires a mix).
    expect(valid).toBeGreaterThan(3_000);
    expect(invalid).toBeGreaterThan(3_000);
  }, 30_000);

  it('buildRules keeps only legal rules from a mixed 2,000-line source', () => {
    const ctx = context();
    const lines: string[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      const base = makeValidLine(index);
      lines.push(
        index % 3 === 0
          ? mutate(base.line, base.type, base.payload, base.target)
          : base.line,
      );
    }

    const result = buildRules({
      sources: [
        {
          sourceId: 'fuzz',
          text: lines.join('\n'),
          dialect: 'surge',
          group: 'G',
        },
      ],
      mode: 'inline',
      knownTargets: new Set(['G', 'PROXY', 'AUTO', 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS']),
      knownProviders: new Set(['rs_fuzz']),
      defaultGroup: 'G',
    });

    expect(result.rules.filter((rule) => rule.type === 'MATCH')).toHaveLength(1);
    expect(result.rules.at(-1)?.type).toBe('MATCH');

    for (const rule of result.rules) {
      expect(getAllRuleTypes()).toContain(rule.type);
      expect(rule.type as string).not.toBe('DOMA');
      expect(parseRuleLine(formatRule(rule), ctx, 1).ok, formatRule(rule)).toBe(true);
    }

    const parsed = parseRuleLines(lines, ctx);
    expect(parsed.stats.input).toBe(2_000);
    expect(parsed.stats.accepted + parsed.stats.dropped).toBe(2_000);
  }, 30_000);
});
