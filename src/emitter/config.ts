/**
 * Config assembly and ACL4SSR INI subset parsing.
 *
 * `assembleConfig` merges template keys with generated `proxies`,
 * `proxy-groups`, `rule-providers` and `rules`, then performs YAML read-back
 * and independent invariant checks (SPEC §6.3, §7.1). A failure here is fatal:
 * integration must return HTTP 500 instead of serving a broken config.
 *
 * `parseAcl4ssrIni` implements SPEC §8 (`[custom]` only, unknown keys produce
 * warnings, never crashes) and returns the intermediate `Acl4ssrConfig`
 * model consumed by the generator.
 */

import type {
  Acl4ssrConfig,
  ConversionStats,
  EmitInput,
  GroupSpec,
  GroupType,
  Matcher,
  ProxyGroup,
  Rule,
  RuleProviderSpec,
  Warning,
} from '../types';
import {
  BUILTIN_TARGETS,
  DEFAULT_GROUP_INTERVAL,
  DEFAULT_GROUP_TOLERANCE,
  DEFAULT_GROUP_URL,
  GROUP_TYPES,
} from '../types';
import {
  assertRuleLine,
  ensureTrailingMatch,
  formatRule,
  MAX_EMIT_RULES,
  toRuleScalars,
} from './rules';
import {
  compileMatcherRegex,
  defaultGroups,
  limitGroups,
  parsePortRange,
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
const MAX_CONFIG_BYTES = 256 * 1024;
const GROUP_TYPE_SET: ReadonlySet<string> = new Set(GROUP_TYPES);

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

// ---------------------------------------------------------------------------
// ACL4SSR INI subset (SPEC §8)
// ---------------------------------------------------------------------------

export interface IniParseSuccess {
  ok: true;
  config: Acl4ssrConfig;
  warnings: Warning[];
}

export interface IniParseFailure {
  ok: false;
  code: 'invalid_config';
  message: string;
}

export type IniParseResult = IniParseSuccess | IniParseFailure;

const KNOWN_INI_KEYS: ReadonlySet<string> = new Set([
  'custom_proxy_group',
  'ruleset',
  'surge_ruleset',
  'enable_rule_generator',
  'overwrite_original_rules',
  'rename',
  'include_remarks',
  'exclude_remarks',
  'clash_rule_base',
]);

/** Keys known from tindy but intentionally unsupported (SPEC §8.2). */
const TOLERATED_INI_KEYS: readonly string[] = [
  'emoji',
  'add_emoji',
  'remove_old_emoji',
  'surge_rule_base',
  'surfboard_rule_base',
  'mellow_rule_base',
  'quan_rule_base',
  'quanx_rule_base',
  'loon_rule_base',
  'sssub_rule_base',
  'singbox_rule_base',
  'insert_url',
  'enable_insert',
  'prepend_insert',
  'filter_script',
  'sort_script',
  'profile_token',
  'update_interval',
  'update_strict',
];
const TOLERATED_SET: ReadonlySet<string> = new Set(TOLERATED_INI_KEYS);

function configWarning(
  warnings: Warning[],
  code: string,
  message: string,
  sourceId: string,
  line?: number,
  raw?: string,
): void {
  const warning: Warning = { code, severity: 'warning', stage: 'template', message, source: sourceId };
  if (typeof line === 'number') warning.line = line;
  if (typeof raw === 'string') {
    warning.raw = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
  }
  warnings.push(warning);
}

function parseIniBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  return null;
}

/**
 * Parse the `[custom]` subset of an ACL4SSR-style INI. Repeated keys
 * accumulate in source order; unknown/unsupported keys and sections are
 * ignored with warnings (never fatal). Invalid input yields
 * `{ok:false, code:'invalid_config'}`.
 */
export function parseAcl4ssrIni(text: string, sourceId = 'config'): IniParseResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, code: 'invalid_config', message: 'config is empty' };
  }
  if (text.includes('\u0000')) {
    return { ok: false, code: 'invalid_config', message: 'config contains a NUL byte' };
  }
  if (utf8ByteLength(text) > MAX_CONFIG_BYTES) {
    return {
      ok: false,
      code: 'invalid_config',
      message: `config exceeds ${MAX_CONFIG_BYTES} bytes`,
    };
  }

  const warnings: Warning[] = [];
  const customProxyGroups: string[] = [];
  const rulesets: string[] = [];
  const rename: string[] = [];
  const includeRemarks: string[] = [];
  const excludeRemarks: string[] = [];
  const ignoredSections = new Set<string>();
  const unsupportedKeys = new Set<string>();
  const warnedKeys = new Set<string>();

  let enableRuleGenerator = true;
  let overwriteOriginalRules = true;
  let clashRuleBase: string | undefined;

  let hasCustomSection = false;
  let hasKnownKey = false;
  // Lines before the first section belong to `[custom]` (tindy ini_reader
  // behavior; see docs/research/original-subconverter.md §R8).
  let currentSection: string | null = 'custom';

  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const trimmed = (lines[index] as string).trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    if (trimmed.startsWith('[')) {
      const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
      if (sectionMatch === null) {
        configWarning(
          warnings,
          'W_CONFIG_KEY_UNSUPPORTED',
          'malformed INI section header ignored',
          sourceId,
          lineNumber,
          trimmed,
        );
        continue;
      }
      const section = (sectionMatch[1] as string).trim().toLowerCase();
      currentSection = section;
      if (section === 'custom') {
        hasCustomSection = true;
      } else if (!ignoredSections.has(section)) {
        ignoredSections.add(section);
        configWarning(
          warnings,
          'W_CONFIG_SECTION_IGNORED',
          `config section "[${section}]" is not supported and was ignored`,
          sourceId,
          lineNumber,
          trimmed,
        );
      }
      continue;
    }

    if (currentSection !== 'custom') continue;

    const equals = trimmed.indexOf('=');
    if (equals <= 0) {
      configWarning(
        warnings,
        'W_CONFIG_KEY_UNSUPPORTED',
        'config line is not a "key=value" pair and was ignored',
        sourceId,
        lineNumber,
        trimmed,
      );
      continue;
    }

    const key = trimmed.slice(0, equals).trim().toLowerCase();
    const value = trimmed.slice(equals + 1).trim();
    if (key === '') {
      configWarning(
        warnings,
        'W_CONFIG_KEY_UNSUPPORTED',
        'config line has an empty key and was ignored',
        sourceId,
        lineNumber,
        trimmed,
      );
      continue;
    }

    if (!KNOWN_INI_KEYS.has(key)) {
      const tolerated = TOLERATED_SET.has(key);
      if (!warnedKeys.has(key)) {
        warnedKeys.add(key);
        unsupportedKeys.add(key);
        configWarning(
          warnings,
          'W_CONFIG_KEY_UNSUPPORTED',
          tolerated
            ? `config key "${key}" is not supported and was ignored`
            : `unknown config key "${key}" was ignored`,
          sourceId,
          lineNumber,
          trimmed,
        );
      }
      continue;
    }

    hasKnownKey = true;
    switch (key) {
      case 'custom_proxy_group':
        if (value !== '') customProxyGroups.push(value);
        break;
      case 'ruleset':
      case 'surge_ruleset':
        if (value !== '') rulesets.push(value);
        break;
      case 'rename':
        if (value !== '') rename.push(value);
        break;
      case 'include_remarks':
        if (value !== '') includeRemarks.push(value);
        break;
      case 'exclude_remarks':
        if (value !== '') excludeRemarks.push(value);
        break;
      case 'clash_rule_base':
        if (value !== '') clashRuleBase = value;
        break;
      case 'enable_rule_generator': {
        const parsed = parseIniBoolean(value);
        if (parsed === null) {
          configWarning(
            warnings,
            'W_CONFIG_KEY_UNSUPPORTED',
            `config key "enable_rule_generator" has an invalid boolean; using default true`,
            sourceId,
            lineNumber,
            trimmed,
          );
        } else {
          enableRuleGenerator = parsed;
        }
        break;
      }
      case 'overwrite_original_rules': {
        const parsed = parseIniBoolean(value);
        if (parsed === null) {
          configWarning(
            warnings,
            'W_CONFIG_KEY_UNSUPPORTED',
            'config key "overwrite_original_rules" has an invalid boolean; using default true',
            sourceId,
            lineNumber,
            trimmed,
          );
        } else {
          overwriteOriginalRules = parsed;
        }
        break;
      }
      default:
        break;
    }
  }

  if (!hasCustomSection && !hasKnownKey) {
    return {
      ok: false,
      code: 'invalid_config',
      message: 'config has no [custom] section and no known keys',
    };
  }

  const config: Acl4ssrConfig = {
    customProxyGroups,
    rulesets,
    enableRuleGenerator,
    overwriteOriginalRules,
    rename,
    includeRemarks,
    excludeRemarks,
    ignoredSections: [...ignoredSections],
    unsupportedKeys: [...unsupportedKeys],
  };
  if (clashRuleBase !== undefined) config.clashRuleBase = clashRuleBase;

  return { ok: true, config, warnings };
}

function groupParseWarning(
  warnings: Warning[],
  code: string,
  message: string,
  sourceId = 'config',
): void {
  warnings.push({ code, severity: 'warning', stage: 'groups', message, source: sourceId });
}

function parseGroupUrl(value: string): boolean {
  if (value === '') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

interface GroupTimes {
  interval: number;
  tolerance: number;
  valid: boolean;
}

/** `interval[,tolerance]` per SPEC §8.3 (the tindy third field is ignored). */
export function parseGroupTimes(value: string): GroupTimes {
  const parts = value.split(',').map((part) => part.trim());
  let interval: number;
  let tolerance: number;
  let valid = parts.length <= 2;

  const first = parts[0] ?? '';
  if (/^\d+$/.test(first) && Number(first) > 0) interval = Number(first);
  else {
    interval = DEFAULT_GROUP_INTERVAL;
    valid = false;
  }

  if (parts.length >= 2) {
    const second = parts[1] ?? '';
    if (/^\d+$/.test(second)) tolerance = Number(second);
    else {
      tolerance = DEFAULT_GROUP_TOLERANCE;
      valid = false;
    }
  } else {
    tolerance = DEFAULT_GROUP_TOLERANCE;
  }

  return { interval, tolerance, valid };
}

function parseMatcherElem(elem: string, warnings: Warning[], sourceId: string): Matcher | null {
  const value = elem.trim();
  if (value === '') {
    // Empty regex matches every node (tindy-compatible; SPEC §8.3 regex rule).
    return { kind: 'name-regex', pattern: '' };
  }

  if (value.startsWith('[]')) {
    const literal = value.slice(2).trim();
    if (literal === '') {
      groupParseWarning(warnings, 'W_GROUP_MATCHER_INVALID', 'empty [] literal member ignored', sourceId);
      return null;
    }
    return { kind: 'literal', value: literal };
  }

  if (value.startsWith('!!')) {
    const directive = /^!!([A-Za-z-]+)=(.*)$/.exec(value);
    if (directive === null) {
      groupParseWarning(warnings, 'W_GROUP_DIRECTIVE_UNSUPPORTED', `group directive "${value}" is not supported`, sourceId);
      return null;
    }
    const name = (directive[1] as string).toUpperCase();
    const argument = (directive[2] as string).trim();
    switch (name) {
      case 'TYPE':
      case 'GROUP':
      case 'SERVER': {
        const compiled = compileMatcherRegex(argument);
        if (!compiled.ok) {
          groupParseWarning(warnings, 'W_GROUP_MATCHER_INVALID', `!!${name} matcher "${argument}": ${compiled.reason}`, sourceId);
          return null;
        }
        if (name === 'TYPE') return { kind: 'node-type', pattern: argument };
        if (name === 'GROUP') return { kind: 'source-group', pattern: argument };
        return { kind: 'server', pattern: argument };
      }
      case 'PORT': {
        if (parsePortRange(argument) === null) {
          groupParseWarning(warnings, 'W_GROUP_MATCHER_INVALID', `!!PORT range "${argument}" is invalid`, sourceId);
          return null;
        }
        return { kind: 'port-range', range: argument };
      }
      default:
        groupParseWarning(warnings, 'W_GROUP_DIRECTIVE_UNSUPPORTED', `group directive "!!${name}" is not supported`, sourceId);
        return null;
    }
  }

  if (value.startsWith('script:')) {
    groupParseWarning(warnings, 'W_GROUP_DIRECTIVE_UNSUPPORTED', 'script: group directives are not supported', sourceId);
    return null;
  }

  const compiled = compileMatcherRegex(value);
  if (!compiled.ok) {
    groupParseWarning(warnings, 'W_GROUP_MATCHER_INVALID', `group matcher "${value}": ${compiled.reason}`, sourceId);
    return null;
  }
  return { kind: 'name-regex', pattern: value };
}

/**
 * Parse one `custom_proxy_group=` line (SPEC §8.3) into a `GroupSpec`.
 * Returns `null` (with a warning) for malformed/unsupported groups.
 */
export function parseCustomProxyGroupLine(
  line: string,
  warnings: Warning[] = [],
  sourceId = 'config',
): GroupSpec | null {
  const raw = typeof line === 'string' ? line.trim() : '';
  if (raw === '') return null;

  const parts = raw.split('`');
  if (parts.length < 3) {
    groupParseWarning(warnings, 'W_GROUP_MATCHER_INVALID', 'custom_proxy_group needs at least 3 backtick-separated fields', sourceId);
    return null;
  }

  const name = (parts[0] as string).trim();
  const typeText = (parts[1] as string).trim().toLowerCase();
  if (name === '') {
    groupParseWarning(warnings, 'W_GROUP_MATCHER_INVALID', 'custom_proxy_group has an empty name', sourceId);
    return null;
  }
  if (!GROUP_TYPE_SET.has(typeText)) {
    groupParseWarning(warnings, 'W_GROUP_UNSUPPORTED_TYPE', `group "${name}" has unsupported type "${typeText}"`, sourceId);
    return null;
  }
  const type = typeText as GroupType;

  let matcherParts: string[];
  let url: string | undefined;
  let interval: number | undefined;
  let tolerance: number | undefined;

  if (type === 'select') {
    matcherParts = parts.slice(2);
  } else {
    if (parts.length < 5) {
      groupParseWarning(
        warnings,
        'W_GROUP_MATCHER_INVALID',
        `group "${name}" of type ${type} requires at least 5 fields`,
        sourceId,
      );
      return null;
    }
    matcherParts = parts.slice(2, parts.length - 2);
    const urlText = (parts[parts.length - 2] as string).trim();
    const timesText = (parts[parts.length - 1] as string).trim();
    if (!parseGroupUrl(urlText)) {
      groupParseWarning(
        warnings,
        'W_GROUP_MATCHER_INVALID',
        `group "${name}" has an invalid health-check URL; using the default`,
        sourceId,
      );
      url = DEFAULT_GROUP_URL;
    } else {
      url = urlText;
    }
    const times = parseGroupTimes(timesText);
    if (!times.valid) {
      groupParseWarning(
        warnings,
        'W_GROUP_MATCHER_INVALID',
        `group "${name}" has invalid interval/tolerance; using defaults`,
        sourceId,
      );
    }
    interval = times.interval;
    tolerance = times.tolerance;
  }

  const matchers: Matcher[] = [];
  for (const elem of matcherParts) {
    const matcher = parseMatcherElem(elem, warnings, sourceId);
    if (matcher !== null) matchers.push(matcher);
  }

  const spec: GroupSpec = { name, type, matchers };
  if (url !== undefined) spec.url = url;
  if (interval !== undefined) spec.interval = interval;
  if (tolerance !== undefined) spec.tolerance = tolerance;
  return spec;
}

/** Parse every raw `custom_proxy_group` line in order. */
export function parseCustomProxyGroups(
  lines: readonly string[],
  warnings: Warning[] = [],
  sourceId = 'config',
): GroupSpec[] {
  const specs: GroupSpec[] = [];
  for (const line of lines) {
    const spec = parseCustomProxyGroupLine(line, warnings, sourceId);
    if (spec !== null) specs.push(spec);
  }
  return specs;
}
