/**
 * Protocol registries, field validators and URI helpers.
 *
 * Sources:
 * - docs/ARCHITECTURE.md §7.1.7 (protocols.ts contract)
 * - docs/SPEC.md §3.4 (protocol registries), §3.5 (server/port), AC-26
 */

import type { Transport } from '../types';
import { formatIp, parseIpLiteral } from './ip';

// ---------------------------------------------------------------------------
// Registries (SPEC §3.4.1 / §3.4.2)
// ---------------------------------------------------------------------------

export const SS_CIPHERS: ReadonlySet<string> = new Set([
  'aes-128-gcm',
  'aes-192-gcm',
  'aes-256-gcm',
  'aes-128-cfb',
  'aes-192-cfb',
  'aes-256-cfb',
  'aes-128-ctr',
  'aes-192-ctr',
  'aes-256-ctr',
  'rc4-md5',
  'chacha20-ietf',
  'chacha20-ietf-poly1305',
  'xchacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
  'none',
]);

export const SSR_PROTOCOLS: ReadonlySet<string> = new Set([
  'origin',
  'auth_sha1_v4',
  'auth_aes128_md5',
  'auth_aes128_sha1',
  'auth_chain_a',
  'auth_chain_b',
]);

export const SSR_OBFS: ReadonlySet<string> = new Set([
  'plain',
  'http_simple',
  'http_post',
  'random_head',
  'tls1.2_ticket_auth',
]);

export const ALLOWED_TRANSPORTS: ReadonlySet<Transport> = new Set(['tcp', 'ws', 'grpc']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSupportedSsCipher(raw: string): boolean {
  return SS_CIPHERS.has(raw.trim().toLowerCase());
}

/** VMess/VLESS UUID (`8-4-4-4-12` hex), case-insensitive. */
export function normalizeUuid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return UUID_RE.test(value) ? value.toLowerCase() : null;
}

export function isUuid(raw: unknown): boolean {
  return normalizeUuid(raw) !== null;
}

/** SSR `cipher: none` becomes mihomo's `dummy` (SPEC §3.4.2). */
export function normalizeSsrCipher(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value === 'dummy') return 'dummy';
  if (!SS_CIPHERS.has(value)) return null;
  return value === 'none' ? 'dummy' : value;
}

// ---------------------------------------------------------------------------
// Port / server validation (SPEC §3.5)
// ---------------------------------------------------------------------------

/** Integer port 1..65535, accepting numeric strings. */
export function parsePortValue(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : null;
  }
  if (typeof raw === 'string') {
    const value = raw.trim();
    if (!/^\d{1,5}$/.test(value)) return null;
    const port = Number(value);
    return port >= 1 && port <= 65535 ? port : null;
  }
  return null;
}

/**
 * Validate/normalize `server`. Accepts IPv4, IPv6 (with or without brackets) and
 * ASCII DNS names; returns lowercase DNS names and canonical IP literals.
 */
export function normalizeServer(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (value === '' || value.length > 253) return null;
  if (/[\s\u0000-\u001F\u007F-\u009F/,;#?]/.test(value)) return null;

  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1);
    const ip = parseIpLiteral(inner);
    return ip && ip.version === 6 ? formatIp(ip) : null;
  }

  const ip = parseIpLiteral(value);
  if (ip) return formatIp(ip);

  if (value.includes(':')) return null; // malformed IPv6

  value = value.replace(/\.+$/, '');
  if (value === '' || value.length > 253) return null;
  // Reject dotted-numeric strings that are not valid IPv4 addresses.
  if (/^\d+(?:\.\d+){3}$/.test(value)) return null;

  const labels = value.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) return null;
  }
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// User / rule regex compilation (ARCHITECTURE §7.1.7, AC-26)
// ---------------------------------------------------------------------------

export class InvalidRegexError extends Error {
  readonly code = 'invalid_regex';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRegexError';
  }
}

function hasBackReference(pattern: string): boolean {
  return /\\[1-9]/.test(pattern);
}

function hasLargeRepeat(pattern: string): boolean {
  const re = /\{(\d+)(?:,(\d*))?\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pattern)) !== null) {
    const min = Number(match[1]);
    const maxText = match[2];
    const max = maxText === undefined || maxText === '' ? Infinity : Number(maxText);
    if (min > 1000 || max > 1000) return true;
  }
  return false;
}

interface GroupScanState {
  containsQuantifier: boolean;
}

/**
 * Detect catastrophic-backtracking shapes such as `(a+)+` or `(.*)*`.
 * This is deliberately conservative; it is a heuristic, not a regex analyser.
 */
function hasNestedQuantifier(pattern: string): boolean {
  const stack: GroupScanState[] = [{ containsQuantifier: false }];
  const mark = (): void => {
    stack[stack.length - 1].containsQuantifier = true;
  };
  let inClass = false;
  let escaped = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      stack.push({ containsQuantifier: false });
      continue;
    }
    if (ch === ')') {
      const group = stack.pop();
      if (!group) continue;
      const next = pattern[i + 1];
      if (next === '*' || next === '+' || next === '?') {
        if (group.containsQuantifier) return true;
        mark();
      } else if (next === '{') {
        const counted = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i + 1));
        if (counted) {
          if (group.containsQuantifier) return true;
          mark();
        }
      }
      continue;
    }
    if (ch === '*' || ch === '+') {
      mark();
    } else if (ch === '{') {
      const counted = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i));
      if (counted) {
        mark();
        i += counted[0].length - 1;
      }
    } else if (ch === '?') {
      if (i === 0 || pattern[i - 1] !== '(') mark();
    }
  }
  return false;
}

export type CompiledRegex =
  | { ok: true; regex: RegExp }
  | { ok: false; reason: string };

export interface CompileUserRegexOptions {
  global?: boolean;
}

/**
 * Compile a user-supplied regex with length and ReDoS heuristics.
 * Callers turn a failure into `400 invalid_regex` (AC-26).
 */
export function compileUserRegex(
  pattern: string,
  context = 'regex',
  options: CompileUserRegexOptions = {},
): CompiledRegex {
  if (typeof pattern !== 'string') return { ok: false, reason: `${context}: pattern is not a string` };
  if (pattern.length > 256) return { ok: false, reason: `${context}: pattern exceeds 256 characters` };
  if (hasBackReference(pattern)) return { ok: false, reason: `${context}: backreferences are not allowed` };
  if (hasLargeRepeat(pattern)) return { ok: false, reason: `${context}: repeat count is too large` };
  if (hasNestedQuantifier(pattern)) return { ok: false, reason: `${context}: nested quantifiers are not allowed` };
  try {
    return { ok: true, regex: new RegExp(pattern, options.global ? 'gu' : 'u') };
  } catch {
    return { ok: false, reason: `${context}: pattern is not a valid regular expression` };
  }
}

/** Compile a rule regex (no execution); supports a leading `(?i)` flag. */
export function compileRuleRegex(pattern: string): CompiledRegex {
  if (typeof pattern !== 'string') return { ok: false, reason: 'pattern is not a string' };
  if (pattern.length > 512) return { ok: false, reason: 'pattern exceeds 512 characters' };
  let source = pattern;
  let flags = 'u';
  if (source.startsWith('(?i)')) {
    source = source.slice(4);
    flags += 'i';
  }
  try {
    return { ok: true, regex: new RegExp(source, flags) };
  } catch {
    return { ok: false, reason: 'pattern is not a valid regular expression' };
  }
}

// ---------------------------------------------------------------------------
// URI splitting helpers
// ---------------------------------------------------------------------------

export interface UriSchemeParts {
  scheme: string;
  rest: string;
}

export function splitUriScheme(uri: string): UriSchemeParts | null {
  const value = uri.trim();
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([\s\S]*)$/.exec(value);
  if (!match) return null;
  return { scheme: match[1].toLowerCase(), rest: match[2] };
}

export function splitFragment(rest: string): { main: string; fragment: string } {
  const index = rest.indexOf('#');
  if (index < 0) return { main: rest, fragment: '' };
  return { main: rest.slice(0, index), fragment: rest.slice(index + 1) };
}

export function splitQuery(main: string): { main: string; query: string } {
  const index = main.indexOf('?');
  if (index < 0) return { main, query: '' };
  return { main: main.slice(0, index), query: main.slice(index + 1) };
}

export interface AuthorityParts {
  userinfo: string;
  host: string;
  port: string;
}

/** Split `[userinfo@]host[:port]`, handling bracketed IPv6. */
export function parseAuthority(authority: string): AuthorityParts | null {
  let rest = authority;
  let userinfo = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    userinfo = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  if (rest === '') return null;

  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end < 0) return null;
    const host = rest.slice(1, end);
    const after = rest.slice(end + 1);
    if (after === '') return { userinfo, host, port: '' };
    if (!after.startsWith(':')) return null;
    return { userinfo, host, port: after.slice(1) };
  }

  const colon = rest.lastIndexOf(':');
  if (colon < 0) return { userinfo, host: rest, port: '' };
  if (rest.indexOf(':') !== colon) return null; // unbracketed IPv6 is invalid in a URI authority
  return { userinfo, host: rest.slice(0, colon), port: rest.slice(colon + 1) };
}

export function decodeComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseQueryParams(raw: string): URLSearchParams {
  try {
    return new URLSearchParams(raw);
  } catch {
    return new URLSearchParams();
  }
}

/** Case-insensitive lookup over the given aliases. */
export function getParam(params: URLSearchParams, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = params.get(name);
    if (value !== null) return value;
  }
  const lower = names.map((name) => name.toLowerCase());
  for (const [key, value] of params) {
    if (lower.includes(key.toLowerCase())) return value;
  }
  return undefined;
}

/** All values for an alias set (used by `alpn`). */
export function getAllParams(params: URLSearchParams, ...names: string[]): string[] {
  const out: string[] = [];
  const lower = names.map((name) => name.toLowerCase());
  for (const [key, value] of params) {
    if (lower.includes(key.toLowerCase())) out.push(value);
  }
  return out;
}

/** Parse 1/true/yes/on and 0/false/no/off; unknown values yield undefined. */
export function parseBooleanParam(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  return undefined;
}

/** `alpn=h2,http/1.1` (repeated or comma-separated) -> string[] | undefined. */
export function parseAlpnParam(params: URLSearchParams): string[] | undefined {
  const values = getAllParams(params, 'alpn');
  if (values.length === 0) return undefined;
  const items = values
    .flatMap((value) => value.split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length > 0 ? items : undefined;
}

/**
 * Normalize a transport query value. `null` means "unsupported transport";
 * `undefined`/`none`/`tcp` map to tcp (default).
 */
export function parseTransportValue(raw: string | undefined): Transport | null {
  if (raw === undefined) return 'tcp';
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'none' || value === 'tcp') return 'tcp';
  if (value === 'ws') return 'ws';
  if (value === 'grpc') return 'grpc';
  return null;
}

/** Parse an integer query value (digits only). */
export function parseIntParam(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (!/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** VMess `alterId`/`aid`: integer 0..65535, missing means 0. */
export function parseAlterIdValue(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 && raw <= 65535 ? raw : null;
  }
  if (typeof raw === 'string') {
    const value = raw.trim();
    if (value === '') return 0;
    if (!/^\d{1,5}$/.test(value)) return null;
    const parsed = Number(value);
    return parsed >= 0 && parsed <= 65535 ? parsed : null;
  }
  return null;
}

/** Map a `plugin` query value (`name;key=value;flag`) to mihomo plugin opts. */
export function parsePluginSpec(raw: string): {
  ok: true;
  plugin: 'obfs' | 'v2ray-plugin';
  opts: Record<string, string | boolean>;
} | { ok: false; message: string } {
  const segments = raw.split(';');
  const name = segments[0].trim().toLowerCase();
  let plugin: 'obfs' | 'v2ray-plugin';
  if (name === 'obfs' || name === 'obfs-local' || name === 'simple-obfs') {
    plugin = 'obfs';
  } else if (name === 'v2ray-plugin') {
    plugin = 'v2ray-plugin';
  } else {
    return { ok: false, message: `unsupported ss plugin: ${name || '(empty)'}` };
  }

  const opts: Record<string, string | boolean> = {};
  for (const rawSegment of segments.slice(1)) {
    const segment = rawSegment.trim();
    if (segment === '') continue;
    const eq = segment.indexOf('=');
    const key = (eq < 0 ? segment : segment.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? '' : segment.slice(eq + 1).trim();
    if (key === '') continue;

    if (plugin === 'obfs') {
      if (key === 'obfs' || key === 'mode') opts.mode = value;
      else if (key === 'obfs-host' || key === 'host') opts.host = value;
      else opts[key] = eq < 0 ? true : value;
    } else {
      if (key === 'tls' || key === 'mux' || key === 'skip-cert-verify') {
        opts[key] = eq < 0 ? true : (parseBooleanParam(value) ?? value);
      } else {
        opts[key] = eq < 0 ? true : value;
      }
    }
  }
  return { ok: true, plugin, opts };
}
