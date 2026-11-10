import type { Env } from './types';
import { handleRequest } from './http/routes';

/**
 * EdgeOne Pages Cloud Functions context (`cloud-functions/`).
 *
 * EdgeOne passes environment variables as a plain object and a web-standard
 * `Request`; there is no Cloudflare `ExecutionContext`. `handleRequest` only
 * uses the context for optional background work, so a minimal shim is enough.
 */
export interface EdgeOneContext {
  request: Request;
  env: Env | Record<string, string | undefined>;
  waitUntil?: (task: Promise<unknown>) => void;
}

export async function handleEdgeOne(context: EdgeOneContext): Promise<Response> {
  const env = context.env as unknown as Env;
  const ctx = {
    waitUntil: context.waitUntil ?? (() => {}),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  return handleRequest(context.request, env, ctx);
}
