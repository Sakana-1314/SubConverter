/**
 * Field splitting for mihomo rule lines (SPEC §5.3).
 *
 * A plain `line.split(',')` is wrong for:
 * - `DOMAIN-REGEX` / `PROCESS-*-REGEX` / `AND` / `OR` / `NOT` / `SUB-RULE`
 *   whose payload may itself contain commas;
 * - ruleset sources where the wrapper GROUP supplies the target;
 * - `MATCH,TARGET` (no payload);
 * - `no-resolve` parameters.
 *
 * This module never validates payload syntax and never resolves the type
 * whitelist; `parse.ts` does both.
 */

import { BUILTIN_TARGETS } from '../types';
import { allowsNoResolve, isCommaBearingType } from './registry';
import { ruleIssue, type RuleIssue, type RuleMode, type SplitOutcome } from './types';

export interface SplitOptions {
  /** `ruleset=GROUP,...`: target comes from the wrapper, never the source. */
  wrapperGroup?: string;
  /** Group/proxy/provider names known in this request. */
  knownTargets?: ReadonlySet<string>;
  mode?: RuleMode;
  /** Override built-in targets (tests). */
  builtins?: ReadonlySet<string>;
}

const BUILTINS: ReadonlySet<string> = new Set(BUILTIN_TARGETS);

/**
 * Normalize full-width commas (U+FF0C) used by Chinese IMEs as separators.
 * We replace them before splitting. Regex payloads that legitimately contain a
 * full-width comma are unusual; the alternative (leaving the line untouched)
 * would drop every rule line authored with full-width separators.
 */
export function normalizeFullWidthCommas(line: string): string {
  return line.includes('\uFF0C') ? line.replace(/\uFF0C/g, ',') : line;
}

/** SPEC §5.3: a field that "looks like a target" is `[A-Za-z0-9_. -]`. */
export function looksLikeTarget(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_. -]+$/.test(value);
}

function knownTarget(value: string, opts: SplitOptions): boolean {
  return (opts.knownTargets?.has(value) ?? false) || (opts.builtins ?? BUILTINS).has(value);
}

function noTarget(): SplitOutcome {
  return {
    ok: false,
    issue: ruleIssue(
      'E_RULE_NO_TARGET',
      'rule has no target; expected TYPE,PAYLOAD,GROUP',
      'error',
      'line may be truncated; see SPEC §6.8',
    ),
  };
}

function emptyLine(): SplitOutcome {
  return {
    ok: false,
    issue: ruleIssue('E_RULE_EMPTY', 'rule line is empty'),
  };
}

function parseExtras(
  extras: string[],
  type: string,
  mode: RuleMode,
  opts: SplitOptions,
  warnings: RuleIssue[],
): string[] {
  const params: string[] = [];
  for (let index = 0; index < extras.length; index += 1) {
    const field = extras[index].trim();
    // Empty fields are almost always a trailing comma; tolerate them instead
    // of emitting a warning for every line in a CRLF/last-line file.
    if (field === '') continue;

    // SPEC §5.3: `no-resolve` is the 4th field for template rules, or the 3rd
    // (target omitted) / 4th field for ruleset/provider rules.
    const paramPosition =
      mode === 'template' || mode === 'inline' ? index === 0 : index <= 1;
    if (
      paramPosition &&
      field.toLowerCase() === 'no-resolve' &&
      allowsNoResolve(type) &&
      params.length === 0
    ) {
      params.push('no-resolve');
      continue;
    }

    if (mode === 'ruleset' || mode === 'provider') {
      // The first extra field is a source policy/target; later fields are
      // parameters. In provider context any target must be absent anyway.
      if (index === 0) {
        warnings.push(
          ruleIssue(
            'W_RULE_SOURCE_TARGET_IGNORED',
            `source field "${field}" is ignored; target comes from GROUP`,
            'warning',
          ),
        );
      } else {
        warnings.push(
          ruleIssue('W_RULE_PARAM_IGNORED', `extra rule field "${field}" is ignored`, 'warning'),
        );
      }
    } else {
      warnings.push(
        ruleIssue(
          'W_RULE_PARAM_IGNORED',
          `extra rule field "${field}" is ignored`,
          'warning',
        ),
      );
    }
  }
  return params;
}

function splitMatch(line: string, opts: SplitOptions): SplitOutcome {
  const mode: RuleMode = opts.mode ?? 'template';
  const warnings: RuleIssue[] = [];
  const comma = line.indexOf(',');

  // Bare MATCH is only legal when a ruleset wrapper group supplies the target.
  if (comma === -1) {
    if (opts.wrapperGroup !== undefined && opts.wrapperGroup !== '') {
      return {
        ok: true,
        type: 'MATCH',
        payload: '',
        target: opts.wrapperGroup,
        params: [],
        targetPresent: true,
        warnings,
      };
    }
    return noTarget();
  }

  const fields = line.split(',');
  const fieldTarget = (fields[1] ?? '').trim();
  if (fieldTarget === '') return noTarget();

  if (mode === 'provider') {
    // MATCH is filtered before split in parse.ts; keep the invariant anyway.
    return {
      ok: true,
      type: 'MATCH',
      payload: '',
      target: '',
      params: [],
      targetPresent: false,
      warnings,
    };
  }

  let target = fieldTarget;
  if (mode === 'ruleset' && opts.wrapperGroup !== undefined && opts.wrapperGroup !== '') {
    if (fieldTarget !== opts.wrapperGroup) {
      warnings.push(
        ruleIssue(
          'W_RULE_SOURCE_TARGET_IGNORED',
          `source target "${fieldTarget}" is ignored; target comes from GROUP`,
          'warning',
        ),
      );
    }
    target = opts.wrapperGroup;
  }

  if (fields.length > 2) {
    warnings.push(
      ruleIssue('W_RULE_PARAM_IGNORED', 'extra fields after MATCH are ignored', 'warning'),
    );
  }

  return {
    ok: true,
    type: 'MATCH',
    payload: '',
    target,
    params: [],
    targetPresent: true,
    warnings,
  };
}

function splitCommaBearing(
  line: string,
  type: string,
  opts: SplitOptions,
): SplitOutcome {
  const mode: RuleMode = opts.mode ?? 'template';
  const comma = line.indexOf(',');
  if (comma === -1) return noTarget();
  const body = line.slice(comma + 1);
  const parts = body.split(',');
  const warnings: RuleIssue[] = [];

  if (mode === 'template' || mode === 'inline') {
    // Template/inline: the LAST comma field is the target (mihomo semantics).
    if (parts.length < 2) return noTarget();
    const target = (parts[parts.length - 1] ?? '').trim();
    if (target === '') return noTarget();
    const payload = parts.slice(0, -1).join(',').trim();
    return {
      ok: true,
      type,
      payload,
      target,
      params: [],
      targetPresent: true,
      warnings,
    };
  }

  // Ruleset/provider: the target is supplied by GROUP (or absent). Only strip
  // the final field when it is a known target; otherwise it is payload.
  let effectiveParts = parts;
  let target = opts.wrapperGroup ?? '';

  if (mode === 'ruleset' && target === '') return noTarget();

  if (parts.length > 1) {
    const last = (parts[parts.length - 1] ?? '').trim();
    if (target !== '' && last === target) {
      effectiveParts = parts.slice(0, -1);
      warnings.push(
        ruleIssue(
          'W_RULE_SOURCE_TARGET_IGNORED',
          `source target "${last}" is ignored; target comes from GROUP`,
          'warning',
        ),
      );
    } else if (knownTarget(last, opts)) {
      effectiveParts = parts.slice(0, -1);
      warnings.push(
        ruleIssue(
          'W_RULE_SOURCE_TARGET_IGNORED',
          `source target "${last}" is ignored; target comes from GROUP`,
          'warning',
        ),
      );
    } else if (looksLikeTarget(last)) {
      // P0-5: keep it as payload, but tell the operator it is ambiguous.
      warnings.push(
        ruleIssue(
          'W_RULE_SOURCE_TARGET_AMBIGUOUS',
          `last field "${last}" looks like a target but is not a known target; kept as payload`,
          'warning',
        ),
      );
    }
  }

  if (mode === 'provider') target = '';

  const payload = effectiveParts.join(',').trim();
  return {
    ok: true,
    type,
    payload,
    target,
    params: [],
    targetPresent: target !== '',
    warnings,
  };
}

function splitNormal(line: string, type: string, opts: SplitOptions): SplitOutcome {
  const mode: RuleMode = opts.mode ?? 'template';
  const comma = line.indexOf(',');
  if (comma === -1) return noTarget();

  const fields = line.split(',');
  if (fields.length < 2) return noTarget();
  const payload = (fields[1] ?? '').trim();
  const warnings: RuleIssue[] = [];

  if (mode === 'template' || mode === 'inline') {
    if (fields.length < 3) return noTarget();
    const target = (fields[2] ?? '').trim();
    if (target === '') return noTarget();
    const params = parseExtras(fields.slice(3), type, mode, opts, warnings);
    return {
      ok: true,
      type,
      payload,
      target,
      params,
      targetPresent: true,
      warnings,
    };
  }

  if (mode === 'ruleset' && (opts.wrapperGroup === undefined || opts.wrapperGroup === '')) {
    return noTarget();
  }

  const target = mode === 'provider' ? '' : (opts.wrapperGroup ?? '');
  // In ruleset/provider context fields after PAYLOAD are params or a source
  // target. Only `no-resolve` survives.
  const params = parseExtras(fields.slice(2), type, mode, opts, warnings);

  return {
    ok: true,
    type,
    payload,
    target,
    params,
    targetPresent: target !== '',
    warnings,
  };
}

/**
 * Split one rule line into type/payload/target/params.
 * `type` must already be a canonical registry type.
 */
export function splitRuleLine(line: string, type: string, opts: SplitOptions = {}): SplitOutcome {
  const text = line.trim();
  if (text === '') return emptyLine();

  if (type === 'MATCH') return splitMatch(text, opts);
  if (isCommaBearingType(type)) return splitCommaBearing(text, type, opts);
  return splitNormal(text, type, opts);
}
