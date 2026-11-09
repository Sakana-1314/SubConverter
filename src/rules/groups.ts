/**
 * ACL4SSR proxy-group DSL (SPEC §8.3) and group expansion (SPEC §7.3).
 *
 * `custom_proxy_group` lines and the query `groups=` payload share this parser.
 * Expansion is O(groups × matchers × nodes); each matcher regex is compiled
 * once, and members are de-duplicated with a Set.
 */

import {
  BUILTIN_TARGETS,
  DEFAULT_GROUP_INTERVAL,
  DEFAULT_GROUP_TOLERANCE,
  DEFAULT_GROUP_URL,
  GROUP_TYPES,
  type GroupSpec,
  type GroupType,
  type Matcher,
  type ProxyNode,
  type ResolvedGroup,
  type Warning,
} from '../types';
import { ruleIssue, toWarning } from './types';

const BUILTINS: ReadonlySet<string> = new Set(BUILTIN_TARGETS);
const MAX_GROUP_NAME_LENGTH = 64;
const MAX_GROUP_MATCHER_LENGTH = 256;

export interface GroupParseContext {
  warnings: Warning[];
  source?: string;
  line?: number;
  /** Accepted for ARCHITECTURE §7.2.10 compatibility; expansion enforces it. */
  maxGroups?: number;
}

function warn(
  ctx: GroupParseContext,
  code: string,
  message: string,
  severity: 'info' | 'warning' | 'error' = 'warning',
): void {
  ctx.warnings.push(
    toWarning(ruleIssue(code, message, severity, undefined, 'groups'), {
      sourceId: ctx.source ?? 'groups',
      line: ctx.line ?? 0,
      raw: '',
    }),
  );
}

// ---------------------------------------------------------------------------
// User regex safety (shared with INI rename/include/exclude)
// ---------------------------------------------------------------------------

export interface CompiledUserRegex {
  ok: true;
  regex: RegExp;
}

export interface UserRegexFailure {
  ok: false;
  reason: string;
}

/**
 * Compile a user-supplied regex with conservative catastrophic-backtracking
 * guards (SPEC §11 AC-26: `(a+)+$` must be rejected).
 */
export function compileUserRegex(
  pattern: string,
  maxLength = MAX_GROUP_MATCHER_LENGTH,
): CompiledUserRegex | UserRegexFailure {
  const source = pattern.trim();
  if (source === '') return { ok: false, reason: 'regular expression is empty' };
  if (source.length > maxLength) {
    return { ok: false, reason: `regular expression is longer than ${maxLength} characters` };
  }
  if (/\\[1-9]/.test(source)) {
    return { ok: false, reason: 'backreferences are not allowed' };
  }
  // Nested quantifiers such as (a+)+, (a*)*, (?:a+){2,}.
  if (/\((?:\?:)?[^()]*[*+?][^()]*\)\s*[*+{]/.test(source)) {
    return { ok: false, reason: 'nested quantifiers are not allowed' };
  }
  if (/\{\d{4,}(?:,\d*)?\}/.test(source)) {
    return { ok: false, reason: 'repetition counts above 999 are not allowed' };
  }
  try {
    return { ok: true, regex: new RegExp(source, 'u') };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'regular expression is invalid',
    };
  }
}

// ---------------------------------------------------------------------------
// Group line parsing
// ---------------------------------------------------------------------------

function parsePortMatcher(raw: string): string | null {
  const value = raw.trim();
  let match = /^(\d{1,5})-(\d{1,5})$/.exec(value);
  if (match) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (from > 65535 || to > 65535 || from > to) return null;
    return `${from}-${to}`;
  }
  match = /^(\d{1,5})(?:\+|->)$/.exec(value);
  if (match) {
    const from = Number(match[1]);
    if (from > 65535) return null;
    return `${from}-65535`;
  }
  match = /^(\d{1,5})$/.exec(value);
  if (match) {
    const port = Number(match[1]);
    if (port > 65535) return null;
    return String(port);
  }
  return null;
}

function parseElement(element: string, ctx: GroupParseContext): Matcher | null {
  const value = element.trim();
  if (value === '') return null;

  if (value.startsWith('[]')) {
    const literal = value.slice(2).trim();
    if (literal === '') {
      warn(ctx, 'W_GROUP_MATCHER_INVALID', 'empty [] literal member is ignored');
      return null;
    }
    return { kind: 'literal', value: literal };
  }

  if (value.startsWith('!!TYPE=')) {
    const pattern = value.slice('!!TYPE='.length).trim();
    const compiled = compileUserRegex(pattern);
    if (!compiled.ok) {
      warn(ctx, 'W_GROUP_MATCHER_INVALID', `!!TYPE regex is invalid: ${compiled.reason}`);
      return null;
    }
    return { kind: 'node-type', pattern };
  }
  if (value.startsWith('!!GROUP=')) {
    const pattern = value.slice('!!GROUP='.length).trim();
    const compiled = compileUserRegex(pattern);
    if (!compiled.ok) {
      warn(ctx, 'W_GROUP_MATCHER_INVALID', `!!GROUP regex is invalid: ${compiled.reason}`);
      return null;
    }
    return { kind: 'source-group', pattern };
  }
  if (value.startsWith('!!SERVER=')) {
    const pattern = value.slice('!!SERVER='.length).trim();
    const compiled = compileUserRegex(pattern);
    if (!compiled.ok) {
      warn(ctx, 'W_GROUP_MATCHER_INVALID', `!!SERVER regex is invalid: ${compiled.reason}`);
      return null;
    }
    return { kind: 'server', pattern };
  }
  if (value.startsWith('!!PORT=')) {
    const parsed = parsePortMatcher(value.slice('!!PORT='.length));
    if (parsed === null) {
      warn(ctx, 'W_GROUP_MATCHER_INVALID', `!!PORT value "${value}" is invalid`);
      return null;
    }
    return { kind: 'port-range', range: parsed };
  }
  if (
    value.startsWith('!!PROVIDER=') ||
    value.startsWith('!!GROUPID=') ||
    value.startsWith('!!INSERT=') ||
    value.toLowerCase().startsWith('script:') ||
    value.startsWith('!!')
  ) {
    warn(ctx, 'W_GROUP_DIRECTIVE_UNSUPPORTED', `group directive "${value}" is not supported`);
    return null;
  }

  const compiled = compileUserRegex(value);
  if (!compiled.ok) {
    warn(ctx, 'W_GROUP_MATCHER_INVALID', `name regex is invalid: ${compiled.reason}`);
    return null;
  }
  return { kind: 'name-regex', pattern: value };
}

function isGroupType(value: string): value is GroupType {
  return (GROUP_TYPES as readonly string[]).includes(value);
}

function parseUrl(value: string, ctx: GroupParseContext): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return value;
  } catch {
    // fall through
  }
  warn(ctx, 'W_GROUP_MATCHER_INVALID', `group URL "${value}" is invalid; using default`);
  return DEFAULT_GROUP_URL;
}

interface ParsedTimes {
  interval: number;
  tolerance: number;
  ok: boolean;
}

function parseTimes(value: string): ParsedTimes {
  const parts = value.split(',').map((part) => part.trim());
  const intervalText = parts[0] ?? '';
  const toleranceText = parts[1];
  const interval = /^\d+$/.test(intervalText) ? Number(intervalText) : Number.NaN;
  const tolerance =
    toleranceText === undefined ? DEFAULT_GROUP_TOLERANCE : (/^\d+$/.test(toleranceText) ? Number(toleranceText) : Number.NaN);
  if (!Number.isFinite(interval) || interval <= 0) {
    return { interval: DEFAULT_GROUP_INTERVAL, tolerance: DEFAULT_GROUP_TOLERANCE, ok: false };
  }
  if (!Number.isFinite(tolerance)) {
    return { interval, tolerance: DEFAULT_GROUP_TOLERANCE, ok: false };
  }
  return { interval, tolerance, ok: true };
}

/**
 * Parse one `custom_proxy_group` line (SPEC §8.3).
 * The group name is not de-duplicated here; call `allocateGroupNames`.
 */
export function parseCustomGroupLine(
  line: string,
  ctx: GroupParseContext,
): GroupSpec | null {
  const raw = line.trim();
  if (raw === '') return null;

  const parts = raw.split('`').map((part) => part.trim());
  if (parts.length < 3) {
    warn(ctx, 'W_GROUP_MATCHER_INVALID', 'group line needs at least NAME`TYPE`ELEM');
    return null;
  }

  const name = parts[0];
  if (name === '' || name.length > MAX_GROUP_NAME_LENGTH) {
    warn(ctx, 'W_GROUP_MATCHER_INVALID', 'group name is empty or longer than 64 characters');
    return null;
  }

  const typeRaw = parts[1].toLowerCase();
  if (!isGroupType(typeRaw)) {
    warn(ctx, 'W_GROUP_UNSUPPORTED_TYPE', `group type "${parts[1]}" is not supported`);
    return null;
  }

  if (typeRaw === 'select') {
    const matchers: Matcher[] = [];
    for (const element of parts.slice(2)) {
      const matcher = parseElement(element, ctx);
      if (matcher !== null) matchers.push(matcher);
    }
    return { name, type: 'select', matchers };
  }

  // url-test / fallback / load-balance: NAME`TYPE`ELEM...`URL`INTERVAL[,TOL]
  if (parts.length < 5) {
    warn(
      ctx,
      'W_GROUP_MATCHER_INVALID',
      `${typeRaw} group needs at least NAME\`TYPE\`ELEM\`URL\`INTERVAL`,
    );
    return null;
  }
  const url = parseUrl(parts[parts.length - 2], ctx);
  const times = parseTimes(parts[parts.length - 1]);
  if (!times.ok) {
    warn(ctx, 'W_GROUP_MATCHER_INVALID', `group interval/tolerance is invalid; using defaults`);
  }

  const matchers: Matcher[] = [];
  for (const element of parts.slice(2, -2)) {
    const matcher = parseElement(element, ctx);
    if (matcher !== null) matchers.push(matcher);
  }

  return {
    name,
    type: typeRaw,
    matchers,
    url,
    interval: times.interval,
    tolerance: times.tolerance,
  };
}

export interface ParseGroupsOptions {
  reserved?: ReadonlySet<string>;
  source?: string;
}

/** Parse a `groups=` payload (one `custom_proxy_group` per line). */
export function parseGroupsParam(
  text: string,
  warnings: Warning[],
  options: ParseGroupsOptions = {},
): GroupSpec[] {
  const source = options.source ?? 'groups';
  const normalized = (text.startsWith('\uFEFF') ? text.slice(1) : text).replace(/\r\n?/g, '\n');
  const specs: GroupSpec[] = [];
  const lines = normalized.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    if (line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;
    const spec = parseCustomGroupLine(line, {
      warnings,
      source,
      line: index + 1,
    });
    if (spec !== null) specs.push(spec);
  }
  return allocateGroupNames(specs, {
    warnings,
    reserved: options.reserved,
    source,
  });
}

// ---------------------------------------------------------------------------
// Group names
// ---------------------------------------------------------------------------

export interface AllocateGroupNamesOptions {
  warnings?: Warning[];
  reserved?: ReadonlySet<string>;
  source?: string;
}

/**
 * De-duplicate group names case-insensitively and move them out of the
 * built-in target namespace by appending `" 2"`, `" 3"`, ... (SPEC §3.5).
 */
export function allocateGroupNames(
  specs: GroupSpec[],
  options: AllocateGroupNamesOptions = {},
): GroupSpec[] {
  const warnings = options.warnings ?? [];
  const source = options.source ?? 'groups';
  const used = new Set<string>();
  for (const builtin of BUILTIN_TARGETS) used.add(builtin.toLowerCase());
  if (options.reserved !== undefined) {
    for (const name of options.reserved) used.add(name.toLowerCase());
  }

  const result: GroupSpec[] = [];
  for (const spec of specs) {
    const base = spec.name;
    let candidate = base;
    let counter = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base} ${counter}`;
      counter += 1;
      if (candidate.length > MAX_GROUP_NAME_LENGTH + 8) break;
    }
    if (candidate.length > MAX_GROUP_NAME_LENGTH) {
      warnings.push(
        toWarning(
          ruleIssue(
            'W_GROUP_NAME_DUPLICATE',
            `group name "${base}" cannot be made unique within 64 characters; group dropped`,
            'warning',
            undefined,
            'groups',
          ),
          { sourceId: source, line: 0, raw: base },
        ),
      );
      continue;
    }
    if (candidate !== base) {
      warnings.push(
        toWarning(
          ruleIssue(
            'W_GROUP_NAME_DUPLICATE',
            BUILTINS.has(base.toUpperCase())
              ? `group name "${base}" is reserved; renamed to "${candidate}"`
              : `group name "${base}" is duplicated; renamed to "${candidate}"`,
            'warning',
            undefined,
            'groups',
          ),
          { sourceId: source, line: 0, raw: base },
        ),
      );
    }
    used.add(candidate.toLowerCase());
    result.push({ ...spec, name: candidate });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

function portMatches(port: number, range: string): boolean {
  const match = /^(\d+)(?:-(\d+))?$/.exec(range);
  if (!match) return false;
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  return port >= from && port <= to;
}

export interface ExpandGroupsOptions {
  maxGroups?: number;
  source?: string;
}

/**
 * Expand matchers against nodes into concrete member lists (SPEC §8.3).
 * Members are de-duplicated preserving order; empty groups get DIRECT.
 */
export function expandGroups(
  specs: readonly GroupSpec[],
  nodes: readonly ProxyNode[],
  warnings: Warning[],
  options: ExpandGroupsOptions = {},
): ResolvedGroup[] {
  const maxGroups = options.maxGroups ?? 128;
  const source = options.source ?? 'groups';
  const groupNames = new Set(specs.map((spec) => spec.name));
  const knownMembers = new Set<string>();
  for (const builtin of BUILTIN_TARGETS) knownMembers.add(builtin);
  for (const name of groupNames) knownMembers.add(name);
  for (const node of nodes) knownMembers.add(node.name);

  const resolved: ResolvedGroup[] = [];
  let limitWarned = false;

  for (const spec of specs) {
    if (resolved.length >= maxGroups) {
      if (!limitWarned) {
        warnings.push(
          toWarning(
            ruleIssue('W_GROUP_LIMIT', `more than ${maxGroups} groups; extra groups are dropped`, 'warning', undefined, 'groups'),
            { sourceId: source, line: 0, raw: '' },
          ),
        );
        limitWarned = true;
      }
      break;
    }

    const members: string[] = [];
    const seen = new Set<string>();
    const add = (name: string): void => {
      if (name === '' || name === spec.name) {
        if (name === spec.name) {
          warnings.push(
            toWarning(
              ruleIssue(
                'W_GROUP_MATCHER_INVALID',
                `group "${spec.name}" must not reference itself; member dropped`,
                'warning',
                undefined,
                'groups',
              ),
              { sourceId: source, line: 0, raw: spec.name },
            ),
          );
        }
        return;
      }
      if (seen.has(name)) return;
      seen.add(name);
      members.push(name);
    };

    for (const matcher of spec.matchers) {
      switch (matcher.kind) {
        case 'literal': {
          if (matcher.value === spec.name) {
            add(matcher.value); // emits the self-reference warning
          } else if (knownMembers.has(matcher.value)) {
            add(matcher.value);
          } else {
            warnings.push(
              toWarning(
                ruleIssue(
                  'W_GROUP_MATCHER_INVALID',
                  `literal member "${matcher.value}" is not a node, group or built-in`,
                  'warning',
                  undefined,
                  'groups',
                ),
                { sourceId: source, line: 0, raw: matcher.value },
              ),
            );
          }
          break;
        }
        case 'name-regex': {
          const compiled = compileUserRegex(matcher.pattern);
          if (!compiled.ok) {
            warnings.push(
              toWarning(
                ruleIssue('W_GROUP_MATCHER_INVALID', `name regex is invalid: ${compiled.reason}`, 'warning', undefined, 'groups'),
                { sourceId: source, line: 0, raw: matcher.pattern },
              ),
            );
            break;
          }
          for (const node of nodes) {
            if (compiled.regex.test(node.name)) add(node.name);
          }
          break;
        }
        case 'node-type': {
          const compiled = compileUserRegex(matcher.pattern);
          if (!compiled.ok) {
            warnings.push(
              toWarning(
                ruleIssue('W_GROUP_MATCHER_INVALID', `node-type regex is invalid: ${compiled.reason}`, 'warning', undefined, 'groups'),
                { sourceId: source, line: 0, raw: matcher.pattern },
              ),
            );
            break;
          }
          for (const node of nodes) {
            if (compiled.regex.test(node.kind.toUpperCase())) add(node.name);
          }
          break;
        }
        case 'source-group': {
          const compiled = compileUserRegex(matcher.pattern);
          if (!compiled.ok) {
            warnings.push(
              toWarning(
                ruleIssue('W_GROUP_MATCHER_INVALID', `source-group regex is invalid: ${compiled.reason}`, 'warning', undefined, 'groups'),
                { sourceId: source, line: 0, raw: matcher.pattern },
              ),
            );
            break;
          }
          for (const node of nodes) {
            if (compiled.regex.test(node.sourceGroup ?? '')) add(node.name);
          }
          break;
        }
        case 'server': {
          const compiled = compileUserRegex(matcher.pattern);
          if (!compiled.ok) {
            warnings.push(
              toWarning(
                ruleIssue('W_GROUP_MATCHER_INVALID', `server regex is invalid: ${compiled.reason}`, 'warning', undefined, 'groups'),
                { sourceId: source, line: 0, raw: matcher.pattern },
              ),
            );
            break;
          }
          for (const node of nodes) {
            if (compiled.regex.test(node.server)) add(node.name);
          }
          break;
        }
        case 'port-range': {
          for (const node of nodes) {
            if (portMatches(node.port, matcher.range)) add(node.name);
          }
          break;
        }
      }
    }

    if (members.length === 0) {
      members.push('DIRECT');
      warnings.push(
        toWarning(
          ruleIssue('W_GROUP_EMPTY', `group "${spec.name}" has no members; DIRECT was added`, 'warning', undefined, 'groups'),
          { sourceId: source, line: 0, raw: spec.name },
        ),
      );
    }

    resolved.push({
      name: spec.name,
      type: spec.type,
      members,
      ...(spec.url === undefined ? {} : { url: spec.url }),
      ...(spec.interval === undefined ? {} : { interval: spec.interval }),
      ...(spec.tolerance === undefined ? {} : { tolerance: spec.tolerance }),
      ...(spec.strategy === undefined ? {} : { strategy: spec.strategy }),
    });
  }

  return resolved;
}

/**
 * Default groups when neither config nor `groups=` provide any:
 * `PROXY` (select, all nodes + DIRECT) and `AUTO` (url-test, all nodes).
 */
export function defaultGroups(
  nodes: readonly ProxyNode[],
  warnings?: Warning[],
): ResolvedGroup[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.name)) continue;
    seen.add(node.name);
    names.push(node.name);
  }

  const proxyMembers = [...names];
  if (!proxyMembers.includes('DIRECT')) proxyMembers.push('DIRECT');

  const autoMembers = names.length > 0 ? [...names] : ['DIRECT'];
  if (warnings !== undefined) {
    warnings.push(
      toWarning(
        ruleIssue(
          'W_GROUP_DEFAULT_ADDED',
          'no groups configured; default PROXY and AUTO groups were added',
          'info',
          undefined,
          'groups',
        ),
        { sourceId: 'groups', line: 0, raw: '' },
      ),
    );
    if (names.length === 0) {
      warnings.push(
        toWarning(
          ruleIssue(
            'W_GROUP_EMPTY',
            'AUTO group has no nodes; DIRECT was added',
            'warning',
            undefined,
            'groups',
          ),
          { sourceId: 'groups', line: 0, raw: 'AUTO' },
        ),
      );
    }
  }

  return [
    { name: 'PROXY', type: 'select', members: proxyMembers },
    {
      name: 'AUTO',
      type: 'url-test',
      members: autoMembers,
      url: DEFAULT_GROUP_URL,
      interval: DEFAULT_GROUP_INTERVAL,
      tolerance: DEFAULT_GROUP_TOLERANCE,
    },
  ];
}
