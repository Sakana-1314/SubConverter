import { describe, expect, it } from 'vitest';
import {
  RULE_REGISTRY,
  TYPED_DIALECTS,
  TYPE_ALIASES,
  UNSUPPORTED_TYPES,
  allowsNoResolve,
  getAllRuleTypes,
  getRuleTypeMeta,
  isCommentSensitiveType,
  isCommaBearingType,
  isEmittedType,
  isKnownToken,
  isKnownType,
  isStrictTypePrefix,
  isTypeOrAliasToken,
  normalizeType,
  resolveAlias,
  resolveRuleType,
} from '../../../src/rules/registry';
import { RULE_TYPES } from '../../../src/types';

const SPEC_TYPES = [
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'DOMAIN-WILDCARD',
  'GEOSITE',
  'GEOIP',
  'SRC-GEOIP',
  'IP-ASN',
  'SRC-IP-ASN',
  'IP-CIDR',
  'IP-CIDR6',
  'SRC-IP-CIDR',
  'IP-SUFFIX',
  'SRC-IP-SUFFIX',
  'SRC-PORT',
  'DST-PORT',
  'IN-PORT',
  'DSCP',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX',
  'PROCESS-NAME-WILDCARD',
  'PROCESS-PATH-WILDCARD',
  'NETWORK',
  'UID',
  'IN-TYPE',
  'IN-USER',
  'IN-NAME',
  'REMATCH-NAME',
  'SUB-RULE',
  'AND',
  'OR',
  'NOT',
  'RULE-SET',
  'MATCH',
];

describe('registry: 37 exact mihomo types (SPEC §5.1)', () => {
  it('contains exactly the 37 documented types in order', () => {
    expect(Object.keys(RULE_REGISTRY)).toEqual(SPEC_TYPES);
    expect(getAllRuleTypes()).toEqual(SPEC_TYPES);
    expect(new Set(getAllRuleTypes()).size).toBe(37);
    expect(RULE_TYPES).toEqual(SPEC_TYPES);
  });

  it('marks only SUB-RULE as non-emitted', () => {
    for (const type of SPEC_TYPES) {
      const meta = getRuleTypeMeta(type);
      expect(meta, type).toBeDefined();
      expect(meta?.emit, type).toBe(type !== 'SUB-RULE');
    }
    expect(isEmittedType('SUB-RULE')).toBe(false);
    expect(isEmittedType('DOMAIN')).toBe(true);
  });

  it('assigns comma-bearing and comment-sensitive flags exactly', () => {
    const commaBearing = SPEC_TYPES.filter((type) => isCommaBearingType(type));
    expect(commaBearing.sort()).toEqual(
      [
        'AND',
        'DOMAIN-REGEX',
        'NOT',
        'OR',
        'PROCESS-NAME-REGEX',
        'PROCESS-PATH-REGEX',
        'SUB-RULE',
      ].sort(),
    );
    const sensitive = SPEC_TYPES.filter((type) => isCommentSensitiveType(type));
    expect(sensitive.sort()).toEqual(commaBearing.sort());
  });

  it('allows no-resolve only on IP-family/GEOIP types', () => {
    const allowed = SPEC_TYPES.filter((type) => allowsNoResolve(type)).sort();
    expect(allowed).toEqual(
      [
        'GEOIP',
        'SRC-GEOIP',
        'IP-ASN',
        'SRC-IP-ASN',
        'IP-CIDR',
        'IP-CIDR6',
        'SRC-IP-CIDR',
        'IP-SUFFIX',
        'SRC-IP-SUFFIX',
      ].sort(),
    );
  });

  it('recognizes only typed dialects for tail heuristics', () => {
    expect([...TYPED_DIALECTS].sort()).toEqual(
      ['clash-classical', 'clash-domain', 'clash-ipcidr', 'surge'].sort(),
    );
  });
});

describe('registry: exact matching, never prefix matching', () => {
  it('normalizes case and surrounding whitespace', () => {
    expect(normalizeType('domain')).toBe('DOMAIN');
    expect(normalizeType('  DOMAIN-SUFFIX  ')).toBe('DOMAIN-SUFFIX');
    expect(normalizeType('Ip-CiDr6')).toBe('IP-CIDR6');
    expect(normalizeType('match')).toBe('MATCH');
  });

  it('rejects truncated and prefix-similar tokens', () => {
    expect(normalizeType('DOMA')).toBeNull();
    expect(normalizeType('DOMAIN-SUFFI')).toBeNull();
    expect(normalizeType('MATCHBOX')).toBeNull();
    expect(normalizeType('DOMAIN-FOO')).toBeNull();
    expect(normalizeType('DOMAIN-REGEX-EXTRA')).toBeNull();
    expect(normalizeType('')).toBeNull();
  });

  it('flags strict prefixes for truncation detection', () => {
    expect(isStrictTypePrefix('DOMA')).toBe(true);
    expect(isStrictTypePrefix('DOMAIN-SUFFI')).toBe(true);
    expect(isStrictTypePrefix('MATCHBO')).toBe(true);
    expect(isStrictTypePrefix('DOMAIN')).toBe(false); // exact token, not strict
    expect(isStrictTypePrefix('MATCHBOX')).toBe(false);
    expect(isStrictTypePrefix('')).toBe(false);
    expect(isStrictTypePrefix('DOMAIN-FOO')).toBe(false);
  });

  it('distinguishes known tokens from arbitrary strings', () => {
    expect(isKnownType('FINAL')).toBe(true); // alias
    expect(isKnownType('SRC-IP')).toBe(true);
    expect(isKnownType('URL-REGEX')).toBe(false);
    expect(isKnownToken('SRC-IP')).toBe(true);
    expect(isTypeOrAliasToken('host-suffix')).toBe(true);
    expect(isTypeOrAliasToken('DOMA')).toBe(false);
  });
});

describe('registry: aliases and unsupported types (SPEC §5.2)', () => {
  it('maps every documented alias', () => {
    expect(TYPE_ALIASES).toEqual({
      FINAL: 'MATCH',
      HOST: 'DOMAIN',
      'HOST-SUFFIX': 'DOMAIN-SUFFIX',
      'HOST-KEYWORD': 'DOMAIN-KEYWORD',
      'HOST-WILDCARD': 'DOMAIN-WILDCARD',
      'DEST-PORT': 'DST-PORT',
      'IP6-CIDR': 'IP-CIDR6',
      'SRC-IP': 'SRC-IP-CIDR',
    });
    expect(resolveAlias('final')).toBe('MATCH');
    expect(resolveAlias('HOST')).toBe('DOMAIN');
    expect(resolveAlias('DOMAIN')).toBeNull();
    expect(normalizeType('HOST-KEYWORD')).toBe('DOMAIN-KEYWORD');
  });

  it('marks SRC-IP as a conditional alias', () => {
    expect(resolveRuleType('SRC-IP')).toMatchObject({
      type: 'SRC-IP-CIDR',
      alias: true,
      conditionalAlias: true,
    });
    expect(resolveRuleType('IP6-CIDR')).toMatchObject({
      type: 'IP-CIDR6',
      alias: true,
      conditionalAlias: false,
    });
  });

  it('marks Surge/QuanX types with no mihomo equivalent as unsupported', () => {
    for (const type of ['URL-REGEX', 'USER-AGENT', 'PROCESS-USER-AGENT', 'DOMAIN-SET']) {
      expect(UNSUPPORTED_TYPES.has(type)).toBe(true);
      expect(resolveRuleType(type)).toMatchObject({ type: null, unsupported: true, unknown: true });
      expect(normalizeType(type)).toBeNull();
    }
    expect(resolveRuleType('MATCHBOX')).toMatchObject({
      type: null,
      unsupported: false,
      unknown: true,
    });
  });
});
