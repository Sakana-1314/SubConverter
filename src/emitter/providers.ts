/**
 * `rule-providers` emission (SPEC §5.7, §7.5).
 *
 * Providers always point at this Worker's `/getruleset` endpoint, never at the
 * upstream source text. Paths use only safe characters and never contain `..`.
 */

import type { RuleProvider, RulesetFormat, RuleProviderSpec } from '../types';
import {
  DEFAULT_PROVIDER_INTERVAL,
  MAX_PROVIDER_URL_LENGTH,
  RULESET_FORMATS,
  RULESET_TYPE_BY_FORMAT,
} from '../types';
import { EmitterError } from './serialize';

const BEHAVIOR_SET: ReadonlySet<string> = new Set(RULESET_FORMATS);
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_PATH_PATTERN = /^[A-Za-z0-9_./-]+$/;

export function providerTypeFor(behavior: RulesetFormat): 3 | 4 | 6 {
  return RULESET_TYPE_BY_FORMAT[behavior];
}

function normalizeOrigin(origin: string): string {
  if (typeof origin !== 'string' || origin === '') {
    throw new EmitterError('E_EMIT_INVALID', 'provider origin is required for providers mode');
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new EmitterError('E_EMIT_INVALID', `provider origin is not a valid URL: ${origin}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EmitterError('E_EMIT_INVALID', 'provider origin must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new EmitterError('E_EMIT_INVALID', 'provider origin must not contain userinfo');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new EmitterError('E_EMIT_INVALID', 'provider origin must not contain a query or fragment');
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new EmitterError('E_EMIT_INVALID', 'provider origin must not contain a path');
  }
  return origin.replace(/\/+$/, '');
}

function validateProviderUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EmitterError('E_EMIT_INVALID', `provider url is not absolute: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EmitterError('E_EMIT_INVALID', 'provider url must use http or https');
  }
  if (!url.pathname.endsWith('/getruleset')) {
    throw new EmitterError('E_EMIT_INVALID', 'provider url must point at /getruleset');
  }
  if (raw.length > MAX_PROVIDER_URL_LENGTH) {
    throw new EmitterError('E_EMIT_INVALID', `provider url exceeds ${MAX_PROVIDER_URL_LENGTH} characters`);
  }
  return raw;
}

/**
 * Build the provider URL:
 * `<origin>/getruleset?type=<3|4|6>&src=<encoded>&dialect=<dialect>&v=1`.
 * A pre-computed `spec.url` is accepted only if it already points at
 * `/getruleset` on an absolute http(s) URL.
 */
export function buildProviderUrl(spec: RuleProviderSpec, providerOrigin: string): string {
  if (typeof spec.url === 'string' && spec.url !== '') {
    return validateProviderUrl(spec.url);
  }
  const origin = normalizeOrigin(providerOrigin);
  if (!BEHAVIOR_SET.has(spec.behavior)) {
    throw new EmitterError('E_EMIT_INVALID', `provider "${spec.name}" has unsupported behavior "${spec.behavior}"`);
  }
  if (typeof spec.source?.raw !== 'string' || typeof spec.source?.dialect !== 'string') {
    throw new EmitterError('E_EMIT_INVALID', `provider "${spec.name}" is missing its source`);
  }
  const type = providerTypeFor(spec.behavior);
  const url = `${origin}/getruleset?type=${type}`
    + `&src=${encodeURIComponent(spec.source.raw)}`
    + `&dialect=${encodeURIComponent(spec.source.dialect)}`
    + '&v=1';
  if (url.length > MAX_PROVIDER_URL_LENGTH) {
    throw new EmitterError('E_EMIT_INVALID', `provider "${spec.name}" url exceeds ${MAX_PROVIDER_URL_LENGTH} characters`);
  }
  return url;
}

export function providerPath(name: string): string {
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    throw new EmitterError('E_EMIT_INVALID', `provider name "${name}" contains unsafe characters`);
  }
  const path = `./providers/${name}.yaml`;
  if (!PROVIDER_PATH_PATTERN.test(path) || path.includes('..')) {
    throw new EmitterError('E_EMIT_INVALID', `provider path for "${name}" is unsafe`);
  }
  return path;
}

function normalizeInterval(spec: RuleProviderSpec): number {
  const interval = spec.interval;
  if (interval === undefined) return DEFAULT_PROVIDER_INTERVAL;
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 60 || interval > 604800) {
    throw new EmitterError('E_EMIT_INVALID', `provider "${spec.name}" has an invalid interval`);
  }
  return interval;
}

/**
 * Build the `rule-providers` map. Returns `undefined` when there are no
 * providers so the key is omitted entirely (SPEC §7.1).
 */
export function toRuleProviders(
  providers: readonly RuleProviderSpec[],
  providerOrigin: string,
): Record<string, RuleProvider> | undefined {
  if (!Array.isArray(providers) || providers.length === 0) return undefined;

  const result: Record<string, RuleProvider> = {};
  for (const spec of providers) {
    if (spec === null || typeof spec !== 'object') {
      throw new EmitterError('E_EMIT_INVALID', 'rule provider must be an object');
    }
    if (typeof spec.name !== 'string' || !PROVIDER_NAME_PATTERN.test(spec.name)) {
      throw new EmitterError('E_EMIT_INVALID', `rule provider name "${String(spec.name)}" is invalid`);
    }
    if (Object.prototype.hasOwnProperty.call(result, spec.name)) {
      throw new EmitterError('E_EMIT_INVALID', `duplicate rule provider name "${spec.name}"`);
    }
    if (!BEHAVIOR_SET.has(spec.behavior)) {
      throw new EmitterError('E_EMIT_INVALID', `provider "${spec.name}" has unsupported behavior`);
    }
    result[spec.name] = {
      type: 'http',
      behavior: spec.behavior,
      format: 'yaml',
      url: buildProviderUrl(spec, providerOrigin),
      path: providerPath(spec.name),
      interval: normalizeInterval(spec),
    };
  }
  return result;
}
