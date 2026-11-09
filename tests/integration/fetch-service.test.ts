import { describe, expect, it } from 'vitest';
import { encodeBase64, encodeBase64Url } from '../../src/links/base64';
import { parseEnv } from '../../src/services/env';
import { SourceLoader, SourceLoadError, type FetchServiceDeps } from '../../src/services/fetch';
import { baseEnv, inlineSource, testEnv } from './helpers';

const TEST_URL = 'http://127.0.0.1:8790/subscription';

function jsonFetch(body: string, headers: Record<string, string> = {}): typeof globalThis.fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
    })) as unknown as typeof globalThis.fetch;
}

describe('SourceLoader', () => {
  it('decodes inline: and data: sources', async () => {
    const policy = parseEnv(baseEnv);
    const loader = new SourceLoader(policy, {
      fetch: jsonFetch('unused'),
      now: () => 0,
    });

    const inline = await loader.load(
      { raw: inlineSource('hello 世界'), label: 'url#1', sourceId: 'url#1' },
      'subscription',
    );
    expect(inline.text).toBe('hello 世界');
    expect(inline.bytes).toBe(new TextEncoder().encode('hello 世界').length);

    const data = await loader.load(
      {
        raw: `data:text/plain;base64,${encodeBase64('hello data')}`,
        label: 'url#2',
        sourceId: 'url#2',
      },
      'subscription',
    );
    expect(data.text).toBe('hello data');
  });

  it('rejects invalid inline text and private production URLs', async () => {
    const policy = parseEnv(baseEnv);
    const loader = new SourceLoader(policy, { fetch: jsonFetch('unused'), now: () => 0 });

    await expect(
      loader.load({ raw: 'inline:%%%', label: 'url#1', sourceId: 'url#1' }, 'subscription'),
    ).rejects.toBeInstanceOf(SourceLoadError);

    await expect(
      loader.load({ raw: 'https://127.0.0.1/x', label: 'url#1', sourceId: 'url#1' }, 'subscription'),
    ).rejects.toMatchObject({ appError: { code: 'blocked_upstream' } });
  });

  it('allows an exact test fixture host only in test mode', async () => {
    const policy = parseEnv(testEnv);
    const loader = new SourceLoader(policy, { fetch: jsonFetch('synthetic'), now: () => 0 });
    const loaded = await loader.load(
      { raw: TEST_URL, label: 'url#1', sourceId: 'url#1' },
      'subscription',
    );
    expect(loaded.text).toBe('synthetic');

    const production = new SourceLoader(parseEnv(baseEnv), {
      fetch: jsonFetch('synthetic'),
      now: () => 0,
    });
    await expect(
      production.load({ raw: TEST_URL, label: 'url#1', sourceId: 'url#1' }, 'subscription'),
    ).rejects.toMatchObject({ appError: { code: 'blocked_upstream' } });
  });

  it('propagates validated and invalid Subscription-UserInfo', async () => {
    const policy = parseEnv(testEnv);
    const good = new SourceLoader(policy, {
      fetch: jsonFetch('body', {
        'subscription-userinfo': 'upload=1; download=2; total=3; expire=4',
      }),
      now: () => 0,
    });
    const loaded = await good.load({ raw: TEST_URL, label: 'url#1', sourceId: 'url#1' }, 'subscription');
    expect(loaded.userInfo).toBe('upload=1; download=2; total=3; expire=4');
    expect(loaded.userInfoInvalid).toBeUndefined();

    const bad = new SourceLoader(policy, {
      fetch: jsonFetch('body', { 'subscription-userinfo': 'not valid' }),
      now: () => 0,
    });
    const invalid = await bad.load({ raw: TEST_URL, label: 'url#1', sourceId: 'url#1' }, 'subscription');
    expect(invalid.userInfoInvalid).toBe(true);
  });

  it('enforces the request-wide total byte budget', async () => {
    const policy = parseEnv({
      ...testEnv,
      MAX_UPSTREAM_BYTES: '1024',
      MAX_TOTAL_UPSTREAM_BYTES: '1024',
    });
    const loader = new SourceLoader(policy, { fetch: jsonFetch('a'.repeat(800)), now: () => 0 });
    await loader.load({ raw: TEST_URL, label: 'url#1', sourceId: 'url#1' }, 'subscription');
    await expect(
      loader.load({ raw: TEST_URL, label: 'url#2', sourceId: 'url#2' }, 'subscription'),
    ).rejects.toMatchObject({ code: 'upstream_too_large' });
  });

  it('treats MAX_REDIRECTS=0 as a redirect-limit failure', async () => {
    const policy = parseEnv({ ...testEnv, MAX_REDIRECTS: '0' });
    const redirecting = (async () =>
      new Response(null, { status: 302, headers: { location: '/next' } })) as unknown as typeof globalThis.fetch;
    const loader = new SourceLoader(policy, { fetch: redirecting, now: () => 0 });
    await expect(
      loader.load({ raw: TEST_URL, label: 'url#1', sourceId: 'url#1' }, 'subscription'),
    ).rejects.toMatchObject({ appError: { code: 'upstream_network' } });
  });

  it('uses the opt-in Cache API for remote ruleset sources', async () => {
    const store = new Map<string, string>();
    const cache = {
      match: async (request: RequestInfo | URL) => {
        const text = store.get(String(request));
        return text === undefined ? undefined : new Response(text);
      },
      put: async (request: RequestInfo | URL, response: Response) => {
        store.set(String(request), await response.text());
      },
    } as unknown as Cache;

    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response('DOMAIN,example.com');
    }) as unknown as typeof globalThis.fetch;
    const deps: FetchServiceDeps = { fetch: counting, now: () => 0, cache, cacheTtlSeconds: 60 };
    const loader = new SourceLoader(parseEnv(testEnv), deps);

    const first = await loader.load({ raw: TEST_URL, label: 'ruleset#1', sourceId: 'ruleset#1' }, 'ruleset');
    const second = await loader.load({ raw: TEST_URL, label: 'ruleset#2', sourceId: 'ruleset#2' }, 'ruleset');
    expect(first.text).toBe('DOMAIN,example.com');
    expect(second.text).toBe('DOMAIN,example.com');
    expect(calls).toBe(1);
  });

  it('accepts base64url inline sources with padding omitted', async () => {
    const policy = parseEnv(baseEnv);
    const loader = new SourceLoader(policy, { fetch: jsonFetch('unused'), now: () => 0 });
    const loaded = await loader.load(
      { raw: `inline:${encodeBase64Url('abc')}`, label: 'url#1', sourceId: 'url#1' },
      'subscription',
    );
    expect(loaded.text).toBe('abc');
  });

  it('enforces the inline boundaries from SPEC AC-32', async () => {
    const policy = parseEnv(baseEnv);
    const loader = new SourceLoader(policy, { fetch: jsonFetch('unused'), now: () => 0 });

    const atLimit = await loader.load(
      { raw: `inline:${encodeBase64Url('a'.repeat(8192))}`, label: 'url#1', sourceId: 'url#1' },
      'subscription',
    );
    expect(atLimit.bytes).toBe(8192);

    await expect(
      loader.load(
        { raw: `inline:${encodeBase64Url('a'.repeat(8193))}`, label: 'url#1', sourceId: 'url#1' },
        'subscription',
      ),
    ).rejects.toMatchObject({ appError: { code: 'invalid_source' } });

    await expect(
      loader.load(
        { raw: `inline:${'a'.repeat(11994)}`, label: 'url#1', sourceId: 'url#1' },
        'subscription',
      ),
    ).rejects.toMatchObject({ appError: { code: 'invalid_source' } });

    await expect(
      loader.load(
        { raw: `inline:${encodeBase64Url('a'.repeat(16_384))}`, label: 'url#1', sourceId: 'url#1' },
        'subscription',
      ),
    ).rejects.toMatchObject({ appError: { code: 'invalid_source' } });

    await expect(
      loader.load(
        { raw: `https://example.com/${'a'.repeat(4097 - 20)}`, label: 'url#1', sourceId: 'url#1' },
        'subscription',
      ),
    ).rejects.toMatchObject({ appError: { code: 'invalid_source' } });
  });

  it('does not allow a non-matching test fixture host', async () => {
    const policy = parseEnv({ ...testEnv, ALLOW_TEST_UPSTREAM_HOSTS: '127.0.0.1:8791' });
    const loader = new SourceLoader(policy, { fetch: jsonFetch('synthetic'), now: () => 0 });
    await expect(
      loader.load({ raw: TEST_URL, label: 'url#1', sourceId: 'url#1' }, 'subscription'),
    ).rejects.toMatchObject({ appError: { code: 'blocked_upstream' } });
  });
});
