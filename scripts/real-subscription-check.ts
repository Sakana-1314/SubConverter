// @ts-nocheck
/**
 * Local real-subscription check (not part of the project's published test suite).
 *
 * Reads the user's already-downloaded subscription from `.private/user-subscription/`
 * and the public ACL4SSR template from `.private/acl4ssr/`, serves both from a
 * loopback fixture server, runs the real Worker entry (`handleRequest`), then
 * validates the generated YAML and loads it with the real mihomo binary.
 *
 * It never fetches the subscription URL and never prints node credentials.
 */

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { handleRequest } from '../src/http/routes';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = join(ROOT, '.private', 'user-subscription');
const SUB_FILE = join(PRIVATE, 'subscription.raw');
const INI_FILE = join(ROOT, '.private', 'acl4ssr', 'ACL4SSR_Online_Full_AdblockPlus.ini');
const MIHOMO = join(ROOT, 'tools', 'mihomo', 'mihomo.exe');
const MIHOMO_DIR = join(ROOT, 'tools', 'mihomo');

const subscription = readFileSync(SUB_FILE, 'utf8');
const ini = readFileSync(INI_FILE, 'utf8');
const RULESET_DIR = join(ROOT, '.private', 'acl4ssr', 'rulesets');
const ruleFiles = existsSync(RULESET_DIR) ? readdirSync(RULESET_DIR).sort() : [];
const useLocalRulesets = process.env.LOCAL_RULESETS === '1';

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/sub') {
    const body = Buffer.from(subscription, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/yaml; charset=utf-8',
      'content-length': String(body.length),
    });
    res.end(body);
    return;
  }
  if (url === '/config.ini') {
    const body = Buffer.from(configText, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(body.length),
    });
    res.end(body);
    return;
  }
  const match = /^\/rules\/(\d+)$/.exec(url);
  if (match) {
    const index = Number(match[1]) - 1;
    const file = ruleFiles[index];
    if (file) {
      const body = readFileSync(join(RULESET_DIR, file));
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;

let configText = ini;
if (useLocalRulesets) {
  let rulesetIndex = 0;
  configText = ini
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim().startsWith('ruleset=')) return line;
      const parts = line.split(',');
      if (parts.length >= 2 && parts[1].startsWith('http')) {
        rulesetIndex += 1;
        parts[1] = `http://127.0.0.1:${port}/rules/${rulesetIndex}`;
        return parts.join(',');
      }
      return line;
    })
    .join('\n');
}

function baseEnv() {
  return {
    UPSTREAM_TIMEOUT_MS: process.env.REAL_UPSTREAM_MS ?? '20000',
    REQUEST_DEADLINE_MS: process.env.REAL_DEADLINE_MS ?? '30000',
    PER_HOP_TIMEOUT_MS: process.env.REAL_HOP_MS ?? '10000',
    MAX_UPSTREAM_BYTES: '8388608',
    MAX_TOTAL_UPSTREAM_BYTES: '33554432',
    MAX_INLINE_BYTES: '8192',
    MAX_INLINE_SOURCE_CHARS: '12000',
    MAX_NODES: '10000',
    MAX_RULES: process.env.REAL_MAX_RULES ?? '50000',
    MAX_GROUPS: '128',
    MAX_REDIRECTS: '3',
    ALLOW_HTTP_UPSTREAM: 'true',
    UPSTREAM_ALLOWED_PORTS: `80,443,${port}`,
    PUBLIC_SUBSCRIPTION_CACHE: 'false',
    SUBSCRIPTION_CACHE_TTL: '60',
    RULESET_CACHE_TTL: '300',
    PUBLIC_ORIGIN: '',
    ENVIRONMENT: 'test',
    ALLOW_TEST_UPSTREAM_HOSTS: `127.0.0.1:${port}`,
  };
}

function readDoc(text) {
  try {
    return parse(text, {
      schema: 'core',
      merge: false,
      maxAliasCount: 50,
      uniqueKeys: true,
    });
  } catch {
    return undefined;
  }
}

function analyze(label, response, text, ms) {
  const doc = readDoc(text);
  const proxies = Array.isArray(doc?.proxies) ? doc.proxies : [];
  const groups = Array.isArray(doc?.['proxy-groups']) ? doc['proxy-groups'] : [];
  const rules = Array.isArray(doc?.rules) ? doc.rules : [];
  const proxyTypes = {};
  for (const p of proxies) {
    const t = p && typeof p === 'object' ? String(p.type ?? '?') : '?';
    proxyTypes[t] = (proxyTypes[t] ?? 0) + 1;
  }
  const ruleTypes = {};
  let invalidTypes = 0;
  let rulesWithoutTarget = 0;
  let doma = 0;
  for (const item of rules) {
    const line = String(item);
    const parts = line.split(',');
    const type = parts[0].trim();
    ruleTypes[type] = (ruleTypes[type] ?? 0) + 1;
    if (type === 'DOMA') doma += 1;
    if (!/^[A-Z][A-Z0-9-]*$/.test(type)) invalidTypes += 1;
    if (parts.length < 3) rulesWithoutTarget += 1;
  }
  const outPath = join(PRIVATE, `real-${label}.yaml`);
  if (response.status === 200) writeFileSync(outPath, text, 'utf8');

  let mihomo = { ran: false, exitCode: -1, stdoutTail: '', stderrTail: '' };
  if (response.status === 200 && existsSync(MIHOMO)) {
    const result = spawnSync(MIHOMO, ['-t', '-d', MIHOMO_DIR, '-f', outPath], {
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    });
    mihomo = {
      ran: true,
      exitCode: typeof result.status === 'number' ? result.status : -1,
      stdoutTail: String(result.stdout ?? '').slice(-500),
      stderrTail: String(result.stderr ?? '').slice(-500),
    };
  }

  return {
    label,
    status: response.status,
    maxRulesEnv: process.env.REAL_MAX_RULES ?? null,
    localRulesets: useLocalRulesets,
    ms,
    bytes: text.length,
    errorBody:
      response.status === 200
        ? ''
        : text.replace(/https?:\/\/\S+/g, '<url>').replace(/[A-Za-z0-9_-]{32,}/g, '<token>').slice(0, 300),
    errorHeader: response.headers.get('x-subconverter-error'),
    warningHeader: response.headers.get('x-subconverter-warnings'),
    warnCodesHeader: response.headers.get('x-subconverter-warn-codes'),
    nodeCountHeader: response.headers.get('x-subconverter-node-count'),
    ruleCountHeader: response.headers.get('x-subconverter-rule-count'),
    parsed: doc !== undefined,
    proxies: proxies.length,
    proxyTypes,
    groups: groups.length,
    rules: rules.length,
    ruleTypes,
    invalidTypes,
    rulesWithoutTarget,
    doma,
    mihomo,
  };
}

async function run(label, query) {
  const started = Date.now();
  const response = await handleRequest(
    new Request(`https://real-check.local/sub?${query}`, { method: 'GET' }),
    baseEnv(),
    {},
  );
  const text = await response.text();
  const ms = Date.now() - started;
  return analyze(label, response, text, ms);
}

const subUrl = encodeURIComponent(`http://127.0.0.1:${port}/sub`);
const configUrl = encodeURIComponent(`http://127.0.0.1:${port}/config.ini`);
const common = `target=clash&url=${subUrl}&new_name=false&insert=false&emoji=false`;

const results = [];
results.push(await run('sub-only', common));
results.push(await run('full-acl4ssr', `${common}&config=${configUrl}`));

// Diagnostics run: same inputs, JSON body, used only to summarize warning details.
const diagResponse = await handleRequest(
  new Request(`https://real-check.local/sub?${common}&config=${configUrl}&diagnostics=json`, {
    method: 'GET',
  }),
  baseEnv(),
  {},
);
const diagText = await diagResponse.text();
let diagSummary = { status: diagResponse.status, stats: null, byCode: {}, details: [] };
try {
  const diag = JSON.parse(diagText);
  const warnings = Array.isArray(diag.warnings) ? diag.warnings : [];
  const byCode = {};
  for (const warning of warnings) {
    const code = String(warning.code ?? '?');
    byCode[code] = (byCode[code] ?? 0) + 1;
  }
  const interesting = new Set([
    'E_TRUNCATED_TAIL',
    'W_RULE_LIMIT',
    'W_RULE_TYPE_UNSUPPORTED',
    'E_FETCH_TIMEOUT',
    'W_RULESET_EMPTY',
  ]);
  diagSummary = {
    status: diagResponse.status,
    stats: diag.stats ?? null,
    byCode,
    details: warnings
      .filter((warning) => interesting.has(String(warning.code ?? '')))
      .map((warning) => ({
        code: String(warning.code ?? '?'),
        message: String(warning.message ?? '').slice(0, 300),
        line: warning.line ?? null,
        sourceId: warning.sourceId ?? null,
      })),
  };
  writeFileSync(join(PRIVATE, 'real-warnings.json'), JSON.stringify(diagSummary, null, 2), 'utf8');
} catch {
  diagSummary = { status: diagResponse.status, stats: null, byCode: {}, details: [] };
}
results.push({ label: 'full-diagnostics', ...diagSummary });

writeFileSync(join(PRIVATE, 'real-check.json'), JSON.stringify(results, null, 2), 'utf8');
console.log(JSON.stringify(results, null, 2));

server.close();
