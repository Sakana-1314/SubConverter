/**
 * Rules-module types and small helpers.
 *
 * Shared domain types (Rule, Warning, RuleType, dialect unions, ...) live in
 * `src/types.ts`; this file only adds the contracts that are internal to the
 * rules pipeline. Every file in `src/rules/` is owned by the `rules` module
 * (docs/ARCHITECTURE.md §5.2, §7.2).
 *
 * Sources:
 * - docs/SPEC.md §4 (rule sources / dialects), §5 (rule registry / validation),
 *   §6.2 (truncation), §7.5 (rule providers), §8 (ACL4SSR INI), §10 (warnings)
 * - docs/ARCHITECTURE.md §6 (data model), §7.2 (rules module contracts)
 */

import type {
  Rule,
  RuleProviderSpec,
  Severity,
  Stage,
  SupportedDialect,
  Warning,
  WarningCode,
} from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SPEC §9.4: rules above this count are truncated with `W_RULE_LIMIT`. */
export const DEFAULT_MAX_RULES = 50_000;

/**
 * Extra candidate lines allowed before MAX_RULES truncation. Bounds memory
 * while preserving small/local fixtures where invalid lines inflate the input
 * count relative to accepted rules.
 */
export const RULE_INPUT_MARGIN = 1_000;

/** SPEC §5.1: rule lines longer than this are rejected with `E_RULE_TOO_LONG`. */
export const MAX_RULE_LINE_LENGTH = 4_096;

/** SPEC §6.2 / §10.2: warning `raw` is truncated to this many characters. */
export const MAX_WARNING_RAW = 160;

/** SPEC §5.7: provider URLs longer than this fall back to inline rules. */
export const PROVIDER_URL_MAX_LEN = 12_000;

// ---------------------------------------------------------------------------
// Warning plumbing
// ---------------------------------------------------------------------------

/**
 * A warning without source/line context. Split/payload helpers are pure and do
 * not know which source line they are working on; `parse.ts` attaches
 * `sourceId`, `line` and `raw` and produces the final `Warning`.
 */
export interface RuleIssue {
  code: WarningCode;
  severity: Severity;
  stage: Stage;
  message: string;
  hint?: string;
}

export function ruleIssue(
  code: WarningCode,
  message: string,
  severity: Severity = 'error',
  hint?: string,
  stage: Stage = 'rules',
): RuleIssue {
  return { code, severity, stage, message, ...(hint === undefined ? {} : { hint }) };
}

/** Escape control characters and cap length for `Warning.raw` (SPEC §2.8). */
export function truncateRaw(value: string, max: number = MAX_WARNING_RAW): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const piece =
      code < 0x20 || code === 0x7f
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : ch;
    if (out.length + piece.length > max) break;
    out += piece;
  }
  return out;
}

export interface WarningContext {
  sourceId: string;
  line: number;
  raw: string;
}

export function toWarning(issue: RuleIssue, ctx: WarningContext): Warning {
  return {
    code: issue.code,
    severity: issue.severity,
    stage: issue.stage,
    message: issue.message,
    source: ctx.sourceId,
    ...(ctx.line > 0 ? { line: ctx.line } : {}),
    raw: truncateRaw(ctx.raw),
    ...(issue.hint === undefined ? {} : { hint: issue.hint }),
  };
}

// ---------------------------------------------------------------------------
// Rule parsing contracts
// ---------------------------------------------------------------------------

/** Where a rule line came from. Controls target requirements (SPEC §5.3). */
export type RuleMode = 'ruleset' | 'template' | 'inline' | 'provider';

export interface ValidationContext {
  /** Stable source id, e.g. `url#1`, `config`, `template`. */
  sourceId: string;
  /** Group supplied by `ruleset=GROUP,SOURCE`; targets are taken from it. */
  wrapperGroup?: string;
  mode: RuleMode;
  /** Group names, node names and built-in targets that may be referenced. */
  knownTargets: Set<string>;
  /** Provider names generated in this request (for `RULE-SET`). */
  knownProviders: Set<string>;
  /** `false` in `/getruleset` provider context. */
  allowMatch: boolean;
}

export interface ExtractedRuleLine {
  /** Rule text exactly as extracted (still needs split/validation). */
  text: string;
  /** 1-based line number in the original source. */
  line: number;
  /**
   * Whether the line was already a typed rule in the source (`DOMAIN,x,...`).
   * Bare entries mapped by `clash-domain` / `clash-ipcidr` / `domain` are
   * marked `false` so tail heuristics do not mistake `DOMA` (a valid bare
   * domain) for a truncated type (SPEC §6.2).
   */
  typed?: boolean;
}

export interface RuleSource {
  /** Stable identifier such as `url#1` / `inline#2` / `config`. */
  sourceId: string;
  /** Decoded source text (UTF-8). */
  text: string;
  /** Dialect after normalization (never `clash-classic`). */
  dialect: SupportedDialect;
  /** `ruleset=GROUP,SOURCE` wrapper group; absent for template/inline text. */
  group?: string;
  /** Provider refresh interval (seconds), from the rule-source third field. */
  interval?: number;
  /** Original source string, used for deterministic provider naming. */
  rawSource?: string;
  /** Alias for `rawSource` (ARCHITECTURE uses `source.raw` for providers). */
  raw?: string;
}

/** Result of `splitRuleLine` (SPEC §5.3). */
export interface SplitRule {
  /** Canonical exact mihomo type. */
  type: string;
  payload: string;
  /** Empty in provider context. */
  target: string;
  /** Only `no-resolve` is ever accepted. */
  params: string[];
  targetPresent: boolean;
  /** Non-fatal findings (aliases, ignored source targets, ignored params). */
  warnings: RuleIssue[];
}

export type SplitOutcome =
  | ({ ok: true } & SplitRule)
  | { ok: false; issue: RuleIssue };

export interface RuleParseSuccess {
  ok: true;
  rule: Rule;
  warnings: Warning[];
}

export interface RuleParseFailure {
  ok: false;
  warnings: Warning[];
}

export type RuleParseResult = RuleParseSuccess | RuleParseFailure;

export interface ParseLinesStats {
  /** Candidate rule lines handed to the parser. */
  input: number;
  /** Lines that produced a `Rule` (before MATCH/limit post-processing). */
  accepted: number;
  /** `input - accepted` at the end of the parse stage. */
  dropped: number;
}

export interface ParseLinesResult {
  rules: Rule[];
  warnings: Warning[];
  stats: ParseLinesStats;
}

// ---------------------------------------------------------------------------
// Dialect contracts
// ---------------------------------------------------------------------------

export interface DialectExtractionStats {
  /** Every entry considered, including entries dropped before parsing. */
  candidates: number;
  /** Entries dropped by the dialect layer (non-string YAML items, ...). */
  dropped: number;
}

export interface DialectExtraction {
  lines: ExtractedRuleLine[];
  warnings: Warning[];
  stats: DialectExtractionStats;
}

/** Parsed content in a known dialect (ARCHITECTURE §7.2.6). */
export interface DialectContent {
  dialect: SupportedDialect;
  value: unknown;
}

export type DialectDetection =
  | { dialect: SupportedDialect; warnings: Warning[] }
  | { error: Warning };

// ---------------------------------------------------------------------------
// buildRules contracts (ARCHITECTURE §7.2.8)
// ---------------------------------------------------------------------------

export interface RuleBuildInput {
  sources: RuleSource[];
  /** Template `rules:` entries (already extracted from YAML by emitter). */
  templateRules?: string[];
  /** Project default is `true` (SPEC §8.2 / ADR-10). */
  overwriteOriginalRules?: boolean;
  mode: 'inline' | 'providers';
  /** Resolved group names, node names and built-in targets. */
  knownTargets: Set<string>;
  /** Provider names already known (usually empty). */
  knownProviders?: Set<string>;
  /** Used for the final catch-all MATCH (SPEC §5.5). */
  defaultGroup?: string;
  /** SPEC §9.4 default 50,000. */
  maxRules?: number;
  /** Source id used for diagnostics about the rules stage itself. */
  sourceId?: string;
  /** How many groups integration may auto-create (SPEC §5.4 / §7.3). */
  maxNewGroups?: number;
  /** Predicted provider URL length for a source (integration knows origin). */
  providerUrlLength?: (source: RuleSource) => number;
  /** Override `PROVIDER_URL_MAX_LEN` (tests). */
  providerUrlMaxLen?: number;
}

export interface RuleBuildStats extends ParseLinesStats {
  /** Real warning totals keyed by code (before any 200-entry collector cap). */
  byCode: Record<string, number>;
}

export interface RuleBuildResult {
  rules: Rule[];
  warnings: Warning[];
  providers: RuleProviderSpec[];
  stats: RuleBuildStats;
  /** Groups referenced by ruleset sources but not in `knownTargets`. */
  extraGroups: string[];
}
