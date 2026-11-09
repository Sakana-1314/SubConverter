/**
 * Clash/mihomo template sanitization (SPEC §7.1, AC-16).
 *
 * Allowed top-level keys pass through untouched (deep-copied); core keys and
 * dangerous keys are dropped with a warning. Template `rules` are extracted
 * only when `overwrite_original_rules=false`; the caller must validate them
 * through the rules module before appending.
 */

import type { Warning } from '../types';
import { EmitterError, isPlainObject, isUnsafeMapKey } from './serialize';

/**
 * Top-level template keys allowed by SPEC §7.1. `proxies`, `proxy-groups`,
 * `rule-providers` and `rules` are owned by the generator and never inherited.
 */
export const ALLOWED_TEMPLATE_KEYS: readonly string[] = [
  'mixed-port',
  'port',
  'socks-port',
  'redir-port',
  'tproxy-port',
  'allow-lan',
  'bind-address',
  'mode',
  'log-level',
  'ipv6',
  'unified-delay',
  'tcp-concurrent',
  'find-process-mode',
  'global-client-fingerprint',
  'interface-name',
  'routing-mark',
  'disable-keep-alive',
  'keep-alive-idle',
  'keep-alive-interval',
  'dns',
  'tun',
  'sniffer',
  'hosts',
  'profile',
  'geodata-mode',
  'geo-auto-update',
  'geox-url',
  'geosite',
  'geodata',
];

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_TEMPLATE_KEYS);

/** Explicit denials from SPEC §7.1 (before the unknown-key fallback). */
export const DENIED_TEMPLATE_KEYS: readonly string[] = [
  'proxies',
  'proxy-groups',
  'rules',
  'rule-providers',
  'proxy-providers',
  'script',
  'external-controller',
  'external-ui',
  'secret',
  'authentication',
  'listeners',
  'tunnels',
  'sub-rules',
  'experimental',
];

const DENIED_SET: ReadonlySet<string> = new Set(DENIED_TEMPLATE_KEYS);
const CORE_KEYS: ReadonlySet<string> = new Set([
  'proxies',
  'proxy-groups',
  'rule-providers',
]);

const MAX_TEMPLATE_DEPTH = 32;

export interface SanitizeTemplateOptions {
  /**
   * Mirrors config `overwrite_original_rules`; defaults to `true` per SPEC
   * §7.1/§8.4 (intentional change from tindy's ExternalConfig default).
   */
  overwriteOriginalRules?: boolean;
  /** Warning `source` label; defaults to `template`. */
  sourceId?: string;
}

export interface TemplateResult {
  template: Record<string, unknown>;
  templateRules: string[];
  warnings: Warning[];
}

type CleanResult = { ok: true; value: unknown } | { ok: false; reason: string };

function templateWarning(
  warnings: Warning[],
  code: string,
  message: string,
  sourceId: string,
): void {
  warnings.push({
    code,
    severity: 'warning',
    stage: 'template',
    message,
    source: sourceId,
  });
}

/** Recursively copy YAML-safe data, rejecting functions/symbols/NaN/cycles. */
function cleanValue(value: unknown, path: string, depth: number): CleanResult {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return { ok: true, value };
  if (type === 'number') {
    if (!Number.isFinite(value as number)) return { ok: false, reason: 'non-finite number' };
    return { ok: true, value };
  }
  if (type !== 'object') return { ok: false, reason: `unsupported value type "${type}"` };

  if (depth >= MAX_TEMPLATE_DEPTH) return { ok: false, reason: 'nesting is too deep' };

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const cleaned = cleanValue(item, `${path}[]`, depth + 1);
      if (!cleaned.ok) return cleaned;
      if (cleaned.value === undefined) return { ok: false, reason: 'array contains undefined' };
      out.push(cleaned.value);
    }
    return { ok: true, value: out };
  }

  if (!isPlainObject(value)) return { ok: false, reason: 'not a plain object' };

  const out: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return { ok: false, reason: 'object keys are not readable' };
  }
  for (const key of keys) {
    if (isUnsafeMapKey(key)) {
      return { ok: false, reason: `unsafe key "${key}"` };
    }
    let child: unknown;
    try {
      child = value[key];
    } catch {
      return { ok: false, reason: `property "${key}" is not readable` };
    }
    const cleaned = cleanValue(child, `${path}.${key}`, depth + 1);
    if (!cleaned.ok) return { ok: false, reason: `${key}: ${cleaned.reason}` };
    if (cleaned.value === undefined) continue;
    Object.defineProperty(out, key, {
      value: cleaned.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { ok: true, value: out };
}

/**
 * Sanitize a parsed template. Throws `EmitterError('invalid_template')` when
 * the root is not a plain object (integration turns that into HTTP 400).
 */
export function sanitizeTemplate(
  value: unknown,
  options: SanitizeTemplateOptions = {},
): TemplateResult {
  if (!isPlainObject(value)) {
    throw new EmitterError('invalid_template', 'template must be a YAML object');
  }
  const overwriteOriginalRules = options.overwriteOriginalRules !== false;
  const sourceId = options.sourceId ?? 'template';
  const warnings: Warning[] = [];
  const template: Record<string, unknown> = {};
  const templateRules: string[] = [];

  for (const key of Object.keys(value)) {
    if (key === 'rules') {
      if (overwriteOriginalRules) {
        templateWarning(
          warnings,
          'W_TEMPLATE_CORE_IGNORED',
          'template "rules" ignored (overwrite_original_rules=true)',
          sourceId,
        );
        continue;
      }
      const rawRules = value[key];
      if (!Array.isArray(rawRules)) {
        templateWarning(warnings, 'W_TEMPLATE_CORE_IGNORED', 'template "rules" is not an array; ignored', sourceId);
        continue;
      }
      for (const entry of rawRules) {
        if (typeof entry === 'string') {
          templateRules.push(entry);
        } else {
          templateWarning(
            warnings,
            'W_TEMPLATE_KEY_DENIED',
            'template rules entry ignored: not a string',
            sourceId,
          );
        }
      }
      continue;
    }

    if (CORE_KEYS.has(key)) {
      templateWarning(
        warnings,
        'W_TEMPLATE_CORE_IGNORED',
        `template core key "${key}" ignored; the generator owns it`,
        sourceId,
      );
      continue;
    }

    if (!ALLOWED_SET.has(key)) {
      templateWarning(
        warnings,
        'W_TEMPLATE_KEY_DENIED',
        DENIED_SET.has(key)
          ? `template key "${key}" is denied`
          : `template key "${key}" is not in the allowed key list`,
        sourceId,
      );
      continue;
    }

    const cleaned = cleanValue(value[key], key, 0);
    if (!cleaned.ok) {
      templateWarning(
        warnings,
        'W_TEMPLATE_KEY_DENIED',
        `template key "${key}" is not plain YAML data: ${cleaned.reason}`,
        sourceId,
      );
      continue;
    }
    if (cleaned.value === undefined) continue;
    Object.defineProperty(template, key, {
      value: cleaned.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return { template, templateRules, warnings };
}

/** Whether a top-level key may be inherited from a template. */
export function isAllowedTemplateKey(key: string): boolean {
  return ALLOWED_SET.has(key);
}
