/**
 * Exact mihomo rule-type registry (SPEC §5.1 / §5.2).
 *
 * This is the single source of truth for the 37 rule types supported by
 * mihomo `Alpha@478af2a` (`rules/parser.go`). Matching is always EXACT after
 * `trim().toUpperCase()`; prefix matching is forbidden because it lets
 * `MATCHBOX` / `DOMAIN-FOO` through (docs/research/doma-diagnosis.md:319-320).
 *
 * Do not add payload validation here: see `payload.ts`.
 */

import type { RuleType, SupportedDialect } from '../types';

export type RuleGroup =
  | 'domain'
  | 'geo'
  | 'ip'
  | 'port'
  | 'misc'
  | 'process'
  | 'logic'
  | 'ref'
  | 'final';

/** Discriminator consumed by `payload.ts`. */
export type PayloadKind =
  | 'domain'
  | 'domain-suffix'
  | 'domain-keyword'
  | 'regex'
  | 'wildcard'
  | 'geo'
  | 'asn'
  | 'ipv4-cidr'
  | 'ipv6-cidr'
  | 'cidr-any'
  | 'ip-suffix'
  | 'port'
  | 'dscp'
  | 'process'
  | 'network'
  | 'uid'
  | 'in-type'
  | 'in-user'
  | 'in-name'
  | 'rematch-name'
  | 'rule-set'
  | 'sub-rule'
  | 'logic'
  | 'match';

export interface RuleTypeMeta {
  type: RuleType;
  group: RuleGroup;
  payloadKind: PayloadKind;
  /** `false` means v1 never emits this type (SPEC §5.1). */
  emit: boolean;
  /** `no-resolve` is accepted as an extra field. */
  allowsNoResolve: boolean;
  /** Payload may contain commas; target is the last comma field. */
  commaBearing: boolean;
  /** Inline `#` / `//` must not be stripped (regex-sensitive payloads). */
  commentSensitive: boolean;
}

function meta(
  type: RuleType,
  group: RuleGroup,
  payloadKind: PayloadKind,
  options: Partial<
    Pick<RuleTypeMeta, 'emit' | 'allowsNoResolve' | 'commaBearing' | 'commentSensitive'>
  > = {},
): RuleTypeMeta {
  return {
    type,
    group,
    payloadKind,
    emit: options.emit ?? true,
    allowsNoResolve: options.allowsNoResolve ?? false,
    commaBearing: options.commaBearing ?? false,
    commentSensitive: options.commentSensitive ?? false,
  };
}

/**
 * The 37 exact types, in the order used by docs/SPEC.md §5.1.
 * `IP-CIDR6` shares a parser case with `IP-CIDR` in mihomo, but we validate
 * them separately so IPv6 payloads never end up in `IP-CIDR`.
 */
export const RULE_REGISTRY: Record<string, RuleTypeMeta> = {
  DOMAIN: meta('DOMAIN', 'domain', 'domain'),
  'DOMAIN-SUFFIX': meta('DOMAIN-SUFFIX', 'domain', 'domain-suffix'),
  'DOMAIN-KEYWORD': meta('DOMAIN-KEYWORD', 'domain', 'domain-keyword'),
  'DOMAIN-REGEX': meta('DOMAIN-REGEX', 'domain', 'regex', {
    commaBearing: true,
    commentSensitive: true,
  }),
  'DOMAIN-WILDCARD': meta('DOMAIN-WILDCARD', 'domain', 'wildcard'),
  GEOSITE: meta('GEOSITE', 'geo', 'geo'),
  GEOIP: meta('GEOIP', 'geo', 'geo', { allowsNoResolve: true }),
  'SRC-GEOIP': meta('SRC-GEOIP', 'geo', 'geo', { allowsNoResolve: true }),
  'IP-ASN': meta('IP-ASN', 'ip', 'asn', { allowsNoResolve: true }),
  'SRC-IP-ASN': meta('SRC-IP-ASN', 'ip', 'asn', { allowsNoResolve: true }),
  'IP-CIDR': meta('IP-CIDR', 'ip', 'ipv4-cidr', { allowsNoResolve: true }),
  'IP-CIDR6': meta('IP-CIDR6', 'ip', 'ipv6-cidr', { allowsNoResolve: true }),
  'SRC-IP-CIDR': meta('SRC-IP-CIDR', 'ip', 'cidr-any', { allowsNoResolve: true }),
  'IP-SUFFIX': meta('IP-SUFFIX', 'ip', 'ip-suffix', { allowsNoResolve: true }),
  'SRC-IP-SUFFIX': meta('SRC-IP-SUFFIX', 'ip', 'ip-suffix', { allowsNoResolve: true }),
  'SRC-PORT': meta('SRC-PORT', 'port', 'port'),
  'DST-PORT': meta('DST-PORT', 'port', 'port'),
  'IN-PORT': meta('IN-PORT', 'port', 'port'),
  DSCP: meta('DSCP', 'misc', 'dscp'),
  'PROCESS-NAME': meta('PROCESS-NAME', 'process', 'process'),
  'PROCESS-PATH': meta('PROCESS-PATH', 'process', 'process'),
  'PROCESS-NAME-REGEX': meta('PROCESS-NAME-REGEX', 'process', 'regex', {
    commaBearing: true,
    commentSensitive: true,
  }),
  'PROCESS-PATH-REGEX': meta('PROCESS-PATH-REGEX', 'process', 'regex', {
    commaBearing: true,
    commentSensitive: true,
  }),
  'PROCESS-NAME-WILDCARD': meta('PROCESS-NAME-WILDCARD', 'process', 'wildcard'),
  'PROCESS-PATH-WILDCARD': meta('PROCESS-PATH-WILDCARD', 'process', 'wildcard'),
  NETWORK: meta('NETWORK', 'misc', 'network'),
  UID: meta('UID', 'misc', 'uid'),
  'IN-TYPE': meta('IN-TYPE', 'misc', 'in-type'),
  'IN-USER': meta('IN-USER', 'misc', 'in-user'),
  'IN-NAME': meta('IN-NAME', 'misc', 'in-name'),
  'REMATCH-NAME': meta('REMATCH-NAME', 'misc', 'rematch-name'),
  'SUB-RULE': meta('SUB-RULE', 'logic', 'sub-rule', {
    emit: false,
    commaBearing: true,
    commentSensitive: true,
  }),
  AND: meta('AND', 'logic', 'logic', { commaBearing: true, commentSensitive: true }),
  OR: meta('OR', 'logic', 'logic', { commaBearing: true, commentSensitive: true }),
  NOT: meta('NOT', 'logic', 'logic', { commaBearing: true, commentSensitive: true }),
  'RULE-SET': meta('RULE-SET', 'ref', 'rule-set'),
  MATCH: meta('MATCH', 'final', 'match'),
};

/** Aliases that have a mihomo equivalent (SPEC §5.2). */
export const TYPE_ALIASES: Readonly<Record<string, RuleType>> = Object.freeze({
  FINAL: 'MATCH',
  HOST: 'DOMAIN',
  'HOST-SUFFIX': 'DOMAIN-SUFFIX',
  'HOST-KEYWORD': 'DOMAIN-KEYWORD',
  'HOST-WILDCARD': 'DOMAIN-WILDCARD',
  'DEST-PORT': 'DST-PORT',
  'IP6-CIDR': 'IP-CIDR6',
  // `SRC-IP` is conditional: it becomes SRC-IP-CIDR only when the payload is a
  // valid CIDR. `parse.ts` applies the payload check and warns
  // W_RULE_TYPE_UNSUPPORTED otherwise.
  'SRC-IP': 'SRC-IP-CIDR',
});

/** Surge/QuanX types with no mihomo equivalent: drop with W_RULE_TYPE_UNSUPPORTED. */
export const UNSUPPORTED_TYPES: ReadonlySet<string> = new Set([
  'URL-REGEX',
  'USER-AGENT',
  'PROCESS-USER-AGENT',
  'DOMAIN-SET',
]);

const ALL_TYPES: readonly RuleType[] = Object.freeze(
  Object.values(RULE_REGISTRY).map((entry) => entry.type),
);

const ALIAS_KEYS: readonly string[] = Object.freeze(Object.keys(TYPE_ALIASES));

/** All tokens that may legitimately start a typed rule line. */
const KNOWN_TOKENS: ReadonlySet<string> = new Set([
  ...Object.keys(RULE_REGISTRY),
  ...ALIAS_KEYS,
]);

/** Dialects whose line contents are typed rules (SPEC §6.2 tail heuristics). */
export const TYPED_DIALECTS: ReadonlySet<SupportedDialect> = new Set<SupportedDialect>([
  'clash-classical',
  'clash-domain',
  'clash-ipcidr',
  'surge',
]);

export interface TypeResolution {
  /** Canonical type, or null when the token is not usable. */
  type: RuleType | null;
  /** True when the input token was an alias (not an exact registry key). */
  alias: boolean;
  /** Original normalized token. */
  token: string;
  /** Input was one of the explicit unsupported Surge/QuanX types. */
  unsupported: boolean;
  /** Input was not a known type or alias at all. */
  unknown: boolean;
  /** `SRC-IP`: caller must check whether the payload is a CIDR. */
  conditionalAlias: boolean;
}

export function resolveRuleType(raw: string): TypeResolution {
  const token = raw.trim().toUpperCase();
  const exact = RULE_REGISTRY[token];
  if (exact) {
    return {
      type: exact.type,
      alias: false,
      token,
      unsupported: false,
      unknown: false,
      conditionalAlias: false,
    };
  }
  const alias = TYPE_ALIASES[token];
  if (alias) {
    return {
      type: alias,
      alias: true,
      token,
      unsupported: false,
      unknown: false,
      conditionalAlias: token === 'SRC-IP',
    };
  }
  return {
    type: null,
    alias: false,
    token,
    unsupported: UNSUPPORTED_TYPES.has(token),
    unknown: true,
    conditionalAlias: false,
  };
}

/** Canonical type after alias translation; null for unknown/unsupported. */
export function normalizeType(raw: string): RuleType | null {
  return resolveRuleType(raw).type;
}

/** Canonical type only when `raw` was an alias; null otherwise. */
export function resolveAlias(raw: string): RuleType | null {
  const resolved = resolveRuleType(raw);
  return resolved.alias ? resolved.type : null;
}

export function isKnownType(raw: string): boolean {
  return resolveRuleType(raw).type !== null;
}

export function isKnownToken(raw: string): boolean {
  return KNOWN_TOKENS.has(raw.trim().toUpperCase());
}

export function getRuleTypeMeta(type: string): RuleTypeMeta | undefined {
  return RULE_REGISTRY[type.trim().toUpperCase()];
}

export function isEmittedType(type: string): boolean {
  return getRuleTypeMeta(type)?.emit ?? false;
}

export function isCommaBearingType(type: string): boolean {
  return getRuleTypeMeta(type)?.commaBearing ?? false;
}

export function isCommentSensitiveType(type: string): boolean {
  return getRuleTypeMeta(type)?.commentSensitive ?? false;
}

export function allowsNoResolve(type: string): boolean {
  return getRuleTypeMeta(type)?.allowsNoResolve ?? false;
}

export function getAllRuleTypes(): readonly RuleType[] {
  return ALL_TYPES;
}

/** True when `token` is a strict prefix of a known type or alias (`DOMA`). */
export function isStrictTypePrefix(token: string): boolean {
  const upper = token.trim().toUpperCase();
  if (!upper || KNOWN_TOKENS.has(upper)) return false;
  // SPEC §6.2 explicitly names `MATCHBO` as a truncated-tail example even
  // though `MATCHBOX` is not a mihomo type. Keep that documented sentinel
  // without turning arbitrary `MATCHBOX` into a truncation signal.
  if (upper === 'MATCHBO') return true;
  for (const known of KNOWN_TOKENS) {
    if (known.startsWith(upper)) return true;
  }
  return false;
}

/** True when the token is a known type or alias (used by tail/template checks). */
export function isTypeOrAliasToken(token: string): boolean {
  return KNOWN_TOKENS.has(token.trim().toUpperCase());
}

/**
 * Detect the rule type token of a raw line without validating it.
 * Returns the substring before the first comma, trimmed.
 */
export function ruleTypeToken(line: string): string {
  const comma = line.indexOf(',');
  return (comma === -1 ? line : line.slice(0, comma)).trim();
}
