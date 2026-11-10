/**
 * Config assembly.
 *
 * `assembleConfig` merges template keys with generated `proxies`,
 * `proxy-groups`, `rule-providers` and `rules`, then performs YAML read-back
 * and independent invariant checks (SPEC §6.3, §7.1). A failure here is fatal:
 * integration must return HTTP 500 instead of serving a broken config.
 */

import type {
  ConversionStats,
  EmitInput,
  ProxyGroup,
  Rule,
  RuleProviderSpec,
  Warning,
} from '../types';
import { BUILTIN_TARGETS } from '../types';
import {
  assertRuleLine,
  ensureTrailingMatch,
  formatRule,
  MAX_EMIT_RULES,
  toRuleScalars,
} from './rules';
import {
  defaultGroups,
  limitGroups,
  sanitizeGroupReferences,
  toMihomoGroups,
} from './groups';
import { toMihomoProxies, type NodeEmitOptions } from './nodes';
import { toRuleProviders } from './providers';
import {
  EmitterError,
  isPlainObject,
  parseForReadback,
  stringifyConfig,
  utf8ByteLength,
} from './serialize';
import { sanitizeTemplate } from './template';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// assembleConfig
// ---------------------------------------------------------------------------

export type EmitClashOptions = EmitInput['options'] & NodeEmitOptions;

export type EmitClashInput = Omit<EmitInput, 'options'> & { options: EmitClashOptions };

export interface RuleValidatorContext {
  mode: 'template';
  sourceId: string;
  knownTargets: Set<string>;
  knownProviders: Set<string>;
  allowMatch: boolean;
}

/**
 * Outcome of re-validating one generated rule line. Integration adapts
 * `rules.parseRuleLine` to this shape; the emitter treats `ok: false` as fatal.
 */
export interface RuleValidatorResult {
  ok: boolean;
  code?: string;
  message?: string;
  /** Shape returned by `rules.parseRuleLine` on rejection. */
  warnings?: Array<{ code?: string; message?: string }>;
}

export type RuleValidator = (line: string, context: RuleValidatorContext) => RuleValidatorResult;

export interface AssembleDeps {
  /**
   * Optional full re-validation hook (SPEC §6.3 / ARCHITECTURE §7.3.7). The
   * `rules` module is the authoritative parser; when provided, every emitted
   * rule line is re-parsed with it. Emitter's own `assertRuleLine` always runs
   * regardless, so the gate does not depend on this hook.
   */
  validateRuleLine?: RuleValidator;
}

export interface AssembleResult {
  yaml: string;
  warnings: Warning[];
  stats: ConversionStats;
}

function ruleWarning(
  warnings: Warning[],
  code: string,
  message: string,
  details: { line?: number; raw?: unknown; source?: string; severity?: Warning['severity'] } = {},
): void {
  const warning: Warning = {
    code,
    severity: details.severity ?? 'error',
    stage: 'rules',
    message,
  };
  if (typeof details.line === 'number') warning.line = details.line;
  if (typeof details.raw === 'string') {
    warning.raw = details.raw.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
  }
  if (typeof details.source === 'string') warning.source = details.source;
  warnings.push(warning);
}

function pickDefaultGroup(
  requested: string | undefined,
  groups: readonly ProxyGroup[],
  nodeNames: ReadonlySet<string>,
  warnings: Warning[],
): string {
  const available = new Set<string>(nodeNames);
  for (const group of groups) available.add(group.name);
  for (const builtin of BUILTIN_TARGETS) available.add(builtin);

  if (typeof requested === 'string' && requested !== '' && available.has(requested)) {
    return requested;
  }
  if (typeof requested === 'string' && requested !== '') {
    warnings.push({
      code: 'W_DEFAULT_MATCH_ADDED',
      severity: 'info',
      stage: 'rules',
      message: `default group "${requested}" is not defined; falling back to an existing target`,
    });
  }
  const proxy = groups.find((group) => group.name === 'PROXY');
  if (proxy !== undefined) return proxy.name;
  const select = groups.find((group) => group.type === 'select');
  if (select !== undefined) return select.name;
  const first = groups[0];
  if (first !== undefined) return first.name;
  return 'DIRECT';
}

function filterRules(
  rules: readonly Rule[],
  knownTargets: ReadonlySet<string>,
  knownProviders: ReadonlySet<string>,
  warnings: Warning[],
): Rule[] {
  const out: Rule[] = [];
  for (const rule of rules) {
    // Structural validation is fatal: emitter never serializes a malformed IR.
    formatRule(rule);

    if (rule.type === 'RULE-SET' && !knownProviders.has(rule.payload)) {
      ruleWarning(warnings, 'E_RULE_TARGET_NOT_FOUND', `rule references unknown provider "${rule.payload}"`, {
        line: rule.line,
        raw: rule.raw,
        source: rule.sourceId,
      });
      continue;
    }
    if (!knownTargets.has(rule.target)) {
      ruleWarning(warnings, 'E_RULE_TARGET_NOT_FOUND', `rule target "${rule.target}" is not a known group, proxy or builtin`, {
        line: rule.line,
        raw: rule.raw,
        source: rule.sourceId,
      });
      continue;
    }
    out.push(rule);
  }
  return out;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyOutput(input: {
  yaml: string;
  template: Record<string, unknown>;
  proxies: Array<Record<string, unknown>>;
  groups: Array<Record<string, unknown>>;
  providers: Record<string, unknown> | undefined;
  ruleTexts: string[];
}): void {
  if (!input.yaml.endsWith('\n') || input.yaml.endsWith('\n\n')) {
    throw new EmitterError('E_EMIT_INVALID', 'output must end with exactly one newline');
  }

  const readback = parseForReadback(input.yaml);
  if (!readback.ok) {
    throw new EmitterError('E_EMIT_INVALID', `YAML read-back failed: ${readback.message}`);
  }
  if (!isPlainObject(readback.value)) {
    throw new EmitterError('E_EMIT_INVALID', 'YAML read-back is not an object');
  }
  const value = readback.value;

  for (const key of Object.keys(input.template)) {
    if (!jsonEqual(value[key], input.template[key])) {
      throw new EmitterError('E_EMIT_INVALID', `YAML read-back mismatch for template key "${key}"`);
    }
  }

  if (!Array.isArray(value.proxies) || !jsonEqual(value.proxies, input.proxies)) {
    throw new EmitterError('E_EMIT_INVALID', 'YAML read-back mismatch for proxies');
  }
  for (const proxy of value.proxies) {
    if (!isPlainObject(proxy)) throw new EmitterError('E_EMIT_INVALID', 'proxy entry is not an object');
    const port = proxy.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new EmitterError('E_EMIT_INVALID', 'proxy entry has a non-integer or out-of-range port');
    }
  }

  if (!Array.isArray(value['proxy-groups']) || !jsonEqual(value['proxy-groups'], input.groups)) {
    throw new EmitterError('E_EMIT_INVALID', 'YAML read-back mismatch for proxy-groups');
  }

  if (input.providers === undefined) {
    if (value['rule-providers'] !== undefined) {
      throw new EmitterError('E_EMIT_INVALID', 'unexpected rule-providers in read-back');
    }
  } else if (!jsonEqual(value['rule-providers'], input.providers)) {
    throw new EmitterError('E_EMIT_INVALID', 'YAML read-back mismatch for rule-providers');
  }

  if (!Array.isArray(value.rules)) {
    throw new EmitterError('E_EMIT_INVALID', 'rules is not an array in read-back');
  }
  const readRules = value.rules;
  if (readRules.length !== input.ruleTexts.length) {
    throw new EmitterError('E_EMIT_INVALID', 'rules length changed during read-back');
  }
  for (let index = 0; index < readRules.length; index += 1) {
    const line = readRules[index];
    const expected = input.ruleTexts[index];
    if (typeof line !== 'string' || line !== expected) {
      throw new EmitterError('E_EMIT_INVALID', `rule[${index}] changed during read-back`);
    }
    assertRuleLine(line);
  }
  const matchIndexes = input.ruleTexts
    .map((line, index) => (line.startsWith('MATCH,') ? index : -1))
    .filter((index) => index >= 0);
  if (matchIndexes.length !== 1 || matchIndexes[0] !== input.ruleTexts.length - 1) {
    throw new EmitterError('E_EMIT_INVALID', 'output must contain exactly one MATCH at the end');
  }
}

/**
 * Merge sanitized template keys with generator-owned sections, serialize and
 * verify by read-back. Throws `EmitterError` on any invariant failure.
 */
export function assembleConfig(input: EmitClashInput, deps: AssembleDeps = {}): AssembleResult {
  if (input === null || typeof input !== 'object') {
    throw new EmitterError('E_EMIT_INVALID', 'emit input must be an object');
  }
  const warnings: Warning[] = [];

  const sanitized = sanitizeTemplate(input.template ?? {});
  warnings.push(...sanitized.warnings);

  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const proxies = toMihomoProxies(nodes, input.options ?? {});
  const nodeNames = new Set<string>();
  for (const node of nodes) {
    if (nodeNames.has(node.name)) {
      throw new EmitterError('E_EMIT_INVALID', `duplicate proxy name "${node.name}"`);
    }
    nodeNames.add(node.name);
  }

  let groups: ProxyGroup[] = Array.isArray(input.groups) ? [...input.groups] : [];
  const providedGroupNames = new Set<string>();
  for (const group of groups) {
    if (providedGroupNames.has(group.name)) {
      throw new EmitterError('E_EMIT_INVALID', `duplicate proxy group name "${group.name}"`);
    }
    providedGroupNames.add(group.name);
  }
  groups = limitGroups(groups, warnings);
  if (groups.length === 0) {
    groups = defaultGroups([...nodeNames], warnings);
  }
  groups = sanitizeGroupReferences(groups, { nodeNames, warnings });
  const groupDocs = toMihomoGroups(groups, warnings);
  const groupNames = new Set(groups.map((group) => group.name));

  const rulesMode = input.options?.rulesMode ?? 'inline';
  const providers: RuleProviderSpec[] = rulesMode === 'providers' && Array.isArray(input.providers)
    ? input.providers
    : [];
  const providerDocs = rulesMode === 'providers'
    ? toRuleProviders(providers, input.origin)
    : undefined;
  const knownProviders = new Set<string>(providerDocs === undefined ? [] : Object.keys(providerDocs));

  const knownTargets = new Set<string>(nodeNames);
  for (const name of groupNames) knownTargets.add(name);
  for (const builtin of BUILTIN_TARGETS) knownTargets.add(builtin);

  const defaultGroup = pickDefaultGroup(input.options?.defaultGroup, groups, nodeNames, warnings);
  const inputRules = Array.isArray(input.rules) ? input.rules : [];
  const filtered = filterRules(inputRules, knownTargets, knownProviders, warnings);
  const finalRules = ensureTrailingMatch(filtered, defaultGroup, warnings, MAX_EMIT_RULES);
  const scalars = toRuleScalars(finalRules);
  const ruleTexts = finalRules.map((rule) => formatRule(rule));

  const doc: Record<string, unknown> = {};
  for (const key of Object.keys(sanitized.template)) {
    Object.defineProperty(doc, key, {
      value: sanitized.template[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  doc.proxies = proxies;
  doc['proxy-groups'] = groupDocs;
  if (providerDocs !== undefined) doc['rule-providers'] = providerDocs;
  doc.rules = scalars;

  const version = typeof input.version === 'string'
    ? input.version.replace(/[^0-9A-Za-z._+-]/g, '') || '0.0.0'
    : '0.0.0';
  const header = `Generated by subconverter-worker ${version};`
    + ` nodes=${proxies.length} groups=${groupDocs.length}`
    + ` rules=${finalRules.length} warnings=${warnings.length}`;
  const yaml = stringifyConfig(doc, { header });
  const bytesOut = utf8ByteLength(yaml);
  if (bytesOut > MAX_OUTPUT_BYTES) {
    throw new EmitterError('E_OUTPUT_TOO_LARGE', `output is ${bytesOut} bytes (limit ${MAX_OUTPUT_BYTES})`);
  }

  verifyOutput({
    yaml,
    template: sanitized.template,
    proxies,
    groups: groupDocs,
    providers: providerDocs,
    ruleTexts,
  });

  if (typeof deps.validateRuleLine === 'function') {
    const context: RuleValidatorContext = {
      mode: 'template',
      sourceId: 'emit',
      knownTargets,
      knownProviders,
      allowMatch: true,
    };
    for (const line of ruleTexts) {
      let result: RuleValidatorResult;
      try {
        result = deps.validateRuleLine(line, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new EmitterError('E_EMIT_INVALID', `rule re-validation threw: ${message}`);
      }
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        const rejection = result?.warnings?.find((warning) => warning?.code?.startsWith('E_'))
          ?? result?.warnings?.[0];
        const code = result?.code ?? rejection?.code;
        throw new EmitterError(
          'E_EMIT_INVALID',
          `rule re-validation rejected "${line}"${code ? ` (${code})` : ''}`,
        );
      }
    }
  }

  const warningCodes = [...new Set(warnings.map((warning) => warning.code))].sort();
  const stats: ConversionStats = {
    nodes: proxies.length,
    groups: groupDocs.length,
    rules: finalRules.length,
    providers: providerDocs === undefined ? 0 : Object.keys(providerDocs).length,
    sources: 0,
    bytesIn: 0,
    bytesOut,
    warnings: warnings.length,
    warningCodes,
  };

  return { yaml, warnings, stats };
}
