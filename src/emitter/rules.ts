/**
 * Rule serialization and independent invariant checking (SPEC §7.4, §6.3).
 *
 * `toRuleScalars` turns validated `Rule` objects into double-quoted YAML
 * scalars. `checkRuleLine` is a deliberately independent, minimal parser used
 * by the read-back gate: it does not import the `rules` module, so a bug in
 * rule parsing cannot hide itself during output validation.
 */

import { Scalar } from 'yaml';
import type { Rule, RuleParam, RuleType, Warning } from '../types';
import { RULE_TYPES } from '../types';
import { EmitterError } from './serialize';

const RULE_TYPE_SET: ReadonlySet<string> = new Set(RULE_TYPES);
const COMMA_PAYLOAD_TYPES: ReadonlySet<string> = new Set([
  'DOMAIN-REGEX',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX',
  'AND',
  'OR',
  'NOT',
]);
/** Types for which `no-resolve` is the only valid extra field (SPEC §5.3). */
const IP_FAMILY_TYPES: ReadonlySet<string> = new Set([
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
const MAX_RULE_LINE_LENGTH = 4096;
export const MAX_EMIT_RULES = 50000;

function truncateRaw(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
}

function assertTarget(target: unknown, type: string): asserts target is string {
  if (typeof target !== 'string' || target === '') {
    throw new EmitterError('E_EMIT_INVALID', `${type} rule has an empty target`);
  }
  if (target !== target.trim() || /[\u0000-\u001f\u007f,\r\n]/.test(target)) {
    throw new EmitterError('E_EMIT_INVALID', `${type} rule target "${target}" is not a valid name`);
  }
}

function assertParams(type: string, params: unknown): asserts params is RuleParam[] {
  if (!Array.isArray(params)) {
    throw new EmitterError('E_EMIT_INVALID', `${type} rule params must be an array`);
  }
  for (const param of params) {
    if (param !== 'no-resolve') {
      throw new EmitterError('E_EMIT_INVALID', `${type} rule has unsupported param "${String(param)}"`);
    }
  }
  if (params.length > 0 && !IP_FAMILY_TYPES.has(type)) {
    throw new EmitterError('E_EMIT_INVALID', `${type} rule does not accept the no-resolve param`);
  }
}

/**
 * Assemble one validated rule into its canonical mihomo text form:
 * `TYPE,PAYLOAD,TARGET[,no-resolve]`, or `MATCH,TARGET`.
 */
export function formatRule(rule: Rule): string {
  if (rule === null || typeof rule !== 'object') {
    throw new EmitterError('E_EMIT_INVALID', 'rule must be an object');
  }
  const type = rule.type;
  if (typeof type !== 'string' || !RULE_TYPE_SET.has(type)) {
    throw new EmitterError('E_EMIT_INVALID', `rule type "${String(type)}" is not in the mihomo registry`);
  }
  if (type === 'SUB-RULE') {
    throw new EmitterError('E_EMIT_INVALID', 'SUB-RULE rules are never emitted');
  }
  assertTarget(rule.target, type);
  assertParams(type, rule.params);

  const params = rule.params.length > 0 ? `,${rule.params.join(',')}` : '';

  if (type === 'MATCH') {
    if (rule.payload !== '') {
      throw new EmitterError('E_EMIT_INVALID', 'MATCH rule must not have a payload');
    }
    if (params !== '') {
      throw new EmitterError('E_EMIT_INVALID', 'MATCH rule must not have params');
    }
    return `MATCH,${rule.target}`;
  }

  if (typeof rule.payload !== 'string' || rule.payload === '') {
    throw new EmitterError('E_EMIT_INVALID', `${type} rule has an empty payload`);
  }
  if (/[\u0000\r\n]/.test(rule.payload)) {
    throw new EmitterError('E_EMIT_INVALID', `${type} rule payload contains control characters`);
  }
  if (!COMMA_PAYLOAD_TYPES.has(type) && rule.payload.includes(',')) {
    throw new EmitterError('E_EMIT_INVALID', `${type} rule payload must not contain a comma`);
  }

  return `${type},${rule.payload},${rule.target}${params}`;
}

/**
 * Convert the final rule list to YAML scalars. The list must be non-empty,
 * contain exactly one MATCH and end with it (SPEC §7.4).
 */
export function toRuleScalars(rules: readonly Rule[]): Scalar[] {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new EmitterError('E_EMIT_INVALID', 'rules must contain at least the final MATCH');
  }
  const last = rules[rules.length - 1];
  if (last === undefined || last.type !== 'MATCH') {
    throw new EmitterError('E_EMIT_INVALID', 'the last rule must be MATCH');
  }
  for (let index = 0; index < rules.length - 1; index += 1) {
    if (rules[index]?.type === 'MATCH') {
      throw new EmitterError('E_EMIT_INVALID', 'only one MATCH rule is allowed and it must be last');
    }
  }

  return rules.map((rule) => {
    const text = formatRule(rule);
    if (text.length > MAX_RULE_LINE_LENGTH) {
      throw new EmitterError('E_EMIT_INVALID', `rule exceeds ${MAX_RULE_LINE_LENGTH} characters`);
    }
    const scalar = new Scalar(text);
    scalar.type = Scalar.QUOTE_DOUBLE;
    return scalar;
  });
}

function makeMatchRule(target: string): Rule {
  return {
    type: 'MATCH' as RuleType,
    payload: '',
    target,
    params: [],
    raw: `MATCH,${target}`,
    line: 0,
    sourceId: 'emitter',
  };
}

/**
 * Enforce the final-MATCH policy: exactly one MATCH, placed last. When rules
 * arrive without MATCH, a `MATCH,<defaultGroup>` is appended and
 * `W_DEFAULT_MATCH_ADDED` is reported. Multiple MATCHes keep the last one
 * (`W_RULE_DUPLICATE_MATCH`). Rules beyond `maxRules` are truncated while the
 * final MATCH is preserved (`W_RULE_LIMIT`).
 */
export function ensureTrailingMatch(
  rules: readonly Rule[],
  defaultGroup: string,
  warnings: Warning[] = [],
  maxRules = MAX_EMIT_RULES,
): Rule[] {
  if (typeof defaultGroup !== 'string' || defaultGroup === '' || /[\u0000-\u001f\u007f,]/.test(defaultGroup)) {
    throw new EmitterError('E_EMIT_INVALID', 'default group name is invalid');
  }

  const nonMatch: Rule[] = [];
  const matches: Rule[] = [];
  for (const rule of rules) {
    if (rule.type === 'MATCH') matches.push(rule);
    else nonMatch.push(rule);
  }

  let match: Rule;
  if (matches.length === 0) {
    match = makeMatchRule(defaultGroup);
    warnings.push({
      code: 'W_DEFAULT_MATCH_ADDED',
      severity: 'info',
      stage: 'rules',
      message: `no MATCH rule found; added MATCH,${defaultGroup}`,
    });
  } else {
    match = matches[matches.length - 1] as Rule;
    if (matches.length > 1) {
      for (const duplicate of matches.slice(0, -1)) {
        warnings.push({
          code: 'W_RULE_DUPLICATE_MATCH',
          severity: 'warning',
          stage: 'rules',
          message: 'multiple MATCH rules found; keeping the last one',
          line: duplicate.line,
          raw: truncateRaw(duplicate.raw),
        });
      }
    }
    if (typeof match.target !== 'string' || match.target === '') {
      match = makeMatchRule(defaultGroup);
      warnings.push({
        code: 'W_DEFAULT_MATCH_ADDED',
        severity: 'info',
        stage: 'rules',
        message: `MATCH rule had an empty target; using ${defaultGroup}`,
      });
    } else {
      assertTarget(match.target, 'MATCH');
      if (match.payload !== '') {
        throw new EmitterError('E_EMIT_INVALID', 'MATCH rule must not have a payload');
      }
    }
  }

  let kept = nonMatch;
  // SPEC §5.6/§9.4: the final MATCH is not subject to MAX_RULES, so at most
  // `maxRules` non-MATCH rules are kept and MATCH is always appended.
  if (kept.length > Math.max(0, maxRules)) {
    warnings.push({
      code: 'W_RULE_LIMIT',
      severity: 'warning',
      stage: 'rules',
      message: `kept the first ${Math.max(0, maxRules)} non-MATCH rules (limit ${maxRules})`,
    });
    kept = kept.slice(0, Math.max(0, maxRules));
  }
  return [...kept, match];
}

export type RuleLineCheck = { ok: true } | { ok: false; message: string };

function fail(message: string): RuleLineCheck {
  return { ok: false, message };
}

function isValidPortValue(value: string): boolean {
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(value);
  if (!match) return false;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  return from <= 65535 && to <= 65535 && from <= to;
}

function isValidUid(value: string): boolean {
  const match = /^(\d{1,10})(?:-(\d{1,10}))?$/.exec(value);
  if (!match) return false;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  return from <= to;
}

function isValidDomain(value: string): boolean {
  if (value === '' || value.length > 253) return false;
  if (/[\s,/\\\u0000-\u001f\u007f]/.test(value)) return false;
  return /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/.test(value);
}

function isValidDomainKeyword(value: string): boolean {
  return value !== '' && value.length <= 128 && !/[\s,\u0000-\u001f\u007f]/.test(value);
}

function isValidWildcard(value: string, maxLength: number): boolean {
  return (
    value !== ''
    && value.length <= maxLength
    && /^[A-Za-z0-9.*?-]+$/.test(value)
    && (value.includes('*') || value.includes('?'))
  );
}

function isValidIpv4Address(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function ipv6GroupCount(part: string): number | null {
  if (part === '') return 0;
  const groups = part.split(':');
  let count = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index] as string;
    if (group === '') return null;
    if (group.includes('.')) {
      if (index !== groups.length - 1 || !isValidIpv4Address(group)) return null;
      count += 2;
      continue;
    }
    if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return null;
    count += 1;
  }
  return count;
}

function isValidIpv6Address(address: string): boolean {
  if (address === '' || !address.includes(':')) return false;
  const doubleColon = address.indexOf('::');
  if (doubleColon === -1) {
    const count = ipv6GroupCount(address);
    return count === 8;
  }
  if (address.indexOf('::', doubleColon + 2) !== -1) return false;
  const head = ipv6GroupCount(address.slice(0, doubleColon));
  const tail = ipv6GroupCount(address.slice(doubleColon + 2));
  if (head === null || tail === null) return false;
  return head + tail < 8;
}

function isValidCidr(value: string, version: 4 | 6): boolean {
  const slash = value.indexOf('/');
  if (slash === -1) return false;
  const address = value.slice(0, slash);
  const prefixText = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return false;
  const prefix = Number(prefixText);
  if (version === 4) return prefix <= 32 && isValidIpv4Address(address);
  return prefix <= 128 && isValidIpv6Address(address);
}

export function isValidCidrValue(value: string, version?: 4 | 6): boolean {
  if (version === 4) return isValidCidr(value, 4);
  if (version === 6) return isValidCidr(value, 6);
  return isValidCidr(value, 4) || isValidCidr(value, 6);
}

function compileRulePattern(pattern: string): string | null {
  if (pattern.length > 512) return 'regular expression is longer than 512 characters';
  let source = pattern;
  let flags = 'u';
  if (source.startsWith('(?i)')) {
    source = source.slice(4);
    flags = 'iu';
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(source, flags);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkLogicPayload(type: string, payload: string): RuleLineCheck {
  if (!payload.startsWith('(') || !payload.endsWith(')')) {
    return fail(`${type} payload must be wrapped in parentheses`);
  }
  let depth = 0;
  let escaped = false;
  const children: string[] = [];
  let current = '';
  for (const char of payload) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '(') {
      depth += 1;
      if (depth === 1) {
        current = '';
        continue;
      }
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) return fail(`${type} payload has unbalanced parentheses`);
      if (depth === 1) {
        children.push(current);
        current = '';
        continue;
      }
    } else if (char === ',' && depth === 1) {
      continue;
    }
    if (depth >= 2) current += char;
  }
  if (depth !== 0) return fail(`${type} payload has unbalanced parentheses`);
  if (/(^|[,()])\s*(MATCH|SUB-RULE)\s*,/i.test(payload)) {
    return fail(`${type} payload must not contain MATCH or SUB-RULE`);
  }
  if (type === 'NOT') {
    if (children.length !== 1) return fail('NOT payload must contain exactly one sub-rule');
  } else if (children.length < 2) {
    return fail(`${type} payload must contain at least two sub-rules`);
  }
  return { ok: true };
}

function checkPayload(type: string, payload: string): RuleLineCheck {
  switch (type) {
    case 'DOMAIN':
    case 'DOMAIN-SUFFIX':
      return isValidDomain(payload) ? { ok: true } : fail(`${type} payload is not a valid domain`);
    case 'DOMAIN-KEYWORD':
      return isValidDomainKeyword(payload) ? { ok: true } : fail('DOMAIN-KEYWORD payload is invalid');
    case 'DOMAIN-WILDCARD':
      return isValidWildcard(payload, 253) ? { ok: true } : fail('DOMAIN-WILDCARD payload is invalid');
    case 'DOMAIN-REGEX':
    case 'PROCESS-NAME-REGEX':
    case 'PROCESS-PATH-REGEX': {
      const error = compileRulePattern(payload);
      return error === null ? { ok: true } : fail(`${type} payload is not a valid regular expression: ${error}`);
    }
    case 'GEOSITE':
    case 'GEOIP':
    case 'SRC-GEOIP':
      return /^[A-Za-z0-9_-]{2,32}$/.test(payload) ? { ok: true } : fail(`${type} payload is invalid`);
    case 'IP-ASN':
    case 'SRC-IP-ASN':
      return /^(AS)?\d{1,10}$/i.test(payload) ? { ok: true } : fail(`${type} payload is not a valid ASN`);
    case 'IP-CIDR':
      return isValidCidrValue(payload, 4) ? { ok: true } : fail('IP-CIDR payload is not a valid IPv4 CIDR');
    case 'IP-CIDR6':
      return isValidCidrValue(payload, 6) ? { ok: true } : fail('IP-CIDR6 payload is not a valid IPv6 CIDR');
    case 'SRC-IP-CIDR':
      return isValidCidrValue(payload) ? { ok: true } : fail('SRC-IP-CIDR payload is not a valid CIDR');
    case 'IP-SUFFIX':
    case 'SRC-IP-SUFFIX':
      if (/^\d{1,2}$/.test(payload) && Number(payload) <= 32) return { ok: true };
      return isValidCidrValue(payload) ? { ok: true } : fail(`${type} payload is invalid`);
    case 'SRC-PORT':
    case 'DST-PORT':
    case 'IN-PORT':
      return isValidPortValue(payload) ? { ok: true } : fail(`${type} payload is not a valid port/range`);
    case 'DSCP':
      return /^\d{1,2}$/.test(payload) && Number(payload) <= 63 ? { ok: true } : fail('DSCP payload is invalid');
    case 'PROCESS-NAME':
    case 'PROCESS-PATH':
      return payload !== '' && payload.length <= 256 && !/[\u0000-\u001f\u007f]/.test(payload)
        ? { ok: true }
        : fail(`${type} payload is invalid`);
    case 'PROCESS-NAME-WILDCARD':
    case 'PROCESS-PATH-WILDCARD':
      return isValidWildcard(payload, 256) ? { ok: true } : fail(`${type} payload is invalid`);
    case 'NETWORK':
      return payload === 'tcp' || payload === 'udp' ? { ok: true } : fail('NETWORK payload must be tcp or udp');
    case 'UID':
      return isValidUid(payload) ? { ok: true } : fail('UID payload is invalid');
    case 'IN-TYPE':
      return payload !== '' && payload.length <= 64 && !/[\u0000-\u001f\u007f]/.test(payload)
        ? { ok: true }
        : fail('IN-TYPE payload is invalid');
    case 'IN-USER':
    case 'IN-NAME':
    case 'REMATCH-NAME':
      return payload !== '' && payload.length <= 256 && !/[\u0000-\u001f\u007f]/.test(payload)
        ? { ok: true }
        : fail(`${type} payload is invalid`);
    case 'RULE-SET':
      return payload !== '' && !/[\s,\u0000-\u001f\u007f]/.test(payload)
        ? { ok: true }
        : fail('RULE-SET payload must be a provider name');
    case 'AND':
    case 'OR':
    case 'NOT':
      return checkLogicPayload(type, payload);
    default:
      return fail(`unknown rule type "${type}"`);
  }
}

/**
 * Independent single-line invariant check used after YAML read-back. It is
 * intentionally stricter than "has a comma": it re-validates the type
 * registry, field arity, target, payload syntax and final-MATCH shape.
 */
export function checkRuleLine(line: string): RuleLineCheck {
  if (typeof line !== 'string' || line === '') return fail('rule line is empty');
  if (line.length > MAX_RULE_LINE_LENGTH) return fail('rule line is too long');
  if (/[\u0000\r\n]/.test(line)) return fail('rule line contains control characters');
  if (line !== line.trim()) return fail('rule line has leading or trailing whitespace');

  const firstComma = line.indexOf(',');
  if (firstComma <= 0) return fail('rule line has no type separator');
  const type = line.slice(0, firstComma);
  if (!RULE_TYPE_SET.has(type)) return fail(`unknown rule type "${type}"`);
  if (type === 'SUB-RULE') return fail('SUB-RULE is never emitted');

  if (type === 'MATCH') {
    const fields = line.split(',');
    if (fields.length !== 2) return fail('MATCH must have exactly two fields');
    const target = fields[1] as string;
    if (target === '') return fail('MATCH has an empty target');
    return { ok: true };
  }

  if (COMMA_PAYLOAD_TYPES.has(type)) {
    const lastComma = line.lastIndexOf(',');
    if (lastComma <= firstComma) return fail(`${type} rule is missing a payload or target`);
    const payload = line.slice(firstComma + 1, lastComma);
    const target = line.slice(lastComma + 1);
    if (payload === '') return fail(`${type} rule has an empty payload`);
    if (target === '') return fail(`${type} rule has an empty target`);
    if (target.includes(',')) return fail(`${type} rule target contains a comma`);
    return checkPayload(type, payload);
  }

  const fields = line.split(',');
  if (fields.length < 3) return fail(`${type} rule is missing a target (truncated line?)`);
  if (fields.length > 4) return fail(`${type} rule has too many fields`);
  const payload = fields[1] as string;
  const target = fields[2] as string;
  if (payload === '') return fail(`${type} rule has an empty payload`);
  if (target === '') return fail(`${type} rule has an empty target`);
  if (fields.length === 4 && fields[3] !== 'no-resolve') {
    return fail(`${type} rule has an unsupported fourth field`);
  }
  if (fields.length === 4 && !IP_FAMILY_TYPES.has(type)) {
    return fail(`${type} rule does not accept no-resolve`);
  }
  return checkPayload(type, payload);
}

/** Throwing variant used by the emitter read-back gate. */
export function assertRuleLine(line: string): void {
  const result = checkRuleLine(line);
  if (!result.ok) {
    throw new EmitterError('E_EMIT_INVALID', `generated rule is invalid: ${result.message}`);
  }
}

export { COMMA_PAYLOAD_TYPES, IP_FAMILY_TYPES, MAX_RULE_LINE_LENGTH };
