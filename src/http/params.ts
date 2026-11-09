/**
 * Query-string parsing for `/sub`, `/clash` and `/getruleset` (SPEC §2.4-§2.7).
 *
 * This layer only validates syntax and limits; source bodies are not decoded
 * and no network I/O happens here.
 */

import { decodeBase64Text } from '../links/base64';
import { makeWarning } from '../links/text';
import { compileUserRegex } from '../links/protocols';
import type {
  DiagnosticsMode,
  RenameSpec,
  RulesMode,
  RulesetType,
  Target,
  Warning,
} from '../types';
import {
  MAX_EXCLUDE_PATTERNS,
  MAX_INCLUDE_PATTERNS,
  MAX_RENAME_RULES,
  MAX_RULESETS,
  MAX_SOURCES,
} from '../types';
import { AppError } from '../services/errors';
import type { SourceSpec } from '../services/fetch';

const KNOWN_PARAMS = new Set([
  'url',
  'target',
  'config',
  'ruleset',
  'groups',
  'template',
  'rules_mode',
  'expand',
  'diagnostics',
  'include',
  'exclude',
  'rename',
  'sort',
  'udp',
  'tfo',
  'scv',
  'group',
  'interval',
  'append_info',
  'filename',
]);

const RULESET_KNOWN_PARAMS = new Set([
  'type',
  'src',
  'url',
  'dialect',
  'group',
  'diagnostics',
]);

/** Known tindy params that v1 intentionally does not implement (SPEC §2.4). */
const UNSUPPORTED_PARAMS = new Set([
  'new_name',
  'ver',
  'sort_script',
  'script',
  'list',
  'insert',
  'prepend',
  'fdn',
  'append_type',
  'emoji',
  'add_emoji',
  'remove_emoji',
  'dev_id',
  'token',
  'upload',
  'upload_path',
  'profile_data',
  'filter_script',
  'strict',
  'surge',
]);

const DIALECT_PREFIXES = new Set([
  'auto',
  'clash-classical',
  'clash-classic',
  'clash-domain',
  'clash-ipcidr',
  'surge',
  'domain',
  'base64',
  'quanx',
]);

export interface RuleSourceParam {
  group: string;
  /** Source string without dialect prefix and interval suffix. */
  raw: string;
  /** Explicit dialect, including `quanx` (rejected later) and `clash-classic`. */
  dialect?: string;
  interval?: number;
  /** `[]RULE` inline rule text; when set, `raw` is empty. */
  inlineRule?: string;
  /** `!!import:` is recognized but intentionally unsupported (SPEC §4.1). */
  importUnsupported?: boolean;
  sourceId: string;
}

export interface SubParams {
  urls: SourceSpec[];
  target: Target;
  config?: SourceSpec;
  rulesets: RuleSourceParam[];
  /** Decoded `groups=` text (one custom_proxy_group per line). */
  groupsText?: string;
  template?: SourceSpec;
  rulesMode: RulesMode;
  diagnostics: DiagnosticsMode;
  include: string[];
  exclude: string[];
  rename: RenameSpec[];
  sort: boolean;
  udp: boolean;
  tfo: boolean;
  scv: boolean;
  group?: string;
  interval: number;
  appendInfo: boolean;
  filename?: string;
}

export interface ParsedSubParams {
  params: SubParams;
  warnings: Warning[];
}

export interface RulesetParams {
  type: RulesetType;
  sourceRaw: string;
  dialect: string;
  diagnostics: DiagnosticsMode;
}

export interface ParsedRulesetParams {
  params: RulesetParams;
  warnings: Warning[];
}

function requestWarning(code: string, message: string, severity: 'info' | 'warning' = 'info'): Warning {
  return makeWarning(code, message, { severity, stage: 'request' });
}

function readBoolean(search: URLSearchParams, name: string, fallback: boolean): boolean {
  if (!search.has(name)) return fallback;
  const raw = search.get(name) ?? '';
  if (raw === '' || raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new AppError('invalid_boolean', `parameter ${name} must be true/false/1/0 or a bare key`);
}

function readInteger(
  search: URLSearchParams,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (!search.has(name)) return undefined;
  const raw = (search.get(name) ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    throw new AppError('invalid_request', `parameter ${name} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError('invalid_request', `parameter ${name} must be between ${min} and ${max}`);
  }
  return value;
}

function readSingleSource(search: URLSearchParams, name: string): SourceSpec | undefined {
  const raw = search.get(name);
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value === '') throw new AppError('invalid_source', `parameter ${name} is empty`);
  return { raw: value, label: name, sourceId: name };
}

function readTaggedSource(raw: string, sourceId: string): SourceSpec | null {
  const value = raw.trim();
  if (value === '') return null;
  if (!value.toLowerCase().startsWith('tag:')) {
    return { raw: value, label: sourceId, sourceId };
  }
  const comma = value.indexOf(',');
  if (comma === -1) {
    throw new AppError('invalid_source', 'tag: prefix must be followed by a comma and a source');
  }
  const label = value.slice('tag:'.length, comma).trim();
  if (label === '' || label.length > 64) {
    throw new AppError('invalid_source', 'tag label must be 1..64 characters');
  }
  const sourceRaw = value.slice(comma + 1).trim();
  if (sourceRaw === '') {
    throw new AppError('invalid_source', 'tagged source is empty');
  }
  return { raw: sourceRaw, label, sourceId, sourceGroup: label };
}

function parseUrlParams(search: URLSearchParams, warnings: Warning[]): SourceSpec[] {
  const specs: SourceSpec[] = [];
  const values = search.getAll('url');
  if (values.length === 0) {
    throw new AppError('invalid_request', 'missing required parameter url');
  }
  for (const value of values) {
    for (const part of value.split('|')) {
      if (part.trim() === '') {
        warnings.push(requestWarning('W_SOURCE_EMPTY', 'empty url source was ignored', 'warning'));
        continue;
      }
      specs.push(readTaggedSourceChecked(part, `url#${specs.length + 1}`));
      if (specs.length > MAX_SOURCES) {
        throw new AppError('too_many_sources', `at most ${MAX_SOURCES} url sources are allowed`);
      }
    }
  }
  if (specs.length === 0) {
    throw new AppError('invalid_request', 'no non-empty url sources were provided');
  }
  return specs;
}

function readTaggedSourceChecked(raw: string, sourceId: string): SourceSpec {
  const spec = readTaggedSource(raw, sourceId);
  if (spec === null) throw new AppError('invalid_source', 'source is empty');
  return spec;
}

/** Parse a `ruleset=GROUP,SOURCE[,INTERVAL]` or `GROUP,[]RULE` value. */
export function parseRuleSourceParam(raw: string, sourceId: string): RuleSourceParam {
  const value = raw.trim();
  if (value === '') throw new AppError('invalid_request', 'ruleset value is empty');
  const comma = value.indexOf(',');
  if (comma === -1) {
    throw new AppError('invalid_request', 'ruleset must be GROUP,SOURCE');
  }
  const group = value.slice(0, comma).trim();
  if (group === '' || group.length > 64) {
    throw new AppError('invalid_request', 'ruleset group must be 1..64 characters');
  }
  let rest = value.slice(comma + 1).trim();
  if (rest === '') throw new AppError('invalid_request', 'ruleset source is empty');

  if (rest.startsWith('[]')) {
    const inlineRule = rest.slice(2).trim();
    if (inlineRule === '') throw new AppError('invalid_request', 'inline ruleset rule is empty');
    return { group, raw: '', inlineRule, sourceId };
  }

  if (rest.startsWith('!!import:')) {
    return { group, raw: rest, importUnsupported: true, sourceId };
  }

  let dialect: string | undefined;
  const colon = rest.indexOf(':');
  if (colon > 0) {
    const prefix = rest.slice(0, colon).trim().toLowerCase();
    if (DIALECT_PREFIXES.has(prefix)) {
      dialect = prefix;
      rest = rest.slice(colon + 1).trim();
      if (rest === '') throw new AppError('invalid_request', 'ruleset source is empty');
    }
  }

  let interval: number | undefined;
  const lastComma = rest.lastIndexOf(',');
  if (lastComma !== -1) {
    const suffix = rest.slice(lastComma + 1).trim();
    if (/^\d+$/.test(suffix)) {
      const candidate = Number(suffix);
      if (candidate >= 60 && candidate <= 604_800) {
        interval = candidate;
        rest = rest.slice(0, lastComma).trim();
      }
    }
  }
  if (rest === '') throw new AppError('invalid_request', 'ruleset source is empty');

  return {
    group,
    raw: rest,
    ...(dialect === undefined ? {} : { dialect }),
    ...(interval === undefined ? {} : { interval }),
    sourceId,
  };
}

function warnUnknownParams(
  search: URLSearchParams,
  known: ReadonlySet<string>,
  warnings: Warning[],
): void {
  const unknown = new Set<string>();
  const unsupported = new Set<string>();
  for (const key of search.keys()) {
    if (known.has(key)) continue;
    if (UNSUPPORTED_PARAMS.has(key)) {
      if (!unsupported.has(key)) {
        unsupported.add(key);
        warnings.push(
          requestWarning(
            'W_PARAM_UNSUPPORTED',
            `parameter ${key} is known from tindy but is not supported and was ignored`,
            'warning',
          ),
        );
      }
      continue;
    }
    if (!unknown.has(key)) {
      unknown.add(key);
      warnings.push(requestWarning('W_PARAM_UNKNOWN', `unknown parameter ${key} was ignored`));
    }
  }
}

/**
 * Parse `/sub` or `/clash` query parameters.
 * `forceClash` is true for `/clash`: a non-clash target is ignored with a
 * warning instead of raising `unsupported_target`.
 */
export function parseSubParams(url: URL, forceClash: boolean): ParsedSubParams {
  const search = url.searchParams;
  const warnings: Warning[] = [];
  warnUnknownParams(search, KNOWN_PARAMS, warnings);

  const targetRaw = (search.get('target') ?? '').trim().toLowerCase();
  let target: Target = 'clash';
  if (targetRaw !== '' && targetRaw !== 'clash') {
    if (forceClash) {
      warnings.push(
        requestWarning('W_PARAM_IGNORED', 'target was ignored on /clash; target is always clash'),
      );
    } else {
      throw new AppError('unsupported_target', 'only target=clash is supported');
    }
  }

  const config = readSingleSource(search, 'config');
  const template = readSingleSource(search, 'template');

  const rulesModeRaw = search.get('rules_mode');
  const expandRaw = search.get('expand');
  if (rulesModeRaw !== null && expandRaw !== null) {
    throw new AppError('conflicting_params', 'rules_mode and expand cannot both be provided');
  }
  let rulesMode: RulesMode = 'inline';
  if (rulesModeRaw !== null) {
    const value = rulesModeRaw.trim().toLowerCase();
    if (value !== 'inline' && value !== 'providers') {
      throw new AppError('invalid_request', 'rules_mode must be inline or providers');
    }
    rulesMode = value;
  } else if (expandRaw !== null) {
    rulesMode = readBoolean(search, 'expand', true) ? 'inline' : 'providers';
  }

  const diagnosticsRaw = (search.get('diagnostics') ?? '').trim().toLowerCase();
  let diagnostics: DiagnosticsMode = 'none';
  if (diagnosticsRaw !== '') {
    if (diagnosticsRaw !== 'none' && diagnosticsRaw !== 'json') {
      throw new AppError('invalid_request', 'diagnostics must be none or json');
    }
    diagnostics = diagnosticsRaw;
  }

  const include = search.getAll('include');
  const exclude = search.getAll('exclude');
  if (include.length > MAX_INCLUDE_PATTERNS) {
    throw new AppError('invalid_request', `at most ${MAX_INCLUDE_PATTERNS} include patterns are allowed`);
  }
  if (exclude.length > MAX_EXCLUDE_PATTERNS) {
    throw new AppError('invalid_request', `at most ${MAX_EXCLUDE_PATTERNS} exclude patterns are allowed`);
  }
  include.forEach((pattern, index) => {
    if (!compileUserRegex(pattern, `include[${index}]`).ok) {
      throw new AppError('invalid_regex', `include[${index}] is not a valid or safe regular expression`);
    }
  });
  exclude.forEach((pattern, index) => {
    if (!compileUserRegex(pattern, `exclude[${index}]`).ok) {
      throw new AppError('invalid_regex', `exclude[${index}] is not a valid or safe regular expression`);
    }
  });

  const renameRaw = search.getAll('rename');
  if (renameRaw.length > MAX_RENAME_RULES) {
    throw new AppError('invalid_request', `at most ${MAX_RENAME_RULES} rename rules are allowed`);
  }
  const rename: RenameSpec[] = renameRaw.map((entry, index) => {
    const at = entry.indexOf('@');
    if (at <= 0) {
      throw new AppError('invalid_request', `rename[${index}] must be pattern@replacement`);
    }
    const pattern = entry.slice(0, at);
    const replacement = entry.slice(at + 1);
    if (!compileUserRegex(pattern, `rename[${index}]`, { global: true }).ok) {
      throw new AppError('invalid_regex', `rename[${index}] pattern is not valid or safe`);
    }
    return { pattern, replacement };
  });

  const groupRaw = search.get('group');
  let group: string | undefined;
  if (groupRaw !== null) {
    const value = groupRaw.trim();
    if (value !== '') {
      if (value.length > 64) {
        throw new AppError('invalid_request', 'group must be at most 64 characters');
      }
      group = value;
    }
  }

  const interval = readInteger(search, 'interval', 0, 2_592_000) ?? 0;
  const filenameRaw = search.get('filename');
  let filename: string | undefined;
  if (filenameRaw !== null && filenameRaw !== '') {
    if (filenameRaw.length > 128) {
      throw new AppError('invalid_request', 'filename must be at most 128 characters');
    }
    if (/[\u0000-\u001f\u007f"]/.test(filenameRaw)) {
      throw new AppError('invalid_request', 'filename contains forbidden control characters or quotes');
    }
    filename = filenameRaw;
  }

  // SPEC §8.4: config owns groups/ruleset when present.
  let rulesets: RuleSourceParam[] = [];
  let groupsText: string | undefined;
  const configPresent = config !== undefined;
  if (configPresent) {
    if (search.has('groups') || search.has('ruleset')) {
      warnings.push(
        requestWarning(
          'W_CONFIG_OVERRIDES_PARAMS',
          'config is present; groups and ruleset query parameters were ignored',
          'warning',
        ),
      );
    }
  } else {
    const rulesetRaw = search.getAll('ruleset');
    if (rulesetRaw.length > MAX_RULESETS) {
      throw new AppError('too_many_sources', `at most ${MAX_RULESETS} ruleset sources are allowed`);
    }
    rulesets = rulesetRaw.map((entry, index) => parseRuleSourceParam(entry, `ruleset#${index + 1}`));

    const groupsRaw = search.get('groups');
    if (groupsRaw !== null && groupsRaw.trim() !== '') {
      const decoded = decodeBase64Text(groupsRaw.trim());
      if (!decoded.ok) {
        throw new AppError('invalid_source', 'groups is not valid base64url UTF-8 text');
      }
      groupsText = decoded.text;
    }
  }

  const params: SubParams = {
    urls: parseUrlParams(search, warnings),
    target,
    ...(config === undefined ? {} : { config }),
    rulesets,
    ...(groupsText === undefined ? {} : { groupsText }),
    ...(template === undefined ? {} : { template }),
    rulesMode,
    diagnostics,
    include,
    exclude,
    rename,
    sort: readBoolean(search, 'sort', false),
    udp: readBoolean(search, 'udp', false),
    tfo: readBoolean(search, 'tfo', false),
    scv: readBoolean(search, 'scv', false),
    ...(group === undefined ? {} : { group }),
    interval,
    appendInfo: readBoolean(search, 'append_info', true),
    ...(filename === undefined ? {} : { filename }),
  };
  return { params, warnings };
}

/** Parse `/getruleset` query parameters. */
export function parseRulesetParams(url: URL): ParsedRulesetParams {
  const search = url.searchParams;
  const warnings: Warning[] = [];
  warnUnknownParams(search, RULESET_KNOWN_PARAMS, warnings);

  const typeRaw = (search.get('type') ?? '').trim();
  if (typeRaw === '') {
    throw new AppError('invalid_request', 'missing required parameter type');
  }
  if (typeRaw !== '3' && typeRaw !== '4' && typeRaw !== '6') {
    throw new AppError('unsupported_ruleset_type', 'type must be 3, 4 or 6');
  }
  const type = Number(typeRaw) as RulesetType;

  const src = search.get('src');
  const urlParam = search.get('url');
  if (src !== null && urlParam !== null) {
    throw new AppError('conflicting_params', 'src and url are mutually exclusive');
  }
  let sourceRaw: string;
  if (src !== null) {
    sourceRaw = src;
  } else if (urlParam !== null) {
    const decoded = decodeBase64Text(urlParam);
    if (!decoded.ok) {
      throw new AppError('invalid_source', 'url parameter is not valid base64url UTF-8 text');
    }
    sourceRaw = decoded.text;
  } else {
    throw new AppError('invalid_request', 'one of src or url is required');
  }
  if (sourceRaw.trim() === '') {
    throw new AppError('invalid_source', 'ruleset source is empty');
  }

  if (search.has('group')) {
    warnings.push(requestWarning('W_PARAM_IGNORED', 'group has no meaning for /getruleset and was ignored'));
  }

  const diagnosticsRaw = (search.get('diagnostics') ?? '').trim().toLowerCase();
  let diagnostics: DiagnosticsMode = 'none';
  if (diagnosticsRaw !== '') {
    if (diagnosticsRaw !== 'none' && diagnosticsRaw !== 'json') {
      throw new AppError('invalid_request', 'diagnostics must be none or json');
    }
    diagnostics = diagnosticsRaw;
  }

  const dialect = (search.get('dialect') ?? 'auto').trim().toLowerCase();
  if (dialect !== 'auto') {
    if (!DIALECT_PREFIXES.has(dialect)) {
      throw new AppError('invalid_source', `dialect ${dialect} is not supported`);
    }
    if (dialect === 'quanx') {
      throw new AppError('invalid_source', 'dialect quanx is not supported');
    }
  }

  return {
    params: { type, sourceRaw, dialect, diagnostics },
    warnings,
  };
}

/** Exported for tests that need the known-key list. */
export const PARAM_KEYS = {
  known: KNOWN_PARAMS,
  unsupported: UNSUPPORTED_PARAMS,
} as const;
