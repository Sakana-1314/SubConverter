/**
 * HTTP response helpers: CORS, security headers, cache policy and error bodies
 * (SPEC §2.2, §2.3, §2.9, §9.5).
 */

import type { Warning } from '../types';
import { VERSION } from '../types';
import type { AppError } from '../services/errors';

export type EndpointKind = 'sub' | 'ruleset' | 'meta' | 'error';

export function baseHeaders(): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Subconverter-Version', VERSION);
  return headers;
}

export function cacheControlFor(
  endpoint: EndpointKind,
  options: {
    publicSubscriptionCache: boolean;
    subscriptionCacheTtl: number;
    rulesetCacheTtl: number;
    rulesMode: 'inline' | 'providers';
    publicOrigin: string;
  },
): string {
  switch (endpoint) {
    case 'meta':
      return 'public, max-age=3600';
    case 'ruleset':
      return `public, max-age=${options.rulesetCacheTtl}, stale-while-revalidate=600`;
    case 'error':
      return 'private, no-store';
    case 'sub': {
      const providersSafe =
        options.rulesMode === 'inline' || options.publicOrigin !== '';
      if (options.publicSubscriptionCache && providersSafe) {
        return `public, max-age=${options.subscriptionCacheTtl}, stale-while-revalidate=300`;
      }
      return 'private, no-store';
    }
  }
}

export function countCodes(warnings: readonly Warning[]): { count: number; codes: string[] } {
  const seen = new Set<string>();
  for (const warning of warnings) seen.add(warning.code);
  return { count: warnings.length, codes: [...seen].sort() };
}

export function applyWarningHeaders(
  headers: Headers,
  warningCount: number,
  warningCodes: readonly string[],
): void {
  headers.set('X-Subconverter-Warnings', String(warningCount));
  if (warningCodes.length > 0) {
    const shown = warningCodes.slice(0, 20);
    const hidden = warningCodes.length - shown.length;
    headers.set(
      'X-Subconverter-Warn-Codes',
      hidden > 0 ? `${shown.join(',')},+${hidden}` : shown.join(','),
    );
  }
}

export interface ResponseOptions {
  status?: number;
  contentType: string;
  cacheControl: string;
  extraHeaders?: Record<string, string>;
  warningCount?: number;
  warningCodes?: readonly string[];
  isHead?: boolean;
}

function buildHeaders(options: ResponseOptions): Headers {
  const headers = baseHeaders();
  headers.set('Content-Type', options.contentType);
  headers.set('Cache-Control', options.cacheControl);
  if (options.warningCount !== undefined) {
    applyWarningHeaders(headers, options.warningCount, options.warningCodes ?? []);
  }
  if (options.extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(options.extraHeaders)) {
      headers.set(key, value);
    }
  }
  return headers;
}

export function textResponse(text: string, options: ResponseOptions): Response {
  const headers = buildHeaders(options);
  return new Response(options.isHead === true ? null : text, {
    status: options.status ?? 200,
    headers,
  });
}

export function yamlResponse(yaml: string, options: ResponseOptions): Response {
  return textResponse(yaml, options);
}

export function jsonResponse(value: unknown, options: ResponseOptions): Response {
  return textResponse(JSON.stringify(value), options);
}

export function noContentResponse(allow = 'GET, OPTIONS'): Response {
  const headers = baseHeaders();
  headers.set('Allow', allow);
  return new Response(null, { status: 204, headers });
}

export interface ErrorOptions {
  diagnostics: boolean;
  warnings?: readonly Warning[];
  warningCount?: number;
  warningCodes?: readonly string[];
  extraHeaders?: Record<string, string>;
}

export function errorResponse(error: AppError, options: ErrorOptions): Response {
  const warnings = options.warnings ?? [];
  const warningCount = options.warningCount ?? warnings.length;
  const warningCodes = options.warningCodes ?? countCodes(warnings).codes;
  const headers = baseHeaders();
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Subconverter-Error', error.code);
  applyWarningHeaders(headers, warningCount, warningCodes);
  if (options.extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(options.extraHeaders)) {
      headers.set(key, value);
    }
  }

  if (options.diagnostics) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('X-Subconverter-Diagnostics', 'json');
    return new Response(
      JSON.stringify({
        ok: false,
        error: { code: error.code, message: error.message },
        warnings: warnings.map((warning) => ({ ...warning })),
      }),
      { status: error.status, headers },
    );
  }

  headers.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(`error: ${error.code}\nmessage: ${error.message}\n`, {
    status: error.status,
    headers,
  });
}

export function notFoundResponse(isHead = false): Response {
  const headers = baseHeaders();
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('Cache-Control', 'private, no-store');
  return new Response(isHead ? null : 'not found\n', { status: 404, headers });
}

export function methodNotAllowedResponse(allow: string, isHead = false): Response {
  const headers = baseHeaders();
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Allow', allow);
  return new Response(isHead ? null : 'method not allowed\n', { status: 405, headers });
}
