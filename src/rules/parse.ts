/**
 * Rule line parser: trim/comment handling -> exact type whitelist -> split ->
 * payload validation -> target policy -> `Rule` (SPEC §5.3, §5.4, §6.2).
 *
 * Ordering matters for the DOMA regression: a single-field non-MATCH line is
 * rejected with `E_RULE_NO_TARGET` BEFORE the type whitelist, so `DOMA` gets
 * the same reason mihomo is famous for (`format invalid`) rather than
 * `E_RULE_UNKNOWN_TYPE` (SPEC §5.3).
 */

import { BUILTIN_TARGETS, type Rule, type RuleParam, type RuleType, type Warning } from '../types';
import { validatePayload } from './payload';
import {
  getRuleTypeMeta,
  isCommentSensitiveType,
  isStrictTypePrefix,
  isTypeOrAliasToken,
  resolveRuleType,
} from './registry';
import { normalizeFullWidthCommas, splitRuleLine } from './split';
import {
  MAX_RULE_LINE_LENGTH,
  ruleIssue,
  toWarning,
  type ExtractedRuleLine,
  type ParseLinesResult,
  type RuleIssue,
  type RuleParseResult,
  type ValidationContext,
} from './types';

const BUILTINS: ReadonlySet<string> = new Set(BUILTIN_TARGETS);

export function isWholeLineComment(line: string): boolean {
  const text = line.trimStart();
  return text.startsWith('#') || text.startsWith(';') || text.startsWith('//');
}

export function stripBomFromLine(line: string): string {
  return line.startsWith('\uFEFF') ? line.slice(1) : line;
}

export interface InlineCommentResult {
  line: string;
  removed: boolean;
}

/**
 * Remove an inline ` #` / ` //` comment from a non-regex rule line
 * (SPEC §4.4). Regex payloads are never truncated.
 */
export function stripInlineComment(line: string): InlineCommentResult {
  const hash = /[ \t]#/.exec(line);
  const slash = /[ \t]\/\//.exec(line);
  let index = -1;
  if (hash !== null) index = hash.index;
  if (slash !== null && (index === -1 || slash.index < index)) index = slash.index;
  if (index === -1) return { line, removed: false };
  return { line: line.slice(0, index).trimEnd(), removed: true };
}

function makeContextDefaults(ctx: ValidationContext): ValidationContext {
  return {
    ...ctx,
    knownTargets: ctx.knownTargets ?? new Set<string>(BUILTIN_TARGETS),
    knownProviders: ctx.knownProviders ?? new Set<string>(),
    allowMatch: ctx.allowMatch ?? true,
  };
}

function isBuiltinTarget(value: string): boolean {
  return BUILTINS.has(value);
}

/**
 * Parse one rule line.
 *
 * `lineNumber` is optional so unit tests can call this directly; production
 * callers use `parseRuleLines` which preserves original line numbers.
 */
export function parseRuleLine(
  line: string,
  context: ValidationContext,
  lineNumber = 1,
): RuleParseResult {
  const ctx = makeContextDefaults(context);
  const original = line;
  const raw = original.trim();
  const issues: RuleIssue[] = [];
  const emitted = new Set<string>();
  const addIssue = (issue: RuleIssue): void => {
    const key = `${issue.code}\u0000${issue.message}\u0000${issue.severity}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    issues.push(issue);
  };
  const finishFailure = (issue: RuleIssue): RuleParseResult => {
    addIssue(issue);
    return {
      ok: false,
      warnings: issues.map((item) =>
        toWarning(item, { sourceId: ctx.sourceId, line: lineNumber, raw }),
      ),
    };
  };
  const finishSuccess = (rule: Rule): RuleParseResult => ({
    ok: true,
    rule,
    warnings: issues.map((item) =>
      toWarning(item, { sourceId: ctx.sourceId, line: lineNumber, raw }),
    ),
  });

  // Line length is checked on the original text (SPEC §5.3).
  if (original.length > MAX_RULE_LINE_LENGTH) {
    return finishFailure(
      ruleIssue(
        'E_RULE_TOO_LONG',
        `rule line is longer than ${MAX_RULE_LINE_LENGTH} characters`,
      ),
    );
  }

  let text = stripBomFromLine(original).trim();
  if (text === '') {
    return finishFailure(ruleIssue('E_RULE_EMPTY', 'rule line is empty', 'warning'));
  }

  // SPEC §4.1: `[]RULE` is an inline rule whose target comes from GROUP.
  if (text.startsWith('[]')) {
    text = text.slice(2).trim();
    if (text === '') {
      return finishFailure(ruleIssue('E_RULE_EMPTY', 'rule line is empty', 'warning'));
    }
  }

  if (isWholeLineComment(text)) {
    return finishFailure(ruleIssue('E_RULE_EMPTY', 'rule line is empty', 'warning'));
  }

  // SPEC §4.1: `!!import:` is a tindy feature that v1 does not support.
  if (text.startsWith('!!import:')) {
    return finishFailure(
      ruleIssue(
        'W_RULESET_IMPORT_UNSUPPORTED',
        '!!import: is not supported; the line was dropped',
        'warning',
      ),
    );
  }

  // Full-width commas are a common IME artifact; normalize before splitting.
  text = normalizeFullWidthCommas(text);

  // Resolve the type token first so comment stripping can skip regex lines.
  const firstComma = text.indexOf(',');
  const rawType = (firstComma === -1 ? text : text.slice(0, firstComma)).trim();
  const preliminary = resolveRuleType(rawType);

  if (preliminary.type !== null && !isCommentSensitiveType(preliminary.type)) {
    const stripped = stripInlineComment(text);
    if (stripped.removed) {
      addIssue(
        ruleIssue('W_RULE_INLINE_COMMENT', 'inline comment was stripped', 'warning'),
      );
      text = stripped.line.trim();
      if (text === '') {
        return finishFailure(ruleIssue('E_RULE_EMPTY', 'rule line is empty', 'warning'));
      }
    }
  }

  // Recompute after comment stripping.
  const commaIndex = text.indexOf(',');
  const token = (commaIndex === -1 ? text : text.slice(0, commaIndex)).trim();
  const resolved = resolveRuleType(token);

  // ---------------------------------------------------------------------
  // Template/inline 2-field pre-check (SPEC §5.3): `DOMAIN,example.com`,
  // `DOMA,example.com` and `DOMAIN-SUFFI,example.com` are missing a target.
  // This mirrors mihomo's `format invalid` (target checked before type).
  // Arbitrary unknown tokens (`MATCHBOX,DIRECT`) keep E_RULE_UNKNOWN_TYPE.
  // ---------------------------------------------------------------------
  if (
    (ctx.mode === 'template' || ctx.mode === 'inline') &&
    commaIndex !== -1 &&
    text.indexOf(',', commaIndex + 1) === -1 &&
    resolved.type !== 'MATCH' &&
    (isTypeOrAliasToken(token) || isStrictTypePrefix(token))
  ) {
    return finishFailure(
      ruleIssue(
        'E_RULE_NO_TARGET',
        'rule has no target; expected TYPE,PAYLOAD,GROUP',
        'error',
        'line may be truncated; see SPEC §6.8',
      ),
    );
  }

  // ---------------------------------------------------------------------
  // Single-field pre-check (SPEC §5.3): `DOMA`, `DOMAIN`, `MATCH`
  // ---------------------------------------------------------------------
  if (commaIndex === -1) {
    if (resolved.type === 'MATCH') {
      if (ctx.mode === 'provider' || !ctx.allowMatch) {
        return finishFailure(
          ruleIssue(
            'W_RULESET_TYPE_FILTERED',
            'MATCH is not allowed in a rule-provider payload',
            'warning',
          ),
        );
      }
      if (ctx.wrapperGroup !== undefined && ctx.wrapperGroup !== '' && ctx.mode === 'ruleset') {
        if (resolved.alias) {
          addIssue(
            ruleIssue(
              'W_RULE_TYPE_ALIAS',
              `rule type ${resolved.token} was normalized to MATCH`,
              'info',
            ),
          );
        }
        return finishSuccess({
          type: 'MATCH',
          payload: '',
          target: ctx.wrapperGroup,
          params: [],
          raw,
          line: lineNumber,
          sourceId: ctx.sourceId,
        });
      }
      return finishFailure(
        ruleIssue('E_RULE_NO_TARGET', 'MATCH rule has no target', 'error', 'line may be truncated'),
      );
    }
    return finishFailure(
      ruleIssue(
        'E_RULE_NO_TARGET',
        'rule has no target; expected TYPE,PAYLOAD,GROUP',
        'error',
        'line may be truncated; see SPEC §6.8',
      ),
    );
  }

  if (resolved.type === null) {
    if (resolved.unsupported) {
      return finishFailure(
        ruleIssue(
          'W_RULE_TYPE_UNSUPPORTED',
          `rule type ${resolved.token} has no mihomo equivalent`,
          'warning',
        ),
      );
    }
    return finishFailure(
      ruleIssue('E_RULE_UNKNOWN_TYPE', `unknown rule type ${resolved.token || '(empty)'}`),
    );
  }

  const canonicalType = resolved.type;
  const meta = getRuleTypeMeta(canonicalType);

  // Provider payloads must not contain catch-all or nested references
  // (SPEC §2.7, §5.3).
  if (ctx.mode === 'provider') {
    if (canonicalType === 'MATCH' || canonicalType === 'RULE-SET') {
      return finishFailure(
        ruleIssue(
          'W_RULESET_TYPE_FILTERED',
          `${canonicalType} is not allowed in a rule-provider payload`,
          'warning',
        ),
      );
    }
  } else if (!ctx.allowMatch && canonicalType === 'MATCH') {
    return finishFailure(
      ruleIssue(
        'W_RULESET_TYPE_FILTERED',
        'MATCH is not allowed in this rule source',
        'warning',
      ),
    );
  }

  if (canonicalType === 'SUB-RULE') {
    return finishFailure(
      ruleIssue(
        'W_RULE_SUB_RULE_UNSUPPORTED',
        'SUB-RULE needs a sub-rules definition and is not emitted by v1',
        'warning',
      ),
    );
  }

  if (resolved.alias && !resolved.conditionalAlias) {
    addIssue(
      ruleIssue(
        'W_RULE_TYPE_ALIAS',
        `rule type ${resolved.token} was normalized to ${canonicalType}`,
        'info',
      ),
    );
  }

  // ---------------------------------------------------------------------
  // Split
  // ---------------------------------------------------------------------
  const split = splitRuleLine(text, canonicalType, {
    wrapperGroup: ctx.wrapperGroup,
    knownTargets: ctx.knownTargets,
    mode: ctx.mode,
  });
  if (!split.ok) return finishFailure(split.issue);
  for (const issue of split.warnings) addIssue(issue);

  // ---------------------------------------------------------------------
  // Payload
  // ---------------------------------------------------------------------
  const validated = validatePayload(canonicalType, split.payload);
  if (!validated.ok) {
    if (resolved.conditionalAlias && validated.code === 'E_RULE_BAD_CIDR') {
      return finishFailure(
        ruleIssue(
          'W_RULE_TYPE_UNSUPPORTED',
          'SRC-IP payload is not a CIDR; there is no safe mihomo equivalent',
          'warning',
        ),
      );
    }
    return finishFailure(ruleIssue(validated.code, validated.message, 'error', validated.hint));
  }

  if (resolved.conditionalAlias) {
    addIssue(
      ruleIssue(
        'W_RULE_TYPE_ALIAS',
        `rule type ${resolved.token} was normalized to ${canonicalType}`,
        'info',
      ),
    );
  }
  if (validated.engineDiff === true) {
    addIssue(
      ruleIssue(
        'W_REGEX_ENGINE_DIFF',
        'regex uses constructs where JS and mihomo regexp2 may differ',
        'warning',
      ),
    );
  }
  if (validated.aliases !== undefined) {
    for (const alias of validated.aliases) {
      addIssue(
        ruleIssue(
          'W_RULE_TYPE_ALIAS',
          `logic sub-rule alias ${alias} was normalized`,
          'info',
        ),
      );
    }
  }

  // RULE-SET must reference a provider generated in this request (SPEC §5.4).
  if (canonicalType === 'RULE-SET' && !ctx.knownProviders.has(validated.normalized)) {
    return finishFailure(
      ruleIssue(
        'E_RULE_TARGET_NOT_FOUND',
        `rule-set provider ${validated.normalized} does not exist`,
      ),
    );
  }

  // ---------------------------------------------------------------------
  // Target existence
  // ---------------------------------------------------------------------
  let target = split.target;
  if (ctx.mode === 'provider') {
    target = '';
  } else if (ctx.mode === 'ruleset') {
    if (target === '') {
      return finishFailure(
        ruleIssue('E_RULE_NO_TARGET', 'rule has no target; GROUP is missing'),
      );
    }
  } else {
    if (target === '') {
      return finishFailure(ruleIssue('E_RULE_NO_TARGET', 'rule has an empty target'));
    }
    if (!isBuiltinTarget(target) && !ctx.knownTargets.has(target)) {
      return finishFailure(
        ruleIssue('E_RULE_TARGET_NOT_FOUND', `target ${target} is not a group, node or built-in`),
      );
    }
  }

  const rule: Rule = {
    type: canonicalType as RuleType,
    payload: validated.normalized,
    target,
    params: split.params as RuleParam[],
    raw,
    line: lineNumber,
    sourceId: ctx.sourceId,
  };

  // `meta` is currently only used to make the type registry lookup explicit;
  // keep the assertion so future registry edits cannot silently allow a
  // non-emittable type through parse (SUB-RULE is handled above).
  if (meta === undefined || (!meta.emit && canonicalType !== 'MATCH')) {
    return finishFailure(
      ruleIssue('W_RULE_TYPE_UNSUPPORTED', `rule type ${canonicalType} is not emitted`),
    );
  }

  return finishSuccess(rule);
}

export interface ParseRuleLinesOptions {
  /** Stop after this many accepted rules (SPEC §9.4 MAX_RULES). */
  maxRules?: number;
  /** Stop after this many input lines; defaults to 2 * maxRules. */
  maxInputLines?: number;
}

/**
 * Parse many lines, isolating failures (SPEC §3.1: one bad line never fails the
 * whole source).
 */
export function parseRuleLines(
  lines: ReadonlyArray<string | ExtractedRuleLine>,
  context: ValidationContext,
  options: ParseRuleLinesOptions = {},
): ParseLinesResult {
  const rules: Rule[] = [];
  const warnings: Warning[] = [];
  const maxRules = options.maxRules ?? Number.POSITIVE_INFINITY;
  const maxInputLines =
    options.maxInputLines ??
    (Number.isFinite(maxRules) ? Math.max(0, maxRules * 2) : Number.POSITIVE_INFINITY);
  let accepted = 0;
  let dropped = 0;
  let processed = 0;
  let limitWarned = false;

  const addLimitWarning = (line: number): void => {
    if (limitWarned) return;
    limitWarned = true;
    warnings.push(
      toWarning(
        ruleIssue(
          'W_RULE_LIMIT',
          `rule source exceeds the ${maxRules} rule / ${maxInputLines} line limit; remaining lines were ignored`,
          'warning',
        ),
        { sourceId: context.sourceId, line, raw: '' },
      ),
    );
  };

  for (let index = 0; index < lines.length; index += 1) {
    const entry = lines[index];
    const text = typeof entry === 'string' ? entry : entry.text;
    const lineNumber = typeof entry === 'string' ? index + 1 : entry.line;
    if (processed >= maxInputLines || accepted >= maxRules) {
      addLimitWarning(lineNumber);
      break;
    }
    processed += 1;
    let result: RuleParseResult;
    try {
      result = parseRuleLine(text, context, lineNumber);
    } catch {
      // Defensive: a parser bug must not turn a subscription into a 500.
      result = {
        ok: false,
        warnings: [
          toWarning(ruleIssue('E_RULE_BAD_PAYLOAD', 'rule line could not be parsed'), {
            sourceId: context.sourceId,
            line: lineNumber,
            raw: text,
          }),
        ],
      };
    }
    warnings.push(...result.warnings);
    if (result.ok) {
      rules.push(result.rule);
      accepted += 1;
    } else {
      dropped += 1;
    }
  }

  return {
    rules,
    warnings,
    stats: { input: processed, accepted, dropped },
  };
}
