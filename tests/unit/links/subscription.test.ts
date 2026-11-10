/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import base64Fixture from '../../fixtures/links/sub-base64.txt?raw';
import clashFixture from '../../fixtures/links/clash-input.yaml?raw';
import plainFixture from '../../fixtures/links/sub-plain.txt?raw';
import { encodeBase64, encodeBase64Url } from '../../../src/links/base64';
import { detectInput } from '../../../src/links/detect';
import { parseSubscriptionText } from '../../../src/links/subscription';

describe('detectInput contract', () => {
  it('returns only kind/decoded for the public API', () => {
    expect(detectInput('ss://aes-256-gcm:p@1.2.3.4:8388#n')).toEqual({ kind: 'plain-links' });
    expect(detectInput('proxies:\n  - {type: ss}\n')).toEqual({ kind: 'clash-yaml' });
    expect(detectInput('hello world')).toEqual({ kind: 'unsupported' });
    expect(detectInput(encodeBase64Url('ss://aes-256-gcm:p@1.2.3.4:8388#n'))).toEqual({
      kind: 'base64',
      decoded: 'ss://aes-256-gcm:p@1.2.3.4:8388#n',
    });
  });
});

function codes(text: string, sourceId = 'url#1'): string[] {
  return parseSubscriptionText(text, sourceId).warnings.map((warning) => warning.code);
}

function fixtureUris(): string[] {
  return plainFixture
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('//'));
}

describe('parseSubscriptionText: fixtures', () => {
  it('parses a plain-text URI list', () => {
    const result = parseSubscriptionText(plainFixture, 'url#1');
    expect(result.stats).toEqual({ lines: 5, accepted: 5, dropped: 0 });
    expect(result.warnings).toEqual([]);
    expect(result.nodes.map((node) => node.kind)).toEqual([
      'ss',
      'ssr',
      'vmess',
      'trojan',
      'vless',
    ]);
    expect(result.nodes.map((node) => node.name)).toEqual([
      'SS Node',
      'SSR Node',
      'VMess WS',
      'Trojan WS',
      'VLESS Reality',
    ]);
  });

  it('parses a base64 subscription and emits an info warning', () => {
    const result = parseSubscriptionText(base64Fixture, 'url#1');
    expect(result.stats).toEqual({ lines: 5, accepted: 5, dropped: 0 });
    expect(result.nodes).toHaveLength(5);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      code: 'W_INPUT_BASE64_DETECTED',
      severity: 'info',
      stage: 'decode',
    });
  });

  it('parses Clash YAML input', () => {
    const result = parseSubscriptionText(clashFixture, 'url#1');
    expect(result.stats).toEqual({ lines: 7, accepted: 6, dropped: 1 });
    expect(result.nodes).toHaveLength(6);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'W_CLASH_SECTION_IGNORED',
      'W_NODE_UNSUPPORTED_PROTOCOL',
      'W_NODE_FIELDS_IGNORED',
    ]);
  });

  it('parses base64-wrapped Clash YAML', () => {
    const result = parseSubscriptionText(encodeBase64(clashFixture), 'url#1');
    expect(result.nodes).toHaveLength(6);
    expect(result.warnings[0].code).toBe('W_INPUT_BASE64_DETECTED');
  });
});

describe('parseSubscriptionText: malformed input isolation', () => {
  it('keeps good lines and reports each bad line', () => {
    const text = [
      ...fixtureUris(),
      'ss://not-base64@@bad',
      'garbage line',
      'socks://1.2.3.4:1080',
    ].join('\n');
    const result = parseSubscriptionText(text, 'url#2');

    expect(result.nodes).toHaveLength(5);
    expect(result.stats).toEqual({ lines: 8, accepted: 5, dropped: 3 });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'E_BASE64_INVALID',
      'E_NODE_LINE',
      'E_NODE_SCHEME_UNSUPPORTED',
    ]);
    expect(result.warnings.map((warning) => warning.line)).toEqual([6, 7, 8]);
    expect(result.warnings.every((warning) => warning.source === 'url#2')).toBe(true);
  });

  it('skips comments and blank lines without warnings', () => {
    const text = '# comment\n; another\n// third\n\n   \n' + fixtureUris()[0] + '\n';
    const result = parseSubscriptionText(text, 'url#1');
    expect(result.nodes).toHaveLength(1);
    expect(result.warnings).toEqual([]);
    expect(result.stats.lines).toBe(1);
  });

  it('normalizes BOM and CRLF', () => {
    const text = '\uFEFF' + fixtureUris().join('\r\n') + '\r\n';
    const result = parseSubscriptionText(text, 'url#1');
    expect(result.nodes).toHaveLength(5);
    expect(result.warnings).toEqual([]);
  });

  it('rejects lines longer than 4096 characters', () => {
    const result = parseSubscriptionText(`ss://${'a'.repeat(4100)}`, 'url#1');
    expect(result.warnings.map((warning) => warning.code)).toEqual(['E_NODE_LINE_TOO_LONG']);
    expect(result.stats.dropped).toBe(1);
  });

  it('never includes node credentials in Warning.raw', () => {
    const rawTrojan = 'trojan://supersecret@tj.example.com:99999#name';
    const rawSs = `ss://${encodeBase64('aes-256-gcm:topsecret@tj.example.com:0')}`;
    const result = parseSubscriptionText(`${rawTrojan}\n${rawSs}`, 'url#1');

    expect(result.warnings).toHaveLength(2);
    for (const warning of result.warnings) {
      expect(warning.raw ?? '').not.toContain('supersecret');
      expect(warning.raw ?? '').not.toContain('topsecret');
      expect(warning.raw ?? '').not.toContain('aWVzLTI1Ni1nY206dG9wc2VjcmV0');
    }
  });
});

describe('parseSubscriptionText: unsupported formats', () => {
  it('reports empty, whitespace, NUL and plain junk', () => {
    expect(codes('')).toEqual(['E_UNSUPPORTED_INPUT_FORMAT']);
    expect(codes('   \n\t\n')).toEqual(['E_UNSUPPORTED_INPUT_FORMAT']);
    expect(codes('ss://ok\x00')).toEqual(['E_UNSUPPORTED_INPUT_FORMAT']);
    expect(codes('hello world')).toEqual(['E_UNSUPPORTED_INPUT_FORMAT']);
  });

  it('rejects base64 of binary data', () => {
    expect(codes('/wA=')).toEqual(['E_UNSUPPORTED_INPUT_FORMAT']);
  });

  it('supports only one base64 layer', () => {
    const once = encodeBase64Url(fixtureUris()[0]);
    const twice = encodeBase64Url(once);
    const result = parseSubscriptionText(twice, 'url#1');
    expect(result.nodes).toHaveLength(0);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'W_INPUT_BASE64_DETECTED',
      'E_UNSUPPORTED_INPUT_FORMAT',
    ]);
    expect(result.warnings[1].message).toContain('nested base64');
  });

  it('does not interpret base64-looking text with invalid padding as a subscription', () => {
    const result = parseSubscriptionText('abcd=', 'url#1');
    expect(result.nodes).toHaveLength(0);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['E_UNSUPPORTED_INPUT_FORMAT']);
  });
});
