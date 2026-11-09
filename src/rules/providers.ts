/**
 * Rule-provider specs and `/getruleset` payload serialization (SPEC §2.7, §5.7,
 * §7.5).
 *
 * The rules module decides behavior, provider names and the exact
 * type -> payload mapping. The integration handler appends the origin and
 * serves the YAML.
 */

import {
  DEFAULT_PROVIDER_INTERVAL,
  type Rule,
  type RuleProviderSpec,
  type RulesetFormat,
  type RulesetType,
} from '../types';
import { isEmittedType } from './registry';
import {
  PROVIDER_URL_MAX_LEN,
  toWarning,
  ruleIssue,
  type RuleIssue,
} from './types';

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

/** SPEC §5.7 behavior decision over the validated rules of one source. */
export function decideBehavior(rules: readonly Rule[]): RulesetFormat {
  if (rules.length === 0) return 'classical';
  let onlyDomain = true;
  let onlyIp = true;
  for (const rule of rules) {
    if (rule.type !== 'DOMAIN' && rule.type !== 'DOMAIN-SUFFIX') onlyDomain = false;
    if (rule.type !== 'IP-CIDR' && rule.type !== 'IP-CIDR6') onlyIp = false;
  }
  if (onlyDomain) return 'domain';
  if (onlyIp) return 'ipcidr';
  return 'classical';
}

export function rulesetTypeForBehavior(behavior: RulesetFormat): RulesetType {
  switch (behavior) {
    case 'domain':
      return 3;
    case 'ipcidr':
      return 4;
    case 'classical':
      return 6;
  }
}

export function behaviorForRulesetType(type: RulesetType): RulesetFormat {
  switch (type) {
    case 3:
      return 'domain';
    case 4:
      return 'ipcidr';
    case 6:
      return 'classical';
  }
}

// ---------------------------------------------------------------------------
// Provider names
// ---------------------------------------------------------------------------

const FNV_OFFSET_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const FNV_OFFSET_64 = 14_695_981_039_346_656_037n;
const FNV_PRIME_64 = 1_099_511_628_211n;

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 8 hex characters, FNV-1a 32-bit over UTF-8 bytes. */
export function fnv1a32Hex(text: string): string {
  let hash = FNV_OFFSET_32;
  for (const byte of utf8Bytes(text)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 16 hex characters, FNV-1a 64-bit (used only for collision expansion). */
export function fnv1a64Hex(text: string): string {
  let hash = FNV_OFFSET_64;
  for (const byte of utf8Bytes(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME_64) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function sourceSlug(sourceRaw: string): string {
  let candidate = 'inline';
  if (!/^(?:inline|data):/i.test(sourceRaw)) {
    try {
      const url = new URL(sourceRaw);
      const segments = url.pathname.split('/').filter((segment) => segment !== '');
      candidate = segments.length > 0 ? segments[segments.length - 1] : 'inline';
    } catch {
      candidate = 'inline';
    }
  }
  candidate = candidate
    .toLowerCase()
    .replace(/\.(?:txt|list|yaml|yml|conf|json)$/i, '')
    .replace(/[^a-z0-9_-]+/g, '');
  if (candidate === '') candidate = 'inline';
  return candidate.slice(0, 24);
}

/**
 * Deterministic provider name: `rs_<8 hex FNV-1a>_<slug>`.
 * On collision the hash is expanded to 12 (then 16/24/32) hex characters
 * (SPEC §5.7). `used` is mutated with the selected name.
 */
export function providerName(
  sourceRaw: string,
  dialect: string,
  used?: Set<string>,
): string {
  const seed = `${dialect}\u0000${sourceRaw}`;
  const slug = sourceSlug(sourceRaw);
  const hash32 = fnv1a32Hex(seed);
  const candidates: string[] = [`rs_${hash32}_${slug}`];

  const hash64 = fnv1a64Hex(seed);
  candidates.push(`rs_${hash64.slice(0, 12)}_${slug}`);
  candidates.push(`rs_${hash64.slice(0, 16)}_${slug}`);
  candidates.push(`rs_${hash64.slice(0, 24)}_${slug}`);
  candidates.push(`rs_${hash64.slice(0, 32)}_${slug}`);

  let chosen = candidates[0];
  if (used !== undefined) {
    let suffix = 2;
    for (const candidate of candidates) {
      if (!used.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
    if (used.has(chosen)) {
      while (used.has(`${chosen}_${suffix}`)) suffix += 1;
      chosen = `${chosen}_${suffix}`;
    }
    used.add(chosen);
  }
  return chosen;
}

export function providerKey(sourceRaw: string, dialect: string): string {
  return `${dialect}\u0000${sourceRaw}`;
}

// ---------------------------------------------------------------------------
// Provider specs
// ---------------------------------------------------------------------------

function normalizeInterval(interval: number | undefined): number {
  if (interval === undefined || !Number.isFinite(interval)) return DEFAULT_PROVIDER_INTERVAL;
  const value = Math.floor(interval);
  if (value < 60 || value > 604_800) return DEFAULT_PROVIDER_INTERVAL;
  return value;
}

export interface ProviderSourceLike {
  sourceId: string;
  dialect: RuleProviderSpec['source']['dialect'];
  rawSource?: string;
  /** Alias for `rawSource` (ARCHITECTURE uses `source.raw`). */
  raw?: string;
  interval?: number;
}

function providerRaw(source: ProviderSourceLike): string {
  return source.rawSource ?? source.raw ?? source.sourceId;
}

export function buildProviderSpec(
  source: ProviderSourceLike,
  behavior: RulesetFormat,
  used?: Set<string>,
): RuleProviderSpec {
  const raw = providerRaw(source);
  return {
    name: providerName(raw, source.dialect, used),
    behavior,
    source: { raw, dialect: source.dialect },
    interval: normalizeInterval(source.interval),
  };
}

export interface ProviderEligibility {
  ok: boolean;
  reason?: string;
}

/** SPEC §5.7: MATCH / RULE-SET / SUB-RULE or an over-long URL block providers. */
export function canBeProvider(
  rules: readonly Rule[],
  source: ProviderSourceLike,
  providerUrlLength: number,
  maxUrlLength: number = PROVIDER_URL_MAX_LEN,
): ProviderEligibility {
  if (rules.length === 0) return { ok: false, reason: 'source has no valid rules' };
  if (providerUrlLength > maxUrlLength) return { ok: false, reason: 'provider URL is too long' };
  for (const rule of rules) {
    if (rule.type === 'MATCH' || rule.type === 'RULE-SET' || rule.type === 'SUB-RULE') {
      return { ok: false, reason: `${rule.type} cannot be moved into a provider` };
    }
  }
  const raw = providerRaw(source);
  if (raw.trim() === '') return { ok: false, reason: 'source is empty' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// `/getruleset` payload mapping (SPEC §2.7)
// ---------------------------------------------------------------------------

/** SPEC §9.4 upper bound for a generated document. */
export const MAX_RULESET_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface RulesetBuildOptions {
  /** Maximum mapped payload items (SPEC §9.4 MAX_RULES). */
  maxItems?: number;
  /** Maximum serialized payload bytes; truncation produces a valid document. */
  maxBytes?: number;
}

export interface RulesetPayloadResult {
  /** Provider payload entries (without the `payload:` wrapper). */
  items: string[];
  /** Warnings for entries filtered out by the requested type. */
  warnings: ReturnType<typeof toWarning>[];
  /** Every input rule that was dropped by the type filter. */
  filtered: number;
}

function filteredWarning(rule: Rule, type: RulesetType): ReturnType<typeof toWarning> {
  return toWarning(
    ruleIssue(
      'W_RULESET_TYPE_FILTERED',
      `rule type ${rule.type} is not compatible with /getruleset type ${type}`,
      'warning',
    ),
    { sourceId: rule.sourceId, line: rule.line, raw: rule.raw },
  );
}

/**
 * Exact type -> payload mapping:
 * - type 3 (domain): DOMAIN -> `example.com`, DOMAIN-SUFFIX -> `+.example.com`
 * - type 4 (ipcidr): IP-CIDR/IP-CIDR6 -> `1.2.3.0/24`
 * - type 6 (classical): emitted types except MATCH/RULE-SET/SUB-RULE ->
 *   `TYPE,PAYLOAD[,no-resolve]` (no target)
 */
export function toRulesetPayload(rules: readonly Rule[], type: RulesetType): RulesetPayloadResult {
  const items: string[] = [];
  const warnings: ReturnType<typeof toWarning>[] = [];
  let filtered = 0;

  const drop = (rule: Rule): void => {
    filtered += 1;
    warnings.push(filteredWarning(rule, type));
  };

  for (const rule of rules) {
    if (type === 3) {
      if (rule.type === 'DOMAIN') items.push(rule.payload);
      else if (rule.type === 'DOMAIN-SUFFIX') items.push(`+.${rule.payload}`);
      else drop(rule);
      continue;
    }
    if (type === 4) {
      if (rule.type === 'IP-CIDR' || rule.type === 'IP-CIDR6') items.push(rule.payload);
      else drop(rule);
      continue;
    }
    // type 6
    if (rule.type === 'MATCH' || rule.type === 'RULE-SET' || rule.type === 'SUB-RULE') {
      drop(rule);
      continue;
    }
    if (!isEmittedType(rule.type)) {
      drop(rule);
      continue;
    }
    const params = rule.params.length > 0 ? `,${rule.params.join(',')}` : '';
    items.push(`${rule.type},${rule.payload}${params}`);
  }

  return { items, warnings, filtered };
}

/** SPEC §2.7 empty-result placeholders (mihomo must still load the provider). */
export function placeholderPayload(type: RulesetType): string {
  switch (type) {
    case 3:
      return '+.placeholder.invalid';
    case 4:
      return '0.0.0.0/32';
    case 6:
      return 'DOMAIN,placeholder.invalid';
  }
}

/** YAML document with exactly one top-level key, `payload`. */
export function serializeRulesetPayload(items: readonly string[]): string {
  return serializeRulesetPayloadLimited(items).yaml;
}

export interface LimitedPayload {
  yaml: string;
  bytes: number;
  /** True when one or more items were omitted to stay under `maxBytes`. */
  truncated: boolean;
}

/**
 * Serialize incrementally and stop before the byte cap. The result is always a
 * legal `payload:` document (placeholder/empty handling is the caller's job).
 */
export function serializeRulesetPayloadLimited(
  items: readonly string[],
  maxBytes = Number.POSITIVE_INFINITY,
): LimitedPayload {
  if (items.length === 0) {
    const yaml = 'payload: []\n';
    return { yaml, bytes: utf8ByteLength(yaml), truncated: false };
  }

  const header = 'payload:\n';
  let yaml = header;
  let bytes = utf8ByteLength(header);
  let count = 0;
  let truncated = false;
  for (const item of items) {
    const line = `  - ${JSON.stringify(item)}\n`;
    const lineBytes = utf8ByteLength(line);
    if (bytes + lineBytes > maxBytes) {
      truncated = true;
      break;
    }
    yaml += line;
    bytes += lineBytes;
    count += 1;
  }
  if (count === 0) {
    const empty = 'payload: []\n';
    return { yaml: empty, bytes: utf8ByteLength(empty), truncated: true };
  }
  return { yaml, bytes, truncated };
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Convenience: mapping + placeholder fallback + YAML, used by `/getruleset`. */
export function buildRulesetDocument(
  rules: readonly Rule[],
  type: RulesetType,
  sourceId = 'getruleset',
  options: RulesetBuildOptions = {},
): {
  yaml: string;
  warnings: ReturnType<typeof toWarning>[];
  placeholder: boolean;
  truncated: boolean;
  bytes: number;
} {
  const mapped = toRulesetPayload(rules, type);
  let itemTruncated = false;
  let items = mapped.items;
  if (options.maxItems !== undefined && items.length > options.maxItems) {
    items = items.slice(0, Math.max(0, options.maxItems));
    itemTruncated = true;
  }
  let placeholder = items.length === 0;
  if (placeholder) items = [placeholderPayload(type)];
  const warnings = [...mapped.warnings];
  if (placeholder) {
    warnings.push(
      toWarning(
        ruleIssue(
          'W_RULESET_EMPTY',
          'rule source is empty or all entries were filtered; a placeholder was emitted',
          'warning',
        ),
        { sourceId, line: 0, raw: '' },
      ),
    );
  }
  if (itemTruncated) {
    warnings.push(
      toWarning(
        ruleIssue(
          'W_RULE_LIMIT',
          `provider payload exceeds ${options.maxItems} items; the rest were ignored`,
          'warning',
        ),
        { sourceId, line: 0, raw: '' },
      ),
    );
  }

  let serialized = serializeRulesetPayloadLimited(items, options.maxBytes);
  if (serialized.truncated) {
    warnings.push(
      toWarning(
        ruleIssue(
          'E_OUTPUT_TOO_LARGE',
          `provider payload exceeds ${options.maxBytes ?? 0} bytes; the payload was truncated`,
          'error',
          undefined,
          'emit',
        ),
        { sourceId, line: 0, raw: '' },
      ),
    );
  }

  // If the byte cap did not even allow the first item, emit the legal
  // placeholder instead of an empty payload.
  if (!placeholder && serialized.yaml === 'payload: []\n') {
    placeholder = true;
    items = [placeholderPayload(type)];
    serialized = serializeRulesetPayloadLimited(items, options.maxBytes);
    warnings.push(
      toWarning(
        ruleIssue(
          'W_RULESET_EMPTY',
          'byte limit left no payload items; a placeholder was emitted',
          'warning',
        ),
        { sourceId, line: 0, raw: '' },
      ),
    );
  }

  return {
    yaml: serialized.yaml,
    warnings,
    placeholder,
    truncated: itemTruncated || serialized.truncated,
    bytes: serialized.bytes,
  };
}

/** Exported for tests that want to assert warning shape without importing types. */
export type ProviderIssue = RuleIssue;
