import { describe, expect, it } from 'vitest';
import type { SourceRef } from '../../../src/types';
import {
  fetchSource,
  type FetchDeps,
  type FetchPolicy,
  type FetchResult,
} from '../../../src/links/fetch';

const NOW = 1_000_000;

function policy(overrides: Partial<FetchPolicy> = {}): FetchPolicy {
  return {
    allowHttp: true,
    allowedPorts: [{ from: 1, to: 65535 }],
    environment: 'production',
    testHosts: new Set(),
    maxBytes: 1024,
    maxRedirects: 3,
    timeoutMs: 10_000,
    deadline: NOW + 10_000,
    perHopTimeoutMs: 1000,
    userAgent: 'subconverter-worker-test',
    ...overrides,
  };
}

function deps(fetchImpl: typeof globalThis.fetch, now: () => number = () => NOW): FetchDeps {
  return { fetch: fetchImpl, now };
}

function source(raw: string): SourceRef {
  return { kind: 'http', value: raw, label: 'url#1' };
}

function inline(text: string): SourceRef {
  return { kind: 'inline', value: text, label: 'inline#1', bytes: text.length };
}

function response(
  body: BodyInit | null,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

function expectFailure(result: FetchResult, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

describe('fetchSource: inline sources', () => {
  it('returns the decoded text without touching fetch', async () => {
    let called = false;
    const result = await fetchSource(
      inline('ss://abc'),
      policy(),
      deps(async () => {
        called = true;
        return response('nope');
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('ss://abc');
      expect(result.bytes).toBe(8);
      expect(result.effectiveUrl).toBe('inline:');
      expect(result.status).toBe(200);
    }
    expect(called).toBe(false);
  });

  it('rejects empty and oversized inline content', async () => {
    const empty = await fetchSource(inline('   '), policy(), deps(async () => response('')));
    expectFailure(empty, 'E_FETCH_EMPTY');

    const large = await fetchSource(
      inline('x'.repeat(20)),
      policy({ maxBytes: 10 }),
      deps(async () => response('')),
    );
    expectFailure(large, 'E_FETCH_TOO_LARGE');
  });
});

describe('fetchSource: HTTP success path', () => {
  it('reads the body and sends only the allowed headers', async () => {
    let headers: Record<string, string> = {};
    const result = await fetchSource(
      source('https://example.com/sub'),
      policy(),
      deps(async (_input, init) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
        return response('ss://real', 200, {
          'content-type': 'text/plain; charset=utf-8',
          'subscription-userinfo': 'upload=1; download=2; total=3; expire=4',
        });
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('ss://real');
      expect(result.contentType).toBe('text/plain; charset=utf-8');
      expect(result.status).toBe(200);
      expect(result.redirects).toBe(0);
      expect(result.effectiveUrl).toBe('https://example.com/sub');
      expect(result.userInfo).toBe('upload=1; download=2; total=3; expire=4');
    }

    expect(headers['User-Agent']).toBe('subconverter-worker-test');
    expect(headers['Accept-Encoding']).toBe('identity');
    expect(headers.Cookie).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
  });

  it('drops an invalid Subscription-UserInfo header', async () => {
    const result = await fetchSource(
      source('https://example.com/sub'),
      policy(),
      deps(async () =>
        response('body', 200, { 'subscription-userinfo': 'upload=abc; evil=1' }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userInfo).toBeUndefined();
      expect(result.userInfoInvalid).toBe(true);
    }
  });

  it('accepts JSON bodies that are not error pages', async () => {
    const result = await fetchSource(
      source('https://example.com/sub'),
      policy(),
      deps(async () =>
        response('{"proxies":[]}', 200, { 'content-type': 'application/json' }),
      ),
    );
    expect(result.ok).toBe(true);
  });
});

describe('fetchSource: redirects', () => {
  it('follows manual redirects and reports the effective URL', async () => {
    const seen: string[] = [];
    const result = await fetchSource(
      source('https://example.com/a'),
      policy(),
      deps(async (input) => {
        const url = String(input);
        seen.push(url);
        if (url === 'https://example.com/a') {
          return response('', 302, { location: '/b' });
        }
        return response('final', 200, { 'content-type': 'text/plain' });
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe('final');
      expect(result.redirects).toBe(1);
      expect(result.effectiveUrl).toBe('https://example.com/b');
    }
    expect(seen).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('rejects a redirect to a private address', async () => {
    const result = await fetchSource(
      source('https://example.com/a'),
      policy(),
      deps(async () => response('', 302, { location: 'http://127.0.0.1/internal' })),
    );
    expectFailure(result, 'E_SSRF_BLOCKED');
  });

  it('rejects too many redirects and missing Location', async () => {
    const tooMany = await fetchSource(
      source('https://example.com/a'),
      policy({ maxRedirects: 1 }),
      deps(async () => response('', 302, { location: '/next' })),
    );
    expectFailure(tooMany, 'E_FETCH_REDIRECT_LIMIT');

    const missing = await fetchSource(
      source('https://example.com/a'),
      policy(),
      deps(async () => response('', 302)),
    );
    expectFailure(missing, 'E_FETCH_REDIRECT_LIMIT');
  });
});

describe('fetchSource: content and size guards', () => {
  it('rejects HTML by Content-Type and by body sniffing', async () => {
    const byType = await fetchSource(
      source('https://example.com/sub'),
      policy(),
      deps(async () => response('<html></html>', 200, { 'content-type': 'text/html' })),
    );
    expectFailure(byType, 'E_FETCH_HTML');

    const byBody = await fetchSource(
      source('https://example.com/sub'),
      policy(),
      deps(async () => response('  \uFEFF<!DOCTYPE html><html></html>', 200, {
        'content-type': 'text/plain',
      })),
    );
    expectFailure(byBody, 'E_FETCH_HTML');
  });

  it('rejects JSON error pages but keeps JSON configs', async () => {
    const errorPage = await fetchSource(
      source('https://example.com/sub'),
      policy(),
      deps(async () =>
        response('{"error":"subscription expired"}', 200, {
          'content-type': 'application/json',
        }),
      ),
    );
    expectFailure(errorPage, 'E_FETCH_ERROR_PAGE');
  });

  it('rejects non-2xx statuses', async () => {
    const result = await fetchSource(
      source('https://example.com/sub'),
      policy(),
      deps(async () => response('denied', 403)),
    );
    expectFailure(result, 'E_FETCH_STATUS');
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('rejects Content-Length and streamed bodies above the limit', async () => {
    const byLength = await fetchSource(
      source('https://example.com/sub'),
      policy({ maxBytes: 100 }),
      deps(async () => response('small', 200, { 'content-length': '9999' })),
    );
    expectFailure(byLength, 'E_FETCH_TOO_LARGE');

    const byStream = await fetchSource(
      source('https://example.com/sub'),
      policy({ maxBytes: 100 }),
      deps(async () => response('x'.repeat(500), 200)),
    );
    expectFailure(byStream, 'E_FETCH_TOO_LARGE');
  });

  it('rejects empty bodies and invalid UTF-8', async () => {
    const empty = await fetchSource(
      source('https://example.com/sub'),
      policy(),
      deps(async () => response(null, 200)),
    );
    expectFailure(empty, 'E_FETCH_EMPTY');

    const invalid = await fetchSource(
      source('https://example.com/sub'),
      policy(),
      deps(async () => response(new Uint8Array([0xff, 0xfe, 0xfd]), 200)),
    );
    expectFailure(invalid, 'E_UTF8_INVALID');
  });
});

describe('fetchSource: network and timeout errors', () => {
  it('maps thrown fetch errors to E_FETCH_NETWORK', async () => {
    const result = await fetchSource(
      source('https://example.com/sub'),
      policy(),
      deps(async () => {
        throw new Error('boom');
      }),
    );
    expectFailure(result, 'E_FETCH_NETWORK');
  });

  it('maps per-hop aborts to E_FETCH_TIMEOUT', async () => {
    const result = await fetchSource(
      source('https://example.com/sub'),
      policy({ perHopTimeoutMs: 5 }),
      deps(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );
    expectFailure(result, 'E_FETCH_TIMEOUT');
  });

  it('fails before fetching when the deadline has already passed', async () => {
    let calls = 0;
    const result = await fetchSource(
      source('https://example.com/sub'),
      policy({ deadline: NOW - 1 }),
      deps(async () => {
        calls++;
        return response('x');
      }),
    );
    expectFailure(result, 'E_FETCH_TIMEOUT');
    expect(calls).toBe(0);
  });

  it('rejects SSRF-blocked initial URLs without fetching', async () => {
    let calls = 0;
    const result = await fetchSource(
      source('https://127.0.0.1/sub'),
      policy(),
      deps(async () => {
        calls++;
        return response('x');
      }),
    );
    expectFailure(result, 'E_SSRF_BLOCKED');
    expect(calls).toBe(0);
  });
});
