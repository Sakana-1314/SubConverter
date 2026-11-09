import { describe, expect, it } from 'vitest';
import {
  decodeBase64Text,
  detectDialect,
  extractRuleLines,
  looksLikeHtmlErrorPage,
  normalizeDialectName,
  normalizeNewlines,
  stripBom,
} from '../../../src/rules/dialects';
import clashPayloadFixture from '../../../test/fixtures/rules/clash-payload.yaml?raw';
import domainListFixture from '../../../test/fixtures/rules/domain-list.txt?raw';
import surgeFixture from '../../../test/fixtures/rules/surge.list?raw';

function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function codes(warnings: ReadonlyArray<{ code: string }>): string[] {
  return warnings.map((warning) => warning.code);
}

describe('dialects: explicit names and aliases (SPEC §4.1 / AC-31)', () => {
  it('accepts clash-classic as an alias with W_DIALECT_ALIAS', () => {
    const result = normalizeDialectName('clash-classic');
    expect(result.dialect).toBe('clash-classical');
    expect(codes(result.warnings)).toEqual(['W_DIALECT_ALIAS']);
  });

  it('rejects quanx and unknown dialects without treating them as URLs', () => {
    for (const value of ['quanx', 'surfboard', 'nonsense']) {
      const result = normalizeDialectName(value);
      expect(result.error?.code).toBe('W_DIALECT_UNSUPPORTED');
      expect(result.error?.severity).toBe('warning');
    }
  });

  it('recognizes every supported dialect and auto', () => {
    for (const value of [
      'clash-classical',
      'clash-domain',
      'clash-ipcidr',
      'surge',
      'domain',
      'base64',
    ]) {
      expect(normalizeDialectName(value).dialect).toBe(value);
    }
    expect(normalizeDialectName('auto').dialect).toBe('auto');
    expect(normalizeDialectName('').dialect).toBe('auto');
  });
});

describe('dialects: automatic detection (SPEC §4.2)', () => {
  it('detects YAML payloads and top-level arrays', () => {
    expect(detectDialect('payload:\n  - DOMAIN,a.com\n  - DOMAIN-SUFFIX,b.com\n')).toMatchObject({
      dialect: 'clash-classical',
    });
    expect(detectDialect('payload:\n  - example.com\n  - foo.com\n')).toMatchObject({
      dialect: 'clash-domain',
    });
    expect(detectDialect('payload:\n  - 1.2.3.0/24\n  - 2001:db8::/32\n')).toMatchObject({
      dialect: 'clash-ipcidr',
    });
    expect(detectDialect('- DOMAIN,a.com\n- DOMAIN,b.com\n')).toMatchObject({
      dialect: 'clash-classical',
    });
    expect(detectDialect('rules:\n  - DOMAIN,a.com\n')).toMatchObject({
      dialect: 'clash-classical',
    });
  });

  it('detects Surge text from the first typed line', () => {
    expect(detectDialect('DOMAIN,a.com,PROXY\nIP-CIDR,1.2.3.0/24,no-resolve\n')).toMatchObject({
      dialect: 'surge',
    });
    expect(detectDialect('# comment\n\nFINAL,DIRECT\n')).toMatchObject({ dialect: 'surge' });
  });

  it('detects base64 and bare domain lists', () => {
    expect(detectDialect(base64Url('DOMAIN,a.com\nDOMAIN,b.com\n'))).toMatchObject({
      dialect: 'base64',
    });
    expect(detectDialect('example.com\nfoo.com\n')).toMatchObject({ dialect: 'domain' });
    expect(detectDialect('')).toMatchObject({ dialect: 'domain' });
  });

  it('rejects HTML error pages', () => {
    const html = '\uFEFF  <!DOCTYPE html><html><body>error</body></html>';
    expect(looksLikeHtmlErrorPage(html)).toBe(true);
    const detected = detectDialect(html);
    expect('error' in detected && detected.error.code).toBe('E_FETCH_HTML');
    const extracted = extractRuleLines(html, 'domain', 'url#1');
    expect(extracted.lines).toEqual([]);
    expect(codes(extracted.warnings)).toContain('E_FETCH_HTML');
  });

  it('ignores Content-Type hints', () => {
    expect(detectDialect('DOMAIN,a.com,PROXY', undefined, 'text/html')).toMatchObject({
      dialect: 'surge',
    });
  });
});

describe('dialects: extraction and BOM/CRLF/comments', () => {
  it('strips BOM and normalizes CRLF while preserving line numbers', () => {
    expect(stripBom('\uFEFFx')).toBe('x');
    expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');

    const extracted = extractRuleLines(
      '\uFEFF# comment\r\nDOMAIN,a.com,PROXY\r\n\r\nDOMAIN-SUFFIX,b.com\r\n',
      'surge',
      'url#1',
    );
    expect(extracted.lines).toEqual([
      { text: 'DOMAIN,a.com,PROXY', line: 2, typed: true },
      { text: 'DOMAIN-SUFFIX,b.com', line: 4, typed: true },
    ]);
    expect(extracted.warnings).toEqual([]);
    expect(extracted.stats).toEqual({ candidates: 2, dropped: 0 });
  });

  it('skips whole-line comments and empty lines in text dialects', () => {
    const extracted = extractRuleLines(
      '# a\n; b\n// c\n\nexample.com\n',
      'domain',
      'url#1',
    );
    expect(extracted.lines).toEqual([{ text: 'DOMAIN-SUFFIX,example.com', line: 5, typed: false }]);
  });

  it('extracts clash-classical payload/rules arrays with YAML line numbers', () => {
    const extracted = extractRuleLines(
      'payload:\n  - DOMAIN,a.com\n  - "DOMAIN,b.com"\n',
      'clash-classical',
      'url#1',
    );
    expect(extracted.lines).toEqual([
      { text: 'DOMAIN,a.com', line: 2, typed: true },
      { text: 'DOMAIN,b.com', line: 3, typed: true },
    ]);
    expect(extracted.stats).toEqual({ candidates: 2, dropped: 0 });

    const rulesKey = extractRuleLines('rules:\n  - DOMAIN,a.com\n', 'clash-classical', 'config');
    expect(rulesKey.lines).toEqual([{ text: 'DOMAIN,a.com', line: 2, typed: true }]);
  });

  it('drops non-string YAML entries with a warning', () => {
    const extracted = extractRuleLines(
      'payload:\n  - DOMAIN,a.com\n  - 42\n  - {a: b}\n',
      'clash-classical',
      'url#1',
    );
    expect(extracted.lines).toHaveLength(1);
    expect(extracted.stats).toEqual({ candidates: 3, dropped: 2 });
    expect(codes(extracted.warnings)).toEqual(['E_RULE_BAD_PAYLOAD', 'E_RULE_BAD_PAYLOAD']);
  });

  it('reports malformed and multi-document YAML', () => {
    const malformed = extractRuleLines('payload:\n - [\n', 'clash-classical', 'url#1');
    expect(malformed.lines).toEqual([]);
    expect(codes(malformed.warnings)).toContain('E_YAML_PARSE');

    const multi = extractRuleLines(
      'payload:\n  - DOMAIN,a.com\n---\npayload:\n  - DOMAIN,b.com\n',
      'clash-classical',
      'url#1',
    );
    expect(multi.lines).toEqual([]);
    expect(codes(multi.warnings)).toContain('E_YAML_MULTI_DOC');
  });

  it('rejects custom YAML tags', () => {
    const extracted = extractRuleLines('payload:\n  - !foo bar\n', 'clash-classical', 'url#1');
    expect(extracted.lines).toEqual([]);
    expect(codes(extracted.warnings)).toContain('E_YAML_TAG');
  });
});

describe('dialects: clash-domain and clash-ipcidr mappings (SPEC §4.3)', () => {
  it('maps bare / . / +. entries to DOMAIN or DOMAIN-SUFFIX', () => {
    const extracted = extractRuleLines(
      'payload:\n  - example.com\n  - .suffix.com\n  - +.plus.com\n  - DOMAIN,typed.com\n',
      'clash-domain',
      'url#1',
    );
    expect(extracted.lines).toEqual([
      { text: 'DOMAIN,example.com', line: 2, typed: false },
      { text: 'DOMAIN-SUFFIX,suffix.com', line: 3, typed: false },
      { text: 'DOMAIN-SUFFIX,plus.com', line: 4, typed: false },
    ]);
    expect(extracted.stats).toEqual({ candidates: 4, dropped: 1 });
    expect(codes(extracted.warnings)).toEqual(['W_RULESET_TYPE_FILTERED']);
  });

  it('maps CIDRs to IP-CIDR / IP-CIDR6 and drops invalid entries', () => {
    const extracted = extractRuleLines(
      'payload:\n  - 1.2.3.0/24\n  - 2001:db8::/32\n  - nope\n',
      'clash-ipcidr',
      'url#1',
    );
    expect(extracted.lines).toEqual([
      { text: 'IP-CIDR,1.2.3.0/24', line: 2, typed: false },
      { text: 'IP-CIDR6,2001:db8::/32', line: 3, typed: false },
    ]);
    expect(extracted.stats).toEqual({ candidates: 3, dropped: 1 });
    expect(codes(extracted.warnings)).toEqual(['E_RULE_BAD_CIDR']);
  });
});

describe('dialects: domain-list prefixes (SPEC §4.3)', () => {
  it('maps full/domain/keyword/regexp and drops include', () => {
    const extracted = extractRuleLines(domainListFixture, 'domain', 'url#1');
    expect(extracted.lines.map((line) => line.text)).toEqual([
      'DOMAIN-SUFFIX,example.com',
      'DOMAIN,exact.example.com',
      'DOMAIN-SUFFIX,suffix.example.com',
      'DOMAIN-KEYWORD,ads',
      'DOMAIN-REGEX,^track[0-9]+\\.example\\.com$',
    ]);
    expect(extracted.stats).toEqual({ candidates: 6, dropped: 1 });
    expect(codes(extracted.warnings)).toEqual(['W_RULESET_TYPE_FILTERED']);
  });

  it('detects declared-count truncation', () => {
    const extracted = extractRuleLines('# TOTAL: 5\nexample.com\nfoo.com\n', 'domain', 'url#1');
    expect(extracted.lines).toHaveLength(2);
    expect(codes(extracted.warnings)).toEqual(['E_TRUNCATED_SOURCE']);
  });

  it('detects declared counts behind a BOM', () => {
    const extracted = extractRuleLines(
      '\uFEFF# TOTAL: 5\nexample.com\nfoo.com\n',
      'domain',
      'url#1',
    );
    expect(codes(extracted.warnings)).toContain('E_TRUNCATED_SOURCE');
  });
});

describe('dialects: base64 (one level)', () => {
  it('decodes once and re-detects', () => {
    const encoded = base64Url('DOMAIN,a.com\nDOMAIN,b.com\n');
    const detected = detectDialect(encoded);
    expect(detected).toMatchObject({ dialect: 'base64' });

    const extracted = extractRuleLines(encoded, 'base64', 'url#1');
    expect(extracted.lines).toEqual([
      { text: 'DOMAIN,a.com', line: 1, typed: true },
      { text: 'DOMAIN,b.com', line: 2, typed: true },
    ]);
    expect(codes(extracted.warnings)).toContain('W_INPUT_BASE64_DETECTED');
  });

  it('rejects invalid and nested base64', () => {
    const nested = base64Url(base64Url('DOMAIN,a.com\n'));
    const extracted = extractRuleLines(nested, 'base64', 'url#1');
    expect(extracted.lines).toEqual([]);
    expect(codes(extracted.warnings)).toContain('E_BASE64_INVALID');

    expect(decodeBase64Text('not base64!').ok).toBe(false);
  });
});

describe('dialects: fixtures', () => {
  it('detects and extracts the Surge fixture', () => {
    expect(detectDialect(surgeFixture)).toMatchObject({ dialect: 'surge' });
    const extracted = extractRuleLines(surgeFixture, 'surge', 'url#1');
    expect(extracted.lines).toHaveLength(9);
    expect(extracted.lines.map((line) => line.line)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it('extracts the Clash payload fixture', () => {
    expect(detectDialect(clashPayloadFixture)).toMatchObject({ dialect: 'clash-classical' });
    const extracted = extractRuleLines(clashPayloadFixture, 'clash-classical', 'url#1');
    expect(extracted.lines.map((line) => line.text)).toEqual([
      'DOMAIN,example.com',
      'DOMAIN-SUFFIX,example.org',
      'IP-CIDR,10.0.0.0/8,no-resolve',
      'DOMAIN-REGEX,^a{1,3}$',
      'DOMAIN,quoted.example.net',
      'DOMAIN-KEYWORD,tracker',
      'MATCH,DIRECT',
    ]);
    expect(extracted.warnings).toEqual([]);
  });

  it('rejects NUL bytes', () => {
    const extracted = extractRuleLines('DOMAIN,a.com\u0000,PROXY', 'surge', 'url#1');
    expect(extracted.lines).toEqual([]);
    expect(codes(extracted.warnings)).toEqual(['E_UTF8_INVALID']);
    expect(extracted.warnings[0].stage).toBe('decode');
  });

  it('returns W_RULESET_EMPTY for empty sources', () => {
    for (const dialect of ['domain', 'clash-classical', 'surge'] as const) {
      const extracted = extractRuleLines('', dialect, 'url#1');
      expect(extracted.lines).toEqual([]);
      expect(codes(extracted.warnings)).toContain('W_RULESET_EMPTY');
    }
  });
});
