/**
 * URI scheme dispatcher (SPEC §3.2).
 *
 * Scheme comparison is case-insensitive; unknown schemes are rejected instead
 * of being reinterpreted as HTTP proxies (tindy's `explodeHTTPSub` is not
 * reproduced).
 */

import type { SupportedUriScheme, UriParseResult } from '../contracts';
import { splitUriScheme } from '../protocols';
import { parseSs } from './ss';
import { parseSsr } from './ssr';
import { parseTrojan } from './trojan';
import { parseVless } from './vless';
import { parseVmess } from './vmess';

export type { UriParseResult } from '../contracts';

const PARSERS: Record<SupportedUriScheme, (uri: string) => UriParseResult> = {
  ss: parseSs,
  ssr: parseSsr,
  vmess: parseVmess,
  trojan: parseTrojan,
  vless: parseVless,
};

function fail(code: string, message: string): UriParseResult {
  return { ok: false, code, message };
}

/** True when `scheme` (without `://`) is handled by this module. */
export function isSupportedUriScheme(scheme: string): scheme is SupportedUriScheme {
  return Object.prototype.hasOwnProperty.call(PARSERS, scheme.toLowerCase());
}

/**
 * Parse one URI. Never throws: unexpected exceptions become `E_NODE_LINE` so a
 * single bad line cannot abort a whole subscription.
 */
export function parseUri(uri: string): UriParseResult {
  if (typeof uri !== 'string') {
    return fail('E_NODE_LINE', 'URI is not a string');
  }
  const trimmed = uri.trim();
  if (trimmed === '') {
    return fail('E_NODE_LINE', 'URI is empty');
  }

  const parts = splitUriScheme(trimmed);
  if (!parts) {
    return fail('E_NODE_LINE', 'line is not a URI');
  }
  if (!isSupportedUriScheme(parts.scheme)) {
    return fail('E_NODE_SCHEME_UNSUPPORTED', `unsupported URI scheme: ${parts.scheme}`);
  }

  try {
    return PARSERS[parts.scheme](trimmed);
  } catch {
    return fail('E_NODE_LINE', 'URI could not be parsed');
  }
}

/** Alias used by line-oriented callers; behavior is identical to `parseUri`. */
export const parseUriLine = parseUri;
