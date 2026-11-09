/**
 * Payload syntax validation and normalization for the 37 mihomo rule types
 * (SPEC §5.1, §5.2, §5.3). Pure functions only: no source/line context leaks in
 * here.
 *
 * CIDR parsing is implemented locally (pure TypeScript) for the same reason the
 * `links` module does it: `node:net` is unavailable in workerd and we must be
 * able to unit-test without Worker APIs. Regexes are compiled but never
 * executed against user input (SPEC §11 R6).
 */

import type { WarningCode } from '../types';
import {
  getRuleTypeMeta,
  resolveRuleType,
  type PayloadKind,
} from './registry';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PayloadSuccess {
  ok: true;
  normalized: string;
  /** Regex may behave differently in mihomo's regexp2 engine (W_REGEX_ENGINE_DIFF). */
  engineDiff?: boolean;
  /** Aliases translated inside a logic payload (W_RULE_TYPE_ALIAS). */
  aliases?: string[];
}

export interface PayloadFailure {
  ok: false;
  code: WarningCode;
  message: string;
  hint?: string;
}

export type PayloadResult = PayloadSuccess | PayloadFailure;

function ok(
  normalized: string,
  extra: { engineDiff?: boolean; aliases?: string[] } = {},
): PayloadSuccess {
  return {
    ok: true,
    normalized,
    ...(extra.engineDiff === true ? { engineDiff: true } : {}),
    ...(extra.aliases !== undefined && extra.aliases.length > 0
      ? { aliases: extra.aliases }
      : {}),
  };
}

function fail(code: WarningCode, message: string, hint?: string): PayloadFailure {
  return { ok: false, code, message, ...(hint === undefined ? {} : { hint }) };
}

function badPayload(message: string): PayloadFailure {
  return fail('E_RULE_BAD_PAYLOAD', message);
}

function badDomain(message = 'domain payload is invalid'): PayloadFailure {
  return fail('E_RULE_BAD_DOMAIN', message);
}

function badCidr(message = 'CIDR payload is invalid'): PayloadFailure {
  return fail('E_RULE_BAD_CIDR', message);
}

function badPort(message = 'port payload is invalid'): PayloadFailure {
  return fail('E_RULE_BAD_PORT', message);
}

function badAsn(message = 'ASN payload is invalid'): PayloadFailure {
  return fail('E_RULE_BAD_ASN', message);
}

function badRegex(message = 'regular expression is invalid'): PayloadFailure {
  return fail('E_RULE_BAD_REGEX', message);
}

function badLogic(message = 'logic rule is invalid'): PayloadFailure {
  return fail('E_RULE_BAD_LOGIC', message);
}

// ---------------------------------------------------------------------------
// IP / CIDR primitives
// ---------------------------------------------------------------------------

export type Ipv4Bytes = [number, number, number, number];

export function parseIpv4Literal(text: string): Ipv4Bytes | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // mihomo (netip) rejects leading zeros; also avoids octal surprises.
    if (part.length > 1 && part.startsWith('0')) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return [bytes[0], bytes[1], bytes[2], bytes[3]];
}

export function parseIpv6Literal(text: string): Uint8Array | null {
  const lower = text.toLowerCase();
  if (!lower || lower.includes('%') || lower.includes('/')) return null;

  const firstDouble = lower.indexOf('::');
  if (firstDouble !== -1 && lower.indexOf('::', firstDouble + 1) !== -1) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const raw = segment.split(':');
    const groups: number[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const group = raw[i];
      if (group === '') return null;
      if (group.includes('.')) {
        if (i !== raw.length - 1) return null;
        const v4 = parseIpv4Literal(group);
        if (v4 === null) return null;
        groups.push((v4[0] << 8) | v4[1]);
        groups.push((v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
        groups.push(Number.parseInt(group, 16));
      }
    }
    return groups;
  };

  let groups: number[];
  if (firstDouble === -1) {
    const parsed = parseGroups(lower);
    if (parsed === null || parsed.length !== 8) return null;
    groups = parsed;
  } else {
    const left = parseGroups(lower.slice(0, firstDouble));
    const right = parseGroups(lower.slice(firstDouble + 2));
    if (left === null || right === null) return null;
    // `::` must stand for at least one zero group.
    if (left.length + right.length > 7) return null;
    groups = [
      ...left,
      ...new Array<number>(8 - left.length - right.length).fill(0),
      ...right,
    ];
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    bytes[2 * i] = (groups[i] >> 8) & 0xff;
    bytes[2 * i + 1] = groups[i] & 0xff;
  }
  return bytes;
}

export function formatIpv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    groups.push(((bytes[2 * i] << 8) | bytes[2 * i + 1]) & 0xffff);
  }
  let bestStart = -1;
  let bestLength = 1;
  let currentStart = -1;
  let currentLength = 0;
  for (let i = 0; i < 8; i += 1) {
    if (groups[i] === 0) {
      if (currentStart === -1) currentStart = i;
      currentLength += 1;
      if (currentLength > bestLength) {
        bestLength = currentLength;
        bestStart = currentStart;
      }
    } else {
      currentStart = -1;
      currentLength = 0;
    }
  }
  const hex = groups.map((value) => value.toString(16));
  if (bestStart === -1 || bestLength < 2) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
}

function maskBytes(bytes: Uint8Array, prefix: number): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    const bits = prefix - i * 8;
    if (bits >= 8) out[i] = bytes[i];
    else if (bits <= 0) out[i] = 0;
    else out[i] = bytes[i] & ((0xff << (8 - bits)) & 0xff);
  }
  return out;
}

export interface ParsedCidr {
  version: 4 | 6;
  prefix: number;
  /** Network address + prefix, lowercase/compressed. */
  canonical: string;
}

export type CidrFamily = 'v4' | 'v6' | 'any';

/** Parse a strict `address/prefix` CIDR. Bare IPs are rejected. */
export function parseCidr(raw: string, family: CidrFamily = 'any'): ParsedCidr | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  const slash = text.indexOf('/');
  if (slash === -1) return null;
  if (text.indexOf('/', slash + 1) !== -1) return null;
  const address = text.slice(0, slash);
  const prefixText = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  const isV4 = !address.includes(':');
  if (family === 'v4' && !isV4) return null;
  if (family === 'v6' && isV4) return null;

  if (isV4) {
    const v4 = parseIpv4Literal(address);
    if (v4 === null || prefix > 32) return null;
    const masked = maskBytes(Uint8Array.from(v4), prefix);
    return {
      version: 4,
      prefix,
      canonical: `${masked[0]}.${masked[1]}.${masked[2]}.${masked[3]}/${prefix}`,
    };
  }

  const v6 = parseIpv6Literal(address);
  if (v6 === null || prefix > 128) return null;
  const masked = maskBytes(v6, prefix);
  return { version: 6, prefix, canonical: `${formatIpv6(masked)}/${prefix}` };
}

export function isValidCidr(raw: string, family: CidrFamily = 'any'): boolean {
  return parseCidr(raw, family) !== null;
}

/** Heuristic used by dialect auto-detection: the entry is a strict CIDR. */
export function looksLikeCidr(raw: string): boolean {
  return parseCidr(raw, 'any') !== null;
}

// ---------------------------------------------------------------------------
// Ports / ASN / UID
// ---------------------------------------------------------------------------

export interface ParsedPortRange {
  from: number;
  to: number;
  canonical: string;
}

export function parsePortRange(raw: string): ParsedPortRange | null {
  const text = raw.trim();
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(text);
  if (!match) return null;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from > 65535 || to > 65535 || from > to) return null;
  return { from, to, canonical: from === to ? String(from) : `${from}-${to}` };
}

export function parseAsn(raw: string): string | null {
  const match = /^(AS)?(\d{1,10})$/i.exec(raw.trim());
  if (!match) return null;
  const digits = String(Number(match[2]));
  return match[1] === undefined ? digits : `AS${digits}`;
}

export function parseUidRange(raw: string): string | null {
  const text = raw.trim();
  const match = /^(\d{1,15})(?:-(\d{1,15}))?$/.exec(text);
  if (!match) return null;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
  return from === to ? String(from) : `${from}-${to}`;
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/** Characters that can never appear in DOMAIN / DOMAIN-SUFFIX payload. */
const DOMAIN_FORBIDDEN = /[\s\u0000-\u001f\u007f,\/:*?#]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface NormalizedDomain {
  ok: true;
  value: string;
}

/**
 * Normalize a DOMAIN / DOMAIN-SUFFIX payload.
 * - lowercase
 * - DOMAIN-SUFFIX strips one leading `+.` or `.`
 * - rejects whitespace/control/`,`/`/`/`:` and wildcards
 */
export function normalizeDomain(
  payload: string,
  suffix: boolean,
): NormalizedDomain | PayloadFailure {
  let value = payload.trim();
  if (suffix) {
    if (value.startsWith('+.')) value = value.slice(2);
    else if (value.startsWith('.')) value = value.slice(1);
  }
  if (value.length === 0) {
    return payload.trim().length === 0
      ? fail('E_RULE_EMPTY_PAYLOAD', 'domain payload is empty')
      : badDomain('domain payload becomes empty after normalization');
  }
  if (value.length > 253) return badDomain('domain payload is longer than 253 characters');
  if (DOMAIN_FORBIDDEN.test(value)) return badDomain('domain payload contains a forbidden character');
  if (value.startsWith('.') || value.startsWith('+')) {
    return badDomain('domain payload has an invalid leading character');
  }
  return { ok: true, value: value.toLowerCase() };
}

/** Heuristic used by dialect detection (does not validate the whole registry). */
export function looksLikeDomain(raw: string): boolean {
  const text = raw.trim();
  if (!text || text.length > 253) return false;
  if (/[\s,\/:*?#]/.test(text)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------

export interface RuleRegexResult {
  ok: true;
  regex: RegExp;
  /** Original pattern (with any leading `(?i)`) preserved for output. */
  normalized: string;
  /** Regexp2 and JS differ for these constructs. */
  engineDiff: boolean;
}

export interface RuleRegexFailure {
  ok: false;
  message: string;
}

/**
 * Compile a rule regex without executing it.
 * - length <= 512 (SPEC §5.1)
 * - a leading `(?i)` is translated to the JS `i` flag
 * - `\p{...}` / `\u{...}` switch on the `u` flag for validation
 */
export function compileRuleRegex(pattern: string): RuleRegexResult | RuleRegexFailure {
  const normalized = pattern.trim();
  if (normalized.length === 0) return { ok: false, message: 'regular expression is empty' };
  if (normalized.length > 512) {
    return { ok: false, message: 'regular expression is longer than 512 characters' };
  }

  let source = normalized;
  let flags = '';
  if (source.startsWith('(?i)')) {
    source = source.slice(4);
    flags += 'i';
  }
  // JS needs `u` for unicode property escapes; mihomo supports them natively.
  const usesUnicodeEscapes = /\\[pP]\{/.test(source) || /\\u\{/.test(source);
  if (usesUnicodeEscapes) flags += 'u';

  try {
    // eslint-disable-next-line no-new
    new RegExp(source, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'regular expression is invalid';
    return { ok: false, message };
  }

  return {
    ok: true,
    regex: new RegExp(source, flags),
    normalized,
    engineDiff: usesUnicodeEscapes || /\\k</.test(source),
  };
}

// ---------------------------------------------------------------------------
// Logic rules (AND / OR / NOT)
// ---------------------------------------------------------------------------

const MAX_LOGIC_DEPTH = 16;
const MAX_LOGIC_SUBRULES = 64;

function balancedParentheses(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** Split on commas that are not nested inside parentheses. */
function splitTopLevel(text: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  parts.push(text.slice(start));
  return parts;
}

function validateLogicPayload(
  type: 'AND' | 'OR' | 'NOT',
  payload: string,
  depth: number,
  aliases: Set<string>,
): PayloadResult {
  if (depth > MAX_LOGIC_DEPTH) return badLogic('logic rule nesting is too deep');

  const text = payload.trim();
  if (text.length < 3 || !text.startsWith('(') || !text.endsWith(')')) {
    return badLogic('logic payload must be wrapped in parentheses');
  }
  if (!balancedParentheses(text)) return badLogic('logic payload has unbalanced parentheses');

  // The first '(' must close at the very end; otherwise `AND,(A),(B)` would be
  // accepted even though the outer payload is not a single group.
  let level = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') level += 1;
    else if (text[i] === ')') {
      level -= 1;
      if (level === 0 && i !== text.length - 1) {
        return badLogic('logic payload must be a single parenthesized group');
      }
    }
  }

  const inner = text.slice(1, -1);
  const parts = splitTopLevel(inner);
  if (parts === null || parts.length === 0) return badLogic('logic payload has no sub-rules');
  if (parts.length > MAX_LOGIC_SUBRULES) return badLogic('logic payload has too many sub-rules');

  for (const part of parts) {
    if (part.trim() === '') return badLogic('logic payload contains an empty sub-rule');
  }

  if ((type === 'AND' || type === 'OR') && parts.length < 2) {
    return badLogic(`${type} requires at least two sub-rules`);
  }
  if (type === 'NOT' && parts.length !== 1) {
    return badLogic('NOT requires exactly one sub-rule');
  }

  const normalizedSubs: string[] = [];
  for (const part of parts) {
    const sub = part.trim();
    if (!sub.startsWith('(') || !sub.endsWith(')') || !balancedParentheses(sub)) {
      return badLogic('each logic sub-rule must be a balanced parenthesized group');
    }
    const subInner = sub.slice(1, -1);
    const comma = subInner.indexOf(',');
    if (comma === -1) return badLogic('logic sub-rule must be TYPE,PAYLOAD');

    const rawType = subInner.slice(0, comma).trim();
    const rawPayload = subInner.slice(comma + 1).trim();
    const resolved = resolveRuleType(rawType);
    if (resolved.type === null) {
      return badLogic(
        resolved.unsupported
          ? `logic sub-rule type ${rawType} has no mihomo equivalent`
          : `unknown logic sub-rule type ${rawType}`,
      );
    }
    if (resolved.type === 'MATCH' || resolved.type === 'SUB-RULE') {
      return badLogic(`${resolved.type} is not allowed inside a logic rule`);
    }
    if (resolved.type === 'AND' || resolved.type === 'OR' || resolved.type === 'NOT') {
      if (depth + 1 > MAX_LOGIC_DEPTH) return badLogic('logic rule nesting is too deep');
    }
    if (resolved.alias) aliases.add(resolved.token);

    const subResult = validatePayloadInternal(resolved.type, rawPayload, depth + 1, aliases);
    if (!subResult.ok) {
      return badLogic(`logic sub-rule ${resolved.type} is invalid: ${subResult.message}`);
    }
    normalizedSubs.push(`(${resolved.type},${subResult.normalized})`);
  }

  return ok(`(${normalizedSubs.join(',')})`);
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

function validatePayloadInternal(
  type: string,
  payload: string,
  depth: number,
  aliases: Set<string>,
): PayloadResult {
  const meta = getRuleTypeMeta(type);
  if (!meta) return fail('E_RULE_UNKNOWN_TYPE', `unknown rule type ${type}`);

  const value = payload.trim();

  if (meta.payloadKind === 'match') {
    return value === '' ? ok('') : badPayload('MATCH takes no payload');
  }

  if (value.length === 0) {
    return fail('E_RULE_EMPTY_PAYLOAD', `${meta.type} requires a non-empty payload`);
  }

  const kind: PayloadKind = meta.payloadKind;
  switch (kind) {
    case 'domain':
    case 'domain-suffix': {
      const normalized = normalizeDomain(value, kind === 'domain-suffix');
      if (!normalized.ok) return normalized;
      return ok(normalized.value);
    }
    case 'domain-keyword': {
      if (value.length > 128) return badDomain('domain keyword is longer than 128 characters');
      // SPEC §5.1: non-empty, no whitespace/control/comma, <=128. `/`, `:` and
      // wildcard characters are legal keyword text and stay untouched.
      if (/\s/.test(value) || CONTROL.test(value) || value.includes(',')) {
        return badDomain('domain keyword contains a forbidden character');
      }
      return ok(value);
    }
    case 'regex': {
      const compiled = compileRuleRegex(value);
      if (!compiled.ok) return badRegex(compiled.message);
      return ok(compiled.normalized, { engineDiff: compiled.engineDiff });
    }
    case 'wildcard': {
      if (!/^[A-Za-z0-9.*?-]+$/.test(value)) {
        return badPayload('wildcard payload may only contain [A-Za-z0-9.*?-]');
      }
      if (!value.includes('*') && !value.includes('?')) {
        return badPayload('wildcard payload needs at least one * or ?');
      }
      const limit = meta.group === 'process' ? 256 : 253;
      if (value.length > limit) return badPayload(`wildcard payload is longer than ${limit} characters`);
      return ok(value);
    }
    case 'geo': {
      if (!/^[A-Za-z0-9_-]{2,32}$/.test(value)) {
        return badPayload('GEOSITE/GEOIP payload must match [A-Za-z0-9_-]{2,32}');
      }
      return ok(value);
    }
    case 'asn': {
      const normalized = parseAsn(value);
      if (normalized === null) return badAsn();
      return ok(normalized);
    }
    case 'ipv4-cidr': {
      const cidr = parseCidr(value, 'v4');
      if (cidr === null) return badCidr('expected a valid IPv4 CIDR');
      return ok(cidr.canonical);
    }
    case 'ipv6-cidr': {
      const cidr = parseCidr(value, 'v6');
      if (cidr === null) return badCidr('expected a valid IPv6 CIDR');
      return ok(cidr.canonical);
    }
    case 'cidr-any': {
      const cidr = parseCidr(value, 'any');
      if (cidr === null) return badCidr('expected a valid IPv4 or IPv6 CIDR');
      return ok(cidr.canonical);
    }
    case 'ip-suffix': {
      if (/^\d{1,2}$/.test(value)) {
        const prefix = Number(value);
        if (prefix > 32) return badCidr('IP-SUFFIX must be 0..32');
        return ok(String(prefix));
      }
      const cidr = parseCidr(value, 'any');
      if (cidr === null) return badCidr('IP-SUFFIX must be 0..32 or a valid CIDR');
      return ok(cidr.canonical);
    }
    case 'port': {
      const range = parsePortRange(value);
      if (range === null) return badPort();
      return ok(range.canonical);
    }
    case 'dscp': {
      if (!/^\d{1,2}$/.test(value)) return badPayload('DSCP must be an integer 0..63');
      const dscp = Number(value);
      if (dscp > 63) return badPayload('DSCP must be an integer 0..63');
      return ok(String(dscp));
    }
    case 'process': {
      if (CONTROL.test(value)) return badPayload('process payload contains a control character');
      if (value.length > 256) return badPayload('process payload is longer than 256 characters');
      return ok(value);
    }
    case 'network': {
      const network = value.toLowerCase();
      if (network !== 'tcp' && network !== 'udp') {
        return fail('E_RULE_BAD_NETWORK', 'NETWORK payload must be tcp or udp');
      }
      return ok(network);
    }
    case 'uid': {
      const uid = parseUidRange(value);
      if (uid === null) return badPayload('UID must be a non-negative integer or a range');
      return ok(uid);
    }
    case 'in-type': {
      if (CONTROL.test(value)) return badPayload('IN-TYPE contains a control character');
      if (value.length > 64) return badPayload('IN-TYPE is longer than 64 characters');
      return ok(value);
    }
    case 'in-user':
    case 'in-name':
    case 'rematch-name': {
      if (CONTROL.test(value)) return badPayload(`${meta.type} contains a control character`);
      if (value.length > 256) return badPayload(`${meta.type} is longer than 256 characters`);
      return ok(value);
    }
    case 'rule-set': {
      if (value.length > 128) return badPayload('RULE-SET provider name is longer than 128 characters');
      if (/[\s,]/.test(value) || CONTROL.test(value)) {
        return badPayload('RULE-SET provider name contains a forbidden character');
      }
      return ok(value);
    }
    case 'sub-rule': {
      if (value.length > 128) return badPayload('SUB-RULE payload is too long');
      if (CONTROL.test(value) || value.includes(',')) {
        return badPayload('SUB-RULE payload contains a forbidden character');
      }
      return ok(value);
    }
    case 'logic': {
      if (type === 'AND' || type === 'OR' || type === 'NOT') {
        return validateLogicPayload(type, value, depth, aliases);
      }
      return badLogic('unknown logic rule type');
    }
    default: {
      return badPayload(`no payload validator for ${meta.type}`);
    }
  }
}

/**
 * Validate and normalize a payload for an exact, already-resolved type.
 * Returns `E_RULE_EMPTY_PAYLOAD` for non-MATCH empty payloads.
 */
export function validatePayload(type: string, payload: string): PayloadResult {
  const aliases = new Set<string>();
  const result = validatePayloadInternal(type, payload, 0, aliases);
  if (result.ok && aliases.size > 0) {
    return { ...result, aliases: [...aliases] };
  }
  return result;
}
