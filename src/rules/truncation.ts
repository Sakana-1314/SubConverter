/**
 * Tail truncation and declared-count checks (SPEC §6.2).
 *
 * The API deliberately receives the raw text, the extracted lines AND the
 * "had final newline" flag: a `lines[]` array alone cannot tell whether the
 * file lacked its final newline (review P0-3).
 *
 * This module only produces warnings; it never removes a line. `parse.ts`
 * rejects the offending line on its own (missing target / empty payload).
 */

import type { SupportedDialect, Warning } from '../types';
import {
  isStrictTypePrefix,
  isTypeOrAliasToken,
  TYPED_DIALECTS,
} from './registry';
import {
  ruleIssue,
  toWarning,
  truncateRaw,
  type ExtractedRuleLine,
} from './types';

export function hasFinalNewline(text: string): boolean {
  return /(?:\r\n|\r|\n)$/.test(text);
}

function isCommentLine(line: string): boolean {
  const text = line.trimStart();
  return text.startsWith('#') || text.startsWith(';') || text.startsWith('//');
}

function lastRawLine(rawText: string): { text: string; line: number } {
  let end = rawText.length;
  // A final newline produces an empty trailing line; skip it.
  while (end > 0) {
    const ch = rawText.charCodeAt(end - 1);
    if (ch !== 0x0a && ch !== 0x0d) break;
    end -= 1;
  }
  if (end === 0) return { text: '', line: 1 };
  const start = rawText.lastIndexOf('\n', end - 1) + 1;
  let line = 1;
  for (let index = 0; index < start; index += 1) {
    if (rawText.charCodeAt(index) === 0x0a) line += 1;
  }
  let text = rawText.slice(start, end);
  if (text.endsWith('\r')) text = text.slice(0, -1);
  return { text, line };
}

function isTruncatedTypedTail(text: string): boolean {
  const value = text.trim();
  if (value === '') return false;
  if (value.endsWith(',')) return true;
  if (value.includes(',')) return false;
  // "Only a type token" (`DOMAIN`) or a strict prefix (`DOMA`, `DOMAIN-SUFFI`).
  return isTypeOrAliasToken(value) || isStrictTypePrefix(value);
}

function rawLineForWarning(input: {
  rawText: string;
  lines: ReadonlyArray<string | ExtractedRuleLine>;
  line: number;
  text: string;
}): string {
  let start = 0;
  for (let current = 1; current < input.line; current += 1) {
    const newline = input.rawText.indexOf('\n', start);
    if (newline === -1) return input.text;
    start = newline + 1;
  }
  let end = input.rawText.indexOf('\n', start);
  if (end === -1) end = input.rawText.length;
  let raw = input.rawText.slice(start, end);
  if (raw.endsWith('\r')) raw = raw.slice(0, -1);
  return raw;
}

export interface CheckTailInput {
  /** Original source text (before BOM stripping is fine; we trim it). */
  rawText: string;
  /** Extracted rule lines, in source order. */
  lines: ReadonlyArray<string | ExtractedRuleLine>;
  hadFinalNewline: boolean;
  dialect: SupportedDialect;
  sourceId: string;
}

/**
 * Typed dialects: flag a final line that looks like a truncated rule when the
 * file has no final newline. Domain dialect uses declared counts and the
 * whitespace-tail heuristic instead (SPEC §6.2).
 */
export function checkTail(input: CheckTailInput): Warning[] {
  const warnings: Warning[] = [];
  const { dialect, sourceId } = input;

  if (dialect === 'domain') {
    if (!input.hadFinalNewline) {
      const last = lastRawLine(input.rawText);
      if (last.text.length > 0 && /^[ \t]+$/.test(last.text)) {
        warnings.push(
          toWarning(
            ruleIssue(
              'W_TRUNCATED_TAIL_SUSPECT',
              'source has no final newline and its last line is whitespace only',
              'warning',
              'the source may be truncated',
            ),
            { sourceId, line: last.line, raw: last.text },
          ),
        );
      }
    }
    return warnings;
  }

  if (!TYPED_DIALECTS.has(dialect) || input.hadFinalNewline) return warnings;

  // For clash-domain/clash-ipcidr only already-typed entries participate.
  type Entry = { text: string; line: number };
  const typedEntries: Entry[] = [];
  for (let index = 0; index < input.lines.length; index += 1) {
    const entry = input.lines[index];
    const text = typeof entry === 'string' ? entry : entry.text;
    const line = typeof entry === 'string' ? index + 1 : entry.line;
    const typed = typeof entry === 'string' ? true : entry.typed !== false;
    if (!typed) continue;
    if (text.trim() === '' || isCommentLine(text)) continue;
    typedEntries.push({ text, line });
  }

  const last = typedEntries[typedEntries.length - 1];
  if (last === undefined || !isTruncatedTypedTail(last.text)) return warnings;

  const raw = rawLineForWarning({
    rawText: input.rawText,
    lines: input.lines,
    line: last.line,
    text: last.text,
  });

  warnings.push(
    toWarning(
      ruleIssue(
        'E_TRUNCATED_TAIL',
        'last rule line looks truncated (no final newline)',
        'error',
        'the source ends mid-rule; the line is rejected, see SPEC §6.2',
      ),
      { sourceId, line: last.line, raw },
    ),
  );
  return warnings;
}

/**
 * Template tail check, run on the raw template text BEFORE YAML parsing
 * (review P0-3). YAML would otherwise happily decode `- DOMA`.
 */
export function checkTemplateTail(rawText: string, sourceId = 'template'): Warning[] {
  if (hasFinalNewline(rawText)) return [];
  const last = lastRawLine(rawText);
  if (last.text.trim() === '') return [];

  let value = last.text.trim();
  if (value.startsWith('-')) value = value.slice(1).trimStart();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (!isTruncatedTypedTail(value)) return [];

  return [
    toWarning(
      ruleIssue(
        'E_TRUNCATED_TAIL',
        'template rules look truncated (no final newline)',
        'error',
        'the last template line is rejected, see SPEC §6.2',
        'template',
      ),
      { sourceId, line: last.line, raw: truncateRaw(last.text) },
    ),
  ];
}

/**
 * Domain sources sometimes declare `# TOTAL: N` / `# COUNT: N` / `# TOTAL N`.
 * Fewer actual entries than declared means the download was truncated.
 */
export function checkDeclaredCount(
  originalText: string,
  actual: number,
  sourceId: string,
): Warning[] {
  let declared: number | undefined;
  let declaredLine = 0;
  let declaredRaw = '';
  let lineNo = 1;
  let lineStart = 0;
  for (;;) {
    const newline = originalText.indexOf('\n', lineStart);
    const end = newline === -1 ? originalText.length : newline;
    let line = originalText.slice(lineStart, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const match = /^\s*#\s*(?:TOTAL|COUNT)\b\s*:?\s*(\d+)\s*$/i.exec(line);
    if (match !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && (declared === undefined || value > declared)) {
        declared = value;
        declaredLine = lineNo;
        declaredRaw = line;
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
    lineNo += 1;
  }

  if (declared === undefined || actual >= declared) return [];
  return [
    toWarning(
      ruleIssue(
        'E_TRUNCATED_SOURCE',
        `source declares ${declared} entries but only ${actual} were found`,
        'error',
        'the source may be truncated',
      ),
      { sourceId, line: declaredLine, raw: declaredRaw },
    ),
  ];
}
