import type { Env } from './types';
import { handleRequest } from './http/routes';

/**
 * Cloudflare Worker entry point.
 *
 * All routing/conversion logic lives in `src/http/routes.ts` and
 * `src/services/*`; this file only binds the Worker `fetch` handler to the
 * environment variables.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
