/**
 * `buildRules`: orchestration of extract -> parse -> target/MATCH/provider
 * post-processing (SPEC §5.5, §5.6, §5.7; ARCHITECTURE §7.2.8).
 *
 * Fail-closed: every rule that reaches the output has passed the same parser,
 * payload validator and target check. Invalid lines become structured warnings
 * and never enter `rules`.
 */

import {
  BUILTIN_TARGETS,
  type Rule,
  type RuleProviderSpec,
  type Warning,
} from '../types';
import { extractRuleLines } from './dialects';
import { parseRuleLines } from './parse';
import {
  buildProviderSpec,
  canBeProvider,
  decideBehavior,
  providerKey,
  providerName,
} from './providers';
import { resolveRuleType, ruleTypeToken } from './registry';
import { checkTail, hasFinalNewline } from './truncation';
import {
  DEFAULT_MAX_RULES,
  PROVIDER_URL_MAX_LEN,
  RULE_INPUT_MARGIN,
  ruleIssue,
  toWarning,
  type DialectExtraction,
  type ExtractedRuleLine,
  type RuleBuildInput,
  type RuleBuildResult,
  type RuleSource,
  type ValidationContext,
} from './types';

const BUILTINS: ReadonlySet<string> = new Set(BUILTIN_TARGETS);

function providerSourceRaw(source: RuleSource): string {
  return source.rawSource ?? source.raw ?? source.sourceId;
}

/**
 * Conservative estimate used when integration does not provide the final URL:
 * origin + `/getruleset?type=N&src=<encoded>&dialect=...&v=1`.
 */
function estimateProviderUrlLength(source: RuleSource): number {
  return 96 + encodeURIComponent(providerSourceRaw(source)).length;
}

function providerBlockingReason(lines: readonly ExtractedRuleLine[]): string | undefined {
  for (const line of lines) {
    const resolved = resolveRuleType(ruleTypeToken(line.text));
    if (
      resolved.type === 'MATCH' ||
      resolved.type === 'RULE-SET' ||
      resolved.type === 'SUB-RULE'
    ) {
      return `${resolved.type} cannot be moved into a provider`;
    }
  }
  return undefined;
}

interface ProviderPlan {
  name?: string;
  reason?: string;
}

/**
 * Build the final rule list.
 *
 * Ordering (SPEC §5.6): `sources` in request order, each source in line order;
 * template rules appended (only when `overwrite_original_rules=false`); exactly
 * one MATCH, always last.
 */
export function buildRules(input: RuleBuildInput): RuleBuildResult {
  const warnings: Warning[] = [];
  const warningKeys = new Set<string>();
  const addWarning = (warning: Warning): void => {
    const key = `${warning.code}\u0000${warning.source ?? ''}\u0000${warning.line ?? ''}\u0000${warning.raw ?? ''}`;
    if (warningKeys.has(key)) return;
    warningKeys.add(key);
    warnings.push(warning);
  };
  const addWarnings = (items: readonly Warning[]): void => {
    for (const item of items) addWarning(item);
  };

  let inputCount = 0;
  let accepted = 0;
  let dropped = 0;

  const baseTargets = new Set(input.knownTargets ?? []);
  for (const builtin of BUILTIN_TARGETS) baseTargets.add(builtin);
  const initialKnownProviders = new Set(input.knownProviders ?? []);
  const knownProviders = new Set(initialKnownProviders);

  const maxRules = Number.isFinite(input.maxRules)
    ? Math.max(0, Math.floor(input.maxRules as number))
    : DEFAULT_MAX_RULES;
  const maxNewGroups = Number.isFinite(input.maxNewGroups)
    ? Math.max(0, Math.floor(input.maxNewGroups as number))
    : Number.POSITIVE_INFINITY;
  const providerUrlMaxLen = input.providerUrlMaxLen ?? PROVIDER_URL_MAX_LEN;
  const syntheticSourceId = input.sourceId ?? 'rules';

  // -----------------------------------------------------------------------
  // 1. Extract every source first. This lets provider names be reserved before
  //    any RULE-SET rule is parsed (forward references inside fallback rules).
  // -----------------------------------------------------------------------
  interface PreparedSource {
    source: RuleSource;
    extraction: DialectExtraction;
  }

  const prepared: PreparedSource[] = [];
  let totalCandidates = 0;
  const finiteMaxRules = Number.isFinite(maxRules);
  const maxCandidates = finiteMaxRules ? (maxRules as number) + RULE_INPUT_MARGIN : Number.POSITIVE_INFINITY;
  for (const source of input.sources) {
    const remaining = finiteMaxRules
      ? Math.max(0, maxCandidates - totalCandidates)
      : undefined;
    const extraction = extractRuleLines(
      source.text,
      source.dialect,
      source.sourceId,
      remaining === undefined ? {} : { maxLines: remaining },
    );
    totalCandidates += extraction.stats.candidates;
    const tail = checkTail({
      rawText: source.text,
      lines: extraction.lines,
      hadFinalNewline: hasFinalNewline(source.text),
      dialect: source.dialect,
      sourceId: source.sourceId,
    });
    addWarnings(extraction.warnings);
    addWarnings(tail);
    inputCount += extraction.stats.candidates;
    dropped += extraction.stats.dropped;
    prepared.push({ source, extraction });
  }

  // -----------------------------------------------------------------------
  // 2. Wrapper groups that ruleset sources reference but that do not exist.
  //    Integration creates these and re-runs target validation (SPEC §5.4).
  // -----------------------------------------------------------------------
  const newGroups: string[] = [];
  const newGroupSet = new Set<string>();
  const overflowGroups = new Set<string>();
  for (const { source } of prepared) {
    const group = source.group;
    if (group === undefined || group === '') continue;
    if (baseTargets.has(group) || BUILTINS.has(group)) continue;
    if (newGroupSet.has(group)) continue;
    if (newGroups.length < maxNewGroups) {
      newGroups.push(group);
      newGroupSet.add(group);
    } else {
      overflowGroups.add(group);
    }
  }
  const effectiveTargets = new Set(baseTargets);
  for (const group of newGroups) effectiveTargets.add(group);

  // -----------------------------------------------------------------------
  // 3. Providers pre-pass (providers mode only).
  // -----------------------------------------------------------------------
  const providerPlans = new Map<string, ProviderPlan>();
  const providerNamesUsed = new Set<string>();
  if (input.mode === 'providers') {
    for (const { source, extraction } of prepared) {
      if (source.group === undefined || source.group === '') continue;
      if (overflowGroups.has(source.group)) continue;
      const key = providerKey(providerSourceRaw(source), source.dialect);
      if (providerPlans.has(key)) continue;

      const blocking = providerBlockingReason(extraction.lines);
      if (blocking !== undefined) {
        providerPlans.set(key, { reason: blocking });
        continue;
      }
      const urlLength = input.providerUrlLength?.(source) ?? estimateProviderUrlLength(source);
      if (urlLength > providerUrlMaxLen) {
        providerPlans.set(key, { reason: 'provider URL is too long' });
        continue;
      }
      const name = providerName(providerSourceRaw(source), source.dialect, providerNamesUsed);
      providerPlans.set(key, { name });
      knownProviders.add(name);
    }
  }

  // -----------------------------------------------------------------------
  // 4. Parse sources in request order.
  // -----------------------------------------------------------------------
  const rules: Rule[] = [];
  const providers: RuleProviderSpec[] = [];
  const providerByKey = new Map<string, RuleProviderSpec>();
  const emittedProviderRules = new Set<string>();
  const generatedRuleSetRules = new Set<Rule>();

  for (const { source, extraction } of prepared) {
    const sourceMode = source.group === undefined || source.group === '' ? 'inline' : 'ruleset';
    const ctx: ValidationContext = {
      sourceId: source.sourceId,
      wrapperGroup: source.group,
      mode: sourceMode,
      knownTargets: effectiveTargets,
      knownProviders,
      allowMatch: true,
    };
    const parsed = parseRuleLines(extraction.lines, ctx, {
      maxInputLines: maxCandidates,
    });
    addWarnings(parsed.warnings);
    accepted += parsed.stats.accepted;
    dropped += parsed.stats.dropped;

    if (sourceMode === 'inline') {
      rules.push(...parsed.rules);
      continue;
    }

    const group = source.group as string;
    if (overflowGroups.has(group)) {
      for (const rule of parsed.rules) {
        addWarning(
          toWarning(
            ruleIssue(
              'E_RULE_TARGET_NOT_FOUND',
              `group ${group} could not be auto-created (MAX_GROUPS); rule dropped`,
            ),
            { sourceId: rule.sourceId, line: rule.line, raw: rule.raw },
          ),
        );
      }
      accepted -= parsed.rules.length;
      dropped += parsed.rules.length;
      continue;
    }

    if (input.mode !== 'providers') {
      rules.push(...parsed.rules);
      continue;
    }

    const key = providerKey(providerSourceRaw(source), source.dialect);
    const plan = providerPlans.get(key);
    const urlLength = input.providerUrlLength?.(source) ?? estimateProviderUrlLength(source);
    const eligibility = canBeProvider(
      parsed.rules,
      source,
      urlLength,
      providerUrlMaxLen,
    );

    if (plan?.name === undefined || !eligibility.ok) {
      if (parsed.rules.length > 0) {
        addWarning(
          toWarning(
            ruleIssue(
              'W_PROVIDER_INLINE_FALLBACK',
              `source cannot be used as a provider (${plan?.reason ?? eligibility.reason ?? 'unknown'}); rules are inlined`,
              'warning',
            ),
            { sourceId: source.sourceId, line: 0, raw: '' },
          ),
        );
      }
      rules.push(...parsed.rules);
      continue;
    }

    let spec = providerByKey.get(key);
    if (spec === undefined) {
      spec = {
        ...buildProviderSpec(source, decideBehavior(parsed.rules)),
        name: plan.name,
      };
      providerByKey.set(key, spec);
      providers.push(spec);
    }

    const emittedKey = `${key}\u0000${group}`;
    if (!emittedProviderRules.has(emittedKey)) {
      emittedProviderRules.add(emittedKey);
      const providerRule: Rule = {
        type: 'RULE-SET',
        payload: spec.name,
        target: group,
        params: [],
        raw: `RULE-SET,${spec.name},${group}`,
        line: 0,
        sourceId: source.sourceId,
      };
      generatedRuleSetRules.add(providerRule);
      rules.push(providerRule);
    }
    // Underlying parsed rules stay counted as accepted validation results; they
    // are served through /getruleset rather than inlined.
  }

  // -----------------------------------------------------------------------
  // 5. Template rules (only when overwrite_original_rules=false).
  // -----------------------------------------------------------------------
  if (input.overwriteOriginalRules === false && input.templateRules !== undefined && input.templateRules.length > 0) {
    const ctx: ValidationContext = {
      sourceId: 'template',
      mode: 'template',
      knownTargets: effectiveTargets,
      knownProviders,
      allowMatch: true,
    };
    const parsed = parseRuleLines(input.templateRules, ctx, {
      maxInputLines: maxCandidates,
    });
    addWarnings(parsed.warnings);
    inputCount += parsed.stats.input;
    accepted += parsed.stats.accepted;
    dropped += parsed.stats.dropped;
    rules.push(...parsed.rules);
  }

  // -----------------------------------------------------------------------
  // 6. MATCH policy: exactly one, last (SPEC §5.5).
  // -----------------------------------------------------------------------
  const matches = rules.filter((rule) => rule.type === 'MATCH');
  const nonMatch = rules.filter((rule) => rule.type !== 'MATCH');
  const finalSourceMatch = matches[matches.length - 1];
  if (matches.length > 1) {
    const removed = matches.length - 1;
    for (const duplicate of matches.slice(0, -1)) {
      addWarning(
        toWarning(
          ruleIssue('W_RULE_DUPLICATE_MATCH', 'duplicate MATCH rule is dropped; the last one wins', 'warning'),
          { sourceId: duplicate.sourceId, line: duplicate.line, raw: duplicate.raw },
        ),
      );
    }
    accepted -= removed;
    dropped += removed;
  }

  let matchTarget = input.defaultGroup?.trim() ?? '';
  if (matchTarget === '') matchTarget = 'DIRECT';
  if (!effectiveTargets.has(matchTarget) && !BUILTINS.has(matchTarget)) {
    matchTarget = 'DIRECT';
  }

  let finalMatch: Rule;
  if (finalSourceMatch !== undefined) {
    finalMatch = finalSourceMatch;
  } else {
    finalMatch = {
      type: 'MATCH',
      payload: '',
      target: matchTarget,
      params: [],
      raw: `MATCH,${matchTarget}`,
      line: 0,
      sourceId: syntheticSourceId,
    };
    addWarning(
      toWarning(
        ruleIssue('W_DEFAULT_MATCH_ADDED', 'no MATCH rule was present; one was appended', 'info'),
        { sourceId: syntheticSourceId, line: 0, raw: finalMatch.raw },
      ),
    );
  }

  // -----------------------------------------------------------------------
  // 7. MAX_RULES (MATCH is exempt and always last).
  // -----------------------------------------------------------------------
  let keptNonMatch = nonMatch;
  if (nonMatch.length > maxRules) {
    const removed = nonMatch.length - maxRules;
    keptNonMatch = nonMatch.slice(0, maxRules);
    addWarning(
      toWarning(
        ruleIssue('W_RULE_LIMIT', `${removed} rules dropped because MAX_RULES=${maxRules}`, 'warning', undefined, 'rules'),
        { sourceId: syntheticSourceId, line: 0, raw: '' },
      ),
    );
    // Generated RULE-SET stand-ins are not input lines; only input-derived
    // rules affect the validation stats.
    const removedInputRules = nonMatch
      .slice(maxRules)
      .filter((rule) => !generatedRuleSetRules.has(rule)).length;
    accepted -= removedInputRules;
    dropped += removedInputRules;
  }

  // -----------------------------------------------------------------------
  // 8. Final RULE-SET existence check. A provider name reserved in the
  //    pre-pass but never generated (empty/invalid source) must not leak into
  //    the output.
  // -----------------------------------------------------------------------
  const generatedProviderNames = new Set(providers.map((provider) => provider.name));
  const finalRules: Rule[] = [];
  for (const rule of keptNonMatch) {
    if (
      rule.type === 'RULE-SET' &&
      !generatedProviderNames.has(rule.payload) &&
      !initialKnownProviders.has(rule.payload)
    ) {
      addWarning(
        toWarning(
          ruleIssue('E_RULE_TARGET_NOT_FOUND', `rule-set provider ${rule.payload} does not exist`),
          { sourceId: rule.sourceId, line: rule.line, raw: rule.raw },
        ),
      );
      accepted -= generatedRuleSetRules.has(rule) ? 0 : 1;
      dropped += generatedRuleSetRules.has(rule) ? 0 : 1;
      continue;
    }
    finalRules.push(rule);
  }
  finalRules.push(finalMatch);

  const usedTargets = new Set(finalRules.map((rule) => rule.target));
  const extraGroups = newGroups.filter((group) => usedTargets.has(group));
  for (const group of extraGroups) {
    addWarning(
      toWarning(
        ruleIssue(
          'W_GROUP_AUTO_CREATED',
          `group "${group}" was auto-created for a ruleset target`,
          'warning',
          undefined,
          'groups',
        ),
        { sourceId: syntheticSourceId, line: 0, raw: group },
      ),
    );
  }
  const usedProviderNames = new Set(
    finalRules.filter((rule) => rule.type === 'RULE-SET').map((rule) => rule.payload),
  );
  const finalProviders = providers.filter((provider) => usedProviderNames.has(provider.name));

  const byCode: Record<string, number> = {};
  for (const warning of warnings) {
    byCode[warning.code] = (byCode[warning.code] ?? 0) + 1;
  }

  return {
    rules: finalRules,
    warnings,
    providers: finalProviders,
    stats: {
      input: inputCount,
      accepted: Math.max(0, accepted),
      dropped: Math.max(0, dropped),
      byCode,
    },
    extraGroups,
  };
}
