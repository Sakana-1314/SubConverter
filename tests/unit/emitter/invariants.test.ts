import { describe, expect, it } from 'vitest';
import type { Rule, RuleType } from '../../../src/types';
import { emitClash, parseForReadback } from '../../../src/emitter/index';
import type { EmitClashInput } from '../../../src/emitter/config';
import { EmitterError, isEmitterError } from '../../../src/emitter/serialize';

function rule(
  type: RuleType,
  payload: string,
  target: string,
  extra: Partial<Rule> = {},
): Rule {
  return {
    type,
    payload,
    target,
    params: [],
    raw: `${type},${payload},${target}`,
    line: 1,
    sourceId: 'inline',
    ...extra,
  };
}

function match(target = 'PROXY', line = 50): Rule {
  return { type: 'MATCH', payload: '', target, params: [], raw: `MATCH,${target}`, line, sourceId: 'inline' };
}

function baseInput(): EmitClashInput {
  return {
    template: {
      'mixed-port': 7890,
      dns: { enable: true, nameserver: ['https://1.1.1.1/dns-query'] },
    },
    nodes: [
      {
        kind: 'ss',
        name: 'true',
        server: '1.2.3.4',
        port: 8388,
        cipher: 'aes-256-gcm',
        password: "p@ss: w#o'rd",
      },
      {
        kind: 'vmess',
        name: '123',
        server: 'vmess.example.com',
        port: 443,
        uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
        alterId: 0,
        cipher: 'auto',
        tls: true,
        network: 'tcp',
      },
    ],
    groups: [
      { name: 'PROXY', type: 'select', members: ['true', '123', 'DIRECT'] },
      { name: 'AUTO', type: 'url-test', members: ['true', '123'] },
    ],
    rules: [
      rule('DOMAIN-KEYWORD', 'a:b#c', 'PROXY', { line: 1 }),
      rule('DOMAIN-REGEX', '^a,b$', 'PROXY', { line: 2 }),
      rule('DOMAIN', 'node.example', 'true', { line: 3 }),
      rule('DOMAIN-SUFFIX', 'example.com', 'DIRECT', { line: 4 }),
      match('PROXY', 5),
    ],
    providers: [],
    origin: 'https://worker.example',
    version: '1.0.0',
    options: { rulesMode: 'inline', defaultGroup: 'PROXY' },
  };
}

function captureError(fn: () => unknown): EmitterError {
  try {
    fn();
  } catch (error) {
    if (isEmitterError(error)) return error;
    throw error;
  }
  throw new Error('expected an EmitterError');
}

describe('emitted output invariants', () => {
  it('parses back and satisfies the independent rule invariants', () => {
    const result = emitClash(baseInput());
    expect(result.yaml.endsWith('\n')).toBe(true);
    expect(result.yaml.endsWith('\n\n')).toBe(false);
    expect(result.stats).toMatchObject({ nodes: 2, groups: 2, rules: 5, providers: 0 });

    const readback = parseForReadback(result.yaml);
    expect(readback.ok).toBe(true);
    if (!readback.ok) return;
    const value = readback.value as Record<string, unknown>;
    const rules = value.rules as string[];
    expect(rules[rules.length - 1]).toBe('MATCH,PROXY');
    expect(rules.filter((line) => line.startsWith('MATCH,'))).toHaveLength(1);
    expect(rules).toEqual([
      'DOMAIN-KEYWORD,a:b#c,PROXY',
      'DOMAIN-REGEX,^a,b$,PROXY',
      'DOMAIN,node.example,true',
      'DOMAIN-SUFFIX,example.com,DIRECT',
      'MATCH,PROXY',
    ]);

    // Every rule must be emitted as a double-quoted scalar (SPEC §7.4).
    for (const line of rules) {
      expect(result.yaml).toContain(`  - "${line}"`);
    }

    const proxies = value.proxies as Array<Record<string, unknown>>;
    expect(proxies.map((proxy) => proxy.name)).toEqual(['true', '123']);
    for (const proxy of proxies) {
      expect(typeof proxy.port).toBe('number');
      expect(Number.isInteger(proxy.port as number)).toBe(true);
      expect(JSON.stringify(proxy)).not.toContain('null');
    }
    expect(JSON.stringify(value)).not.toContain('undefined');
    expect(result.yaml).not.toContain('.nan');
  });

  it('quotes YAML-like proxy names and survives read-back', () => {
    const input = baseInput();
    const result = emitClash(input);
    const readback = parseForReadback(result.yaml);
    expect(readback.ok).toBe(true);
    if (!readback.ok) return;
    const proxies = (readback.value as Record<string, unknown>).proxies as Array<Record<string, unknown>>;
    expect(proxies.map((proxy) => proxy.name)).toEqual(['true', '123']);
  });

  it('rejects structurally invalid rule IR with E_EMIT_INVALID', () => {
    const cases: Array<[string, Rule]> = [
      ['empty payload', rule('DOMAIN', '', 'PROXY')],
      ['bad CIDR', rule('IP-CIDR', '999.1.1.1/24', 'PROXY')],
      ['unbalanced AND', rule('AND', '((DOMAIN,a.com),(NETWORK,tcp)', 'PROXY')],
      ['unknown type', rule('DOMA' as unknown as RuleType, 'example.com', 'PROXY')],
      ['empty target', rule('DOMAIN', 'example.com', '')],
    ];

    for (const [label, badRule] of cases) {
      const input = baseInput();
      input.rules = [badRule, match()];
      const error = captureError(() => emitClash(input));
      expect(error.code, label).toBe('E_EMIT_INVALID');
    }
  });

  it('drops rules with unknown targets and keeps the final MATCH', () => {
    const input = baseInput();
    input.rules = [
      rule('DOMAIN-SUFFIX', 'example.com', 'MISSING_TARGET'),
      match(),
    ];
    const result = emitClash(input);
    const readback = parseForReadback(result.yaml);
    expect(readback.ok).toBe(true);
    if (!readback.ok) return;
    expect((readback.value as Record<string, unknown>).rules).toEqual(['MATCH,PROXY']);
    const warning = result.warnings.find((entry) => entry.code === 'E_RULE_TARGET_NOT_FOUND');
    expect(warning?.severity).toBe('error');
    expect(warning?.stage).toBe('rules');
  });

  it('emits a valid document for empty input', () => {
    const result = emitClash({
      template: {},
      nodes: [],
      groups: [],
      rules: [],
      providers: [],
      origin: 'https://worker.example',
      version: '1.0.0',
      options: { rulesMode: 'inline', defaultGroup: 'PROXY' },
    });
    expect(result.stats.nodes).toBe(0);
    expect(result.stats.groups).toBe(2);
    expect(result.stats.rules).toBe(1);

    const readback = parseForReadback(result.yaml);
    expect(readback.ok).toBe(true);
    if (!readback.ok) return;
    const value = readback.value as Record<string, unknown>;
    expect(value.proxies).toEqual([]);
    expect(value.rules).toEqual(['MATCH,PROXY']);
    expect((value['proxy-groups'] as Array<Record<string, unknown>>).map((group) => group.name))
      .toEqual(['PROXY', 'AUTO']);

    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).toContain('W_GROUP_DEFAULT_ADDED');
    expect(codes).toContain('W_DEFAULT_MATCH_ADDED');
  });

  it('is deterministic', () => {
    expect(emitClash(baseInput()).yaml).toBe(emitClash(baseInput()).yaml);
  });

  it('emits rule-providers only in providers mode', () => {
    const providerName = 'rs_0123abcd_domestic';
    const input = baseInput();
    input.providers = [{
      name: providerName,
      behavior: 'domain',
      source: { raw: 'https://example.com/domestic.yaml', dialect: 'clash-domain' },
      interval: 86400,
    }];
    input.rules = [
      rule('RULE-SET', providerName, 'PROXY'),
      match(),
    ];
    input.options = { rulesMode: 'providers', defaultGroup: 'PROXY' };

    const result = emitClash(input);
    expect(result.stats.providers).toBe(1);
    const readback = parseForReadback(result.yaml);
    expect(readback.ok).toBe(true);
    if (!readback.ok) return;
    const value = readback.value as Record<string, unknown>;
    const providers = value['rule-providers'] as Record<string, Record<string, unknown>>;
    expect(providers[providerName]).toEqual({
      type: 'http',
      behavior: 'domain',
      format: 'yaml',
      url: 'https://worker.example/getruleset?type=3&src=https%3A%2F%2Fexample.com%2Fdomestic.yaml&dialect=clash-domain&v=1',
      path: `./providers/${providerName}.yaml`,
      interval: 86400,
    });
    expect(value.rules).toEqual([`RULE-SET,${providerName},PROXY`, 'MATCH,PROXY']);

    const inline = baseInput();
    inline.providers = input.providers;
    const inlineResult = emitClash(inline);
    const inlineBack = parseForReadback(inlineResult.yaml);
    expect(inlineBack.ok).toBe(true);
    if (!inlineBack.ok) return;
    expect((inlineBack.value as Record<string, unknown>)['rule-providers']).toBeUndefined();
    expect(inlineResult.stats.providers).toBe(0);
  });
});

describe('rules module validation hook', () => {
  it('calls the injected validator for every emitted rule', () => {
    const seen: Array<{ line: string; mode: string; allowMatch: boolean }> = [];
    emitClash(baseInput(), {
      validateRuleLine: (line, context) => {
        seen.push({ line, mode: context.mode, allowMatch: context.allowMatch });
        expect(context.knownTargets.has('PROXY')).toBe(true);
        expect(context.knownProviders.size).toBe(0);
        return { ok: true };
      },
    });
    expect(seen.map((entry) => entry.line)).toEqual([
      'DOMAIN-KEYWORD,a:b#c,PROXY',
      'DOMAIN-REGEX,^a,b$,PROXY',
      'DOMAIN,node.example,true',
      'DOMAIN-SUFFIX,example.com,DIRECT',
      'MATCH,PROXY',
    ]);
    expect(seen.every((entry) => entry.mode === 'template')).toBe(true);
    expect(seen.every((entry) => entry.allowMatch)).toBe(true);
  });

  it('turns a validator rejection into E_EMIT_INVALID', () => {
    const error = captureError(() => emitClash(baseInput(), {
      validateRuleLine: () => ({ ok: false, code: 'E_RULE_BAD_CIDR', message: 'bad' }),
    }));
    expect(error.code).toBe('E_EMIT_INVALID');
    expect(error.message).toContain('E_RULE_BAD_CIDR');
  });

  it('wraps validator exceptions as E_EMIT_INVALID', () => {
    const error = captureError(() => emitClash(baseInput(), {
      validateRuleLine: () => {
        throw new Error('parser exploded');
      },
    }));
    expect(error.code).toBe('E_EMIT_INVALID');
    expect(error.message).toContain('parser exploded');
  });
});

describe('parseForReadback edge cases', () => {
  it('rejects empty, multi-document and custom-tagged YAML', () => {
    expect(parseForReadback('')).toMatchObject({ ok: false });
    expect(parseForReadback('a: 1\n---\nb: 2')).toMatchObject({ ok: false });
    expect(parseForReadback('a: !foo bar')).toMatchObject({ ok: false });
    expect(parseForReadback('a: [')).toMatchObject({ ok: false });
  });

  it('accepts a single plain document', () => {
    const result = parseForReadback('proxies: []\nrules:\n  - "MATCH,DIRECT"\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ proxies: [], rules: ['MATCH,DIRECT'] });
  });
});
