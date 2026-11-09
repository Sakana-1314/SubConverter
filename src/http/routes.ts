/**
 * Worker router and HTTP handlers (SPEC §2, ARCHITECTURE §7.4).
 *
 * Routing/method checks/CORS live here; conversion logic is delegated to
 * `services/pipeline.ts` and `services/ruleset.ts`.
 */

import type { Env } from '../types';
import { APP_NAME, VERSION } from '../types';
import { parseEnv, type EnvPolicy } from '../services/env';
import { toAppError } from '../services/errors';
import {
  SourceLoadError,
  type FetchServiceDeps,
} from '../services/fetch';
import { runGetRuleset } from '../services/ruleset';
import { runSub, type SubResult } from '../services/pipeline';
import {
  parseRulesetParams,
  parseSubParams,
  parseRuleSourceParam,
  type SubParams,
} from './params';
import {
  cacheControlFor,
  errorResponse,
  methodNotAllowedResponse,
  noContentResponse,
  notFoundResponse,
  textResponse,
  yamlResponse,
  jsonResponse,
} from './responses';

const REGISTERED = new Set(['/', '/version', '/sub', '/clash', '/getruleset']);

function allowFor(path: string): string {
  return path === '/' || path === '/version' ? 'GET, HEAD, OPTIONS' : 'GET, OPTIONS';
}

function diagnosticsRequested(url: URL): boolean {
  return (url.searchParams.get('diagnostics') ?? '').trim().toLowerCase() === 'json';
}

function targetHeader(): Record<string, string> {
  return { 'X-Subconverter-Target': 'clash' };
}

function runtimeDeps(): FetchServiceDeps {
  return { fetch: globalThis.fetch.bind(globalThis), now: () => Date.now() };
}

const HELP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${APP_NAME} ${VERSION}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:56rem;margin:2rem auto;padding:0 1rem;line-height:1.55;color:#1f2328}
code,pre{background:#f6f8fa;border-radius:4px;padding:.1rem .3rem;font-size:.9em}
pre{padding:.75rem;overflow:auto}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d7de;padding:.35rem .5rem;text-align:left;vertical-align:top}
h1,h2{line-height:1.25}
</style>
</head>
<body>
<h1>${APP_NAME} ${VERSION}</h1>
<p>Subscription converter for mihomo/Clash on Cloudflare Workers.</p>

<h2>Endpoints</h2>
<table>
<tr><th>Endpoint</th><th>Purpose</th></tr>
<tr><td><code>GET /sub</code></td><td>Convert subscriptions to mihomo YAML.</td></tr>
<tr><td><code>GET /clash</code></td><td>Same as <code>/sub?target=clash</code>.</td></tr>
<tr><td><code>GET /getruleset</code></td><td>Validated mihomo rule-provider payload.</td></tr>
<tr><td><code>GET /version</code></td><td>Version text.</td></tr>
</table>

<h2>/sub parameters</h2>
<ul>
<li><code>url</code> (required, repeatable up to 8, or <code>|</code>-separated): <code>inline:&lt;base64url&gt;</code>, <code>data:text/plain;base64,&lt;base64&gt;</code> or http(s) URL. Optional <code>tag:&lt;label&gt;,&lt;source&gt;</code> prefix.</li>
<li><code>target=clash</code>, <code>config</code>, <code>template</code>, <code>ruleset=GROUP,SOURCE[,INTERVAL]</code> (repeatable), <code>groups</code> (base64url).</li>
<li><code>rules_mode=inline|providers</code>, <code>diagnostics=none|json</code>, <code>include</code>, <code>exclude</code>, <code>rename</code> (repeatable).</li>
<li><code>sort</code>, <code>udp</code>, <code>tfo</code>, <code>scv</code>, <code>group</code>, <code>interval</code>, <code>append_info</code>, <code>filename</code>.</li>
</ul>

<h2>Example</h2>
<pre>GET /sub?url=inline:$(printf 'ss://...' | base64url)</pre>

<h2>Diagnostics</h2>
<p>Add <code>diagnostics=json</code> for a structured envelope with warnings and stats.
Warnings are also summarized in <code>X-Subconverter-Warnings</code> and
<code>X-Subconverter-Warn-Codes</code>.</p>
</body>
</html>
`;

function helpResponse(isHead: boolean): Response {
  return textResponse(HELP_HTML, {
    contentType: 'text/html; charset=utf-8',
    cacheControl: cacheControlFor('meta', {
      publicSubscriptionCache: false,
      subscriptionCacheTtl: 0,
      rulesetCacheTtl: 0,
      rulesMode: 'inline',
      publicOrigin: '',
    }),
    extraHeaders: {
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'Referrer-Policy': 'no-referrer',
    },
    isHead,
  });
}

function versionResponse(isHead: boolean): Response {
  return textResponse(`${APP_NAME} ${VERSION} target=clash\n`, {
    contentType: 'text/plain; charset=utf-8',
    cacheControl: cacheControlFor('meta', {
      publicSubscriptionCache: false,
      subscriptionCacheTtl: 0,
      rulesetCacheTtl: 0,
      rulesMode: 'inline',
      publicOrigin: '',
    }),
    isHead,
  });
}

function subSuccessResponse(
  params: SubParams,
  policy: EnvPolicy,
  result: SubResult,
  diagnostics: boolean,
): Response {
  const cacheControl = cacheControlFor('sub', {
    publicSubscriptionCache: policy.publicSubscriptionCache,
    subscriptionCacheTtl: policy.subscriptionCacheTtl,
    rulesetCacheTtl: policy.rulesetCacheTtl,
    rulesMode: params.rulesMode,
    publicOrigin: policy.publicOrigin,
  });
  const extraHeaders: Record<string, string> = {
    ...targetHeader(),
    'X-Subconverter-Node-Count': String(result.stats.nodes),
    'X-Subconverter-Rule-Count': String(result.stats.rules),
    'X-Subconverter-Provider-Count': String(result.stats.providers),
  };
  if (params.interval > 0) {
    extraHeaders['profile-update-interval'] = String(Math.floor(params.interval / 3600));
  }
  if (params.appendInfo && result.userInfo !== undefined) {
    extraHeaders['Subscription-UserInfo'] = result.userInfo;
  }
  if (params.filename !== undefined) {
    const ascii = params.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    extraHeaders['Content-Disposition'] =
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(params.filename)}`;
  }

  if (diagnostics) {
    return jsonResponse(
      {
        ok: true,
        version: VERSION,
        target: 'clash',
        contentType: 'text/yaml; charset=utf-8',
        output: result.yaml,
        stats: result.stats,
        warnings: result.warnings,
      },
      {
        contentType: 'application/json; charset=utf-8',
        cacheControl,
        extraHeaders: { ...extraHeaders, 'X-Subconverter-Diagnostics': 'json' },
        warningCount: result.warningCount,
        warningCodes: result.warningCodes,
      },
    );
  }

  return yamlResponse(result.yaml, {
    contentType: 'text/yaml; charset=utf-8',
    cacheControl,
    extraHeaders,
    warningCount: result.warningCount,
    warningCodes: result.warningCodes,
  });
}

async function handleSub(
  url: URL,
  env: Env,
  forceClash: boolean,
  diagnostics: boolean,
): Promise<Response> {
  let policy: EnvPolicy;
  try {
    policy = parseEnv(env);
  } catch (error) {
    return errorResponse(toAppError(error), {
      diagnostics,
      extraHeaders: targetHeader(),
    });
  }

  let parsed;
  try {
    parsed = parseSubParams(url, forceClash);
  } catch (error) {
    return errorResponse(toAppError(error), {
      diagnostics,
      extraHeaders: targetHeader(),
    });
  }

  try {
    const result = await runSub(
      parsed.params,
      policy,
      runtimeDeps(),
      url.origin,
      parsed.warnings,
      parseRuleSourceParam,
    );
    return subSuccessResponse(parsed.params, policy, result, diagnostics);
  } catch (error) {
    return errorResponse(toAppError(error), {
      diagnostics,
      warnings: parsed.warnings,
      extraHeaders: targetHeader(),
    });
  }
}

async function handleRuleset(url: URL, env: Env, diagnostics: boolean): Promise<Response> {
  let policy: EnvPolicy;
  try {
    policy = parseEnv(env);
  } catch (error) {
    return errorResponse(toAppError(error), { diagnostics });
  }

  let parsed;
  try {
    parsed = parseRulesetParams(url);
  } catch (error) {
    return errorResponse(toAppError(error), { diagnostics });
  }

  let result;
  try {
    result = await runGetRuleset(parsed.params, policy, runtimeDeps(), parsed.warnings);
  } catch (error) {
    if (error instanceof SourceLoadError) {
      return errorResponse(error.appError, { diagnostics, warnings: parsed.warnings });
    }
    return errorResponse(toAppError(error), { diagnostics, warnings: parsed.warnings });
  }

  const cacheControl = cacheControlFor('ruleset', {
    publicSubscriptionCache: policy.publicSubscriptionCache,
    subscriptionCacheTtl: policy.subscriptionCacheTtl,
    rulesetCacheTtl: policy.rulesetCacheTtl,
    rulesMode: 'inline',
    publicOrigin: policy.publicOrigin,
  });
  const extraHeaders: Record<string, string> = {};
  if (result.placeholder) extraHeaders['X-Subconverter-Placeholder'] = '1';

  if (diagnostics) {
    return jsonResponse(
      {
        ok: true,
        type: parsed.params.type,
        output: result.yaml,
        warnings: result.warnings,
        stats: result.stats,
      },
      {
        contentType: 'application/json; charset=utf-8',
        cacheControl,
        extraHeaders: { ...extraHeaders, 'X-Subconverter-Diagnostics': 'json' },
        warningCount: result.warningCount,
        warningCodes: result.warningCodes,
      },
    );
  }

  return yamlResponse(result.yaml, {
    contentType: 'text/yaml; charset=utf-8',
    cacheControl,
    extraHeaders,
    warningCount: result.warningCount,
    warningCodes: result.warningCodes,
  });
}

/**
 * Single Worker entry point. Never throws: unexpected exceptions become a 500
 * JSON/text body without stack traces.
 */
export async function handleRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const diagnostics = diagnosticsRequested(url);

  try {
    if (!REGISTERED.has(path)) {
      return notFoundResponse(method === 'HEAD');
    }

    if (method === 'OPTIONS') {
      return noContentResponse(allowFor(path));
    }

    if (method === 'HEAD') {
      if (path === '/') return helpResponse(true);
      if (path === '/version') return versionResponse(true);
      return methodNotAllowedResponse('GET, OPTIONS', true);
    }

    if (method !== 'GET') {
      return methodNotAllowedResponse(allowFor(path));
    }

    switch (path) {
      case '/':
        return helpResponse(false);
      case '/version':
        return versionResponse(false);
      case '/sub':
        return handleSub(url, env, false, diagnostics);
      case '/clash':
        return handleSub(url, env, true, diagnostics);
      case '/getruleset':
        return handleRuleset(url, env, diagnostics);
      default:
        return notFoundResponse(false);
    }
  } catch (error) {
    return errorResponse(toAppError(error), { diagnostics });
  }
}

/** Exported for tests: the help/version bodies are intentionally static. */
export const HELP_PAGE = HELP_HTML;
