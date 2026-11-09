/**
 * Subprocess harness for memory-limit regressions (review findings #1/#2).
 * Run with: node --max-old-space-size=<N> --import tsx <this-file> <mode>
 */
import { parseRuleSourceParam, type SubParams } from '../../src/http/params';
import { parseSubscriptionText } from '../../src/links/subscription';
import {
  buildRulesetDocument,
  extractRuleLines,
  parseRuleLines,
  RULE_INPUT_MARGIN,
} from '../../src/rules/index';
import { parseEnv } from '../../src/services/env';
import { runSub } from '../../src/services/pipeline';
import { runGetRuleset } from '../../src/services/ruleset';

const argv =
  (globalThis as { process?: { argv?: string[] } }).process?.argv ?? [];
const mode = argv[2] ?? '';

const TEST_ENV = {
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
  UPSTREAM_ALLOWED_PORTS: '80,443,8790',
  PUBLIC_SUBSCRIPTION_CACHE: 'false',
  SUBSCRIPTION_CACHE_TTL: '60',
  RULESET_CACHE_TTL: '300',
  PUBLIC_ORIGIN: '',
  ENVIRONMENT: 'test',
  ALLOW_TEST_UPSTREAM_HOSTS: '127.0.0.1:8790',
};

function fakeFetch(body: string): typeof globalThis.fetch {
  return (async () =>
    new Response(body, {
      headers: { 'content-type': 'text/plain' },
    })) as unknown as typeof globalThis.fetch;
}

function nodeYaml(count: number): string {
  let yaml = 'proxies:\n';
  for (let index = 0; index < count; index += 1) {
    yaml +=
      `  - name: node${index}\n` +
      '    type: ss\n' +
      '    server: 1.2.3.4\n' +
      '    port: 8388\n' +
      '    cipher: aes-128-gcm\n' +
      '    password: p\n';
  }
  return yaml;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value));
}

if (mode === 'nodes') {
  const yaml = nodeYaml(40_000);
  const result = parseSubscriptionText(yaml, 'url#1', { maxNodes: 10_000 });
  print({
    nodes: result.nodes.length,
    codes: [...new Set(result.warnings.map((warning) => warning.code))],
    inputBytes: new TextEncoder().encode(yaml).length,
  });
} else if (mode === 'sub') {
  const yaml = nodeYaml(40_000);
  const params: SubParams = {
    urls: [{ raw: 'http://127.0.0.1:8790/sub', label: 'url#1', sourceId: 'url#1' }],
    target: 'clash',
    rulesets: [],
    rulesMode: 'inline',
    diagnostics: 'none',
    include: [],
    exclude: [],
    rename: [],
    sort: false,
    udp: false,
    tfo: false,
    scv: false,
    interval: 0,
    appendInfo: true,
  };
  const result = await runSub(
    params,
    parseEnv(TEST_ENV),
    { fetch: fakeFetch(yaml), now: () => 0 },
    'https://worker.test',
    [],
    parseRuleSourceParam,
  );
  print({
    nodes: result.stats.nodes,
    yamlBytes: result.stats.bytesOut,
    codes: result.warningCodes,
    inputBytes: new TextEncoder().encode(yaml).length,
  });
} else if (mode === 'rules' || mode === 'getruleset') {
  const count = 2_000_000;
  const text = 'a\n'.repeat(count);
  if (mode === 'rules') {
    const maxInputLines = 50_000 + RULE_INPUT_MARGIN;
    const extraction = extractRuleLines(text, 'domain', 'getruleset', {
      maxLines: maxInputLines,
    });
    const parsed = parseRuleLines(
      extraction.lines,
      {
        sourceId: 'getruleset',
        mode: 'provider',
        knownTargets: new Set<string>(),
        knownProviders: new Set<string>(),
        allowMatch: false,
      },
      { maxInputLines },
    );
    const document = buildRulesetDocument(parsed.rules, 3, 'getruleset', {
      maxItems: 50_000,
      maxBytes: 16 * 1024 * 1024,
    });
    print({
      inputBytes: text.length,
      extracted: extraction.lines.length,
      rules: parsed.rules.length,
      yamlBytes: document.bytes,
      placeholder: document.placeholder,
      codes: [
        ...new Set(
          [...extraction.warnings, ...parsed.warnings, ...document.warnings].map(
            (warning) => warning.code,
          ),
        ),
      ],
    });
  } else {
    const deps = { fetch: fakeFetch(text), now: () => 0 };
    const result = await runGetRuleset(
      {
        type: 3,
        sourceRaw: 'http://127.0.0.1:8790/rules',
        dialect: 'auto',
        diagnostics: 'none',
      },
      parseEnv(TEST_ENV),
      deps,
    );
    print({
      inputBytes: text.length,
      accepted: result.stats.accepted,
      yamlBytes: result.stats.bytesOut,
      placeholder: result.placeholder,
      codes: result.warningCodes,
    });
  }
} else {
  throw new Error(`unknown mode: ${mode}`);
}
