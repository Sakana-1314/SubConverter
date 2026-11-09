/**
 * Integration fetch service: source syntax, inline decoding, upstream loading.
 *
 * Remote fetch/redirect/size/SSRF behavior is delegated to `links/fetch.ts`
 * (single source of truth for SPEC §9.2-§9.4). This module adds:
 * - `inline:` / `data:` decoding and their tighter limits;
 * - per-request total-byte accounting (`MAX_TOTAL_UPSTREAM_BYTES`);
 * - optional, explicitly opt-in Cache API support (not used by `/sub`, see
 *   SPEC §9.5: upstream bodies are not cached by default).
 */

import { decodeBase64Text } from '../links/base64';
import {
  fetchSource,
  type FetchErrorCode,
  type FetchPolicy,
  type FetchResult,
} from '../links/fetch';
import { validateUpstreamUrl, type UrlPolicy } from '../links/url-guard';
import type { SourceRef } from '../types';
import type { EnvPolicy } from './env';
import { AppError } from './errors';

export type SourceKind = 'subscription' | 'ruleset' | 'config' | 'template';

export interface SourceSpec {
  /** Source string without a `tag:` prefix. */
  raw: string;
  /** Diagnostic label such as `url#1` / `ruleset#2` / `config`. */
  label: string;
  sourceId: string;
  /** Value from `tag:<label>,<source>`. */
  sourceGroup?: string;
}

export interface LoadedText {
  text: string;
  bytes: number;
  userInfo?: string;
  userInfoInvalid?: boolean;
}

export interface FetchServiceDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
  /** Optional Cache API instance. Callers opt in; routes do not pass one. */
  cache?: Cache;
  /** Cache TTL for remote ruleset sources when `cache` is provided. */
  cacheTtlSeconds?: number;
}

/** A per-source failure that pipelines turn into a Warning (partial failure). */
export class SourceLoadError extends Error {
  readonly warningCode: string;
  readonly appError: AppError;

  constructor(warningCode: string, appError: AppError, message = appError.message) {
    super(message);
    this.name = 'SourceLoadError';
    this.warningCode = warningCode;
    this.appError = appError;
  }
}

function sourceInvalid(message: string): SourceLoadError {
  return new SourceLoadError(
    'E_UNSUPPORTED_INPUT_FORMAT',
    new AppError('invalid_source', message),
  );
}

function urlPolicy(policy: EnvPolicy): UrlPolicy {
  return {
    allowHttp: policy.allowHttpUpstream,
    allowedPorts: policy.allowedPorts,
    environment: policy.environment,
    testHosts: policy.testHosts,
  };
}

function decodeInline(
  raw: string,
  decodedPrefix: string,
  policy: EnvPolicy,
): SourceRef {
  if (raw.length > policy.maxInlineSourceChars) {
    throw new SourceLoadError(
      'E_FETCH_TOO_LARGE',
      new AppError(
        'invalid_source',
        `inline source exceeds ${policy.maxInlineSourceChars} characters`,
      ),
    );
  }
  const encoded = raw.slice(decodedPrefix.length);
  if (encoded.trim() === '') {
    throw sourceInvalid('inline source is empty');
  }
  const decoded = decodeBase64Text(encoded);
  if (!decoded.ok) {
    throw new SourceLoadError(
      'E_BASE64_INVALID',
      new AppError('invalid_source', 'inline source is not valid base64url/UTF-8 text'),
    );
  }
  const bytes = new TextEncoder().encode(decoded.text).length;
  if (bytes > policy.maxInlineBytes) {
    // SPEC AC-32 requires `invalid_source` (400) for inline payloads over the
    // decoded-byte limit; keep E_FETCH_TOO_LARGE as the per-source warning code.
    throw new SourceLoadError(
      'E_FETCH_TOO_LARGE',
      new AppError('invalid_source', `inline source exceeds ${policy.maxInlineBytes} bytes`),
    );
  }
  return {
    kind: 'inline',
    value: decoded.text,
    label: 'inline',
    bytes,
  };
}

/**
 * Turn a query/config source string into a `SourceRef`.
 * Throws `SourceLoadError` for malformed or disallowed sources.
 */
export function resolveSourceRef(spec: SourceSpec, policy: EnvPolicy): SourceRef {
  const raw = spec.raw;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw sourceInvalid('source is empty');
  }

  if (/^inline:/i.test(raw)) {
    return decodeInline(raw, raw.slice(0, 'inline:'.length), policy);
  }
  if (/^data:text\/plain;base64,/i.test(raw)) {
    const prefix = raw.slice(0, 'data:text/plain;base64,'.length);
    const ref = decodeInline(raw, prefix, policy);
    return { ...ref, label: 'data' };
  }

  if (/^https?:\/\//i.test(raw)) {
    if (raw.length > 4096) {
      throw sourceInvalid('remote source URL exceeds 4096 characters');
    }
    const validated = validateUpstreamUrl(raw, urlPolicy(policy));
    if (!validated.ok) {
      if (validated.code === 'blocked_upstream' || /^http:\/\//i.test(raw)) {
        // HTTP upstreams disabled is a policy/SSRF rejection; the deployment
        // smoke check expects `url=http://127.0.0.1/` -> 400 blocked_upstream.
        throw new SourceLoadError(
          'E_SSRF_BLOCKED',
          new AppError('blocked_upstream', validated.reason),
        );
      }
      throw sourceInvalid(validated.reason);
    }
    return {
      kind: 'http',
      value: validated.url.href,
      label: 'http',
      ...(spec.sourceGroup === undefined ? {} : { sourceGroup: spec.sourceGroup }),
    };
  }

  throw sourceInvalid('source must be inline:, data:text/plain;base64, or an http(s) URL');
}

function fetchFailureCode(code: FetchErrorCode): { warningCode: FetchErrorCode; error: AppError } {
  switch (code) {
    case 'E_SSRF_BLOCKED':
      return { warningCode: code, error: new AppError('blocked_upstream', 'upstream URL was rejected') };
    case 'E_FETCH_TIMEOUT':
      return { warningCode: code, error: new AppError('upstream_timeout', 'upstream request timed out') };
    case 'E_FETCH_TOO_LARGE':
      return { warningCode: code, error: new AppError('upstream_too_large', 'upstream response is too large') };
    case 'E_FETCH_NETWORK':
    case 'E_FETCH_REDIRECT_LIMIT':
      return { warningCode: code, error: new AppError('upstream_network', 'upstream request failed') };
    case 'E_FETCH_STATUS':
    case 'E_FETCH_HTML':
    case 'E_FETCH_ERROR_PAGE':
    case 'E_FETCH_EMPTY':
    case 'E_UTF8_INVALID':
      return { warningCode: code, error: new AppError('upstream_status', 'upstream response is not usable') };
    default:
      return { warningCode: code, error: new AppError('upstream_network', 'upstream request failed') };
  }
}

function resultToError(result: Extract<FetchResult, { ok: false }>): SourceLoadError {
  const mapped = fetchFailureCode(result.code);
  return new SourceLoadError(mapped.warningCode, mapped.error, result.message);
}

function maxBytesFor(kind: SourceKind, policy: EnvPolicy): number {
  switch (kind) {
    case 'subscription':
      return policy.maxUpstreamBytes;
    case 'ruleset':
      // SPEC §9.4: rule sources are capped at 4 MiB.
      return Math.min(policy.maxUpstreamBytes, 4 * 1024 * 1024);
    case 'config':
    case 'template':
      // SPEC §9.4: config/template are capped at 256 KiB.
      return Math.min(policy.maxUpstreamBytes, 256 * 1024);
  }
}

/**
 * Loads all sources for one request, sharing the total-byte budget and the
 * request deadline.
 */
export class SourceLoader {
  private readonly policy: EnvPolicy;
  private readonly deps: FetchServiceDeps;
  private readonly deadline: number;
  private totalBytes = 0;

  constructor(policy: EnvPolicy, deps: FetchServiceDeps) {
    this.policy = policy;
    this.deps = deps;
    this.deadline = deps.now() + policy.requestDeadlineMs;
  }

  get bytesIn(): number {
    return this.totalBytes;
  }

  async load(spec: SourceSpec, kind: SourceKind): Promise<LoadedText> {
    const ref = resolveSourceRef(spec, this.policy);
    const maxBytes = ref.kind === 'inline' ? this.policy.maxInlineBytes : maxBytesFor(kind, this.policy);
    const fetchPolicy: FetchPolicy = {
      allowHttp: this.policy.allowHttpUpstream,
      allowedPorts: this.policy.allowedPorts,
      environment: this.policy.environment,
      testHosts: this.policy.testHosts,
      maxBytes,
      maxRedirects: this.policy.maxRedirects,
      timeoutMs: this.policy.upstreamTimeoutMs,
      deadline: this.deadline,
      perHopTimeoutMs: this.policy.perHopTimeoutMs,
      userAgent: this.policy.userAgent,
    };

    // Cache API is opt-in and limited to remote ruleset sources. `/sub` does not
    // pass a cache because SPEC §9.5 forbids caching upstream subscription bodies.
    const useCache =
      ref.kind === 'http' &&
      kind === 'ruleset' &&
      this.deps.cache !== undefined &&
      (this.deps.cacheTtlSeconds ?? 0) > 0;
    if (useCache) {
      try {
        const cached = await this.deps.cache!.match(ref.value);
        if (cached !== null && cached !== undefined) {
          const text = await cached.text();
          if (text !== '') {
            const bytes = new TextEncoder().encode(text).length;
            this.chargeBudget(bytes);
            return { text, bytes };
          }
        }
      } catch {
        // Cache failures are non-fatal; fall through to the network.
      }
    }

    const result = await fetchSource(ref, fetchPolicy, {
      fetch: this.deps.fetch,
      now: this.deps.now,
    });
    if (!result.ok) throw resultToError(result);

    this.chargeBudget(result.bytes);

    if (useCache) {
      try {
        await this.deps.cache!.put(
          ref.value,
          new Response(result.text, {
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': `max-age=${this.deps.cacheTtlSeconds ?? 0}`,
            },
          }),
        );
      } catch {
        // Best-effort cache write.
      }
    }

    const loaded: LoadedText = { text: result.text, bytes: result.bytes };
    if (result.userInfo !== undefined) loaded.userInfo = result.userInfo;
    if (result.userInfoInvalid === true) loaded.userInfoInvalid = true;
    return loaded;
  }

  private chargeBudget(bytes: number): void {
    if (this.totalBytes + bytes > this.policy.maxTotalUpstreamBytes) {
      throw new AppError(
        'upstream_too_large',
        `total upstream bytes exceed ${this.policy.maxTotalUpstreamBytes}`,
      );
    }
    this.totalBytes += bytes;
  }
}
