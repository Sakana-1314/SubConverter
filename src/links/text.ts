/**
 * Small, dependency-free text helpers shared by every input parser.
 *
 * Sources:
 * - docs/ARCHITECTURE.md §7.1.3 (text.ts contract)
 * - docs/SPEC.md §3.1 (BOM/NUL/newlines), §9.6 (warning redaction)
 */

import type { Severity, Stage, Warning } from '../types';

const BOM = '\uFEFF';

/** Remove one leading UTF-8 BOM (U+FEFF). */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Normalize CRLF and lone CR to LF. */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** True when the string contains a NUL code unit (SPEC §3.1 rejects it). */
export function hasNul(s: string): boolean {
  return s.includes('\u0000');
}

/**
 * Split normalized text into logical lines.
 *
 * A single trailing newline does not produce a trailing empty line; callers
 * that need "did the file end with a newline" must inspect the raw text.
 */
export function splitLines(s: string): string[] {
  const normalized = normalizeNewlines(s);
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;

/** Remove C0/C1 control characters (keeps ordinary whitespace other than CR/LF). */
export function stripControlChars(s: string): string {
  return s.replace(CONTROL_RE, '');
}

function escapeControlChar(ch: string): string {
  const code = ch.charCodeAt(0);
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

/**
 * Truncate a diagnostic string to `max` characters (UTF-16 code units) and
 * escape every control character. Never returns CR/LF.
 */
export function truncateForWarning(s: string, max = 160): string {
  const limit = Math.max(0, Math.trunc(max));
  let out = '';
  let units = 0;
  for (const ch of s) {
    const isControl = ch === '\r' || ch === '\n' || /[\u0000-\u001F\u007F-\u009F]/.test(ch);
    const piece = isControl ? escapeControlChar(ch) : ch;
    if (units + piece.length > limit) break;
    out += piece;
    units += piece.length;
  }
  return out;
}

/**
 * Redact a node URI for use in `Warning.raw`.
 *
 * SPEC §9.6 forbids raw node URIs/passwords/UUIDs. We keep only the scheme and
 * the authority after the last `@`; payload-style links (legacy ss, ssr,
 * vmess JSON) are reduced to `scheme://[redacted]`.
 */
export function redactUri(uri: string, max = 160): string {
  const trimmed = uri.trim();
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(trimmed);
  if (!match) return truncateForWarning(trimmed, max);
  const scheme = match[1].toLowerCase();
  const rest = trimmed.slice(match[0].length);
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    let authority = rest.slice(at + 1);
    const cut = authority.search(/[?#]/);
    if (cut >= 0) authority = authority.slice(0, cut);
    return truncateForWarning(`${scheme}://${authority}`, max);
  }
  return `${scheme}://[redacted]`;
}

/**
 * FNV-1a 32-bit over the UTF-8 bytes of `s`, returned as 8 lowercase hex digits.
 * Deterministic across runtimes (archived docs/ARCHITECTURE.md §7.2.9).
 */
export function fnv1a32(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** FNV-1a 64-bit over UTF-8 bytes, returned as 16 lowercase hex digits. */
export function fnv1a64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Stable host identifier for logs: lowercase host hashed with FNV-1a 32. */
export function hashHost(host: string): string {
  return fnv1a32(host.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Warning helpers
// ---------------------------------------------------------------------------

const INFO_CODES = new Set(['W_INPUT_BASE64_DETECTED', 'W_NODE_NAME_EMPTY']);

function defaultStage(code: string): Stage {
  if (code.startsWith('E_YAML') || code.startsWith('W_CLASH')) return 'yaml';
  if (code.includes('BASE64') || code === 'E_UTF8_INVALID' || code === 'E_UNSUPPORTED_INPUT_FORMAT') {
    return 'decode';
  }
  if (code.startsWith('E_FETCH') || code.startsWith('W_FETCH') || code === 'E_SSRF_BLOCKED') return 'fetch';
  if (code.startsWith('E_RULE') || code.startsWith('W_RULE') || code.includes('TRUNCATED')) return 'rules';
  if (code.startsWith('E_OUTPUT') || code === 'E_EMIT_INVALID' || code === 'W_WARNING_LIMIT') return 'emit';
  return 'nodes';
}

function defaultSeverity(code: string): Severity {
  if (INFO_CODES.has(code)) return 'info';
  if (code.startsWith('W_')) return 'warning';
  return 'error';
}

/** Build a structured warning with the SPEC §10 severity/stage defaults. */
export function makeWarning(
  code: string,
  message: string,
  extra: Partial<Omit<Warning, 'code' | 'message'>> & {
    severity?: Severity;
    stage?: Stage;
  } = {},
): Warning {
  const severity = extra.severity ?? defaultSeverity(code);
  const stage = extra.stage ?? defaultStage(code);
  const warning: Warning = { code, severity, stage, message };
  if (extra.source !== undefined) warning.source = extra.source;
  if (extra.line !== undefined) warning.line = extra.line;
  if (extra.raw !== undefined) warning.raw = truncateForWarning(extra.raw);
  if (extra.hint !== undefined) warning.hint = extra.hint;
  return warning;
}
