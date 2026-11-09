/**
 * Environment parsing (ARCHITECTURE §2.2).
 *
 * All Worker vars arrive as strings. Invalid values fail closed with a 500
 * (`internal_error`) rather than silently using a different limit.
 */

import { VERSION, type Env } from '../types';
import { AppError } from './errors';

export interface PortRange {
  from: number;
  to: number;
}

export interface EnvPolicy {
  upstreamTimeoutMs: number;
  requestDeadlineMs: number;
  perHopTimeoutMs: number;
  maxUpstreamBytes: number;
  maxTotalUpstreamBytes: number;
  maxInlineBytes: number;
  maxInlineSourceChars: number;
  maxNodes: number;
  maxRules: number;
  maxGroups: number;
  maxRedirects: number;
  allowHttpUpstream: boolean;
  allowedPorts: PortRange[];
  publicSubscriptionCache: boolean;
  subscriptionCacheTtl: number;
  rulesetCacheTtl: number;
  publicOrigin: string;
  environment: 'production' | 'test';
  testHosts: Set<string>;
  userAgent: string;
}

const DEFAULTS = {
  UPSTREAM_TIMEOUT_MS: 8000,
  REQUEST_DEADLINE_MS: 10000,
  PER_HOP_TIMEOUT_MS: 5000,
  MAX_UPSTREAM_BYTES: 8_388_608,
  MAX_TOTAL_UPSTREAM_BYTES: 16_777_216,
  MAX_INLINE_BYTES: 8192,
  MAX_INLINE_SOURCE_CHARS: 12000,
  MAX_NODES: 10_000,
  MAX_RULES: 50_000,
  MAX_GROUPS: 128,
  MAX_REDIRECTS: 3,
  SUBSCRIPTION_CACHE_TTL: 60,
  RULESET_CACHE_TTL: 300,
} as const;

function invalid(name: string, detail: string): never {
  throw new AppError('internal_error', `invalid environment variable ${name}: ${detail}`);
}

function readInt(env: Env, name: keyof Env, min: number, max: number, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw.trim())) invalid(name, 'expected an integer');
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) invalid(name, 'expected a safe integer');
  if (value < min || value > max) invalid(name, `expected ${min}..${max}`);
  return value;
}

function readBool(env: Env, name: keyof Env): boolean {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  invalid(name, 'expected true/false/1/0');
}

function parsePortRangeItem(item: string): PortRange | null {
  const value = item.trim();
  const range = /^(\d{1,5})-(\d{1,5})$/.exec(value);
  if (range !== null) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from < 1 || to > 65535 || from > to) return null;
    return { from, to };
  }
  if (/^\d{1,5}$/.test(value)) {
    const port = Number(value);
    if (port < 1 || port > 65535) return null;
    return { from: port, to: port };
  }
  return null;
}

function readPorts(env: Env): PortRange[] {
  const raw = (env.UPSTREAM_ALLOWED_PORTS ?? '').trim();
  if (raw === '') {
    return [
      { from: 80, to: 80 },
      { from: 443, to: 443 },
    ];
  }
  const ranges: PortRange[] = [];
  for (const item of raw.split(',')) {
    if (item.trim() === '') continue;
    const range = parsePortRangeItem(item);
    if (range === null) invalid('UPSTREAM_ALLOWED_PORTS', `invalid port range "${item}"`);
    ranges.push(range);
  }
  if (ranges.length === 0) {
    return [
      { from: 80, to: 80 },
      { from: 443, to: 443 },
    ];
  }
  return ranges;
}

function readPublicOrigin(env: Env): string {
  const raw = (env.PUBLIC_ORIGIN ?? '').trim();
  if (raw === '') return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid('PUBLIC_ORIGIN', 'not a valid URL');
  }
  if (url.protocol !== 'https:') invalid('PUBLIC_ORIGIN', 'must use https');
  if (url.username !== '' || url.password !== '') invalid('PUBLIC_ORIGIN', 'must not contain userinfo');
  if (url.pathname !== '' && url.pathname !== '/') invalid('PUBLIC_ORIGIN', 'must not contain a path');
  if (url.search !== '' || url.hash !== '') invalid('PUBLIC_ORIGIN', 'must not contain query or fragment');
  return raw.replace(/\/+$/, '');
}

function readTestHosts(env: Env, environment: 'production' | 'test'): Set<string> {
  if (environment !== 'test') return new Set();
  const raw = (env.ALLOW_TEST_UPSTREAM_HOSTS ?? '').trim();
  if (raw === '') return new Set();
  const hosts = new Set<string>();
  for (const item of raw.split(',')) {
    const value = item.trim();
    if (value === '') continue;
    if (!/^[A-Za-z0-9.[\]:-]+:\d{1,5}$/.test(value)) {
      invalid('ALLOW_TEST_UPSTREAM_HOSTS', `invalid host:port "${value}"`);
    }
    hosts.add(value);
  }
  return hosts;
}

function readEnvironment(env: Env): 'production' | 'test' {
  const raw = (env.ENVIRONMENT ?? 'production').trim().toLowerCase();
  if (raw === 'production' || raw === '') return 'production';
  if (raw === 'test') return 'test';
  invalid('ENVIRONMENT', 'expected production or test');
}

/**
 * Parse and validate all env vars. Called once per request (the env object is
 * small; YAML/large objects are never touched here).
 */
export function parseEnv(env: Env): EnvPolicy {
  const environment = readEnvironment(env);

  const upstreamTimeoutMs = readInt(env, 'UPSTREAM_TIMEOUT_MS', 500, 20_000, DEFAULTS.UPSTREAM_TIMEOUT_MS);
  const perHopTimeoutMs = readInt(env, 'PER_HOP_TIMEOUT_MS', 500, 10_000, DEFAULTS.PER_HOP_TIMEOUT_MS);
  const requestDeadlineMs = readInt(env, 'REQUEST_DEADLINE_MS', 1_000, 30_000, DEFAULTS.REQUEST_DEADLINE_MS);
  if (requestDeadlineMs < perHopTimeoutMs) {
    invalid('REQUEST_DEADLINE_MS', 'must be >= PER_HOP_TIMEOUT_MS');
  }

  const maxUpstreamBytes = readInt(env, 'MAX_UPSTREAM_BYTES', 1024, 33_554_432, DEFAULTS.MAX_UPSTREAM_BYTES);
  const maxTotalUpstreamBytes = readInt(
    env,
    'MAX_TOTAL_UPSTREAM_BYTES',
    maxUpstreamBytes,
    67_108_864,
    Math.max(DEFAULTS.MAX_TOTAL_UPSTREAM_BYTES, maxUpstreamBytes),
  );

  return {
    upstreamTimeoutMs,
    requestDeadlineMs,
    perHopTimeoutMs,
    maxUpstreamBytes,
    maxTotalUpstreamBytes,
    maxInlineBytes: readInt(env, 'MAX_INLINE_BYTES', 1024, 8192, DEFAULTS.MAX_INLINE_BYTES),
    maxInlineSourceChars: readInt(
      env,
      'MAX_INLINE_SOURCE_CHARS',
      4096,
      16_000,
      DEFAULTS.MAX_INLINE_SOURCE_CHARS,
    ),
    maxNodes: readInt(env, 'MAX_NODES', 1, 50_000, DEFAULTS.MAX_NODES),
    maxRules: readInt(env, 'MAX_RULES', 1, 200_000, DEFAULTS.MAX_RULES),
    maxGroups: readInt(env, 'MAX_GROUPS', 1, 512, DEFAULTS.MAX_GROUPS),
    maxRedirects: readInt(env, 'MAX_REDIRECTS', 0, 5, DEFAULTS.MAX_REDIRECTS),
    allowHttpUpstream: readBool(env, 'ALLOW_HTTP_UPSTREAM'),
    allowedPorts: readPorts(env),
    publicSubscriptionCache: readBool(env, 'PUBLIC_SUBSCRIPTION_CACHE'),
    subscriptionCacheTtl: readInt(env, 'SUBSCRIPTION_CACHE_TTL', 0, 3600, DEFAULTS.SUBSCRIPTION_CACHE_TTL),
    rulesetCacheTtl: readInt(env, 'RULESET_CACHE_TTL', 0, 86_400, DEFAULTS.RULESET_CACHE_TTL),
    publicOrigin: readPublicOrigin(env),
    environment,
    testHosts: readTestHosts(env, environment),
    userAgent: `subconverter-worker/${VERSION}`,
  };
}
