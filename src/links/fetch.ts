/**
 * Upstream fetcher with redirect, SSRF, size, timeout and content checks.
 *
 * All I/O goes through the injected `deps.fetch`, so unit tests can exercise
 * redirects/timeouts/size limits without touching the network (SPEC §6.1).
 *
 * Sources:
 * - docs/ARCHITECTURE.md §7.1.6 (fetch.ts contract)
 * - docs/SPEC.md §6.1 (HTTP layer), §9.3 (redirects), §9.4 (limits), §9.6
 */

import type { SourceRef } from '../types';
import { validateUpstreamUrl, type UrlPolicy } from './url-guard';

export interface FetchDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
}

export interface FetchPolicy extends UrlPolicy {
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  /** Epoch milliseconds; all hops share this deadline. */
  deadline: number;
  perHopTimeoutMs: number;
  userAgent: string;
}

export type FetchErrorCode =
  | 'E_FETCH_STATUS'
  | 'E_FETCH_TIMEOUT'
  | 'E_FETCH_TOO_LARGE'
  | 'E_FETCH_NETWORK'
  | 'E_FETCH_REDIRECT_LIMIT'
  | 'E_FETCH_HTML'
  | 'E_FETCH_ERROR_PAGE'
  | 'E_FETCH_EMPTY'
  | 'E_UTF8_INVALID'
  | 'E_SSRF_BLOCKED';

export type FetchResult =
  | {
      ok: true;
      text: string;
      bytes: number;
      effectiveUrl: string;
      contentType: string | null;
      status: number;
      redirects: number;
      userInfo?: string;
      /** True when an upstream Subscription-UserInfo header failed validation. */
      userInfoInvalid?: boolean;
    }
  | { ok: false; code: FetchErrorCode; message: string; status?: number };

const USER_INFO_RE = /^(upload|download|total|expire)=\d+(;\s*(upload|download|total|expire)=\d+)*$/;
const HTML_PREFIXES = ['<!doctype html', '<html', '<head', '<body'];

function fail(code: FetchErrorCode, message: string, status?: number): FetchResult {
  const result: FetchResult = { ok: false, code, message };
  if (status !== undefined) result.status = status;
  return result;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function looksLikeHtml(text: string): boolean {
  // Only the very beginning matters; lowercasing the entire body would waste
  // CPU and memory on large subscriptions.
  const head = text
    .replace(/^\uFEFF/, '')
    .trimStart()
    .slice(0, 64)
    .toLowerCase();
  return HTML_PREFIXES.some((prefix) => head.startsWith(prefix));
}

function isJsonErrorPage(text: string, mediaType: string): boolean {
  if (mediaType !== 'application/json') return false;
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  if (!trimmed.startsWith('{')) return false;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if ('payload' in obj || 'rules' in obj || 'proxies' in obj) return false;
  return 'error' in obj || 'message' in obj;
}

interface ReadResult {
  ok: boolean;
  bytes?: Uint8Array;
  code?: 'E_FETCH_TOO_LARGE' | 'E_FETCH_EMPTY';
}

async function readLimited(response: Response, maxBytes: number): Promise<ReadResult> {
  const body = response.body;
  if (!body) return { ok: false, code: 'E_FETCH_EMPTY' };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore cancellation errors
      }
      return { ok: false, code: 'E_FETCH_TOO_LARGE' };
    }
    chunks.push(value);
  }
  if (total === 0) return { ok: false, code: 'E_FETCH_EMPTY' };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

function fetchInline(source: Extract<SourceRef, { kind: 'inline' }>, policy: FetchPolicy): FetchResult {
  const bytes = new TextEncoder().encode(source.value).length;
  if (policy.maxBytes >= 0 && bytes > policy.maxBytes) {
    return fail('E_FETCH_TOO_LARGE', 'inline source exceeds the byte limit');
  }
  if (source.value.trim() === '') {
    return fail('E_FETCH_EMPTY', 'inline source is empty');
  }
  return {
    ok: true,
    text: source.value,
    bytes,
    effectiveUrl: 'inline:',
    contentType: null,
    status: 200,
    redirects: 0,
  };
}

async function fetchHttp(rawUrl: string, policy: FetchPolicy, deps: FetchDeps): Promise<FetchResult> {
  const initial = validateUpstreamUrl(rawUrl, policy);
  if (!initial.ok) {
    return fail('E_SSRF_BLOCKED', initial.reason);
  }

  let current = initial.url;
  let redirects = 0;

  for (;;) {
    const remaining = policy.deadline - deps.now();
    if (remaining <= 0) {
      return fail('E_FETCH_TIMEOUT', 'upstream deadline exceeded');
    }
    const hopTimeout = Math.min(policy.perHopTimeoutMs, remaining);
    if (hopTimeout <= 0) {
      return fail('E_FETCH_TIMEOUT', 'upstream deadline exceeded');
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, hopTimeout);

    try {
      let response: Response;
      try {
        response = await deps.fetch(current.href, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'User-Agent': policy.userAgent,
            Accept: 'text/plain, application/yaml, application/json, */*',
            'Accept-Encoding': 'identity',
          },
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
          return fail('E_FETCH_TIMEOUT', 'upstream request timed out');
        }
        return fail('E_FETCH_NETWORK', 'upstream request failed');
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await cancelBody(response);
        if (redirects >= policy.maxRedirects) {
          return fail('E_FETCH_REDIRECT_LIMIT', 'too many upstream redirects');
        }
        const location = response.headers.get('location');
        if (!location || location.trim() === '') {
          return fail('E_FETCH_REDIRECT_LIMIT', 'redirect response has no Location');
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return fail('E_FETCH_REDIRECT_LIMIT', 'redirect Location is not a valid URL');
        }
        const validated = validateUpstreamUrl(next.href, policy);
        if (!validated.ok) {
          return fail('E_SSRF_BLOCKED', validated.reason);
        }
        redirects++;
        current = validated.url;
        continue;
      }

      if (response.status < 200 || response.status > 299) {
        await cancelBody(response);
        return fail('E_FETCH_STATUS', `upstream returned HTTP ${response.status}`, response.status);
      }

      const contentType = response.headers.get('content-type');
      const mediaType = (contentType ?? '').split(';')[0].trim().toLowerCase();
      if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
        await cancelBody(response);
        return fail('E_FETCH_HTML', 'upstream returned an HTML document', response.status);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength !== null && /^\d+$/.test(contentLength.trim())) {
        if (Number(contentLength.trim()) > policy.maxBytes) {
          await cancelBody(response);
          return fail('E_FETCH_TOO_LARGE', 'upstream Content-Length exceeds the byte limit', response.status);
        }
      }

      const read = await readLimited(response, policy.maxBytes);
      if (!read.ok) {
        if (read.code === 'E_FETCH_TOO_LARGE') {
          return fail('E_FETCH_TOO_LARGE', 'upstream response exceeds the byte limit', response.status);
        }
        return fail('E_FETCH_EMPTY', 'upstream response is empty', response.status);
      }

      const text = decodeUtf8(read.bytes!);
      if (text === null) {
        return fail('E_UTF8_INVALID', 'upstream body is not valid UTF-8', response.status);
      }
      if (looksLikeHtml(text)) {
        return fail('E_FETCH_HTML', 'upstream returned an HTML document', response.status);
      }
      if (isJsonErrorPage(text, mediaType)) {
        return fail('E_FETCH_ERROR_PAGE', 'upstream returned a JSON error page', response.status);
      }
      if (text.trim() === '') {
        return fail('E_FETCH_EMPTY', 'upstream response is empty', response.status);
      }

      const userInfoHeader = response.headers.get('subscription-userinfo');
      const userInfoValid =
        userInfoHeader !== null &&
        userInfoHeader.length <= 512 &&
        /^[\x20-\x7E]+$/.test(userInfoHeader) &&
        USER_INFO_RE.test(userInfoHeader);
      const userInfo = userInfoValid ? (userInfoHeader as string) : undefined;

      const result: FetchResult = {
        ok: true,
        text,
        bytes: read.bytes!.byteLength,
        effectiveUrl: current.href,
        contentType,
        status: response.status,
        redirects,
      };
      if (userInfo !== undefined) result.userInfo = userInfo;
      if (userInfoHeader !== null && !userInfoValid) result.userInfoInvalid = true;
      return result;
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
        return fail('E_FETCH_TIMEOUT', 'upstream request timed out');
      }
      return fail('E_FETCH_NETWORK', 'upstream request failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Fetch a source (inline or HTTP) according to the supplied policy. */
export async function fetchSource(
  source: SourceRef,
  policy: FetchPolicy,
  deps: FetchDeps,
): Promise<FetchResult> {
  if (source.kind === 'inline') return fetchInline(source, policy);
  return fetchHttp(source.value, policy, deps);
}
