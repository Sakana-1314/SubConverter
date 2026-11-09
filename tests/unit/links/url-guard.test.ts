import { describe, expect, it } from 'vitest';
import { validateUpstreamUrl, type UrlPolicy } from '../../../src/links/url-guard';

function policy(overrides: Partial<UrlPolicy> = {}): UrlPolicy {
  return {
    allowHttp: false,
    allowedPorts: [{ from: 80, to: 443 }],
    environment: 'production',
    testHosts: new Set(),
    ...overrides,
  };
}

function expectBlocked(raw: string, p: UrlPolicy = policy()): void {
  const result = validateUpstreamUrl(raw, p);
  expect(result.ok, raw).toBe(false);
  if (!result.ok) expect(['blocked_upstream', 'invalid_url']).toContain(result.code);
}

describe('validateUpstreamUrl: accepted inputs', () => {
  it('accepts a normal HTTPS URL', () => {
    const result = validateUpstreamUrl('https://example.com/sub?token=x', policy());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.protocol).toBe('https:');
      expect(result.url.hostname).toBe('example.com');
    }
  });

  it('accepts explicit 443 and strips trailing dots', () => {
    const result = validateUpstreamUrl('https://example.com.:443/sub', policy());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.hostname).toBe('example.com');
  });

  it('rejects HTTP when disabled but accepts it when enabled', () => {
    expectBlocked('http://example.com/sub');
    const result = validateUpstreamUrl('http://example.com/sub', policy({ allowHttp: true }));
    expect(result.ok).toBe(true);
  });

  it('accepts configured ports inside ranges', () => {
    const p = policy({ allowHttp: true, allowedPorts: [{ from: 8080, to: 8081 }] });
    expect(validateUpstreamUrl('http://example.com:8080/x', p).ok).toBe(true);
    expect(validateUpstreamUrl('http://example.com:8081/x', p).ok).toBe(true);
    expectBlocked('http://example.com:8082/x', p);
  });
});

describe('validateUpstreamUrl: SSRF matrix (AC-19)', () => {
  it('blocks loopback, private, link-local, CGNAT and metadata addresses', () => {
    const blocked = [
      'https://127.0.0.1/',
      'https://127.1/',
      'https://2130706433/',
      'https://0x7f000001/',
      'https://0177.0.0.1/',
      'https://10.0.0.1/',
      'https://100.64.0.1/',
      'https://169.254.169.254/',
      'https://172.16.0.1/',
      'https://192.168.0.1/',
      'https://192.0.2.1/',
      'https://198.18.0.1/',
      'https://203.0.113.1/',
      'https://224.0.0.1/',
      'https://[::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[fe80::1]/',
      'https://[fc00::1]/',
      'https://[2001:db8::1]/',
      'https://[2002::1]/',
    ];
    for (const raw of blocked) expectBlocked(raw);
  });

  it('blocks localhost and wildcard DNS services', () => {
    const blocked = [
      'https://localhost/',
      'https://localhost./',
      'https://foo.localhost/',
      'https://foo.local/',
      'https://foo.internal/',
      'https://foo.home.arpa/',
      'https://metadata/',
      'https://metadata.google.internal/',
      'https://instance-data/',
      'https://metadata.azure.com/',
      'https://localtest.me/',
      'https://a.localtest.me/',
      'https://lvh.me/',
      'https://nip.io/',
      'https://127.0.0.1.nip.io/',
      'https://xip.io/',
      'https://1.2.3.4.sslip.io/',
      'https://traefik.me/',
    ];
    for (const raw of blocked) expectBlocked(raw);
  });

  it('blocks userinfo, non-http schemes and malformed URLs', () => {
    const blocked = [
      'https://user:pass@example.com/',
      'https://user@example.com/',
      'file:///etc/passwd',
      'ftp://example.com/',
      'gopher://example.com/',
      'not a url',
      '/relative/path',
      'https://',
      'https://[::gg]/',
    ];
    for (const raw of blocked) expectBlocked(raw);
  });

  it('blocks URLs longer than 4096 characters', () => {
    expectBlocked(`https://example.com/${'a'.repeat(4100)}`);
  });
});

describe('validateUpstreamUrl: test-fixture allowlist (AC-33)', () => {
  const testPolicy = policy({
    allowHttp: true,
    allowedPorts: [{ from: 80, to: 8790 }],
    environment: 'test',
    testHosts: new Set(['127.0.0.1:8790']),
  });

  it('allows an exact host:port in test environment', () => {
    const result = validateUpstreamUrl('http://127.0.0.1:8790/fixture', testPolicy);
    expect(result.ok).toBe(true);
  });

  it('still blocks non-matching host:port in test environment', () => {
    expectBlocked('http://127.0.0.1:8791/fixture', testPolicy);
    expectBlocked('http://127.0.0.1/fixture', testPolicy);
    expectBlocked('http://10.0.0.1:8790/fixture', testPolicy);
    expectBlocked('http://metadata:8790/fixture', testPolicy);
  });

  it('ignores the allowlist in production', () => {
    const production = policy({
      allowHttp: true,
      allowedPorts: [{ from: 80, to: 8790 }],
      environment: 'production',
      testHosts: new Set(['127.0.0.1:8790']),
    });
    expectBlocked('http://127.0.0.1:8790/fixture', production);
  });

  it('still enforces userinfo and protocol rules for allowlisted hosts', () => {
    expectBlocked('http://user:pass@127.0.0.1:8790/fixture', testPolicy);
    expectBlocked('ftp://127.0.0.1:8790/fixture', testPolicy);
  });
});
