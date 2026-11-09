/**
 * Proxy group emission and member selection (SPEC §7.3, §8.3).
 *
 * Supported types: select / url-test / fallback / load-balance.
 * Members are de-duplicated (stable order), a group never references itself,
 * empty groups fall back to `DIRECT`, and group-to-group references are
 * checked for unknown names and cycles before serialization.
 */

import type {
  GroupSpec,
  GroupType,
  LoadBalanceStrategy,
  ProxyGroup,
  Warning,
} from '../types';
import {
  BUILTIN_TARGETS,
  DEFAULT_GROUP_INTERVAL,
  DEFAULT_GROUP_TOLERANCE,
  DEFAULT_GROUP_URL,
  GROUP_TYPES,
} from '../types';
import { EmitterError } from './serialize';

const GROUP_TYPE_SET: ReadonlySet<string> = new Set(GROUP_TYPES);
const LOAD_BALANCE_STRATEGIES: ReadonlySet<string> = new Set([
  'round-robin',
  'consistent-hashing',
]);
const MAX_GROUPS = 128;

export interface GroupMemberCandidate {
  name: string;
  kind?: string;
  server?: string;
  port?: number;
  sourceGroup?: string;
}

export interface GroupBuildOptions {
  name: string;
  type: GroupType;
  /** Candidate nodes used by include/exclude name filtering. */
  nodes?: readonly GroupMemberCandidate[];
  /** Literal members added before filtered nodes (builtins / node / group names). */
  members?: readonly string[];
  /** Node-name regexes; multiple patterns are OR-ed. */
  include?: readonly string[];
  /** Node-name regexes; multiple patterns are OR-ed. */
  exclude?: readonly string[];
  url?: string;
  interval?: number;
  tolerance?: number;
  strategy?: LoadBalanceStrategy;
}

export type RegexResult = { ok: true; regex: RegExp } | { ok: false; reason: string };

/**
 * Conservative unsafe-regex heuristic (mirrors the project's user-regex policy
 * closely enough for group matchers). The authoritative implementation lives
 * in `links/protocols.ts`; this local copy keeps the emitter dependency-free.
 */
export function isUnsafeRegexSource(pattern: string): string | null {
  if (pattern.length > 256) return 'pattern is longer than 256 characters';
  if (/\\[1-9]/.test(pattern)) return 'backreferences are not allowed';
  // Nested quantifier: (a+)+ / (a*){2,} / (\d{1,3})*
  if (/\((?:\\.|[^()\\])*(?:[+*]|\{\d+(?:,\d*)?\})(?:\\.|[^()\\])*\)(?:[+*]|\{\d+(?:,\d*)?\})/.test(pattern)) {
    return 'nested quantifiers are not allowed';
  }
  const repeat = /\{\s*(\d+)(?:,(\d*))?\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = repeat.exec(pattern)) !== null) {
    const upper = match[2] === undefined || match[2] === '' ? Number(match[1]) : Number(match[2]);
    if (Number.isFinite(upper) && upper > 1000) return 'repetition count is too large';
  }
  return null;
}

export function compileMatcherRegex(pattern: string, flags = 'u'): RegexResult {
  const unsafe = isUnsafeRegexSource(pattern);
  if (unsafe !== null) return { ok: false, reason: unsafe };
  try {
    return { ok: true, regex: new RegExp(pattern, flags) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `invalid regular expression: ${message}` };
  }
}

export interface PortRange {
  min: number;
  max: number;
}

/** Parse the `!!PORT=` range syntax `a-b`, `a`, `a+`, `a-` (SPEC §8.3). */
export function parsePortRange(value: string): PortRange | null {
  const text = value.trim();
  let match = /^(\d{1,5})-(\d{1,5})$/.exec(text);
  if (match) {
    const min = Number(match[1]);
    const max = Number(match[2]);
    if (min > max || max > 65535) return null;
    return { min, max };
  }
  match = /^(\d{1,5})\+$/.exec(text);
  if (match) {
    const min = Number(match[1]);
    if (min > 65535) return null;
    return { min, max: 65535 };
  }
  match = /^(\d{1,5})-$/.exec(text);
  if (match) {
    const max = Number(match[1]);
    if (max > 65535) return null;
    return { min: 0, max };
  }
  match = /^(\d{1,5})$/.exec(text);
  if (match) {
    const port = Number(match[1]);
    if (port > 65535) return null;
    return { min: port, max: port };
  }
  return null;
}

function groupWarning(
  warnings: Warning[],
  code: string,
  message: string,
  severity: Warning['severity'] = 'warning',
): void {
  warnings.push({ code, severity, stage: 'groups', message });
}

function assertGroupIdentity(name: string, type: string): asserts type is GroupType {
  if (typeof name !== 'string' || name === '') {
    throw new EmitterError('E_EMIT_INVALID', 'proxy group has an empty name');
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new EmitterError('E_EMIT_INVALID', `proxy group "${name}" contains control characters`);
  }
  if (!GROUP_TYPE_SET.has(type)) {
    throw new EmitterError('E_EMIT_INVALID', `proxy group "${name}" has unsupported type "${type}"`);
  }
}

function dedupeMembers(members: readonly string[], selfName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const member of members) {
    if (typeof member !== 'string' || member === '') continue;
    if (member === selfName) continue;
    if (seen.has(member)) continue;
    seen.add(member);
    out.push(member);
  }
  return out;
}

/**
 * De-duplicate members and apply the SPEC §7.3/§8.3 empty-group fallback so a
 * resolved group handed to the emitter is always loadable.
 */
function finalizeMembers(name: string, members: readonly string[], warnings: Warning[]): string[] {
  const cleaned = dedupeMembers(members, name);
  if (cleaned.length > 0) return cleaned;
  groupWarning(warnings, 'W_GROUP_EMPTY', `group "${name}" is empty; using DIRECT`);
  return ['DIRECT'];
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function withGroupDefaults(
  spec: Pick<GroupSpec, 'name' | 'type' | 'url' | 'interval' | 'tolerance' | 'strategy'>,
  members: string[],
): ProxyGroup {
  const group: ProxyGroup = { name: spec.name, type: spec.type, members };
  if (spec.type === 'select') return group;
  group.url = typeof spec.url === 'string' && spec.url !== '' ? spec.url : DEFAULT_GROUP_URL;
  group.interval = positiveInteger(spec.interval, DEFAULT_GROUP_INTERVAL);
  if (spec.type === 'url-test') {
    group.tolerance = nonNegativeInteger(spec.tolerance, DEFAULT_GROUP_TOLERANCE);
  }
  if (spec.type === 'load-balance' && typeof spec.strategy === 'string' && LOAD_BALANCE_STRATEGIES.has(spec.strategy)) {
    group.strategy = spec.strategy as LoadBalanceStrategy;
  }
  return group;
}

/**
 * Build one group from literal members plus include/exclude name-regex
 * filtering over `nodes`. Invalid or unsafe regexes are ignored with
 * `W_GROUP_MATCHER_INVALID`; an empty result becomes `DIRECT` + `W_GROUP_EMPTY`.
 */
export function buildGroup(options: GroupBuildOptions, warnings: Warning[] = []): ProxyGroup {
  assertGroupIdentity(options.name, options.type);
  const members: string[] = [...(options.members ?? [])];

  const includes: RegExp[] = [];
  for (const pattern of options.include ?? []) {
    const compiled = compileMatcherRegex(pattern);
    if (!compiled.ok) {
      groupWarning(warnings, 'W_GROUP_MATCHER_INVALID', `include matcher "${pattern}": ${compiled.reason}`);
      continue;
    }
    includes.push(compiled.regex);
  }
  const excludes: RegExp[] = [];
  for (const pattern of options.exclude ?? []) {
    const compiled = compileMatcherRegex(pattern);
    if (!compiled.ok) {
      groupWarning(warnings, 'W_GROUP_MATCHER_INVALID', `exclude matcher "${pattern}": ${compiled.reason}`);
      continue;
    }
    excludes.push(compiled.regex);
  }

  const hasIncludeFilter = (options.include ?? []).length > 0;
  for (const node of options.nodes ?? []) {
    if (hasIncludeFilter && !includes.some((regex) => regex.test(node.name))) continue;
    if (excludes.some((regex) => regex.test(node.name))) continue;
    members.push(node.name);
  }

  return withGroupDefaults(options, finalizeMembers(options.name, members, warnings));
}

/** Expand a parsed `custom_proxy_group` / `GroupSpec` against the node list. */
export function expandGroupSpec(
  spec: GroupSpec,
  nodes: readonly GroupMemberCandidate[],
  warnings: Warning[] = [],
): ProxyGroup {
  assertGroupIdentity(spec.name, spec.type);
  const members: string[] = [];

  for (const matcher of spec.matchers) {
    switch (matcher.kind) {
      case 'literal':
        if (matcher.value !== '') members.push(matcher.value);
        break;
      case 'name-regex': {
        const compiled = compileMatcherRegex(matcher.pattern);
        if (!compiled.ok) {
          groupWarning(warnings, 'W_GROUP_MATCHER_INVALID', `name matcher "${matcher.pattern}": ${compiled.reason}`);
          break;
        }
        for (const node of nodes) {
          if (compiled.regex.test(node.name)) members.push(node.name);
        }
        break;
      }
      case 'node-type': {
        const compiled = compileMatcherRegex(`^(?:${matcher.pattern})$`, 'iu');
        if (!compiled.ok) {
          groupWarning(warnings, 'W_GROUP_MATCHER_INVALID', `type matcher "${matcher.pattern}": ${compiled.reason}`);
          break;
        }
        for (const node of nodes) {
          const kind = typeof node.kind === 'string' ? node.kind.toUpperCase() : '';
          if (kind !== '' && compiled.regex.test(kind)) members.push(node.name);
        }
        break;
      }
      case 'source-group': {
        const compiled = compileMatcherRegex(matcher.pattern);
        if (!compiled.ok) {
          groupWarning(warnings, 'W_GROUP_MATCHER_INVALID', `source-group matcher "${matcher.pattern}": ${compiled.reason}`);
          break;
        }
        for (const node of nodes) {
          if (compiled.regex.test(node.sourceGroup ?? '')) members.push(node.name);
        }
        break;
      }
      case 'server': {
        const compiled = compileMatcherRegex(matcher.pattern);
        if (!compiled.ok) {
          groupWarning(warnings, 'W_GROUP_MATCHER_INVALID', `server matcher "${matcher.pattern}": ${compiled.reason}`);
          break;
        }
        for (const node of nodes) {
          if (compiled.regex.test(node.server ?? '')) members.push(node.name);
        }
        break;
      }
      case 'port-range': {
        const range = parsePortRange(matcher.range);
        if (range === null) {
          groupWarning(warnings, 'W_GROUP_MATCHER_INVALID', `port matcher "${matcher.range}" is not a valid range`);
          break;
        }
        for (const node of nodes) {
          if (typeof node.port === 'number' && node.port >= range.min && node.port <= range.max) {
            members.push(node.name);
          }
        }
        break;
      }
      default: {
        const exhaustive: never = matcher;
        throw new EmitterError('E_EMIT_INVALID', `unsupported matcher: ${String(exhaustive)}`);
      }
    }
  }

  return withGroupDefaults(spec, finalizeMembers(spec.name, members, warnings));
}

/** SPEC §7.3 default groups when the caller has no config/groups. */
export function defaultGroups(nodeNames: readonly string[], warnings: Warning[] = []): ProxyGroup[] {
  const names = dedupeMembers(nodeNames, '');
  const proxyMembers = [...names, ...BUILTIN_TARGETS.filter((target) => target === 'DIRECT')];
  const autoMembers = names.length > 0 ? names : ['DIRECT'];
  groupWarning(warnings, 'W_GROUP_DEFAULT_ADDED', 'no groups configured; added PROXY and AUTO', 'info');
  return [
    { name: 'PROXY', type: 'select', members: dedupeMembers(proxyMembers, 'PROXY') },
    {
      name: 'AUTO',
      type: 'url-test',
      members: dedupeMembers(autoMembers, 'AUTO'),
      url: DEFAULT_GROUP_URL,
      interval: DEFAULT_GROUP_INTERVAL,
      tolerance: DEFAULT_GROUP_TOLERANCE,
    },
  ];
}

export interface GroupReferenceContext {
  nodeNames: Iterable<string>;
  warnings?: Warning[];
}

/**
 * Drop unknown references, self references and group cycles so the emitted
 * configuration is always loadable. References may only be proxies, other
 * groups or built-in targets (`DIRECT`/`REJECT`/...).
 */
export function sanitizeGroupReferences(
  groups: readonly ProxyGroup[],
  context: GroupReferenceContext,
): ProxyGroup[] {
  const warnings = context.warnings ?? [];
  const groupNames = new Set(groups.map((group) => group.name));
  const known = new Set<string>(context.nodeNames);
  for (const builtin of BUILTIN_TARGETS) known.add(builtin);
  for (const name of groupNames) known.add(name);

  const cleaned: ProxyGroup[] = groups.map((group) => {
    const members: string[] = [];
    for (const member of dedupeMembers(group.members, group.name)) {
      if (!known.has(member)) {
        groupWarning(
          warnings,
          'E_RULE_TARGET_NOT_FOUND',
          `group "${group.name}" references unknown member "${member}"`,
          'error',
        );
        continue;
      }
      members.push(member);
    }
    return { ...group, members };
  });

  const byName = new Map(cleaned.map((group) => [group.name, group]));
  const state = new Map<string, 0 | 1 | 2>();
  const removals = new Set<string>();
  const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`;

  const visit = (name: string): void => {
    state.set(name, 1);
    const group = byName.get(name);
    if (group === undefined) {
      state.set(name, 2);
      return;
    }
    for (const member of group.members) {
      if (!groupNames.has(member)) continue;
      const status = state.get(member) ?? 0;
      if (status === 1) {
        removals.add(edgeKey(name, member));
        groupWarning(
          warnings,
          'W_GROUP_MATCHER_INVALID',
          `removed group cycle edge "${name}" -> "${member}"`,
        );
      } else if (status === 0) {
        visit(member);
      }
    }
    state.set(name, 2);
  };

  for (const group of cleaned) {
    if ((state.get(group.name) ?? 0) === 0) visit(group.name);
  }

  if (removals.size === 0) return cleaned;
  return cleaned.map((group) => ({
    ...group,
    members: group.members.filter((member) => !removals.has(edgeKey(group.name, member))),
  }));
}

/** Truncate to `MAX_GROUPS` (128) and report `W_GROUP_LIMIT`. */
export function limitGroups(groups: readonly ProxyGroup[], warnings: Warning[] = []): ProxyGroup[] {
  if (groups.length <= MAX_GROUPS) return [...groups];
  groupWarning(warnings, 'W_GROUP_LIMIT', `kept the first ${MAX_GROUPS} of ${groups.length} groups`);
  return groups.slice(0, MAX_GROUPS);
}

/**
 * Map one resolved group to its mihomo representation. Members are emitted in
 * stable de-duplicated order; an empty group becomes `[DIRECT]`.
 */
export function toMihomoGroup(group: ProxyGroup, warnings: Warning[] = []): Record<string, unknown> {
  assertGroupIdentity(group.name, group.type);

  let members = dedupeMembers(group.members, group.name);
  if (members.length === 0) {
    members = ['DIRECT'];
    groupWarning(warnings, 'W_GROUP_EMPTY', `group "${group.name}" is empty; using DIRECT`);
  }

  const out: Record<string, unknown> = { name: group.name, type: group.type };
  if (group.type !== 'select') {
    out.url = typeof group.url === 'string' && group.url !== '' ? group.url : DEFAULT_GROUP_URL;
    out.interval = positiveInteger(group.interval, DEFAULT_GROUP_INTERVAL);
    if (group.type === 'url-test') {
      out.tolerance = nonNegativeInteger(group.tolerance, DEFAULT_GROUP_TOLERANCE);
    }
    if (group.type === 'load-balance') {
      if (typeof group.strategy === 'string' && LOAD_BALANCE_STRATEGIES.has(group.strategy)) {
        out.strategy = group.strategy;
      }
    }
  }
  out.proxies = members;
  return out;
}

export function toMihomoGroups(
  groups: readonly ProxyGroup[],
  warnings: Warning[] = [],
): Array<Record<string, unknown>> {
  return groups.map((group) => toMihomoGroup(group, warnings));
}

/** The `proxies` value of an already emitted group (used by tests/readback). */
export function groupMemberNames(group: Record<string, unknown>): string[] {
  const members = group.proxies;
  if (!Array.isArray(members)) return [];
  return members.filter((member): member is string => typeof member === 'string');
}
