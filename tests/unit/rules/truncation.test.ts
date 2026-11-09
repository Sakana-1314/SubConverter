import { describe, expect, it } from 'vitest';
import {
  checkDeclaredCount,
  checkTail,
  checkTemplateTail,
  hasFinalNewline,
} from '../../../src/rules/truncation';

function codes(warnings: ReadonlyArray<{ code: string }>): string[] {
  return warnings.map((warning) => warning.code);
}

describe('truncation: typed tail detection (SPEC §6.2)', () => {
  it('flags a final truncated type token when there is no final newline', () => {
    const warnings = checkTail({
      rawText: 'DOMAIN,a.com,PROXY\nDOMA',
      lines: ['DOMAIN,a.com,PROXY', 'DOMA'],
      hadFinalNewline: false,
      dialect: 'surge',
      sourceId: 'url#1',
    });
    expect(codes(warnings)).toEqual(['E_TRUNCATED_TAIL']);
    expect(warnings[0]).toMatchObject({
      code: 'E_TRUNCATED_TAIL',
      severity: 'error',
      stage: 'rules',
      source: 'url#1',
      line: 2,
      raw: 'DOMA',
    });
    expect(warnings[0].hint).toBeDefined();
  });

  it('does not flag DOMA when the file has a final newline (parse handles it)', () => {
    expect(
      checkTail({
        rawText: 'DOMAIN,a.com,PROXY\nDOMA\n',
        lines: ['DOMAIN,a.com,PROXY', 'DOMA'],
        hadFinalNewline: true,
        dialect: 'surge',
        sourceId: 'url#1',
      }),
    ).toEqual([]);
  });

  it('flags trailing commas, bare type tokens and strict prefixes', () => {
    for (const last of ['DOMAIN,a.com,', 'DOMAIN', 'DOMAIN-SUFFI', 'MATCHBO', 'FINAL']) {
      const warnings = checkTail({
        rawText: `DOMAIN,a.com,PROXY\n${last}`,
        lines: ['DOMAIN,a.com,PROXY', last],
        hadFinalNewline: false,
        dialect: 'clash-classical',
        sourceId: 'url#1',
      });
      expect(codes(warnings), last).toEqual(['E_TRUNCATED_TAIL']);
    }
  });

  it('does not use type-prefix heuristics for non-typed entries', () => {
    expect(
      checkTail({
        rawText: 'payload:\n  - DOMA',
        lines: [{ text: 'DOMAIN-SUFFIX,DOMA', line: 2, typed: false }],
        hadFinalNewline: false,
        dialect: 'clash-domain',
        sourceId: 'url#1',
      }),
    ).toEqual([]);
  });

  it('ignores unknown-but-not-prefix tokens such as MATCHBOX', () => {
    expect(
      checkTail({
        rawText: 'MATCHBOX',
        lines: ['MATCHBOX'],
        hadFinalNewline: false,
        dialect: 'surge',
        sourceId: 'url#1',
      }),
    ).toEqual([]);
  });
});

describe('truncation: template tail before YAML parsing (P0-3)', () => {
  it('flags - DOMA without a final newline', () => {
    const warnings = checkTemplateTail('rules:\n  - DOMAIN,a.com,PROXY\n  - DOMA', 'template');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'E_TRUNCATED_TAIL',
      stage: 'template',
      line: 3,
      source: 'template',
    });
  });

  it('flags quoted bare type tokens and trailing commas', () => {
    expect(codes(checkTemplateTail('rules:\n  - "DOMAIN"', 'template'))).toEqual([
      'E_TRUNCATED_TAIL',
    ]);
    expect(codes(checkTemplateTail('rules:\n  - DOMAIN,a.com,', 'template'))).toEqual([
      'E_TRUNCATED_TAIL',
    ]);
  });

  it('does not flag a template that ends with a newline', () => {
    expect(checkTemplateTail('rules:\n  - DOMA\n', 'template')).toEqual([]);
    expect(checkTemplateTail('rules:\n  - DOMAIN,a.com,PROXY\n', 'template')).toEqual([]);
  });
});

describe('truncation: domain declared counts and whitespace tail', () => {
  it('parses # TOTAL / # COUNT declarations', () => {
    for (const declaration of ['# TOTAL: 5', '# COUNT: 5', '# TOTAL 5', '#total:5']) {
      const warnings = checkDeclaredCount(`${declaration}\nexample.com\nfoo.com\n`, 2, 'url#1');
      expect(codes(warnings), declaration).toEqual(['E_TRUNCATED_SOURCE']);
      expect(warnings[0].line).toBe(1);
    }
  });

  it('does not warn when the actual count meets or exceeds the declaration', () => {
    expect(checkDeclaredCount('# TOTAL: 2\na\nb\n', 2, 'url#1')).toEqual([]);
    expect(checkDeclaredCount('# TOTAL: 2\na\nb\nc\n', 3, 'url#1')).toEqual([]);
    expect(checkDeclaredCount('no declaration here\n', 1, 'url#1')).toEqual([]);
  });

  it('uses the whitespace-tail heuristic only for the domain dialect', () => {
    const warnings = checkTail({
      rawText: 'example.com\n  ',
      lines: ['DOMAIN-SUFFIX,example.com'],
      hadFinalNewline: false,
      dialect: 'domain',
      sourceId: 'url#1',
    });
    expect(codes(warnings)).toEqual(['W_TRUNCATED_TAIL_SUSPECT']);
    expect(warnings[0].severity).toBe('warning');

    expect(
      checkTail({
        rawText: 'example.com\n  ',
        lines: ['DOMAIN-SUFFIX,example.com'],
        hadFinalNewline: true,
        dialect: 'domain',
        sourceId: 'url#1',
      }),
    ).toEqual([]);
  });

  it('detects final newline presence', () => {
    expect(hasFinalNewline('a\n')).toBe(true);
    expect(hasFinalNewline('a\r\n')).toBe(true);
    expect(hasFinalNewline('a\r')).toBe(true);
    expect(hasFinalNewline('a')).toBe(false);
    expect(hasFinalNewline('')).toBe(false);
  });
});
