import { describe, expect, it } from 'vitest';
import { buildRules, parseRuleLine, type ValidationContext } from '../../../src/rules/index';
import domaFixture from '../../fixtures/rules/doma-20675.txt?raw';

function context(): ValidationContext {
  return {
    sourceId: 'url#1',
    mode: 'template',
    knownTargets: new Set(['PROXY', 'DIRECT']),
    knownProviders: new Set(),
    allowMatch: true,
  };
}

describe('DOMA regression: 20,675-rule ruleset (AC-06)', () => {
  it('fixture has the documented size and shape', () => {
    expect(new TextEncoder().encode(domaFixture).byteLength).toBe(278_330);
    const lines = domaFixture.split('\n');
    expect(lines).toHaveLength(20_675);
    expect(lines.at(-1)).toBe('DOMA');
    expect(domaFixture.endsWith('\n')).toBe(false);
    expect(domaFixture.slice(0, 10)).toBe('DOMAIN,x0\n');
    expect(domaFixture).toContain('\nDOMAIN,x20673\n');
    const base64UrlChars = btoa(domaFixture)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '').length;
    expect(base64UrlChars).toBe(371_107);
  });

  it('intercepts the final DOMA, keeps 20,674 valid rules and reports exact warnings', () => {
    const started = performance.now();
    const result = buildRules({
      sources: [
        {
          sourceId: 'url#1',
          text: domaFixture,
          dialect: 'surge',
          group: 'PROXY',
        },
      ],
      mode: 'inline',
      knownTargets: new Set(['PROXY']),
      defaultGroup: 'PROXY',
    });
    const elapsed = performance.now() - started;

    // 20,674 valid DOMAIN rules + exactly one final MATCH.
    expect(result.rules).toHaveLength(20_675);
    expect(result.rules.filter((rule) => rule.type === 'DOMAIN')).toHaveLength(20_674);
    expect(result.rules.at(-1)).toMatchObject({ type: 'MATCH', target: 'PROXY' });
    expect(result.rules.slice(0, 20_674).map((rule) => rule.payload)).toEqual(
      Array.from({ length: 20_674 }, (_, index) => `x${index}`),
    );

    // DOMA never enters the output, in any form.
    expect(result.rules.some((rule) => (rule.type as string) === 'DOMA')).toBe(false);
    expect(result.rules.some((rule) => rule.raw.trim().split(',')[0]?.trim() === 'DOMA')).toBe(false);
    expect(result.rules.some((rule) => rule.raw.includes(',DOMA,'))).toBe(false);
    expect(JSON.stringify(result.rules)).not.toContain('"type":"DOMA"');

    // Exact warning: line 20675 (1-based), raw DOMA.
    const noTarget = result.warnings.filter((warning) => warning.code === 'E_RULE_NO_TARGET');
    expect(noTarget).toHaveLength(1);
    expect(noTarget[0]).toMatchObject({
      code: 'E_RULE_NO_TARGET',
      severity: 'error',
      stage: 'rules',
      source: 'url#1',
      line: 20_675,
      raw: 'DOMA',
    });
    expect(noTarget[0].hint).toContain('truncated');
    expect(codes(result.warnings)).toContain('E_TRUNCATED_TAIL');
    expect(
      result.warnings
        .filter((warning) => warning.code === 'E_TRUNCATED_TAIL')
        .map((warning) => warning.line),
    ).toEqual([20_675]);

    // Only the DOMA line was dropped.
    expect(result.stats).toMatchObject({
      input: 20_675,
      accepted: 20_674,
      dropped: 1,
    });
    expect(result.stats.byCode.E_RULE_NO_TARGET).toBe(1);
    expect(result.stats.byCode.E_TRUNCATED_TAIL).toBe(1);
    expect(result.stats.byCode.W_DEFAULT_MATCH_ADDED).toBe(1);
    expect(result.stats.byCode.E_RULE_UNKNOWN_TYPE).toBeUndefined();

    // Performance gate (generous; the pipeline is O(n)).
    expect(elapsed).toBeLessThan(5_000);

    // Read-back: every emitted rule must be accepted by the same parser.
    for (const rule of result.rules) {
      const line =
        rule.type === 'MATCH'
          ? `MATCH,${rule.target}`
          : `${rule.type},${rule.payload},${rule.target}`;
      expect(parseRuleLine(line, context(), 1).ok, line).toBe(true);
    }
  }, 30_000);

  it('intercepts DOMA,example.com at line 20,674 and keeps the other rules', () => {
    const validLines = Array.from({ length: 20_673 }, (_, index) => `DOMAIN,v${index}`);
    validLines.push('DOMA,example.com');
    validLines.push('DOMAIN,last.example.com');
    const text = `${validLines.join('\n')}\n`;

    const result = buildRules({
      sources: [
        {
          sourceId: 'url#1',
          text,
          dialect: 'surge',
          group: 'PROXY',
        },
      ],
      mode: 'inline',
      knownTargets: new Set(['PROXY']),
      defaultGroup: 'PROXY',
    });

    expect(result.rules).toHaveLength(20_675); // 20,674 valid + MATCH
    expect(result.rules.at(-1)?.type).toBe('MATCH');
    expect(result.rules.some((rule) => rule.raw === 'DOMA,example.com')).toBe(false);
    expect(result.rules[20_673]).toMatchObject({
      type: 'DOMAIN',
      payload: 'last.example.com',
      target: 'PROXY',
    });

    const warning = result.warnings.find((item) => item.raw === 'DOMA,example.com');
    expect(warning).toMatchObject({
      code: 'E_RULE_UNKNOWN_TYPE',
      source: 'url#1',
      line: 20_674,
    });
    expect(result.stats).toMatchObject({
      input: 20_675,
      accepted: 20_674,
      dropped: 1,
    });
  }, 30_000);
});

function codes(warnings: ReadonlyArray<{ code: string }>): string[] {
  return warnings.map((warning) => warning.code);
}
