/**
 * Dialect detection and rule-line extraction (SPEC §4).
 *
 * Supported dialects:
 * - `clash-classical` (alias `clash-classic`): YAML `payload:` / `rules:` /
 *   top-level string array; each item is a rule line.
 * - `clash-domain`: YAML payload of bare domains / `.domain` / `+.domain`.
 * - `clash-ipcidr`: YAML payload of CIDRs.
 * - `surge`: `TYPE,VALUE[,policy][,no-resolve]` text lines.
 * - `domain`: bare domain list with `full:` / `domain:` / `keyword:` /
 *   `regexp:` / `include:` prefixes.
 * - `base64`: one level of base64url wrapping, decoded and re-detected.
 *
 * Extraction never validates rule types/payloads; it only produces candidate
 * lines with original line numbers. `parse.ts` is the single validation gate.
 */

import { isAlias, isCollection, isMap, isPair, isScalar, isSeq, parseAllDocuments } from 'yaml';
import type { SupportedDialect, Warning } from '../types';
import { looksLikeCidr, looksLikeDomain, parseCidr } from './payload';
import { resolveRuleType } from './registry';
import { checkDeclaredCount, checkTail, hasFinalNewline } from './truncation';
import {
  ruleIssue,
  toWarning,
  truncateRaw,
  type DialectDetection,
  type DialectExtraction,
  type ExtractedRuleLine,
} from './types';

export const SUPPORTED_DIALECT_VALUES: ReadonlySet<string> = new Set([
  'clash-classical',
  'clash-classic',
  'clash-domain',
  'clash-ipcidr',
  'surge',
  'domain',
  'base64',
]);

export function stripBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function isWholeLineComment(line: string): boolean {
  const text = line.trimStart();
  return text.startsWith('#') || text.startsWith(';') || text.startsWith('//');
}

/** SPEC §6.1: HTML error pages are not rule sources. */
export function looksLikeHtmlErrorPage(text: string): boolean {
  const head = stripBom(text).replace(/^\s+/, '').slice(0, 256).toLowerCase();
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<body')
  );
}

// ---------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export interface Base64TextResult {
  ok: true;
  text: string;
  bytes: number;
}

export interface Base64TextFailure {
  ok: false;
  reason: 'charset' | 'length' | 'utf8' | 'nonprintable' | 'empty';
}

function decodeBase64Bytes(input: string): Uint8Array | Base64TextFailure {
  // Accept standard + URL-safe alphabets, optional padding, and ignore ASCII
  // whitespace introduced by line wrapping. Any other character is rejected.
  const compact = input.replace(/[ \t\r\n\f\v]/g, '');
  if (compact === '') return { ok: false, reason: 'empty' };
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) {
    return { ok: false, reason: 'charset' };
  }
  const padding = compact.indexOf('=');
  if (padding !== -1 && padding < compact.length - 2) {
    return { ok: false, reason: 'charset' };
  }
  const withoutPadding = compact.replace(/=+$/, '');
  if (withoutPadding.includes('=')) return { ok: false, reason: 'charset' };
  if (withoutPadding.length % 4 === 1) return { ok: false, reason: 'length' };

  const std = withoutPadding.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  const out: number[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(padded[i]);
    const c1 = BASE64_ALPHABET.indexOf(padded[i + 1]);
    const c2 = padded[i + 2] === '=' ? -1 : BASE64_ALPHABET.indexOf(padded[i + 2]);
    const c3 = padded[i + 3] === '=' ? -1 : BASE64_ALPHABET.indexOf(padded[i + 3]);
    if (c0 < 0 || c1 < 0) return { ok: false, reason: 'charset' };
    out.push(((c0 << 2) | (c1 >> 4)) & 0xff);
    if (c2 >= 0) out.push(((c1 << 4) | (c2 >> 2)) & 0xff);
    if (c3 >= 0) out.push(((c2 << 6) | c3) & 0xff);
  }
  return Uint8Array.from(out);
}

function printableRatio(text: string): number {
  let total = 0;
  let printable = 0;
  for (const ch of text) {
    total += 1;
    const code = ch.codePointAt(0) ?? 0;
    const isControl = (code < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t') || code === 0x7f;
    if (!isControl) printable += 1;
  }
  return total === 0 ? 0 : printable / total;
}

/** Strict-ish base64url decoder used by dialect detection/extraction. */
export function decodeBase64Text(input: string): Base64TextResult | Base64TextFailure {
  const bytes = decodeBase64Bytes(input);
  if (!(bytes instanceof Uint8Array)) return bytes;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, reason: 'utf8' };
  }
  if (text.includes('\u0000')) return { ok: false, reason: 'nonprintable' };
  if (printableRatio(text) < 0.9) return { ok: false, reason: 'nonprintable' };
  return { ok: true, text, bytes: bytes.length };
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineAtOffset(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function rawAtLine(text: string, line: number): string {
  const lines = normalizeNewlines(text).split('\n');
  return lines[line - 1] ?? '';
}

interface ParsedYamlOk {
  ok: true;
  doc: NonNullable<ReturnType<typeof parseAllDocuments>[number]>;
  lineStarts: number[];
}

interface ParsedYamlFailure {
  ok: false;
  warnings: Warning[];
}

/**
 * `yaml@2.9` exposes `maxAliasCount` on `toJS()`, not on the parser. We never
 * call `toJS()` on untrusted input (we walk the AST), so we implement the same
 * budget by counting `Alias` nodes. This also gives a hard node-count cap.
 */
function exceedsAliasBudget(root: unknown): boolean {
  const stack: unknown[] = [root];
  let aliases = 0;
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    visited += 1;
    if (visited > 500_000) return true;
    if (isAlias(current)) {
      aliases += 1;
      if (aliases > 50) return true;
      continue;
    }
    if (isPair(current)) {
      stack.push(current.key, current.value);
      continue;
    }
    if (isCollection(current)) {
      for (const item of current.items) stack.push(item);
    }
  }
  return false;
}

function parseYamlForRules(
  text: string,
  sourceId: string,
): ParsedYamlOk | ParsedYamlFailure {
  const lineStarts = buildLineStarts(text);
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(text, {
      schema: 'core',
      merge: false,
      uniqueKeys: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'YAML parse error';
    return {
      ok: false,
      warnings: [
        toWarning(ruleIssue('E_YAML_PARSE', `YAML parse failed: ${message}`, 'error', undefined, 'yaml'), {
          sourceId,
          line: 1,
          raw: text,
        }),
      ],
    };
  }

  // A trailing `---` may produce an empty second document; only non-empty
  // documents count as multi-document input (SPEC §3.3).
  const nonEmptyDocs = docs.filter((doc) => doc.contents !== null && doc.contents !== undefined);
  if (nonEmptyDocs.length > 1) {
    return {
      ok: false,
      warnings: [
        toWarning(
          ruleIssue('E_YAML_MULTI_DOC', 'rule source contains multiple YAML documents', 'error', undefined, 'yaml'),
          { sourceId, line: 1, raw: text },
        ),
      ],
    };
  }

  const doc = nonEmptyDocs[0] ?? docs[0];
  if (doc === undefined) {
    return {
      ok: false,
      warnings: [toWarning(ruleIssue('E_YAML_PARSE', 'YAML document is empty', 'error', undefined, 'yaml'), { sourceId, line: 1, raw: '' })],
    };
  }

  if (doc.errors.length > 0) {
    const error = doc.errors[0];
    const pos = error.linePos?.[0];
    const line = pos?.line ?? 1;
    return {
      ok: false,
      warnings: [
        toWarning(
          ruleIssue('E_YAML_PARSE', `YAML parse failed: ${error.message}`, 'error', undefined, 'yaml'),
          { sourceId, line, raw: rawAtLine(text, line) },
        ),
      ],
    };
  }

  const unresolved = doc.warnings.find((warning) =>
    warning.message.toLowerCase().includes('unresolved tag'),
  );
  if (unresolved !== undefined) {
    const pos = unresolved.linePos?.[0];
    const line = pos?.line ?? 1;
    return {
      ok: false,
      warnings: [
        toWarning(
          ruleIssue('E_YAML_TAG', 'custom YAML tags are not allowed', 'error', undefined, 'yaml'),
          { sourceId, line, raw: rawAtLine(text, line) },
        ),
      ],
    };
  }

  if (exceedsAliasBudget(doc.contents)) {
    return {
      ok: false,
      warnings: [
        toWarning(
          ruleIssue(
            'E_YAML_PARSE',
            'YAML alias count exceeds the allowed budget (50)',
            'error',
            undefined,
            'yaml',
          ),
          { sourceId, line: 1, raw: text },
        ),
      ],
    };
  }

  return { ok: true, doc, lineStarts };
}

interface YamlEntry {
  text: string;
  /** 1-based line in the YAML source. */
  line: number;
}

interface YamlEntryResult {
  entries: YamlEntry[];
  candidates: number;
  warnings: Warning[];
}

function extractYamlEntries(
  doc: ParsedYamlOk['doc'],
  text: string,
  sourceId: string,
  lineStarts: number[],
): YamlEntryResult {
  const entries: YamlEntry[] = [];
  const warnings: Warning[] = [];
  const rawLines = normalizeNewlines(text).split('\n');
  let candidates = 0;

  const addItem = (item: unknown): void => {
    candidates += 1;
    const node = item as { range?: [number, number, number]; value?: unknown };
    const offset = Array.isArray(node.range) ? node.range[0] : 0;
    const line = lineAtOffset(lineStarts, offset);
    const raw = rawLines[line - 1] ?? '';
    if (!isScalar(item) || typeof (item as { value?: unknown }).value !== 'string') {
      warnings.push(
        toWarning(
          ruleIssue('E_RULE_BAD_PAYLOAD', 'rule entry is not a string', 'error'),
          { sourceId, line, raw: truncateRaw(raw) },
        ),
      );
      return;
    }
    const value = (item as { value: string }).value;
    if (value.includes('\n') || value.includes('\r')) {
      warnings.push(
        toWarning(
          ruleIssue('E_RULE_BAD_PAYLOAD', 'rule entry contains a line break', 'error'),
          { sourceId, line, raw: truncateRaw(raw) },
        ),
      );
      return;
    }
    entries.push({ text: value, line });
  };

  const contents = doc.contents;
  if (isSeq(contents)) {
    for (const item of contents.items) addItem(item);
    return { entries, candidates, warnings };
  }

  if (isMap(contents)) {
    let seq: unknown;
    if (doc.has('payload')) {
      seq = doc.get('payload', true);
    } else if (doc.has('rules')) {
      seq = doc.get('rules', true);
    } else {
      return { entries, candidates, warnings };
    }
    if (!isSeq(seq)) {
      const line = lineAtOffset(lineStarts, (contents as { range?: [number, number, number] }).range?.[0] ?? 0);
      warnings.push(
        toWarning(
          ruleIssue('E_YAML_PARSE', 'payload/rules must be a YAML array', 'error', undefined, 'yaml'),
          { sourceId, line, raw: rawAtLine(text, line) },
        ),
      );
      return { entries, candidates, warnings };
    }
    for (const item of seq.items) addItem(item);
    return { entries, candidates, warnings };
  }

  return { entries, candidates, warnings };
}

// ---------------------------------------------------------------------------
// Dialect detection
// ---------------------------------------------------------------------------

/** First non-comment, non-empty line of a text source. */
function firstRuleLine(text: string): string | undefined {
  for (const line of normalizeNewlines(stripBom(text)).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || isWholeLineComment(trimmed)) continue;
    return trimmed;
  }
  return undefined;
}

interface AutoDetectOptions {
  allowBase64: boolean;
}

function autoDetect(
  text: string,
  options: AutoDetectOptions,
  maxEntries = Number.POSITIVE_INFINITY,
): SupportedDialect {
  if (text.trim() === '') return 'domain';

  // 2. YAML payload/rules or a top-level string array. Bound the text before
  //    parseAllDocuments so a huge adversarial YAML cannot build a full AST.
  const hasRulesKey = /^[ \t]*(?:payload|rules)[ \t]*:/m.test(text);
  const limited = limitClashYamlText(text, maxEntries);
  const tooManyPlainLines =
    Number.isFinite(maxEntries) && countLinesUpTo(text, maxEntries + 1) > maxEntries;
  const shouldParseYaml =
    !limited.flowRejected &&
    (!tooManyPlainLines || hasRulesKey || limited.truncated);
  const parsed = shouldParseYaml
    ? parseYamlForRules(limited.text, 'auto')
    : ({ ok: false } as const);
  if (parsed.ok) {
    const contents = parsed.doc.contents;
    let seqItems: unknown[] | undefined;
    if (isSeq(contents)) {
      seqItems = contents.items;
    } else if (isMap(contents) && parsed.doc.has('payload')) {
      const seq = parsed.doc.get('payload', true);
      if (isSeq(seq)) seqItems = seq.items;
    } else if (isMap(contents) && parsed.doc.has('rules')) {
      const seq = parsed.doc.get('rules', true);
      if (isSeq(seq)) seqItems = seq.items;
    }

    if (seqItems !== undefined) {
      const strings: string[] = [];
      for (const item of seqItems) {
        if (isScalar(item) && typeof (item as { value?: unknown }).value === 'string') {
          strings.push((item as { value: string }).value);
        }
      }
      if (strings.length > 0 && strings.every((value) => !value.includes(','))) {
        const allDomains = strings.every((value) => looksLikeDomain(value));
        const allCidrs = strings.every((value) => looksLikeCidr(value));
        if (allCidrs && !allDomains) return 'clash-ipcidr';
        if (allDomains && !allCidrs) return 'clash-domain';
      }
      return 'clash-classical';
    }

    if (isSeq(contents) || isMap(contents)) {
      // YAML but no rules: still a classical-shaped source so extraction can
      // report an empty source rather than misclassifying it as a domain list.
      return 'clash-classical';
    }
  } else if (hasRulesKey) {
    return 'clash-classical';
  }

  // 3. First non-comment line looks like a typed Surge/Clash rule.
  const first = firstRuleLine(text);
  if (first !== undefined && first.includes(',')) {
    const token = first.slice(0, first.indexOf(',')).trim();
    if (token !== '') {
      const resolved = resolveRuleType(token);
      if (resolved.type !== null || resolved.unsupported) return 'surge';
    }
  }

  // 4. Strict base64url wrapper (one level).
  if (options.allowBase64) {
    const decoded = decodeBase64Text(text);
    if (decoded.ok) return 'base64';
  }

  // 5. Bare domain list.
  return 'domain';
}

export function normalizeDialectName(raw: string): {
  dialect: SupportedDialect | 'auto';
  warnings: Warning[];
  error?: Warning;
} {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'auto') return { dialect: 'auto', warnings: [] };
  if (value === 'clash-classic') {
    return {
      dialect: 'clash-classical',
      warnings: [
        {
          code: 'W_DIALECT_ALIAS',
          severity: 'info',
          stage: 'rules',
          message: 'dialect clash-classic is an alias of clash-classical',
        },
      ],
    };
  }
  if (value === 'clash-classical') return { dialect: 'clash-classical', warnings: [] };
  if (value === 'clash-domain' || value === 'clash-ipcidr' || value === 'surge' || value === 'domain' || value === 'base64') {
    return { dialect: value, warnings: [] };
  }
  return {
    dialect: 'auto',
    warnings: [],
    error: {
      code: 'W_DIALECT_UNSUPPORTED',
      severity: 'warning',
      stage: 'rules',
      message: `dialect ${value} is not supported`,
      hint: 'supported dialects: clash-classical, clash-domain, clash-ipcidr, surge, domain, base64',
    },
  };
}

/**
 * Detect the dialect of a rule source.
 * `contentType` is intentionally ignored: upstream Content-Type is untrusted
 * (SPEC §4.2).
 */
export interface DetectDialectOptions {
  /** Bound auto-detection YAML parsing (SPEC §9.4 MAX_RULES). */
  maxEntries?: number;
}

export function detectDialect(
  content: string,
  explicit?: string,
  _contentType?: string | null,
  options: DetectDialectOptions = {},
): DialectDetection {
  const text = stripBom(content);

  if (looksLikeHtmlErrorPage(text)) {
    return {
      error: {
        code: 'E_FETCH_HTML',
        severity: 'error',
        stage: 'fetch',
        message: 'rule source looks like an HTML error page',
      },
    };
  }

  if (explicit !== undefined && explicit.trim() !== '') {
    const normalized = normalizeDialectName(explicit);
    if (normalized.error !== undefined) return { error: normalized.error };
    if (normalized.dialect !== 'auto') {
      return { dialect: normalized.dialect, warnings: normalized.warnings };
    }
    return {
      dialect: autoDetect(text, { allowBase64: true }, options.maxEntries),
      warnings: normalized.warnings,
    };
  }

  return {
    dialect: autoDetect(text, { allowBase64: true }, options.maxEntries),
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractRuleLinesOptions {
  /**
   * Maximum candidate lines/entries to materialize. Used by integration to
   * bound memory before parsing (SPEC §9.4 MAX_RULES); omitted in unit tests.
   */
  maxLines?: number;
}

function addRuleLimitWarning(
  warnings: Warning[],
  sourceId: string,
  maxLines: number,
): void {
  warnings.push(
    toWarning(
      ruleIssue(
        'W_RULE_LIMIT',
        `rule source exceeds ${maxLines} candidate lines/entries; the rest were ignored`,
        'warning',
      ),
      { sourceId, line: 0, raw: '' },
    ),
  );
}

/** Iterate lines without allocating the full split array. */
function* iterateLines(text: string): Generator<{ line: string; lineNo: number }> {
  let start = 0;
  let lineNo = 1;
  for (;;) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      yield { line: text.slice(start), lineNo };
      return;
    }
    yield { line: text.slice(start, newline), lineNo };
    start = newline + 1;
    lineNo += 1;
  }
}

function countCommasUpTo(text: string, limit: number): number {
  let count = 0;
  let index = text.indexOf(',');
  while (index !== -1) {
    count += 1;
    if (count > limit) return count;
    index = text.indexOf(',', index + 1);
  }
  return count;
}

function countLinesUpTo(text: string, limit: number): number {
  let count = 1;
  let index = text.indexOf('\n');
  while (index !== -1) {
    count += 1;
    if (count > limit) return count;
    index = text.indexOf('\n', index + 1);
  }
  return count;
}

interface LimitedYamlText {
  text: string;
  truncated: boolean;
  /** A small flow-style document with too many entries; fail closed. */
  flowRejected: boolean;
}

/**
 * Truncate a block-sequence YAML document before the parser builds its AST.
 * Cuts only at the start of a same-indent `- ` entry, so the prefix remains a
 * valid YAML sequence. Flow-style documents (no block entries) with too many
 * commas are rejected instead of parsed.
 */
function limitClashYamlText(text: string, maxEntries: number): LimitedYamlText {
  if (!Number.isFinite(maxEntries)) return { text, truncated: false, flowRejected: false };
  if (maxEntries <= 0) return { text: '', truncated: true, flowRejected: false };

  let firstIndent = -1;
  let count = 0;
  let cut = -1;
  let lineStart = 0;
  for (;;) {
    const newline = text.indexOf('\n', lineStart);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, end);
    const match = /^([ \t]*)-[ \t]/.exec(line);
    if (match !== null) {
      const indent = (match[1] as string).length;
      if (firstIndent === -1) firstIndent = indent;
      if (indent === firstIndent) {
        count += 1;
        if (count > maxEntries) {
          cut = lineStart;
          break;
        }
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  if (cut !== -1) {
    return { text: text.slice(0, cut), truncated: true, flowRejected: false };
  }
  if (firstIndent === -1 && countCommasUpTo(text, maxEntries) > maxEntries) {
    return { text: '', truncated: true, flowRejected: true };
  }
  return { text, truncated: false, flowRejected: false };
}

function hasFatalExtractionWarning(warnings: Warning[]): boolean {
  return warnings.some(
    (warning) =>
      warning.code === 'E_BASE64_INVALID' ||
      warning.code === 'E_YAML_PARSE' ||
      warning.code === 'E_YAML_MULTI_DOC' ||
      warning.code === 'E_YAML_TAG' ||
      warning.code === 'E_FETCH_HTML',
  );
}

function addEmptyWarning(
  lines: ExtractedRuleLine[],
  warnings: Warning[],
  sourceId: string,
): void {
  if (lines.length !== 0 || hasFatalExtractionWarning(warnings)) return;
  if (warnings.some((warning) => warning.code === 'W_RULESET_EMPTY')) return;
  warnings.push(
    toWarning(
      ruleIssue('W_RULESET_EMPTY', 'rule source is empty or all entries were filtered', 'warning'),
      { sourceId, line: 0, raw: '' },
    ),
  );
}

function emptyExtraction(warnings: Warning[]): DialectExtraction {
  return {
    lines: [],
    warnings,
    stats: { candidates: 0, dropped: 0 },
  };
}

function extractTextLines(
  content: string,
  sourceId: string,
  dialect: 'surge' | 'domain',
  maxLines = Number.POSITIVE_INFINITY,
): DialectExtraction {
  const text = normalizeNewlines(stripBom(content));
  const lines: ExtractedRuleLine[] = [];
  const warnings: Warning[] = [];
  let candidates = 0;
  let dropped = 0;
  let truncated = false;

  for (const { line: rawLine, lineNo } of iterateLines(text)) {
    const line = stripBomFromLine(rawLine).trim();
    if (line === '' || isWholeLineComment(line)) continue;
    if (candidates >= maxLines) {
      truncated = true;
      break;
    }
    candidates += 1;

    if (dialect === 'surge') {
      lines.push({ text: line, line: lineNo, typed: true });
      continue;
    }

    // domain dialect prefixes (SPEC §4.3)
    const prefixed = /^(full|domain|keyword|regexp|include):(.*)$/i.exec(line);
    if (prefixed !== null) {
      const prefix = prefixed[1].toLowerCase();
      const value = prefixed[2].trim();
      if (prefix === 'include') {
        dropped += 1;
        warnings.push(
          toWarning(
            ruleIssue(
              'W_RULESET_TYPE_FILTERED',
              'include: directive is not supported in a domain list',
              'warning',
            ),
            { sourceId, line: lineNo, raw: line },
          ),
        );
        continue;
      }
      // A comma can only be a separator here, never part of a domain. Regex
      // payloads are the exception: commas are valid regex text.
      if (prefix !== 'regexp' && /[,\uFF0C]/.test(value)) {
        dropped += 1;
        warnings.push(
          toWarning(
            ruleIssue('E_RULE_BAD_DOMAIN', 'domain entry contains a comma; line dropped', 'error'),
            { sourceId, line: lineNo, raw: line },
          ),
        );
        continue;
      }
      const type =
        prefix === 'full'
          ? 'DOMAIN'
          : prefix === 'keyword'
            ? 'DOMAIN-KEYWORD'
            : prefix === 'regexp'
              ? 'DOMAIN-REGEX'
              : 'DOMAIN-SUFFIX';
      lines.push({ text: `${type},${value}`, line: lineNo, typed: false });
      continue;
    }

    if (/[,\uFF0C]/.test(line)) {
      dropped += 1;
      warnings.push(
        toWarning(
          ruleIssue('E_RULE_BAD_DOMAIN', 'domain entry contains a comma; line dropped', 'error'),
          { sourceId, line: lineNo, raw: line },
        ),
      );
      continue;
    }

    lines.push({ text: `DOMAIN-SUFFIX,${line}`, line: lineNo, typed: false });
  }

  if (truncated) addRuleLimitWarning(warnings, sourceId, maxLines);
  if (dialect === 'domain' && !truncated) {
    warnings.push(...checkDeclaredCount(text, candidates, sourceId));
  }
  addEmptyWarning(lines, warnings, sourceId);

  return { lines, warnings, stats: { candidates, dropped } };
}

function stripBomFromLine(line: string): string {
  return line.startsWith('\uFEFF') ? line.slice(1) : line;
}

function extractClash(
  content: string,
  dialect: 'clash-classical' | 'clash-domain' | 'clash-ipcidr',
  sourceId: string,
  maxLines = Number.POSITIVE_INFINITY,
): DialectExtraction {
  const text = stripBom(content);
  if (text.trim() === '') {
    const emptyWarnings: Warning[] = [];
    addEmptyWarning([], emptyWarnings, sourceId);
    return { lines: [], warnings: emptyWarnings, stats: { candidates: 0, dropped: 0 } };
  }
  const limited = limitClashYamlText(text, maxLines);
  if (limited.flowRejected || (limited.truncated && limited.text.trim() === '')) {
    const warnings: Warning[] = [];
    addRuleLimitWarning(warnings, sourceId, maxLines);
    return { lines: [], warnings, stats: { candidates: 0, dropped: 0 } };
  }
  const parsed = parseYamlForRules(limited.text, sourceId);
  if (!parsed.ok) {
    return { lines: [], warnings: parsed.warnings, stats: { candidates: 0, dropped: 0 } };
  }
  const extracted = extractYamlEntries(parsed.doc, limited.text, sourceId, parsed.lineStarts);
  const lines: ExtractedRuleLine[] = [];
  const warnings: Warning[] = [...extracted.warnings];
  if (limited.truncated) addRuleLimitWarning(warnings, sourceId, maxLines);
  const typedCandidates: ExtractedRuleLine[] = [];
  let dropped = extracted.candidates - extracted.entries.length;

  for (const entry of extracted.entries) {
    const value = entry.text.trim();
    if (dialect === 'clash-classical') {
      lines.push({ text: entry.text, line: entry.line, typed: true });
      continue;
    }

    // Typed entries are invalid in bare domain/CIDR payloads, but they still
    // participate in the tail heuristic (SPEC §6.2 mentions typed elements in
    // clash-domain/clash-ipcidr).
    if (value.includes(',')) {
      typedCandidates.push({ text: entry.text, line: entry.line, typed: true });
    }

    if (value === '') {
      dropped += 1;
      warnings.push(
        toWarning(ruleIssue('E_RULE_EMPTY_PAYLOAD', 'empty provider entry', 'error'), {
          sourceId,
          line: entry.line,
          raw: entry.text,
        }),
      );
      continue;
    }

    if (dialect === 'clash-ipcidr') {
      const cidr = parseCidr(value, 'any');
      if (cidr === null) {
        dropped += 1;
        warnings.push(
          toWarning(ruleIssue('E_RULE_BAD_CIDR', 'provider entry is not a CIDR', 'error'), {
            sourceId,
            line: entry.line,
            raw: entry.text,
          }),
        );
        continue;
      }
      lines.push({
        text: `${cidr.version === 4 ? 'IP-CIDR' : 'IP-CIDR6'},${cidr.canonical}`,
        line: entry.line,
        typed: false,
      });
      continue;
    }

    // clash-domain: bare domain, `.domain`, `+.domain`.
    if (value.includes(',')) {
      dropped += 1;
      warnings.push(
        toWarning(
          ruleIssue(
            'W_RULESET_TYPE_FILTERED',
            'typed entry is not valid in a clash-domain provider',
            'warning',
          ),
          { sourceId, line: entry.line, raw: entry.text },
        ),
      );
      continue;
    }
    let payload = value;
    let type = 'DOMAIN';
    if (payload.startsWith('+.')) {
      type = 'DOMAIN-SUFFIX';
      payload = payload.slice(2);
    } else if (payload.startsWith('.')) {
      type = 'DOMAIN-SUFFIX';
      payload = payload.slice(1);
    }
    lines.push({ text: `${type},${payload}`, line: entry.line, typed: false });
  }

  if (typedCandidates.length > 0 && !hasFinalNewline(limited.text)) {
    warnings.push(
      ...checkTail({
        rawText: limited.text,
        lines: typedCandidates,
        hadFinalNewline: false,
        dialect,
        sourceId,
      }),
    );
  }

  if (lines.length === 0) {
    addEmptyWarning(lines, warnings, sourceId);
  }

  return {
    lines,
    warnings,
    stats: { candidates: extracted.candidates, dropped },
  };
}

function extractBase64(
  content: string,
  sourceId: string,
  options: ExtractRuleLinesOptions = {},
): DialectExtraction {
  const decoded = decodeBase64Text(content);
  if (!decoded.ok) {
    const message =
      decoded.reason === 'utf8'
        ? 'base64 payload is not valid UTF-8'
        : decoded.reason === 'nonprintable'
          ? 'base64 payload does not look like text'
          : 'base64 payload is invalid';
    return {
      lines: [],
      warnings: [
        toWarning(ruleIssue('E_BASE64_INVALID', message, 'error'), {
          sourceId,
          line: 1,
          raw: content,
        }),
      ],
      stats: { candidates: 0, dropped: 0 },
    };
  }

  const detected = detectDialect(decoded.text, undefined, null, {
    maxEntries: options.maxLines,
  });
  if ('error' in detected) {
    return { lines: [], warnings: [detected.error], stats: { candidates: 0, dropped: 0 } };
  }
  if (detected.dialect === 'base64') {
    // SPEC §4.2: at most one base64 layer.
    return {
      lines: [],
      warnings: [
        toWarning(ruleIssue('E_BASE64_INVALID', 'nested base64 is not decoded twice', 'error'), {
          sourceId,
          line: 1,
          raw: content,
        }),
      ],
      stats: { candidates: 0, dropped: 0 },
    };
  }

  const inner = extractRuleLines(decoded.text, detected.dialect, sourceId, options);
  const innerTail = checkTail({
    rawText: decoded.text,
    lines: inner.lines,
    hadFinalNewline: hasFinalNewline(decoded.text),
    dialect: detected.dialect,
    sourceId,
  });
  return {
    lines: inner.lines,
    warnings: [
      {
        code: 'W_INPUT_BASE64_DETECTED',
        severity: 'info',
        stage: 'decode',
        message: 'rule source was base64-decoded',
        source: sourceId,
      },
      ...detected.warnings,
      ...inner.warnings,
      ...innerTail,
    ],
    stats: inner.stats,
  };
}

/**
 * Extract candidate rule lines from a source in a known dialect.
 * Line numbers always refer to the original (decoded, for base64) text.
 */
export function extractRuleLines(
  content: string,
  dialect: SupportedDialect,
  sourceId: string,
  options: ExtractRuleLinesOptions = {},
): DialectExtraction {
  // SPEC §3.1: NUL bytes mean this is not a text rule source.
  if (content.includes('\u0000')) {
    return {
      lines: [],
      warnings: [
        {
          code: 'E_UTF8_INVALID',
          severity: 'error',
          stage: 'decode',
          message: 'rule source contains a NUL byte',
          source: sourceId,
        },
      ],
      stats: { candidates: 0, dropped: 0 },
    };
  }

  if (looksLikeHtmlErrorPage(content)) {
    return {
      lines: [],
      warnings: [
        {
          code: 'E_FETCH_HTML',
          severity: 'error',
          stage: 'fetch',
          message: 'rule source looks like an HTML error page',
          source: sourceId,
          line: 1,
          raw: truncateRaw(content),
        },
      ],
      stats: { candidates: 0, dropped: 0 },
    };
  }

  switch (dialect) {
    case 'base64':
      return extractBase64(content, sourceId, options);
    case 'clash-classical':
    case 'clash-domain':
    case 'clash-ipcidr':
      return extractClash(content, dialect, sourceId, options.maxLines);
    case 'surge':
      return extractTextLines(content, sourceId, 'surge', options.maxLines);
    case 'domain':
      return extractTextLines(content, sourceId, 'domain', options.maxLines);
    default:
      return emptyExtraction([]);
  }
}
