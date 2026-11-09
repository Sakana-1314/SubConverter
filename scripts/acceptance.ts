// @ts-nocheck
/**
 * Local end-to-end acceptance harness for subconverter-worker.
 *
 * It calls the public Worker entry (`handleRequest` from src/http/routes.ts)
 * programmatically with constructed `Request` objects — no wrangler/workerd
 * required. Sources that exceed the inline limits (the 20k-rule file and the
 * HTML/BOM fixtures) are served by a local 127.0.0.1 fixture server using the
 * documented test-only SSRF allow-list (`ENVIRONMENT=test` +
 * `ALLOW_TEST_UPSTREAM_HOSTS`).
 *
 * Outputs:
 *   out/generated.yaml        main conversion (20k rules + 5 protocols)
 *   out/generated-ini.yaml    ACL4SSR INI conversion
 *   out/acceptance-report.json machine-readable report
 *   docs/acceptance.md        human-readable report
 *
 * The mihomo download + `-t` check is best-effort: a download/run failure is
 * reported as notCovered and never fails the acceptance run itself.
 *
 * `// @ts-nocheck` is intentional: this local harness uses Node built-ins
 * (node:http/fs/child_process) while the project's tsconfig only ships
 * @cloudflare/workers-types for src/. `tsx` executes it directly.
 */

import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { handleRequest } from '../src/http/routes';
import { decodeBase64Text, encodeBase64Url } from '../src/links/base64';
import { getAllRuleTypes, parseRuleLine } from '../src/rules/index';
import { BUILTIN_TARGETS } from '../src/types';

// ---------------------------------------------------------------------------
// Paths / constants
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const E2E_DIR = join(ROOT, 'fixtures', 'e2e');
const OUT_DIR = join(ROOT, 'out');
const TOOLS_DIR = join(ROOT, 'tools');
const MIHOMO_DIR = join(TOOLS_DIR, 'mihomo');
const MIHOMO_EXE = join(MIHOMO_DIR, 'mihomo.exe');
const MIHOMO_SOURCE = join(MIHOMO_DIR, 'source.json');
const GENERATED = join(OUT_DIR, 'generated.yaml');
const GENERATED_INI = join(OUT_DIR, 'generated-ini.yaml');
const REPORT_JSON = join(OUT_DIR, 'acceptance-report.json');
const DOC_MD = join(ROOT, 'docs', 'acceptance.md');

const BIG_RULE_VALID_COUNT = 20_674;
const BIG_RULE_LINE_UNKNOWN = 20_675; // 1-based; 0-based 20674 = "DOMA,example.com"
const BIG_RULE_LINE_TRUNCATED = 20_676; // 1-based; 0-based 20675 = "DOMA" (no final \n)
/** Valid X25519 public key (32 bytes base64url) used by the VLESS Reality fixture. */
const VLESS_REALITY_PBK = '3Y7e1OCa5Lz6v34zpYfM8TId3V_eqI8mVYwUmK1Y2NY';

/** Independent copy of the SPEC §5.1 37-type registry (do not import). */
const INDEPENDENT_RULE_TYPES = new Set([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'DOMAIN-WILDCARD',
  'GEOSITE',
  'GEOIP',
  'SRC-GEOIP',
  'IP-ASN',
  'SRC-IP-ASN',
  'IP-CIDR',
  'IP-CIDR6',
  'SRC-IP-CIDR',
  'IP-SUFFIX',
  'SRC-IP-SUFFIX',
  'SRC-PORT',
  'DST-PORT',
  'IN-PORT',
  'DSCP',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX',
  'PROCESS-NAME-WILDCARD',
  'PROCESS-PATH-WILDCARD',
  'NETWORK',
  'UID',
  'IN-TYPE',
  'IN-USER',
  'IN-NAME',
  'REMATCH-NAME',
  'SUB-RULE',
  'AND',
  'OR',
  'NOT',
  'RULE-SET',
  'MATCH',
]);

const COMMA_BEARING_TYPES = new Set([
  'DOMAIN-REGEX',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX',
  'AND',
  'OR',
  'NOT',
  'SUB-RULE',
]);

const GROUP_TYPES = new Set(['select', 'url-test', 'fallback', 'load-balance']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const checks = [];
const notCovered = [];
const runInfo = {
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  workspace: ROOT,
  fixtures: [],
  mainRequest: '',
  stats: null,
  generatedBytes: 0,
  iniBytes: 0,
  iniStats: null,
  fixtureRequests: [],
};
let requiredFailure = false;

function addCheck(name, passed, evidence, required = true) {
  checks.push({ name, passed: Boolean(passed), evidence: String(evidence), required });
  if (required && !passed) requiredFailure = true;
}

function errorText(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function ruleToken(line) {
  const comma = line.indexOf(',');
  return (comma === -1 ? line : line.slice(0, comma)).trim().toUpperCase();
}

function ruleTarget(line) {
  const comma = line.indexOf(',');
  if (comma === -1) return '';
  const token = ruleToken(line);
  if (token === 'MATCH') return line.slice(comma + 1).trim();
  if (COMMA_BEARING_TYPES.has(token)) return line.slice(line.lastIndexOf(',') + 1).trim();
  const fields = line.split(',');
  return (fields[2] ?? '').trim();
}

function warningSummary(warning) {
  return `${warning.code}@line=${warning.line ?? '-'} raw=${JSON.stringify(warning.raw ?? '')} source=${warning.source ?? '-'}`;
}

function findWarnings(warnings, predicate) {
  return warnings.filter(predicate);
}

// ---------------------------------------------------------------------------
// Independent rule validation (deliberately does not import the registry)
// ---------------------------------------------------------------------------

function independentRuleError(line, knownTargets) {
  if (typeof line !== 'string') return 'rule is not a string';
  if (line === '' || line.trim() !== line) return 'rule is empty or has outer whitespace';
  if (line.length > 4096) return 'rule exceeds 4096 characters';
  if (/[\u0000-\u001f\u007f]/.test(line)) return 'rule contains control characters';

  const comma = line.indexOf(',');
  if (comma === -1) return 'rule has no comma (missing target)';
  const token = line.slice(0, comma).trim().toUpperCase();
  if (!INDEPENDENT_RULE_TYPES.has(token)) return `type ${token} is not in the independent whitelist`;
  if (token === 'SUB-RULE') return 'SUB-RULE must never be emitted by v1';

  if (token === 'MATCH') {
    const rest = line.slice(comma + 1).trim();
    if (rest === '' || rest.includes(',')) return 'MATCH must be exactly MATCH,TARGET';
    if (!knownTargets.has(rest)) return `MATCH target ${rest} does not exist`;
    return null;
  }

  let payload;
  let target;
  let params;
  if (COMMA_BEARING_TYPES.has(token)) {
    const last = line.lastIndexOf(',');
    if (last <= comma) return `${token} has no target field`;
    payload = line.slice(comma + 1, last).trim();
    target = line.slice(last + 1).trim();
    params = [];
  } else {
    const fields = line.split(',');
    if (fields.length < 3) return `${token} has fewer than 3 fields (missing target)`;
    if (fields.length > 4) return `${token} has more than 4 fields`;
    payload = fields[1].trim();
    target = fields[2].trim();
    params = fields.slice(3).map((value) => value.trim());
  }

  if (payload === '') return `${token} has an empty payload`;
  if (target === '') return `${token} has an empty target`;
  if (!knownTargets.has(target)) return `${token} target ${target} does not exist`;
  for (const param of params) {
    if (param !== 'no-resolve') return `${token} has an unsupported parameter ${param}`;
  }

  if (token === 'DOMAIN' || token === 'DOMAIN-SUFFIX') {
    if (payload.length > 253) return `${token} payload is longer than 253 characters`;
    if (/[\s,\/:*?#]/.test(payload)) return `${token} payload has a forbidden character`;
    if (payload !== payload.toLowerCase()) return `${token} payload is not lowercase`;
  }
  if (token === 'IP-CIDR' && !/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(payload)) {
    return 'IP-CIDR payload is not IPv4 CIDR shaped';
  }
  if (token === 'IP-CIDR6' && !/^[0-9a-fA-F:]+\/\d{1,3}$/.test(payload)) {
    return 'IP-CIDR6 payload is not IPv6 CIDR shaped';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function baseEnv(port) {
  return {
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

async function callSub(query) {
  const response = await handleRequest(
    new Request(`https://acceptance.local/sub?${query}`, { method: 'GET' }),
    baseEnv(runInfo.port),
    {},
  );
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { response, text, body };
}

function yamlReadback(text) {
  return parse(text, {
    schema: 'core',
    merge: false,
    maxAliasCount: 50,
    uniqueKeys: true,
  });
}

/**
 * Shared structural + rule validation used for both generated documents.
 * Returns { failures, doc, knownTargets } and adds individual checks.
 */
function validateDocument({ prefix, yamlText, warnings, checkPrefix }) {
  const result = { doc: undefined, failures: [], knownTargets: new Set() };
  let doc;
  try {
    doc = yamlReadback(yamlText);
  } catch (error) {
    addCheck(`${prefix}_yaml_readback`, false, `yaml.parse failed: ${errorText(error)}`);
    return result;
  }
  result.doc = doc;
  const structural = [];
  if (!isPlainObject(doc)) structural.push('root is not an object');
  if (!Array.isArray(doc?.proxies)) structural.push('proxies is not an array');
  if (!Array.isArray(doc?.['proxy-groups'])) structural.push('proxy-groups is not an array');
  if (!Array.isArray(doc?.rules)) structural.push('rules is not an array');
  if (!yamlText.endsWith('\n') || yamlText.endsWith('\n\n')) structural.push('output must end with exactly one newline');
  addCheck(
    `${prefix}_yaml_readback`,
    structural.length === 0,
    structural.length === 0
      ? `yaml.parse OK; proxies=${doc.proxies.length} groups=${doc['proxy-groups'].length} rules=${doc.rules.length}`
      : structural.join('; '),
  );
  if (structural.length > 0) return result;

  const proxyNames = new Set(doc.proxies.map((proxy) => proxy.name));
  const groupNames = new Set(doc['proxy-groups'].map((group) => group.name));
  const knownTargets = new Set([...proxyNames, ...groupNames, ...BUILTIN_TARGETS]);
  result.knownTargets = knownTargets;
  const knownProviders = new Set(Object.keys(doc['rule-providers'] ?? {}));

  // --- proxies: integer ports + protocol whitelist ---
  const proxyErrors = [];
  for (const [index, proxy] of doc.proxies.entries()) {
    if (!isPlainObject(proxy)) {
      proxyErrors.push(`proxies[${index}] is not an object`);
      continue;
    }
    if (typeof proxy.name !== 'string' || proxy.name === '') proxyErrors.push(`proxies[${index}].name`);
    if (typeof proxy.type !== 'string') proxyErrors.push(`proxies[${index}].type`);
    if (!Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) {
      proxyErrors.push(`proxies[${index}].port=${JSON.stringify(proxy.port)}`);
    }
  }
  addCheck(
    `${prefix}_proxy_fields`,
    proxyErrors.length === 0,
    proxyErrors.length === 0 ? `all ${doc.proxies.length} proxies have valid name/type/integer port` : proxyErrors.join('; '),
  );

  // --- proxy-groups: known type, non-empty, resolvable members, no duplicates/self ---
  const groupErrors = [];
  for (const group of doc['proxy-groups']) {
    if (!isPlainObject(group)) {
      groupErrors.push('group is not an object');
      continue;
    }
    if (typeof group.name !== 'string' || group.name === '') groupErrors.push('group name missing');
    if (!GROUP_TYPES.has(group.type)) groupErrors.push(`group ${group.name} type ${group.type} unsupported`);
    const members = group.proxies;
    if (!Array.isArray(members) || members.length === 0) {
      groupErrors.push(`group ${group.name} has no members`);
      continue;
    }
    const seen = new Set();
    for (const member of members) {
      if (typeof member !== 'string' || member === '') {
        groupErrors.push(`group ${group.name} has a non-string member`);
        continue;
      }
      if (member === group.name) groupErrors.push(`group ${group.name} references itself`);
      if (seen.has(member)) groupErrors.push(`group ${group.name} repeats ${member}`);
      seen.add(member);
      if (!knownTargets.has(member)) groupErrors.push(`group ${group.name} member ${member} does not exist`);
    }
  }
  addCheck(
    `${prefix}_group_references_exist`,
    groupErrors.length === 0,
    groupErrors.length === 0
      ? `${doc['proxy-groups'].length} groups; all members resolve to proxies/groups/builtins`
      : groupErrors.slice(0, 8).join('; '),
  );

  // --- rules: project parser + independent whitelist + target existence ---
  const projectFailures = [];
  for (let index = 0; index < doc.rules.length; index += 1) {
    const line = doc.rules[index];
    const parsedLine = parseRuleLine(
      line,
      {
        sourceId: 'readback',
        mode: 'template',
        knownTargets,
        knownProviders,
        allowMatch: true,
      },
      index + 1,
    );
    if (!parsedLine.ok) {
      projectFailures.push({
        index,
        line,
        warnings: parsedLine.warnings.map((warning) => warning.code ?? warning.message),
      });
    }
  }
  addCheck(
    `${prefix}_project_rule_revalidation`,
    projectFailures.length === 0,
    projectFailures.length === 0
      ? `${doc.rules.length} emitted rules re-parsed with rules.parseRuleLine (mode=template, knownTargets+knownProviders)`
      : `${projectFailures.length} failures; first=${JSON.stringify(projectFailures[0])}`,
  );

  const independentFailures = [];
  for (const line of doc.rules) {
    const failure = independentRuleError(line, knownTargets);
    if (failure !== null) independentFailures.push({ line, failure });
  }
  const matchIndexes = doc.rules
    .map((line, index) => (ruleToken(line) === 'MATCH' ? index : -1))
    .filter((index) => index >= 0);
  if (matchIndexes.length !== 1) independentFailures.push({ line: '', failure: `expected exactly one MATCH, found ${matchIndexes.length}` });
  if (matchIndexes.length === 1 && matchIndexes[0] !== doc.rules.length - 1) {
    independentFailures.push({ line: '', failure: 'MATCH is not the last rule' });
  }
  const domaRules = doc.rules.filter((line) => /^DOMA(?:,|$)/.test(line));
  if (domaRules.length > 0) independentFailures.push({ line: domaRules[0], failure: 'DOMA leaked into output' });

  const projectTypes = [...getAllRuleTypes()].sort();
  const independentTypes = [...INDEPENDENT_RULE_TYPES].sort();
  const registryMatches =
    projectTypes.length === 37 &&
    independentTypes.length === 37 &&
    JSON.stringify(projectTypes) === JSON.stringify(independentTypes);
  addCheck(
    `${prefix}_independent_whitelist_validation`,
    independentFailures.length === 0 && registryMatches,
    independentFailures.length === 0 && registryMatches
      ? `${doc.rules.length} rules: all types in the independent 37-type whitelist; targets resolve; exactly one trailing MATCH`
      : `${independentFailures.length} failures; registryMatches=${registryMatches}; first=${JSON.stringify(independentFailures[0])}`,
  );

  const missingTargets = [];
  for (const line of doc.rules) {
    const target = ruleTarget(line);
    if (target === '' || !knownTargets.has(target)) missingTargets.push({ line, target });
  }
  addCheck(
    `${prefix}_rule_targets_exist`,
    missingTargets.length === 0,
    missingTargets.length === 0
      ? `all ${doc.rules.length} rule targets are generated groups, proxies or builtins`
      : `${missingTargets.length} missing targets; first=${JSON.stringify(missingTargets[0])}`,
  );

  result.failures = independentFailures;
  return result;
}

// ---------------------------------------------------------------------------
// Fixture server
// ---------------------------------------------------------------------------

function startFixtureServer(fixtures) {
  const served = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const fixture = fixtures.get(pathname);
    if (fixture === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    served.push(pathname);
    response.writeHead(200, {
      'content-type': fixture.contentType,
      'content-length': String(fixture.body.length),
    });
    response.end(fixture.body);
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise({ server, port: address.port, served });
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

// ---------------------------------------------------------------------------
// mihomo download + run (best effort)
// ---------------------------------------------------------------------------

function runCommand(command, args, timeoutMs) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function findFileRecursive(directory, name) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findFileRecursive(full, name);
      if (nested !== null) return nested;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

function extractZip(zipPath, destination) {
  const listing = runCommand('tar', ['-tf', zipPath], 60_000);
  if (listing.status !== 0) {
    throw new Error(`tar -tf failed: ${(listing.stderr || listing.stdout || '').trim()}`);
  }
  const entries = String(listing.stdout).split(/\r?\n/).filter((line) => line !== '');
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`unsafe zip entry rejected: ${entry}`);
    }
  }
  let extracted = runCommand('tar', ['-xf', zipPath, '-C', destination], 120_000);
  if (extracted.status !== 0) {
    const quote = (value) => `'${value.replace(/'/g, "''")}'`;
    extracted = runCommand(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destination)} -Force`,
      ],
      120_000,
    );
  }
  if (extracted.status !== 0) {
    throw new Error(`zip extraction failed: ${(extracted.stderr || extracted.stdout || '').trim()}`);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function readManifest() {
  if (!existsSync(MIHOMO_SOURCE)) return null;
  try {
    return JSON.parse(readFileSync(MIHOMO_SOURCE, 'utf8'));
  } catch {
    return null;
  }
}

function findLocalAsset(assetName) {
  const direct = join(MIHOMO_DIR, assetName);
  if (existsSync(direct)) return direct;
  let entries = [];
  try {
    entries = readdirSync(MIHOMO_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = join(MIHOMO_DIR, entry.name, assetName);
    if (existsSync(nested)) return nested;
  }
  return null;
}

/**
 * Download with curl (bundled with Windows 10+/macOS/Linux). Resume is used
 * when a partial file is present, because the GitHub CDN is very slow from
 * some networks. `spawnSync` bounds the wait (SPEC's acceptance harness must
 * never hang forever on a download).
 */
function downloadWithCurl(url, destination, expectedSize) {
  const existing = existsSync(destination) ? statSync(destination).size : 0;
  const args = [
    '-L',
    '--fail',
    '--show-error',
    '--max-time',
    '900',
    '--speed-limit',
    '512',
    '--speed-time',
    '60',
    '-o',
    destination,
  ];
  if (existing > 0 && existing < expectedSize) args.splice(1, 0, '-C', '-');
  args.push(url);
  const result = runCommand('curl', args, 920_000);
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`curl could not be started: ${errorText(result.error)}`);
  }
  if (result.status !== 0) {
    throw new Error(`curl exit ${result.status}: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
  }
  const bytes = readFileSync(destination);
  if (bytes.length !== expectedSize) {
    throw new Error(`downloaded size ${bytes.length} != release asset size ${expectedSize}`);
  }
  return bytes;
}

async function ensureMihomoBinary() {
  const manifest = readManifest();
  if (existsSync(MIHOMO_EXE)) {
    return {
      exePath: MIHOMO_EXE,
      manifest,
      cached: true,
      downloadMethod: manifest?.downloadMethod
        ? `${manifest.downloadMethod} (cached binary reused)`
        : 'cached binary',
    };
  }

  mkdirSync(MIHOMO_DIR, { recursive: true });
  const apiResponse = await fetchWithTimeout(
    'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest',
    {
      headers: {
        'User-Agent': 'subconverter-worker-acceptance',
        Accept: 'application/vnd.github+json',
      },
    },
    60_000,
  );
  if (!apiResponse.ok) throw new Error(`GitHub API HTTP ${apiResponse.status}`);
  const release = await apiResponse.json();

  const windowsAmd64 = (release.assets ?? []).filter(
    (asset) => /^mihomo-windows-amd64-v.*\.zip$/i.test(asset.name) && !/compatible/i.test(asset.name),
  );
  const asset =
    windowsAmd64.find((candidate) => /^mihomo-windows-amd64-v\d+\.\d+\.\d+\.zip$/i.test(candidate.name)) ??
    windowsAmd64[0];
  if (asset === undefined) throw new Error('no mihomo-windows-amd64 release asset found');

  const checksumAsset = (release.assets ?? []).find((candidate) =>
    /(sha256|checksums?)(\.txt)?$/i.test(candidate.name),
  );

  const stamp = `${Date.now()}-${process.pid}`;
  const extractDir = join(MIHOMO_DIR, `.extract-${stamp}`);
  mkdirSync(extractDir, { recursive: true });

  let zipPath;
  let buffer;
  let downloadMethod;
  const localAsset = findLocalAsset(asset.name);
  try {
    if (localAsset !== null && statSync(localAsset).size === asset.size) {
      zipPath = localAsset;
      buffer = readFileSync(localAsset);
      downloadMethod = `reused official asset already present at ${localAsset}`;
    } else {
      zipPath = join(MIHOMO_DIR, asset.name);
      buffer = downloadWithCurl(asset.browser_download_url, zipPath, asset.size);
      downloadMethod = 'curl (GitHub official release asset)';
    }

    let checksumStatus = 'official release publishes no SHA-256 checksum asset';
    if (checksumAsset !== undefined) {
      const checksumResponse = await fetchWithTimeout(
        checksumAsset.browser_download_url,
        { headers: { 'User-Agent': 'subconverter-worker-acceptance' } },
        60_000,
      );
      if (!checksumResponse.ok) throw new Error(`checksum download HTTP ${checksumResponse.status}`);
      const checksumText = await checksumResponse.text();
      const line = checksumText
        .split(/\r?\n/)
        .find((candidate) => candidate.trim().toLowerCase().endsWith(asset.name.toLowerCase()));
      if (line === undefined) throw new Error(`checksum entry for ${asset.name} not found`);
      const expected = line.trim().split(/\s+/)[0].toLowerCase();
      const actual = createHash('sha256').update(buffer).digest('hex');
      if (expected !== actual) throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`);
      checksumStatus = `verified against ${checksumAsset.name}`;
    }

    const digest = createHash('sha256').update(buffer).digest('hex');
    extractZip(zipPath, extractDir);
    const extractedExe = findFileRecursive(extractDir, 'mihomo.exe');
    if (extractedExe === null) throw new Error('mihomo.exe not found in the extracted archive');
    copyFileSync(extractedExe, MIHOMO_EXE);

    const manifestValue = {
      releaseTag: release.tag_name,
      assetName: asset.name,
      url: asset.browser_download_url,
      assetSize: asset.size,
      downloadedBytes: buffer.length,
      sha256: digest,
      checksum: checksumStatus,
      downloadMethod,
      downloadedAt: new Date().toISOString(),
      exePath: MIHOMO_EXE,
    };
    writeFileSync(MIHOMO_SOURCE, `${JSON.stringify(manifestValue, null, 2)}\n`);
    return { exePath: MIHOMO_EXE, manifest: manifestValue, cached: false, downloadMethod };
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

async function runMihomoValidation() {
  const outcome = {
    attempted: false,
    passed: false,
    command: 'tools/mihomo/mihomo.exe -t -d tools/mihomo -f out/generated.yaml',
    cached: false,
    downloadMethod: null,
    manifest: null,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    error: null,
    skipReason: null,
  };
  if (process.env.ACCEPTANCE_SKIP_MIHOMO === '1') {
    outcome.skipReason = 'mihomo -t skipped for this iteration (ACCEPTANCE_SKIP_MIHOMO=1)';
    return outcome;
  }
  try {
    const prepared = await ensureMihomoBinary();
    outcome.attempted = true;
    outcome.cached = prepared.cached;
    outcome.downloadMethod = prepared.downloadMethod ?? null;
    outcome.manifest = prepared.manifest;
    const run = runCommand(
      prepared.exePath,
      ['-t', '-d', MIHOMO_DIR, '-f', GENERATED],
      180_000,
    );
    outcome.exitCode = run.status;
    outcome.signal = run.signal;
    outcome.stdout = String(run.stdout ?? '').slice(0, 20_000);
    outcome.stderr = String(run.stderr ?? '').slice(0, 20_000);
    if (run.error !== undefined && run.error !== null) {
      outcome.error = errorText(run.error);
    }
    outcome.passed = run.status === 0;
  } catch (error) {
    outcome.attempted = true;
    outcome.error = errorText(error);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Report writing
// ---------------------------------------------------------------------------

function mdCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function truncate(value, limit = 500) {
  const text = String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…(${text.length} chars)`;
}

function writeReports(mihomoOutcome, fatalError) {
  const passed = checks.filter((check) => check.passed).length;
  const failedRequired = checks.filter((check) => check.required && !check.passed);
  const report = {
    startedAt: runInfo.startedAt,
    finishedAt: new Date().toISOString(),
    command: 'npm.cmd run acceptance',
    node: runInfo.node,
    platform: runInfo.platform,
    workspace: runInfo.workspace,
    fatalError: fatalError ?? null,
    summary: {
      checks: checks.length,
      passed,
      failed: checks.length - passed,
      requiredFailed: failedRequired.length,
      exitCode: failedRequired.length === 0 && fatalError === undefined ? 0 : 1,
    },
    fixtures: runInfo.fixtures,
    mainRequest: runInfo.mainRequest,
    stats: runInfo.stats,
    generatedConfig: GENERATED,
    generatedBytes: runInfo.generatedBytes,
    iniConfig: GENERATED_INI,
    iniBytes: runInfo.iniBytes,
    iniStats: runInfo.iniStats,
    fixtureRequests: runInfo.fixtureRequests,
    checks,
    mihomo: mihomoOutcome,
    notCovered,
  };
  writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);

  const lines = [];
  lines.push('# Acceptance report');
  lines.push('');
  lines.push(`- Generated at: ${report.finishedAt}`);
  lines.push('- Command: `npm.cmd run acceptance` (runs `tsx scripts/acceptance.ts`)');
  lines.push(`- Platform: ${runInfo.platform}; Node ${runInfo.node}`);
  lines.push(`- Workspace: \`${runInfo.workspace}\``);
  lines.push(`- Result: **${report.summary.exitCode === 0 ? 'PASS' : 'FAIL'}** — ${passed}/${checks.length} checks passed`);
  lines.push(`- Exit code: ${report.summary.exitCode}`);
  if (fatalError !== undefined && fatalError !== null) {
    lines.push(`- Fatal harness error: ${mdCell(fatalError)}`);
  }
  lines.push('');
  lines.push('## Fixtures');
  lines.push('');
  lines.push('| Fixture | Size | Shape |');
  lines.push('|---|---:|---|');
  for (const fixture of runInfo.fixtures) {
    lines.push(`| \`${fixture.path}\` | ${fixture.size} B | ${mdCell(fixture.shape)} |`);
  }
  lines.push('');
  lines.push('The 20k-rule fixture is intentionally oversized for `inline:` (526,435 B > 8,192 B decoded limit), so it is served by a loopback fixture server through the documented `ENVIRONMENT=test` / `ALLOW_TEST_UPSTREAM_HOSTS` escape hatch. Its layout is:');
  lines.push('');
  lines.push('- lines 1..20674: `DOMAIN,x<N>.example.com` (20,674 legal rules)');
  lines.push('- line 20675 (0-based 20674): `DOMA,example.com`');
  lines.push('- line 20676 (0-based 20675): `DOMA`, with no final newline (truncated tail)');
  lines.push('- `fixtures/e2e/rules-bom-crlf.txt`: UTF-8 BOM + CRLF rules');
  lines.push('- `fixtures/e2e/error-page.html`: HTML error page, must fail the source only');
  lines.push('');
  lines.push('## Conversion');
  lines.push('');
  lines.push(`- Main request: \`/sub?${mdCell(truncate(runInfo.mainRequest, 600))}\``);
  lines.push(`- Generated config: \`${GENERATED}\` (${runInfo.generatedBytes} B)`);
  lines.push(`- Stats: \`${mdCell(JSON.stringify(runInfo.stats))}\``);
  lines.push(`- INI config: \`${GENERATED_INI}\` (${runInfo.iniBytes} B)`);
  lines.push(`- INI stats: \`${mdCell(JSON.stringify(runInfo.iniStats))}\``);
  lines.push(`- Loopback fixture requests served: ${runInfo.fixtureRequests.length === 0 ? '(none)' : runInfo.fixtureRequests.join(', ')}`);
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  lines.push('| # | Check | Result | Evidence |');
  lines.push('|---:|---|---|---|');
  checks.forEach((check, index) => {
    lines.push(`| ${index + 1} | \`${check.name}\` | ${check.passed ? 'PASS' : 'FAIL'} | ${mdCell(truncate(check.evidence, 700))} |`);
  });
  lines.push('');
  lines.push('## mihomo client validation');
  lines.push('');
  if (!mihomoOutcome.attempted) {
    lines.push(mihomoOutcome.skipReason ?? 'Not attempted.');
  } else {
    lines.push(`- Command: \`${mihomoOutcome.command}\``);
    lines.push(`- Binary cached: ${mihomoOutcome.cached ? 'yes' : 'no'}`);
    if (mihomoOutcome.downloadMethod) lines.push(`- Acquisition: ${mdCell(mihomoOutcome.downloadMethod)}`);
    if (mihomoOutcome.manifest !== null) {
      const manifest = mihomoOutcome.manifest;
      lines.push(`- Official release: \`${manifest.releaseTag}\``);
      lines.push(`- Asset: \`${manifest.assetName}\``);
      lines.push(`- URL: ${manifest.url}`);
      lines.push(`- Asset size (GitHub API): ${manifest.assetSize} B; downloaded: ${manifest.downloadedBytes} B`);
      lines.push(`- SHA-256 (computed locally): \`${manifest.sha256}\``);
      lines.push(`- Checksum: ${manifest.checksum}`);
    }
    lines.push(`- Exit code: ${mihomoOutcome.exitCode === null ? 'n/a' : mihomoOutcome.exitCode}${mihomoOutcome.signal ? ` (signal ${mihomoOutcome.signal})` : ''}`);
    lines.push(`- stderr: ${mihomoOutcome.stderr === '' ? 'empty (0 bytes)' : `${Buffer.byteLength(mihomoOutcome.stderr)} bytes`}`);
    if (mihomoOutcome.error !== null) lines.push(`- Error: ${mdCell(mihomoOutcome.error)}`);
    if (mihomoOutcome.stderr !== '') {
      lines.push('- stderr (tail):');
      lines.push('```text');
      lines.push(mihomoOutcome.stderr.slice(-4000));
      lines.push('```');
    }
    if (mihomoOutcome.stdout !== '') {
      lines.push('- stdout (tail):');
      lines.push('```text');
      lines.push(mihomoOutcome.stdout.slice(-4000));
      lines.push('```');
    }
    lines.push(`- Verdict: ${mihomoOutcome.passed ? 'PASS (`mihomo -t` exit 0)' : 'notCovered (download or execution failed; acceptance does not fail for this)'}`);
  }
  lines.push('');
  lines.push('## Not covered');
  lines.push('');
  if (notCovered.length === 0) {
    lines.push('Nothing.');
  } else {
    for (const item of notCovered) lines.push(`- ${item}`);
  }
  lines.push('');
  writeFileSync(DOC_MD, `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(MIHOMO_DIR, { recursive: true });

  // -------------------------------------------------------------------------
  // Load + validate fixtures
  // -------------------------------------------------------------------------
  const subscriptionPath = join(E2E_DIR, 'subscription.txt');
  const bigRulesPath = join(E2E_DIR, 'rules-big.txt');
  const bomCrlfPath = join(E2E_DIR, 'rules-bom-crlf.txt');
  const errorPagePath = join(E2E_DIR, 'error-page.html');
  const iniPath = join(E2E_DIR, 'acl4ssr.ini');

  const subscriptionB64 = readFileSync(subscriptionPath, 'utf8').trim();
  const subscriptionBuffer = readFileSync(subscriptionPath);
  const bigRulesBuffer = readFileSync(bigRulesPath);
  const bigRulesText = bigRulesBuffer.toString('utf8');
  const bomCrlfBuffer = readFileSync(bomCrlfPath);
  const bomCrlfText = bomCrlfBuffer.toString('utf8');
  const errorPageBuffer = readFileSync(errorPagePath);
  const iniText = readFileSync(iniPath, 'utf8');

  const decodedSubscription = decodeBase64Text(subscriptionB64);
  const subscriptionPlain = decodedSubscription.ok ? decodedSubscription.text : '';
  const subscriptionLines = subscriptionPlain.split(/\r?\n/);
  const uriLines = subscriptionLines.filter((line) => /^(?:ss|ssr|vmess|trojan|vless):\/\//i.test(line.trim()));
  const bigLines = bigRulesText.split('\n');

  runInfo.fixtures = [
    {
      path: 'fixtures/e2e/subscription.txt',
      size: fileSize(subscriptionPath),
      shape: `base64 of ${subscriptionPlain.length}-char URI list; ${uriLines.length} supported URIs + 1 bad hysteria2 link; decoded ${Buffer.byteLength(subscriptionPlain)} B`,
    },
    {
      path: 'fixtures/e2e/rules-big.txt',
      size: fileSize(bigRulesPath),
      shape: `${bigLines.length} lines; 20,674 legal DOMAIN rules; line 20675=DOMA,example.com; line 20676=DOMA (no final newline)`,
    },
    {
      path: 'fixtures/e2e/rules-bom-crlf.txt',
      size: fileSize(bomCrlfPath),
      shape: `BOM=${bomCrlfText.startsWith('\uFEFF')}; CRLF=${bomCrlfText.includes('\r\n')}; 2 typed rules`,
    },
    {
      path: 'fixtures/e2e/error-page.html',
      size: fileSize(errorPagePath),
      shape: 'HTML error page served as text/html',
    },
    {
      path: 'fixtures/e2e/acl4ssr.ini',
      size: fileSize(iniPath),
      shape: 'ACL4SSR subset: 4 custom_proxy_group + 3 inline ruleset + rename + clash_rule_base',
    },
  ];

  const fixtureErrors = [];
  if (!decodedSubscription.ok) fixtureErrors.push(`subscription.txt is not valid base64/UTF-8 (${decodedSubscription.reason})`);
  if (uriLines.length !== 5) fixtureErrors.push(`expected 5 supported URIs, found ${uriLines.length}`);
  if (!subscriptionPlain.includes('hysteria2://bad.example.com:443#Unsupported')) {
    fixtureErrors.push('bad hysteria2 link missing from subscription');
  }
  if (bigLines.length !== 20_676) fixtureErrors.push(`rules-big expected 20,676 lines, found ${bigLines.length}`);
  if (bigRulesText.endsWith('\n')) fixtureErrors.push('rules-big must not end with a newline');
  if (bigLines[0] !== 'DOMAIN,x0.example.com') fixtureErrors.push(`rules-big line 1 is ${JSON.stringify(bigLines[0])}`);
  if (bigLines[20_674] !== 'DOMA,example.com') fixtureErrors.push(`rules-big line 20675 is ${JSON.stringify(bigLines[20_674])}`);
  if (bigLines[20_675] !== 'DOMA') fixtureErrors.push(`rules-big line 20676 is ${JSON.stringify(bigLines[20_675])}`);
  const legalBigLines = bigLines.filter((line) => /^DOMAIN,x\d+\.example\.com$/.test(line));
  if (legalBigLines.length !== BIG_RULE_VALID_COUNT) {
    fixtureErrors.push(`rules-big legal rule count ${legalBigLines.length} != ${BIG_RULE_VALID_COUNT}`);
  }
  if (!bomCrlfText.startsWith('\uFEFF') || !bomCrlfText.includes('\r\n')) {
    fixtureErrors.push('BOM/CRLF fixture shape is wrong');
  }
  if (!errorPageBuffer.toString('utf8').toLowerCase().startsWith('<!doctype html')) {
    fixtureErrors.push('HTML fixture does not start with <!doctype html');
  }
  if (!/custom_proxy_group=/.test(iniText) || !/ruleset=/.test(iniText)) {
    fixtureErrors.push('INI fixture is missing custom_proxy_group/ruleset');
  }
  addCheck(
    'fixtures_shape',
    fixtureErrors.length === 0,
    fixtureErrors.length === 0
      ? 'subscription.txt (5 URIs + 1 bad), rules-big.txt (20,676 lines, 20,674 legal), BOM/CRLF, HTML, INI all match the documented shape'
      : fixtureErrors.join('; '),
  );

  // -------------------------------------------------------------------------
  // Loopback fixture server + main conversion
  // -------------------------------------------------------------------------
  const fixtures = new Map([
    ['/rules-big.txt', { body: bigRulesBuffer, contentType: 'text/plain; charset=utf-8' }],
    ['/rules-bom-crlf.txt', { body: bomCrlfBuffer, contentType: 'text/plain; charset=utf-8' }],
    ['/error-page.html', { body: errorPageBuffer, contentType: 'text/html; charset=utf-8' }],
  ]);
  const { server, port, served } = await startFixtureServer(fixtures);
  runInfo.port = port;

  try {
    const query = new URLSearchParams();
    query.set('url', `inline:${encodeBase64Url(subscriptionB64)}`);
    query.append('ruleset', `PROXY,http://127.0.0.1:${port}/rules-big.txt`);
    query.append('ruleset', `PROXY,http://127.0.0.1:${port}/rules-bom-crlf.txt`);
    query.append('ruleset', `PROXY,http://127.0.0.1:${port}/error-page.html`);
    query.set('diagnostics', 'json');
    runInfo.mainRequest = query.toString();

    const started = Date.now();
    const first = await callSub(query.toString());
    const elapsedMs = Date.now() - started;
    addCheck(
      'http_200_diagnostics_json',
      first.response.status === 200 && first.body?.ok === true,
      `status=${first.response.status} content-type=${first.response.headers.get('content-type')} diagnostics=${first.body?.ok === true} elapsedMs=${elapsedMs}`,
    );
    if (first.response.status !== 200 || first.body?.ok !== true) {
      throw new Error(`main conversion failed: HTTP ${first.response.status}: ${first.text.slice(0, 500)}`);
    }

    const generated = first.body.output;
    writeFileSync(GENERATED, generated);
    runInfo.generatedBytes = Buffer.byteLength(generated);
    runInfo.stats = first.body.stats;
    const warnings = Array.isArray(first.body.warnings) ? first.body.warnings : [];

    addCheck(
      'diagnostics_stats_match_output',
      first.body.stats?.nodes === 5 &&
        first.body.stats?.groups === 2 &&
        first.body.stats?.rules === BIG_RULE_VALID_COUNT + 2 + 1 &&
        first.body.stats?.sources === 1 &&
        warnings.length <= 200,
      `stats=${JSON.stringify(first.body.stats)} warnings=${warnings.length}`,
    );

    // --- proxies ---
    let doc;
    try {
      doc = yamlReadback(generated);
    } catch (error) {
      addCheck('generated_yaml_parses', false, `yaml.parse failed: ${errorText(error)}`);
      throw error;
    }
    addCheck(
      'generated_yaml_parses',
      isPlainObject(doc) && Array.isArray(doc.proxies) && Array.isArray(doc['proxy-groups']) && Array.isArray(doc.rules),
      'yaml.parse OK; proxies/proxy-groups/rules arrays present',
    );

    const types = doc.proxies.map((proxy) => proxy.type);
    const typeCounts = types.reduce((accumulator, type) => {
      accumulator[type] = (accumulator[type] ?? 0) + 1;
      return accumulator;
    }, {});
    const expectedTypes = ['ss', 'ssr', 'trojan', 'vless', 'vmess'];
    const actualTypes = Object.keys(typeCounts).sort();
    const proxyByName = new Map(doc.proxies.map((proxy) => [proxy.name, proxy]));
    const ss = proxyByName.get('SS Node');
    const ssr = proxyByName.get('SSR Node');
    const vmess = proxyByName.get('VMess WS');
    const trojan = proxyByName.get('Trojan WS');
    const vless = proxyByName.get('VLESS Reality');
    const proxyShapeErrors = [];
    if (doc.proxies.length !== 5) proxyShapeErrors.push(`proxies ${doc.proxies.length} != 5`);
    if (JSON.stringify(actualTypes) !== JSON.stringify(expectedTypes)) {
      proxyShapeErrors.push(`types ${JSON.stringify(actualTypes)} != ${JSON.stringify(expectedTypes)}`);
    }
    if (ss === undefined || ss.cipher !== 'aes-256-gcm' || ss.server !== '1.2.3.4' || ss.port !== 8388) proxyShapeErrors.push('ss fields');
    if (ssr === undefined || ssr.protocol !== 'auth_chain_a' || ssr.obfs !== 'http_simple' || ssr.port !== 8388) proxyShapeErrors.push('ssr fields');
    if (vmess === undefined || vmess.uuid !== '11111111-2222-3333-4444-555555555555' || vmess.alterId !== 0 || vmess.network !== 'ws' || vmess.tls !== true) proxyShapeErrors.push('vmess fields');
    if (trojan === undefined || trojan.password !== 'tr0jan@pass' || trojan.network !== 'ws' || trojan.sni !== 'tj.example.com') proxyShapeErrors.push('trojan fields');
    if (vless === undefined || vless.uuid !== 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' || vless.network !== 'tcp' || vless.flow !== 'xtls-rprx-vision' || vless['reality-opts']?.['public-key'] !== VLESS_REALITY_PBK) proxyShapeErrors.push('vless fields');
    addCheck(
      'proxies_count_and_protocol_types',
      proxyShapeErrors.length === 0,
      proxyShapeErrors.length === 0
        ? `5 proxies: ss(SIP002), ssr, vmess, trojan, vless; fields verified (ss aes-256-gcm, ssr auth_chain_a/http_simple, vmess ws+tls, trojan ws, vless tcp+reality)`
        : proxyShapeErrors.join('; '),
    );

    // --- DOMA / warnings ---
    const domaRuleLeak = doc.rules.filter((line) => /^DOMA(?:,|$)/.test(line) || line.includes(',DOMA,'));
    addCheck(
      'doma_dropped_from_output',
      domaRuleLeak.length === 0 && !generated.includes('\n    - "DOMA'),
      domaRuleLeak.length === 0 ? 'no rule starts with DOMA and no ,DOMA, appears in generated YAML' : JSON.stringify(domaRuleLeak.slice(0, 3)),
    );

    const unknownWarning = findWarnings(
      warnings,
      (warning) => warning.code === 'E_RULE_UNKNOWN_TYPE' && warning.raw === 'DOMA,example.com',
    );
    const noTargetWarning = findWarnings(
      warnings,
      (warning) => warning.code === 'E_RULE_NO_TARGET' && warning.raw === 'DOMA',
    );
    const truncatedWarning = findWarnings(
      warnings,
      (warning) => warning.code === 'E_TRUNCATED_TAIL' && warning.raw === 'DOMA',
    );
    addCheck(
      'doma_warnings_with_line_numbers',
      unknownWarning.length === 1 &&
        unknownWarning[0].line === BIG_RULE_LINE_UNKNOWN &&
        unknownWarning[0].source === 'ruleset#1' &&
        noTargetWarning.length === 1 &&
        noTargetWarning[0].line === BIG_RULE_LINE_TRUNCATED &&
        noTargetWarning[0].source === 'ruleset#1' &&
        truncatedWarning.length === 1 &&
        truncatedWarning[0].line === BIG_RULE_LINE_TRUNCATED,
      `E_RULE_UNKNOWN_TYPE=${JSON.stringify(unknownWarning.map(warningSummary))}; E_RULE_NO_TARGET=${JSON.stringify(noTargetWarning.map(warningSummary))}; E_TRUNCATED_TAIL=${JSON.stringify(truncatedWarning.map(warningSummary))}`,
    );

    const badNodeWarnings = findWarnings(
      warnings,
      (warning) => warning.code === 'E_NODE_SCHEME_UNSUPPORTED' && String(warning.raw ?? '').includes('hysteria2'),
    );
    addCheck(
      'bad_link_is_warning_not_fatal',
      badNodeWarnings.length === 1 && badNodeWarnings[0].line === 8 && first.response.status === 200,
      `HTTP 200 with ${warnings.length} warnings; bad link -> ${JSON.stringify(badNodeWarnings.map(warningSummary))}`,
    );

    const htmlWarnings = findWarnings(warnings, (warning) => warning.code === 'E_FETCH_HTML');
    addCheck(
      'html_error_page_source_rejected',
      htmlWarnings.length === 1 && htmlWarnings[0].source === 'ruleset#3',
      `E_FETCH_HTML=${JSON.stringify(htmlWarnings.map(warningSummary))}; conversion still returned 200`,
    );
    addCheck(
      'fixture_server_served_all_sources',
      served.includes('/rules-big.txt') && served.includes('/rules-bom-crlf.txt') && served.includes('/error-page.html'),
      `served=${JSON.stringify(served)}`,
    );

    // --- scale + BOM/CRLF ---
    const expectedBigRules = Array.from(
      { length: BIG_RULE_VALID_COUNT },
      (_, index) => `DOMAIN,x${index}.example.com,PROXY`,
    );
    const actualBigRules = doc.rules.filter((line) => /^DOMAIN,x\d+\.example\.com,PROXY$/.test(line));
    const bigRulesMatch =
      actualBigRules.length === BIG_RULE_VALID_COUNT &&
      actualBigRules.every((line, index) => line === expectedBigRules[index]);
    const bomRule = doc.rules.includes('DOMAIN,bom.example.com,PROXY');
    const crlfRule = doc.rules.includes('DOMAIN-SUFFIX,crlf.example.com,PROXY');
    addCheck(
      '20k_rules_and_bom_crlf_kept',
      bigRulesMatch && bomRule && crlfRule && doc.rules.length === BIG_RULE_VALID_COUNT + 2 + 1,
      `legal DOMAIN rules=${actualBigRules.length}/${BIG_RULE_VALID_COUNT}; total rules=${doc.rules.length}; BOM rule=${bomRule}; CRLF rule=${crlfRule}; first=${doc.rules[0]}; last=${doc.rules.at(-1)}`,
    );

    // --- full validation (project registry + independent whitelist) ---
    validateDocument({
      prefix: 'main',
      yamlText: generated,
      warnings,
      checkPrefix: 'main',
    });

    // --- determinism (SPEC AC-18) ---
    const second = await callSub(query.toString());
    const deterministic =
      second.response.status === 200 &&
      second.body?.ok === true &&
      second.body.output === generated;
    addCheck(
      'deterministic_output',
      deterministic,
      deterministic
        ? `two identical /sub calls produced byte-identical output (sha256=${sha256(generated)})`
        : `second call status=${second.response.status} ok=${second.body?.ok} sha256A=${sha256(generated)} sha256B=${typeof second.body?.output === 'string' ? sha256(second.body.output) : 'n/a'}`,
      false,
    );

    // -----------------------------------------------------------------------
    // ACL4SSR INI conversion (separate request; config owns ruleset/groups)
    // -----------------------------------------------------------------------
    const iniQuery = new URLSearchParams();
    iniQuery.set('url', `inline:${encodeBase64Url(subscriptionB64)}`);
    iniQuery.set('config', `inline:${encodeBase64Url(iniText)}`);
    iniQuery.set('diagnostics', 'json');
    const iniResult = await callSub(iniQuery.toString());
    addCheck(
      'ini_conversion_http_200',
      iniResult.response.status === 200 && iniResult.body?.ok === true,
      `status=${iniResult.response.status} stats=${JSON.stringify(iniResult.body?.stats)}`,
    );
    if (iniResult.response.status !== 200 || iniResult.body?.ok !== true) {
      throw new Error(`INI conversion failed: HTTP ${iniResult.response.status}: ${iniResult.text.slice(0, 500)}`);
    }
    const iniYaml = iniResult.body.output;
    writeFileSync(GENERATED_INI, iniYaml);
    runInfo.iniBytes = Buffer.byteLength(iniYaml);
    runInfo.iniStats = iniResult.body.stats;
    const iniWarnings = Array.isArray(iniResult.body.warnings) ? iniResult.body.warnings : [];
    const iniDoc = yamlReadback(iniYaml);
    const iniGroupNames = iniDoc['proxy-groups'].map((group) => group.name);
    const iniProxyNames = iniDoc.proxies.map((proxy) => proxy.name);
    const iniRuleSet = iniDoc.rules;
    const autoGroup = iniDoc['proxy-groups'].find((group) => group.name === 'AUTO');
    const fallbackGroup = iniDoc['proxy-groups'].find((group) => group.name === 'Fallback');
    const lbGroup = iniDoc['proxy-groups'].find((group) => group.name === 'LB');
    const iniShapeErrors = [];
    if (iniDoc.proxies.length !== 5) iniShapeErrors.push(`proxies ${iniDoc.proxies.length} != 5`);
    if (!iniGroupNames.includes('PROXY')) iniShapeErrors.push('PROXY group missing');
    if (!iniGroupNames.includes('AUTO')) iniShapeErrors.push('AUTO group missing');
    if (!iniGroupNames.includes('Fallback')) iniShapeErrors.push('Fallback group missing');
    if (!iniGroupNames.includes('LB')) iniShapeErrors.push('LB group missing');
    if (!iniProxyNames.includes('SS Renamed')) iniShapeErrors.push('rename ^SS Node@SS Renamed not applied');
    if (iniProxyNames.includes('SS Node')) iniShapeErrors.push('old name SS Node still present');
    if (!iniRuleSet.includes('DOMAIN-SUFFIX,example.org,PROXY')) iniShapeErrors.push('config ruleset 1 missing');
    if (!iniRuleSet.includes('DOMAIN-KEYWORD,example,PROXY')) iniShapeErrors.push('config ruleset 2 missing');
    if (!iniRuleSet.includes('DOMAIN,ads.example.com,DIRECT')) iniShapeErrors.push('config ruleset 3 missing');
    if (!iniRuleSet.includes('MATCH,PROXY')) iniShapeErrors.push('final MATCH,PROXY missing');
    if (autoGroup?.url !== 'https://www.gstatic.com/generate_204' || autoGroup?.interval !== 300 || autoGroup?.tolerance !== 50) {
      iniShapeErrors.push('AUTO url-test fields are wrong');
    }
    if (fallbackGroup?.url !== 'https://example.com/generate_204' || fallbackGroup?.interval !== 600) {
      iniShapeErrors.push('Fallback fields are wrong');
    }
    if (JSON.stringify(lbGroup?.proxies) !== JSON.stringify(['SS Renamed'])) {
      iniShapeErrors.push(`LB members ${JSON.stringify(lbGroup?.proxies)} != ["SS Renamed"]`);
    }
    if (iniDoc['mixed-port'] !== 7890 || !isPlainObject(iniDoc.dns)) iniShapeErrors.push('built-in template keys missing');
    addCheck(
      'ini_config_applied',
      iniShapeErrors.length === 0 && iniDoc.rules.length === 4,
      iniShapeErrors.length === 0
        ? `5 proxies (SS Node renamed), groups=${JSON.stringify(iniGroupNames)}, rules=${JSON.stringify(iniRuleSet)}, AUTO url-test fields + Fallback interval + LB !!TYPE=^SS$ verified, built-in template mixed-port=7890`
        : iniShapeErrors.join('; '),
    );
    const iniWarningCodes = new Set(iniWarnings.map((warning) => warning.code));
    const iniExpectedWarnings = ['W_CONFIG_SECTION_IGNORED', 'W_CONFIG_KEY_UNSUPPORTED', 'W_BUILTIN_TEMPLATE_MAPPED', 'W_DEFAULT_MATCH_ADDED'];
    const missingIniWarnings = iniExpectedWarnings.filter((code) => !iniWarningCodes.has(code));
    addCheck(
      'ini_config_warnings',
      missingIniWarnings.length === 0,
      `warnings=${JSON.stringify([...iniWarningCodes].sort())} missing=${JSON.stringify(missingIniWarnings)}`,
    );
    validateDocument({
      prefix: 'ini',
      yamlText: iniYaml,
      warnings: iniWarnings,
      checkPrefix: 'ini',
    });

    // -----------------------------------------------------------------------
    // Optional mihomo client gate
    // -----------------------------------------------------------------------
    const mihomoOutcome = await runMihomoValidation();
    if (mihomoOutcome.passed) {
      addCheck(
        'mihomo_-t_accepts_generated_config',
        true,
        `exit=0; command=${mihomoOutcome.command}; asset=${mihomoOutcome.manifest?.assetName ?? 'cached'} sha256=${mihomoOutcome.manifest?.sha256 ?? 'n/a'}`,
        false,
      );
    } else if (mihomoOutcome.attempted) {
      notCovered.push(
        `mihomo -t did not pass: ${mihomoOutcome.error ?? `exit=${mihomoOutcome.exitCode}`}; see docs/acceptance.md (acceptance script intentionally does not fail for this)`,
      );
      addCheck(
        'mihomo_-t_accepts_generated_config',
        false,
        `exit=${mihomoOutcome.exitCode}; error=${mihomoOutcome.error ?? '-'}; stderr=${truncate(mihomoOutcome.stderr, 300)}`,
        false,
      );
    } else {
      notCovered.push(mihomoOutcome.skipReason ?? 'mihomo -t was not attempted');
    }
    runInfo.mihomo = mihomoOutcome;
    if (mihomoOutcome.manifest !== null) {
      notCovered.push(
        `official mihomo ${mihomoOutcome.manifest.releaseTag} release publishes no SHA-256 checksum asset (only version.txt); local SHA-256 ${mihomoOutcome.manifest.sha256} is recorded in tools/mihomo/source.json but could not be verified against an official checksum`,
      );
    }
  } finally {
    await closeServer(server);
    runInfo.fixtureRequests = served;
  }
}

let fatalError;
try {
  await main();
} catch (error) {
  fatalError = errorText(error);
  addCheck('acceptance_harness_completed', false, fatalError);
}
writeReports(runInfo.mihomo ?? { attempted: false, passed: false, command: 'not run' }, fatalError);
process.exitCode = requiredFailure ? 1 : 0;
console.log(
  JSON.stringify(
    {
      summary: {
        checks: checks.length,
        passed: checks.filter((check) => check.passed).length,
        requiredFailed: checks.filter((check) => check.required && !check.passed).length,
        exitCode: process.exitCode ?? 0,
      },
      checks: checks.map((check) => ({ name: check.name, passed: check.passed, evidence: check.evidence })),
      generatedConfig: GENERATED,
      generatedBytes: runInfo.generatedBytes,
      stats: runInfo.stats,
      mihomo: runInfo.mihomo,
      notCovered,
      fatalError: fatalError ?? null,
      report: REPORT_JSON,
      doc: DOC_MD,
    },
    null,
    2,
  ),
);
