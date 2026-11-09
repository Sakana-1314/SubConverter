import { encodeBase64Url } from '../../src/links/base64';
import { handleRequest } from '../../src/http/routes';
import type { Env } from '../../src/types';

export const baseEnv: Env = {
  UPSTREAM_TIMEOUT_MS: '8000',
  REQUEST_DEADLINE_MS: '10000',
  PER_HOP_TIMEOUT_MS: '5000',
  MAX_UPSTREAM_BYTES: '8388608',
  MAX_TOTAL_UPSTREAM_BYTES: '16777216',
  MAX_INLINE_BYTES: '8192',
  MAX_INLINE_SOURCE_CHARS: '12000',
  MAX_NODES: '10000',
  MAX_RULES: '50000',
  MAX_GROUPS: '128',
  MAX_REDIRECTS: '3',
  ALLOW_HTTP_UPSTREAM: 'false',
  UPSTREAM_ALLOWED_PORTS: '80,443',
  PUBLIC_SUBSCRIPTION_CACHE: 'false',
  SUBSCRIPTION_CACHE_TTL: '60',
  RULESET_CACHE_TTL: '300',
  PUBLIC_ORIGIN: '',
  ENVIRONMENT: 'production',
  ALLOW_TEST_UPSTREAM_HOSTS: '',
};

export const testEnv: Env = {
  ...baseEnv,
  ALLOW_HTTP_UPSTREAM: 'true',
  UPSTREAM_ALLOWED_PORTS: '80,443,8790',
  ENVIRONMENT: 'test',
  ALLOW_TEST_UPSTREAM_HOSTS: '127.0.0.1:8790',
};

export function inlineSource(text: string): string {
  return `inline:${encodeBase64Url(text)}`;
}

export const SS_URI = 'ss://YWVzLTEyOC1nY206cGFzcw==@1.2.3.4:8388#node1';

export async function call(
  method: string,
  path: string,
  env: Env = baseEnv,
): Promise<Response> {
  return callAt('https://worker.test', method, path, env);
}

export async function callAt(
  origin: string,
  method: string,
  path: string,
  env: Env = baseEnv,
): Promise<Response> {
  return handleRequest(
    new Request(`${origin}${path}`, { method }),
    env,
    {} as ExecutionContext,
  );
}
