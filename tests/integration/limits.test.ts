import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseClashNodes, limitClashInput } from '../../src/links/clash-input';
import { parseSubscriptionText } from '../../src/links/subscription';
import { buildRulesetDocument, buildRules } from '../../src/rules/index';
import type { Rule } from '../../src/types';
import { parseEnv } from '../../src/services/env';
import { runGetRuleset } from '../../src/services/ruleset';
import { testEnv } from './helpers';

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runLimitChild(mode: string, heapMb = 128): ChildResult {
  return spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${heapMb}`,
      '--import',
      'tsx',
      'tests/integration/limit-child.ts',
      mode,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  );
}

function parseOutput(result: ChildResult): Record<string, unknown> {
  const lines = result.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
}

describe('memory-limit regressions (subprocess, 128 MB heap)', () => {
  it('bounds a 40k-node Clash YAML before YAML AST materialization', () => {
    const child = runLimitChild('nodes');
    expect(child.status, child.stderr).toBe(0);
    const output = parseOutput(child);
    expect(output.nodes).toBe(10_000);
    expect(output.codes).toContain('W_NODE_LIMIT');
    expect(Number(output.inputBytes)).toBeGreaterThan(4_000_000);
  });

  it('bounds a 2M-line domain ruleset before rule objects are materialized', () => {
    const child = runLimitChild('rules');
    expect(child.status, child.stderr).toBe(0);
    const output = parseOutput(child);
    expect(output.inputBytes).toBe(4_000_000);
    expect(Number(output.extracted)).toBeLessThanOrEqual(51_000);
    expect(Number(output.rules)).toBeLessThanOrEqual(51_000);
    expect(Number(output.yamlBytes)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(output.codes).toContain('W_RULE_LIMIT');
  });

  it('bounds the full /getruleset service path with auto dialect detection', () => {
    const child = runLimitChild('getruleset');
    expect(child.status, child.stderr).toBe(0);
    const output = parseOutput(child);
    expect(output.inputBytes).toBe(4_000_000);
    expect(Number(output.accepted)).toBeLessThanOrEqual(51_000);
    expect(Number(output.yamlBytes)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(output.codes).toContain('W_RULE_LIMIT');
  });

  it('bounds the full /sub pipeline for 40k Clash nodes (192 MB Node proxy)', () => {
    const child = runLimitChild('sub', 192);
    expect(child.status, child.stderr).toBe(0);
    const output = parseOutput(child);
    expect(output.nodes).toBe(10_000);
    expect(Number(output.yamlBytes)).toBeGreaterThan(0);
    expect(output.codes).toContain('W_NODE_LIMIT');
  });
});

describe('bounded parsing behavior', () => {
  it('limits Clash nodes while keeping a W_NODE_LIMIT warning', () => {
    const count = 12_000;
    let yaml = 'proxies:\n';
    for (let index = 0; index < count; index += 1) {
      yaml +=
        `  - name: n${index}\n` +
        '    type: ss\n' +
        '    server: 1.2.3.4\n' +
        '    port: 8388\n' +
        '    cipher: aes-128-gcm\n' +
        '    password: p\n';
    }
    const result = parseSubscriptionText(yaml, 'url#1', { maxNodes: 1_000 });
    expect(result.nodes).toHaveLength(1_000);
    expect(result.warnings.map((warning) => warning.code)).toContain('W_NODE_LIMIT');
  });

  it('rejects a flow-style Clash proxies list over the node budget', () => {
    const proxies = Array.from(
      { length: 20 },
      (_, index) => `{name: n${index}, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-128-gcm, password: p}`,
    );
    const limited = limitClashInput(`proxies: [${proxies.join(', ')}]\n`, 10);
    expect(limited.truncated).toBe(true);
    expect(limited.reason).toBe('flow');
    expect(limited.text).toBe('proxies: []\n');
  });

  it('stops parseClashNodes at the supplied node budget', () => {
    const list = Array.from({ length: 50 }, (_, index) => ({
      name: `n${index}`,
      type: 'ss',
      server: '1.2.3.4',
      port: 8388,
      cipher: 'aes-128-gcm',
      password: 'p',
    }));
    const result = parseClashNodes({ proxies: list }, 'url#1', 5);
    expect(result.nodes).toHaveLength(5);
    expect(result.warnings.map((warning) => warning.code)).toContain('W_NODE_LIMIT');
  });

  it('limits /getruleset extraction with MAX_RULES', async () => {
    const policy = parseEnv({ ...testEnv, MAX_RULES: '1000' });
    const text = 'a\n'.repeat(60_000);
    const result = await runGetRuleset(
      {
        type: 3,
        sourceRaw: 'http://127.0.0.1:8790/rules',
        dialect: 'auto',
        diagnostics: 'none',
      },
      policy,
      {
        fetch: (async () =>
          new Response(text, {
            headers: { 'content-type': 'text/plain' },
          })) as unknown as typeof globalThis.fetch,
        now: () => 0,
      },
    );
    expect(result.warningCodes).toContain('W_RULE_LIMIT');
    expect(result.stats.accepted).toBeLessThanOrEqual(2_000);
    const lines = result.yaml.trimEnd().split('\n');
    expect(lines.length).toBeLessThanOrEqual(1_001);
  });

  it('caps buildRulesetDocument by item count and serialized bytes', () => {
    const rules: Rule[] = Array.from({ length: 20 }, (_, index) => ({
      type: 'DOMAIN-SUFFIX',
      payload: `example${index}.com`,
      target: '',
      params: [],
      raw: `DOMAIN-SUFFIX,example${index}.com`,
      line: index + 1,
      sourceId: 'ruleset#1',
    }));
    const byItems = buildRulesetDocument(rules, 3, 'getruleset', { maxItems: 5 });
    expect(byItems.truncated).toBe(true);
    expect(byItems.warnings.map((warning) => warning.code)).toContain('W_RULE_LIMIT');
    expect(byItems.yaml.trimEnd().split('\n')).toHaveLength(6); // payload: + 5 items

    const byBytes = buildRulesetDocument(rules, 3, 'getruleset', { maxBytes: 60 });
    expect(byBytes.truncated).toBe(true);
    expect(byBytes.bytes).toBeLessThanOrEqual(60);
    expect(byBytes.warnings.map((warning) => warning.code)).toContain('E_OUTPUT_TOO_LARGE');
    expect(byBytes.yaml.endsWith('\n')).toBe(true);
    expect(byBytes.yaml.startsWith('payload:')).toBe(true);
  });

  it('caps /sub rule extraction before building all Rule objects', () => {
    const text = 'DOMAIN-SUFFIX,a.example,DIRECT\n'.repeat(60_000);
    const result = buildRules({
      sources: [{ sourceId: 'ruleset#1', text, dialect: 'surge' }],
      mode: 'inline',
      knownTargets: new Set(['DIRECT']),
      maxRules: 1_000,
    });
    expect(result.warnings.map((warning) => warning.code)).toContain('W_RULE_LIMIT');
    expect(result.rules.filter((rule) => rule.type !== 'MATCH')).toHaveLength(1_000);
    expect(result.rules.at(-1)?.type).toBe('MATCH');
  });
});
