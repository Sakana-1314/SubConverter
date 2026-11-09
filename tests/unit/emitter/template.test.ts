import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE } from '../../../src/emitter/default-template';
import {
  ALLOWED_TEMPLATE_KEYS,
  DENIED_TEMPLATE_KEYS,
  isAllowedTemplateKey,
  sanitizeTemplate,
} from '../../../src/emitter/template';
import { EmitterError, isEmitterError } from '../../../src/emitter/serialize';

function templateError(value: unknown): EmitterError {
  try {
    sanitizeTemplate(value);
  } catch (error) {
    if (isEmitterError(error)) return error;
    throw error;
  }
  throw new Error('expected an EmitterError');
}

describe('sanitizeTemplate: allowed keys', () => {
  it('preserves allowed keys and their order', () => {
    const input = {
      'mixed-port': 7890,
      'allow-lan': false,
      mode: 'rule',
      dns: { enable: true, nameserver: ['https://1.1.1.1/dns-query'] },
      tun: { enable: false, stack: 'system' },
      profile: { 'store-selected': true },
    };
    const result = sanitizeTemplate(input);
    expect(result.template).toEqual(input);
    expect(Object.keys(result.template)).toEqual([
      'mixed-port',
      'allow-lan',
      'mode',
      'dns',
      'tun',
      'profile',
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.templateRules).toEqual([]);
  });

  it('deep-copies nested values', () => {
    const dns = { enable: true, nameserver: ['https://1.1.1.1/dns-query'] };
    const result = sanitizeTemplate({ dns });
    expect(result.template.dns).toEqual(dns);
    expect(result.template.dns).not.toBe(dns);
    (result.template.dns as { nameserver: string[] }).nameserver.push('https://8.8.8.8/dns-query');
    expect(dns.nameserver).toEqual(['https://1.1.1.1/dns-query']);
  });

  it('exposes the SPEC allowed/denied key sets', () => {
    expect(ALLOWED_TEMPLATE_KEYS).toContain('mixed-port');
    expect(ALLOWED_TEMPLATE_KEYS).toContain('dns');
    expect(ALLOWED_TEMPLATE_KEYS).toContain('geox-url');
    expect(DENIED_TEMPLATE_KEYS).toContain('external-controller');
    expect(isAllowedTemplateKey('dns')).toBe(true);
    expect(isAllowedTemplateKey('proxies')).toBe(false);
  });
});

describe('sanitizeTemplate: denied and core keys', () => {
  it('drops core keys with W_TEMPLATE_CORE_IGNORED and denied keys with W_TEMPLATE_KEY_DENIED', () => {
    const result = sanitizeTemplate({
      proxies: [],
      'proxy-groups': [],
      rules: ['DOMAIN-SUFFIX,ignored.example,PROXY'],
      'rule-providers': {},
      script: { code: 'def main(): pass' },
      secret: 's3cret',
      'external-controller': '127.0.0.1:9090',
      'unknown-option': true,
      'mixed-port': 7890,
    });
    expect(result.template).toEqual({ 'mixed-port': 7890 });
    expect(result.templateRules).toEqual([]);

    const core = result.warnings.filter((warning) => warning.code === 'W_TEMPLATE_CORE_IGNORED');
    const denied = result.warnings.filter((warning) => warning.code === 'W_TEMPLATE_KEY_DENIED');
    expect(core).toHaveLength(4);
    expect(denied).toHaveLength(4);
    expect(result.warnings.every((warning) => warning.stage === 'template')).toBe(true);
  });

  it('extracts template rules when overwrite_original_rules=false', () => {
    const result = sanitizeTemplate({
      'mixed-port': 7890,
      rules: ['DOMAIN-SUFFIX,a.example,PROXY', 42, 'MATCH,PROXY'],
    }, { overwriteOriginalRules: false, sourceId: 'config' });
    expect(result.template).toEqual({ 'mixed-port': 7890 });
    expect(result.templateRules).toEqual(['DOMAIN-SUFFIX,a.example,PROXY', 'MATCH,PROXY']);
    const warning = result.warnings.find((entry) => entry.code === 'W_TEMPLATE_KEY_DENIED');
    expect(warning?.message).toContain('not a string');
    expect(warning?.source).toBe('config');
  });

  it('ignores a non-array template rules value', () => {
    const result = sanitizeTemplate(
      { rules: 'DOMAIN,a.example,PROXY' },
      { overwriteOriginalRules: false },
    );
    expect(result.templateRules).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['W_TEMPLATE_CORE_IGNORED']);
  });
});

describe('sanitizeTemplate: non-object input', () => {
  it.each([null, [], 'template', 42, true])('rejects %p as invalid_template', (value) => {
    const error = templateError(value);
    expect(error.code).toBe('invalid_template');
  });
});

describe('sanitizeTemplate: undefined and non-plain data', () => {
  it('removes undefined properties recursively', () => {
    const result = sanitizeTemplate({
      dns: {
        enable: true,
        dropped: undefined,
        nested: { keep: 1, dropped: undefined },
      },
      'mixed-port': undefined,
    });
    expect(result.template).toEqual({ dns: { enable: true, nested: { keep: 1 } } });
    expect(result.warnings).toEqual([]);
  });

  it('rejects NaN and Infinity', () => {
    const result = sanitizeTemplate({ port: Number.NaN, 'mixed-port': Number.POSITIVE_INFINITY, 'allow-lan': true });
    expect(result.template).toEqual({ 'allow-lan': true });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((warning) => warning.code === 'W_TEMPLATE_KEY_DENIED')).toBe(true);
  });

  it('rejects functions, symbols, Dates and non-plain values', () => {
    const result = sanitizeTemplate({
      tun: () => undefined,
      hosts: new Date(0),
      profile: { value: Symbol('x') },
      dns: { nameserver: [undefined] },
      'mixed-port': 1,
    });
    expect(result.template).toEqual({ 'mixed-port': 1 });
    expect(result.warnings).toHaveLength(4);
  });

  it('rejects prototype-pollution keys at any depth', () => {
    const input = JSON.parse('{"dns":{"__proto__":{"polluted":true}}}') as Record<string, unknown>;
    const result = sanitizeTemplate(input);
    expect(result.template.dns).toBeUndefined();
    expect(result.warnings[0]?.code).toBe('W_TEMPLATE_KEY_DENIED');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('DEFAULT_TEMPLATE', () => {
  it('matches SPEC §12.2 and is deeply frozen', () => {
    expect(DEFAULT_TEMPLATE).toMatchObject({
      'mixed-port': 7890,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'info',
      ipv6: true,
      dns: {
        enable: true,
        ipv6: true,
        'enhanced-mode': 'fake-ip',
        'fake-ip-range': '198.18.0.1/16',
        nameserver: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
      },
    });
    expect(Object.isFrozen(DEFAULT_TEMPLATE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TEMPLATE.dns)).toBe(true);
    expect(Object.isFrozen((DEFAULT_TEMPLATE.dns as { nameserver: string[] }).nameserver)).toBe(true);
  });

  it('sanitizes into a fresh copy', () => {
    const result = sanitizeTemplate(DEFAULT_TEMPLATE);
    expect(result.warnings).toEqual([]);
    expect(result.template).toEqual(DEFAULT_TEMPLATE);
    expect(result.template.dns).not.toBe(DEFAULT_TEMPLATE.dns);
  });
});
