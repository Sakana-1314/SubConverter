/**
 * SSRF guard for upstream URLs.
 *
 * Implements docs/SPEC.md §9.2 step by step, fail-closed. No DNS lookup is
 * possible inside Workers (`node:dns` is unavailable), so name-based resolution
 * risks remain; the platform's `global_fetch_strictly_public` flag is the
 * second line of defence.
 *
 * Sources:
 * - docs/ARCHITECTURE.md §7.1.5 (url-guard.ts contract)
 * - docs/SPEC.md §9.2 (validation order), AC-19 / AC-33
 */

import { parseIpLiteral, isPublicIp } from './ip';

export interface PortRange {
  from: number;
  to: number;
}

export interface UrlPolicy {
  allowHttp: boolean;
  allowedPorts: PortRange[];
  environment: 'production' | 'test';
  /** Exact `host:port` entries; only honored when environment === 'test'. */
  testHosts: Set<string>;
}

export type UrlGuardResult =
  | { ok: true; url: URL }
  | { ok: false; code: 'invalid_url' | 'blocked_upstream'; reason: string };

const MAX_URL_LENGTH = 4096;

const DENIED_EXACT = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'metadata.azure.com',
]);

const DENIED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

// Wildcard DNS services (SPEC §9.2 step 5). Both the apex and any subdomain.
const DENIED_WILDCARD_DNS = [
  'localtest.me',
  'lvh.me',
  'vcap.me',
  'nip.io',
  'sslip.io',
  'xip.io',
  'traefik.me',
];

function isDeniedHostname(host: string): boolean {
  if (DENIED_EXACT.has(host)) return true;
  for (const suffix of DENIED_SUFFIXES) {
    if (host.endsWith(suffix)) return true;
  }
  for (const wildcard of DENIED_WILDCARD_DNS) {
    if (host === wildcard || host.endsWith(`.${wildcard}`)) return true;
  }
  return false;
}

function defaultPortFor(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

function portAllowed(port: number, ranges: PortRange[]): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return ranges.some((range) => port >= range.from && port <= range.to);
}

/**
 * Validate a remote source URL.
 *
 * Order matches SPEC §9.2: length → URL → scheme → userinfo → hostname
 * normalization → host deny table → IP literal checks → port.
 */
export function validateUpstreamUrl(raw: string, policy: UrlPolicy): UrlGuardResult {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return { ok: false, code: 'invalid_url', reason: 'URL length is empty or exceeds 4096 characters' };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'invalid_url', reason: 'URL could not be parsed' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'invalid_url', reason: 'only http(s) URLs are accepted' };
  }
  if (url.protocol === 'http:' && !policy.allowHttp) {
    return { ok: false, code: 'invalid_url', reason: 'http upstreams are disabled' };
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'blocked_upstream', reason: 'URL userinfo is not allowed' };
  }

  let hostnameRaw = url.hostname;
  if (hostnameRaw === '') {
    return { ok: false, code: 'invalid_url', reason: 'URL has an empty host' };
  }
  // `URL.hostname` serializes IPv6 with brackets; strip them for parsing.
  const isBracketedV6 = hostnameRaw.startsWith('[') && hostnameRaw.endsWith(']');
  let hostname = (isBracketedV6 ? hostnameRaw.slice(1, -1) : hostnameRaw).toLowerCase();
  // SPEC: strip one or more trailing dots ("localhost." must not bypass).
  hostname = hostname.replace(/\.+$/, '');
  if (hostname === '') {
    return { ok: false, code: 'invalid_url', reason: 'URL has an empty host' };
  }

  if (isDeniedHostname(hostname)) {
    return { ok: false, code: 'blocked_upstream', reason: 'host is in the private/metadata deny list' };
  }

  const port = url.port === '' ? defaultPortFor(url.protocol) : Number(url.port);
  if (!portAllowed(port, policy.allowedPorts)) {
    return { ok: false, code: 'blocked_upstream', reason: 'port is not in the allowed upstream port list' };
  }

  if (!hostname.includes(':') && !isBracketedV6 && hostname !== url.hostname) {
    // Normalize trailing-dot names. The setter works for DNS names and IPv4;
    // IPv6 is left as serialized by the URL implementation.
    try {
      url.hostname = hostname;
    } catch {
      return { ok: false, code: 'invalid_url', reason: 'hostname could not be normalized' };
    }
  }

  const ip = parseIpLiteral(hostname);
  if (ip) {
    const testExempt =
      policy.environment === 'test' &&
      (policy.testHosts.has(url.host) || policy.testHosts.has(`${hostname}:${port}`));
    if (!testExempt && !isPublicIp(ip)) {
      return { ok: false, code: 'blocked_upstream', reason: 'IP literal is not globally routable' };
    }
  } else if (hostname.includes(':')) {
    // Looks like an IPv6 literal but failed to parse: fail closed.
    return { ok: false, code: 'blocked_upstream', reason: 'malformed IP literal' };
  }

  return { ok: true, url };
}
