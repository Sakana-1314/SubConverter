/**
 * `/getruleset` conversion pipeline (SPEC §2.7).
 *
 * Reuses the rules module's dialect extraction/parser and exact type -> payload
 * mapping. Network failures remain HTTP errors; empty/fully-filtered content
 * returns a 200 placeholder payload so mihomo can still load the provider.
 */

import {
  buildRulesetDocument,
  detectDialect,
  extractRuleLines,
  MAX_RULESET_OUTPUT_BYTES,
  normalizeDialectName,
  parseRuleLines,
  RULE_INPUT_MARGIN,
} from '../rules/index';
import type { RulesetType, Warning } from '../types';
import type { RulesetParams } from '../http/params';
import { AppError } from './errors';
import type { EnvPolicy } from './env';
import { SourceLoadError, SourceLoader, type FetchServiceDeps } from './fetch';
import { WarningCollector } from './warnings';

export interface GetRulesetResult {
  yaml: string;
  warnings: Warning[];
  warningCount: number;
  warningCodes: string[];
  placeholder: boolean;
  stats: {
    input: number;
    accepted: number;
    dropped: number;
    bytesIn: number;
    bytesOut: number;
    warnings: number;
    warningCodes: string[];
  };
}

export async function runGetRuleset(
  params: RulesetParams,
  policy: EnvPolicy,
  deps: FetchServiceDeps,
  parameterWarnings: readonly Warning[] = [],
): Promise<GetRulesetResult> {
  const collector = new WarningCollector();
  collector.addAll(parameterWarnings);
  const loader = new SourceLoader(policy, deps);

  let text: string;
  try {
    const loaded = await loader.load(
      { raw: params.sourceRaw, label: 'getruleset', sourceId: 'getruleset' },
      'ruleset',
    );
    text = loaded.text;
  } catch (error) {
    if (error instanceof SourceLoadError) throw error.appError;
    throw error;
  }

  let explicit: string | undefined;
  if (params.dialect !== 'auto') {
    const normalized = normalizeDialectName(params.dialect);
    if (normalized.error !== undefined) {
      throw new AppError('invalid_source', normalized.error.message);
    }
    collector.addAll(normalized.warnings);
    if (normalized.dialect !== 'auto') explicit = normalized.dialect;
  }

  const detected = detectDialect(text, explicit, undefined, {
    maxEntries: policy.maxRules,
  });
  if ('error' in detected) {
    if (detected.error.code === 'E_FETCH_HTML') {
      throw new AppError('upstream_status', detected.error.message);
    }
    throw new AppError('invalid_source', detected.error.message);
  }
  collector.addAll(detected.warnings);

  const maxInputLines = policy.maxRules + RULE_INPUT_MARGIN;
  const extraction = extractRuleLines(text, detected.dialect, 'getruleset', {
    maxLines: maxInputLines,
  });
  collector.addAll(extraction.warnings);

  const parsed = parseRuleLines(extraction.lines, {
    sourceId: 'getruleset',
    mode: 'provider',
    knownTargets: new Set<string>(),
    knownProviders: new Set<string>(),
    allowMatch: false,
  }, { maxInputLines });
  collector.addAll(parsed.warnings);

  const document = buildRulesetDocument(parsed.rules, params.type as RulesetType, 'getruleset', {
    maxItems: policy.maxRules,
    maxBytes: MAX_RULESET_OUTPUT_BYTES,
  });
  collector.addAll(document.warnings);

  const bytesOut = new TextEncoder().encode(document.yaml).length;
  const stats = {
    input: parsed.stats.input,
    accepted: parsed.stats.accepted,
    dropped: parsed.stats.dropped,
    bytesIn: loader.bytesIn,
    bytesOut,
    warnings: collector.count,
    warningCodes: collector.codes(),
  };

  return {
    yaml: document.yaml,
    warnings: collector.toJSON(),
    warningCount: collector.count,
    warningCodes: collector.codes(),
    placeholder: document.placeholder,
    stats,
  };
}
