/**
 * ACL4SSR-style INI subset (SPEC §8).
 *
 * Only `[custom]` has semantics. Repeated keys accumulate. Inja/Jinja is not
 * executed: lines containing `{% ... %}` are treated as ordinary text and
 * normally produce an "unsupported key" warning. The project default for
 * `overwrite_original_rules` is **true** (SPEC §8.4 / ADR-10).
 */

import type { Acl4ssrConfig, Warning } from '../types';
import { compileUserRegex } from './groups';
import { ruleIssue, toWarning } from './types';

export const CONFIG_MAX_BYTES = 256 * 1024;

const SUPPORTED_KEYS: ReadonlySet<string> = new Set([
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

/** SPEC §8.2: tolerated but unsupported keys (warning + ignore). */
const TOLERATED_KEYS: ReadonlySet<string> = new Set([
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
]);

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

interface PendingEntry {
  key: string;
  value: string;
  line: number;
  section: string | null;
}

function parseBool(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function configWarning(line: number, raw: string, code: string, message: string): Warning {
  return toWarning(ruleIssue(code, message, 'warning', undefined, 'template'), {
    sourceId: 'config',
    line,
    raw,
  });
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Parse an ACL4SSR config. `maxBytes` defaults to 256 KiB (SPEC §8.1).
 */
export function parseAcL4ssrIni(text: string, maxBytes = CONFIG_MAX_BYTES): IniParseResult {
  if (maxBytes > 0 && byteLength(text) > maxBytes) {
    return { ok: false, code: 'invalid_config', message: `config is larger than ${maxBytes} bytes` };
  }

  const normalized = (text.startsWith('\uFEFF') ? text.slice(1) : text).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  const warnings: Warning[] = [];
  const pending: PendingEntry[] = [];
  const ignoredSections: string[] = [];
  let section: string | null = null;
  let sawCustom = false;
  let knownKeyCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith(';') || line.startsWith('#') || line.startsWith('//')) continue;

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1].trim().toLowerCase();
      if (section === 'custom') {
        sawCustom = true;
      } else {
        const name = sectionMatch[1].trim();
        if (!ignoredSections.includes(name)) ignoredSections.push(name);
        warnings.push(
          configWarning(lineNo, line, 'W_CONFIG_SECTION_IGNORED', `config section [${name}] is ignored`),
        );
      }
      continue;
    }

    const equals = line.indexOf('=');
    if (equals === -1) {
      warnings.push(
        configWarning(
          lineNo,
          line,
          'W_CONFIG_KEY_UNSUPPORTED',
          `config line is not key=value and was ignored: ${line.slice(0, 40)}`,
        ),
      );
      continue;
    }

    const key = line.slice(0, equals).trim().toLowerCase();
    const value = line.slice(equals + 1).trim();
    if (key === '') {
      warnings.push(
        configWarning(lineNo, line, 'W_CONFIG_KEY_UNSUPPORTED', 'config key is empty; line ignored'),
      );
      continue;
    }
    if (SUPPORTED_KEYS.has(key) || TOLERATED_KEYS.has(key)) knownKeyCount += 1;
    // Parse [custom] keys; also tolerate keys before the first section header.
    if (section === 'custom' || section === null) {
      pending.push({ key, value, line: lineNo, section });
    }
  }

  // SPEC §8.1: no [custom] and no known key at all -> invalid_config.
  if (!sawCustom && knownKeyCount === 0) {
    return {
      ok: false,
      code: 'invalid_config',
      message: 'config has no [custom] section and no recognized keys',
    };
  }

  const config: Acl4ssrConfig = {
    customProxyGroups: [],
    rulesets: [],
    enableRuleGenerator: true,
    overwriteOriginalRules: true,
    rename: [],
    includeRemarks: [],
    excludeRemarks: [],
    ignoredSections,
    unsupportedKeys: [],
  };
  const unsupportedSeen = new Set<string>();

  for (const entry of pending) {
    const { key, value, line } = entry;
    const raw = lines[line - 1] ?? '';

    if (TOLERATED_KEYS.has(key)) {
      if (!unsupportedSeen.has(key)) {
        unsupportedSeen.add(key);
        config.unsupportedKeys.push(key);
        warnings.push(
          configWarning(
            line,
            raw,
            'W_CONFIG_KEY_UNSUPPORTED',
            `config key ${key} is not supported by v1 and was ignored`,
          ),
        );
      }
      continue;
    }

    if (!SUPPORTED_KEYS.has(key)) {
      if (!unsupportedSeen.has(key)) {
        unsupportedSeen.add(key);
        config.unsupportedKeys.push(key);
        warnings.push(
          configWarning(
            line,
            raw,
            'W_CONFIG_KEY_UNSUPPORTED',
            `unknown config key ${key} was ignored`,
          ),
        );
      }
      continue;
    }

    switch (key) {
      case 'custom_proxy_group':
        config.customProxyGroups.push(value);
        break;
      case 'ruleset':
      case 'surge_ruleset':
        config.rulesets.push(value);
        break;
      case 'enable_rule_generator': {
        const parsed = parseBool(value);
        if (parsed === undefined) {
          warnings.push(
            configWarning(
              line,
              raw,
              'W_CONFIG_KEY_UNSUPPORTED',
              `enable_rule_generator value "${value}" is not a boolean; keeping default true`,
            ),
          );
        } else {
          config.enableRuleGenerator = parsed;
        }
        break;
      }
      case 'overwrite_original_rules': {
        const parsed = parseBool(value);
        if (parsed === undefined) {
          warnings.push(
            configWarning(
              line,
              raw,
              'W_CONFIG_KEY_UNSUPPORTED',
              `overwrite_original_rules value "${value}" is not a boolean; keeping default true`,
            ),
          );
        } else {
          config.overwriteOriginalRules = parsed;
        }
        break;
      }
      case 'rename': {
        const at = value.indexOf('@');
        const pattern = at === -1 ? '' : value.slice(0, at).trim();
        if (at <= 0 || pattern === '') {
          warnings.push(
            configWarning(line, raw, 'W_CONFIG_KEY_UNSUPPORTED', 'rename must be pattern@replacement'),
          );
          break;
        }
        const compiled = compileUserRegex(pattern);
        if (!compiled.ok) {
          warnings.push(
            configWarning(
              line,
              raw,
              'W_CONFIG_KEY_UNSUPPORTED',
              `rename regex is invalid and was ignored: ${compiled.reason}`,
            ),
          );
          break;
        }
        config.rename.push(value);
        break;
      }
      case 'include_remarks':
      case 'exclude_remarks': {
        const compiled = compileUserRegex(value);
        if (!compiled.ok) {
          warnings.push(
            configWarning(
              line,
              raw,
              'W_CONFIG_KEY_UNSUPPORTED',
              `${key} regex is invalid and was ignored: ${compiled.reason}`,
            ),
          );
          break;
        }
        if (key === 'include_remarks') config.includeRemarks.push(value);
        else config.excludeRemarks.push(value);
        break;
      }
      case 'clash_rule_base': {
        if (value === '') {
          warnings.push(
            configWarning(line, raw, 'W_CONFIG_KEY_UNSUPPORTED', 'clash_rule_base is empty; ignored'),
          );
        } else {
          config.clashRuleBase = value;
        }
        break;
      }
    }
  }

  return { ok: true, config, warnings };
}
