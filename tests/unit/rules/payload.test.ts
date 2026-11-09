import { describe, expect, it } from 'vitest';
import {
  compileRuleRegex,
  looksLikeCidr,
  looksLikeDomain,
  normalizeDomain,
  parseAsn,
  parseCidr,
  parsePortRange,
  parseUidRange,
  validatePayload,
  type PayloadResult,
} from '../../../src/rules/payload';
import { getAllRuleTypes } from '../../../src/rules/registry';

const LEGAL: Record<string, string> = {
  DOMAIN: 'example.com',
  'DOMAIN-SUFFIX': 'example.com',
  'DOMAIN-KEYWORD': 'ads',
  'DOMAIN-REGEX': '^ads?[0-9]*\\.example\\.com$',
  'DOMAIN-WILDCARD': '*.example.com',
  GEOSITE: 'cn',
  GEOIP: 'CN',
  'SRC-GEOIP': 'CN',
  'IP-ASN': 'AS13335',
  'SRC-IP-ASN': '13335',
  'IP-CIDR': '1.2.3.0/24',
  'IP-CIDR6': '2001:db8::/32',
  'SRC-IP-CIDR': '10.0.0.0/8',
  'IP-SUFFIX': '24',
  'SRC-IP-SUFFIX': '2001:db8::/32',
  'SRC-PORT': '80',
  'DST-PORT': '80-90',
  'IN-PORT': '443',
  DSCP: '46',
  'PROCESS-NAME': 'chrome.exe',
  'PROCESS-PATH': '/usr/bin/curl',
  'PROCESS-NAME-REGEX': '^chrome(64)?$',
  'PROCESS-PATH-REGEX': '^/usr/(bin|local)/curl$',
  'PROCESS-NAME-WILDCARD': 'chrome*',
  'PROCESS-PATH-WILDCARD': '*curl*',
  NETWORK: 'TCP',
  UID: '1000-2000',
  'IN-TYPE': 'wifi',
  'IN-USER': 'alice',
  'IN-NAME': 'wlan0',
  'REMATCH-NAME': 'rule-*',
  'SUB-RULE': 'child',
  AND: '((DOMAIN,a.com),(NETWORK,tcp))',
  OR: '((DOMAIN,a.com),(DOMAIN,b.com))',
  NOT: '((DOMAIN,a.com))',
  'RULE-SET': 'rs_abc123_domestic',
  MATCH: '',
};

const ILLEGAL: Record<string, { payload: string; code: string }> = {
  DOMAIN: { payload: 'bad domain', code: 'E_RULE_BAD_DOMAIN' },
  'DOMAIN-SUFFIX': { payload: '+.', code: 'E_RULE_BAD_DOMAIN' },
  'DOMAIN-KEYWORD': { payload: 'a b', code: 'E_RULE_BAD_DOMAIN' },
  'DOMAIN-REGEX': { payload: '(', code: 'E_RULE_BAD_REGEX' },
  'DOMAIN-WILDCARD': { payload: 'example.com', code: 'E_RULE_BAD_PAYLOAD' },
  GEOSITE: { payload: 'x', code: 'E_RULE_BAD_PAYLOAD' },
  GEOIP: { payload: '', code: 'E_RULE_EMPTY_PAYLOAD' },
  'SRC-GEOIP': { payload: 'a b', code: 'E_RULE_BAD_PAYLOAD' },
  'IP-ASN': { payload: 'AS', code: 'E_RULE_BAD_ASN' },
  'SRC-IP-ASN': { payload: 'AS12345678901', code: 'E_RULE_BAD_ASN' },
  'IP-CIDR': { payload: '1.2.3.4', code: 'E_RULE_BAD_CIDR' },
  'IP-CIDR6': { payload: '1.2.3.0/24', code: 'E_RULE_BAD_CIDR' },
  'SRC-IP-CIDR': { payload: '10.0.0.0', code: 'E_RULE_BAD_CIDR' },
  'IP-SUFFIX': { payload: '33', code: 'E_RULE_BAD_CIDR' },
  'SRC-IP-SUFFIX': { payload: 'x', code: 'E_RULE_BAD_CIDR' },
  'SRC-PORT': { payload: '65536', code: 'E_RULE_BAD_PORT' },
  'DST-PORT': { payload: '90-80', code: 'E_RULE_BAD_PORT' },
  'IN-PORT': { payload: '-1', code: 'E_RULE_BAD_PORT' },
  DSCP: { payload: '64', code: 'E_RULE_BAD_PAYLOAD' },
  'PROCESS-NAME': { payload: '', code: 'E_RULE_EMPTY_PAYLOAD' },
  'PROCESS-PATH': { payload: 'a\u0001b', code: 'E_RULE_BAD_PAYLOAD' },
  'PROCESS-NAME-REGEX': { payload: '[', code: 'E_RULE_BAD_REGEX' },
  'PROCESS-PATH-REGEX': { payload: '', code: 'E_RULE_EMPTY_PAYLOAD' },
  'PROCESS-NAME-WILDCARD': { payload: 'chrome', code: 'E_RULE_BAD_PAYLOAD' },
  'PROCESS-PATH-WILDCARD': { payload: 'a/b', code: 'E_RULE_BAD_PAYLOAD' },
  NETWORK: { payload: 'sctp', code: 'E_RULE_BAD_NETWORK' },
  UID: { payload: 'a-b', code: 'E_RULE_BAD_PAYLOAD' },
  'IN-TYPE': { payload: 'x'.repeat(65), code: 'E_RULE_BAD_PAYLOAD' },
  'IN-USER': { payload: '', code: 'E_RULE_EMPTY_PAYLOAD' },
  'IN-NAME': { payload: 'a\u0000b', code: 'E_RULE_BAD_PAYLOAD' },
  'REMATCH-NAME': { payload: 'x'.repeat(257), code: 'E_RULE_BAD_PAYLOAD' },
  'SUB-RULE': { payload: '', code: 'E_RULE_EMPTY_PAYLOAD' },
  AND: { payload: '((DOMAIN,a.com))', code: 'E_RULE_BAD_LOGIC' },
  OR: { payload: '((DOMAIN,a.com),(MATCH,G))', code: 'E_RULE_BAD_LOGIC' },
  NOT: { payload: '((DOMAIN,a.com),(NETWORK,tcp))', code: 'E_RULE_BAD_LOGIC' },
  'RULE-SET': { payload: '', code: 'E_RULE_EMPTY_PAYLOAD' },
  MATCH: { payload: 'x', code: 'E_RULE_BAD_PAYLOAD' },
};

function expectOk(result: PayloadResult): asserts result is Extract<PayloadResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  expect(result.ok).toBe(true);
}

function expectFail(result: PayloadResult, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

describe('payload: one legal payload for every registry type (AC-11)', () => {
  it('covers all 37 registry entries', () => {
    expect(Object.keys(LEGAL).sort()).toEqual([...getAllRuleTypes()].sort());
    expect(Object.keys(ILLEGAL).sort()).toEqual([...getAllRuleTypes()].sort());
  });

  for (const type of getAllRuleTypes()) {
    it(`${type} accepts its legal payload`, () => {
      const result = validatePayload(type, LEGAL[type]);
      expectOk(result);
      if (type !== 'MATCH') expect(result.normalized.length).toBeGreaterThan(0);
    });

    it(`${type} rejects an illegal payload with ${ILLEGAL[type].code}`, () => {
      expectFail(validatePayload(type, ILLEGAL[type].payload), ILLEGAL[type].code);
    });
  }
});

describe('payload: normalization', () => {
  it('lowercases domains and strips DOMAIN-SUFFIX prefixes', () => {
    expect(validatePayload('DOMAIN', 'EXAMPLE.COM')).toEqual({
      ok: true,
      normalized: 'example.com',
    });
    expect(validatePayload('DOMAIN-SUFFIX', '+.Example.COM')).toEqual({
      ok: true,
      normalized: 'example.com',
    });
    expect(validatePayload('DOMAIN-SUFFIX', '.Example.COM')).toEqual({
      ok: true,
      normalized: 'example.com',
    });
    expect(validatePayload('DOMAIN-KEYWORD', 'Ads')).toEqual({ ok: true, normalized: 'Ads' });
  });

  it('normalizes CIDRs to their network address', () => {
    expect(validatePayload('IP-CIDR', '192.168.1.5/24')).toEqual({
      ok: true,
      normalized: '192.168.1.0/24',
    });
    expect(validatePayload('IP-CIDR6', '2001:DB8:0:0:0:0:0:1/32')).toEqual({
      ok: true,
      normalized: '2001:db8::/32',
    });
    expect(validatePayload('IP-SUFFIX', '08')).toEqual({ ok: true, normalized: '8' });
    expect(validatePayload('IP-SUFFIX', '10.1.2.3/8')).toEqual({
      ok: true,
      normalized: '10.0.0.0/8',
    });
  });

  it('normalizes port ranges, ASN, network, UID', () => {
    expect(validatePayload('SRC-PORT', '080')).toEqual({ ok: true, normalized: '80' });
    expect(validatePayload('DST-PORT', '080-090')).toEqual({ ok: true, normalized: '80-90' });
    expect(validatePayload('IP-ASN', 'as13335')).toEqual({ ok: true, normalized: 'AS13335' });
    expect(validatePayload('NETWORK', 'UDP')).toEqual({ ok: true, normalized: 'udp' });
    expect(validatePayload('UID', '0001-0002')).toEqual({ ok: true, normalized: '1-2' });
  });

  it('normalizes logic payloads recursively', () => {
    expect(validatePayload('AND', ' ( (DOMAIN, A.COM) , (NETWORK, TCP) ) ')).toEqual({
      ok: true,
      normalized: '((DOMAIN,a.com),(NETWORK,tcp))',
    });
    expect(
      validatePayload('AND', '((OR,((DOMAIN,a.com),(DOMAIN,b.com))),(NETWORK,tcp))'),
    ).toEqual({
      ok: true,
      normalized: '((OR,((DOMAIN,a.com),(DOMAIN,b.com))),(NETWORK,tcp))',
    });
  });
});

describe('payload: CIDR/IP primitives', () => {
  it('parses IPv4/IPv6 prefixes and masks host bits', () => {
    expect(parseCidr('0.0.0.0/0')?.canonical).toBe('0.0.0.0/0');
    expect(parseCidr('255.255.255.255/32')?.canonical).toBe('255.255.255.255/32');
    expect(parseCidr('1.2.3.4/24', 'v4')?.canonical).toBe('1.2.3.0/24');
    expect(parseCidr('::/0')?.canonical).toBe('::/0');
    expect(parseCidr('::1/128')?.canonical).toBe('::1/128');
    expect(parseCidr('2001:db8::1/32', 'v6')?.canonical).toBe('2001:db8::/32');
    expect(parseCidr('::ffff:0:0/96')?.canonical).toBe('::ffff:0:0/96');
  });

  it('rejects malformed CIDRs fail-closed', () => {
    for (const value of [
      '1.2.3.4',
      '1.2.3.0/33',
      '1.2.3.04/24',
      '01.2.3.4/24',
      '256.1.1.1/24',
      '2001:db8::/129',
      '2001:db8::1',
      '::1/128/1',
      '1.2.3.0/ 24',
      '1.2.3.0/abc',
    ]) {
      expect(parseCidr(value), value).toBeNull();
    }
    expect(parseCidr('1.2.3.0/24', 'v6')).toBeNull();
    expect(parseCidr('2001:db8::/32', 'v4')).toBeNull();
  });

  it('exposes lookup heuristics for dialect detection', () => {
    expect(looksLikeCidr('1.2.3.0/24')).toBe(true);
    expect(looksLikeCidr('example.com')).toBe(false);
    expect(looksLikeDomain('example.com')).toBe(true);
    expect(looksLikeDomain('+.example.com')).toBe(true);
    expect(looksLikeDomain('1.2.3.0/24')).toBe(false);
    expect(looksLikeDomain('a b')).toBe(false);
  });
});

describe('payload: regex compilation', () => {
  it('translates a leading (?i) and validates without executing', () => {
    const compiled = compileRuleRegex('(?i)^ads[0-9]+$');
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.normalized).toBe('(?i)^ads[0-9]+$');
      expect(compiled.regex.flags).toContain('i');
      expect(compiled.engineDiff).toBe(false);
    }
  });

  it('flags regexp2 differences conservatively', () => {
    const compiled = compileRuleRegex('\\p{L}+');
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.engineDiff).toBe(true);
  });

  it('rejects invalid and over-long regexes', () => {
    expect(compileRuleRegex('[').ok).toBe(false);
    expect(compileRuleRegex('').ok).toBe(false);
    expect(compileRuleRegex('a'.repeat(513)).ok).toBe(false);
    expect(compileRuleRegex('a'.repeat(512)).ok).toBe(true);
  });
});

describe('payload: ports / ASN / UID / domains', () => {
  it('parses port ranges', () => {
    expect(parsePortRange('80')).toEqual({ from: 80, to: 80, canonical: '80' });
    expect(parsePortRange('80-90')).toEqual({ from: 80, to: 90, canonical: '80-90' });
    expect(parsePortRange('0-65535')).toEqual({ from: 0, to: 65535, canonical: '0-65535' });
    for (const value of ['65536', '90-80', '-1', '1-', '1,2']) {
      expect(parsePortRange(value), value).toBeNull();
    }
  });

  it('parses ASN and UID ranges', () => {
    expect(parseAsn('13335')).toBe('13335');
    expect(parseAsn('as13335')).toBe('AS13335');
    expect(parseAsn('AS000013335')).toBe('AS13335');
    expect(parseAsn('ASX')).toBeNull();
    expect(parseUidRange('1000')).toBe('1000');
    expect(parseUidRange('1000-2000')).toBe('1000-2000');
    expect(parseUidRange('2000-1000')).toBeNull();
    expect(parseUidRange('-1')).toBeNull();
  });

  it('rejects long domains, forbidden characters and wildcards', () => {
    expect(normalizeDomain('x'.repeat(254), false).ok).toBe(false);
    expect(normalizeDomain('a'.repeat(253), false).ok).toBe(true);
    for (const value of ['bad domain', 'a/b', 'a:b', 'a,b', '*.example.com', '.leading']) {
      expect(normalizeDomain(value, false).ok, value).toBe(false);
    }
  });
});

describe('payload: logic rules (SPEC §5.1 / AC-12)', () => {
  it('rejects nested MATCH and SUB-RULE', () => {
    expectFail(validatePayload('AND', '((MATCH,G),(DOMAIN,a.com))'), 'E_RULE_BAD_LOGIC');
    expectFail(validatePayload('AND', '((SUB-RULE,x),(DOMAIN,a.com))'), 'E_RULE_BAD_LOGIC');
  });

  it('rejects unbalanced parentheses and non-single outer groups', () => {
    expectFail(validatePayload('AND', '((DOMAIN,a.com),(NETWORK,tcp)'), 'E_RULE_BAD_LOGIC');
    expectFail(validatePayload('AND', '(DOMAIN,a.com),(NETWORK,tcp)'), 'E_RULE_BAD_LOGIC');
    expectFail(validatePayload('AND', '((DOMAIN,a.com),())'), 'E_RULE_BAD_LOGIC');
  });

  it('enforces AND/OR/NOT arity', () => {
    expectFail(validatePayload('AND', '((DOMAIN,a.com))'), 'E_RULE_BAD_LOGIC');
    expectFail(validatePayload('OR', '((DOMAIN,a.com))'), 'E_RULE_BAD_LOGIC');
    expectFail(validatePayload('NOT', '()'), 'E_RULE_BAD_LOGIC');
  });

  it('rejects too many or too deeply nested sub-rules', () => {
    const many = `(${'((DOMAIN,a.com)),'.repeat(65)}((DOMAIN,b.com)))`;
    expectFail(validatePayload('AND', many), 'E_RULE_BAD_LOGIC');

    let nested = '((DOMAIN,a.com))';
    for (let i = 0; i < 20; i += 1) nested = `((OR,${nested}),(NETWORK,tcp))`;
    expectFail(validatePayload('AND', nested), 'E_RULE_BAD_LOGIC');
  });

  it('rejects invalid sub-rule payloads', () => {
    expectFail(
      validatePayload('AND', '((IP-CIDR,999.0.0.0/99),(NETWORK,tcp))'),
      'E_RULE_BAD_LOGIC',
    );
    expectFail(
      validatePayload('AND', '((DOMAIN,a.com,PROXY),(NETWORK,tcp))'),
      'E_RULE_BAD_LOGIC',
    );
  });
});
