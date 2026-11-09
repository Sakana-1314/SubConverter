import { describe, expect, it } from 'vitest';
import type { GroupSpec, ProxyGroup, Warning } from '../../../src/types';
import {
  buildGroup,
  compileMatcherRegex,
  defaultGroups,
  expandGroupSpec,
  isUnsafeRegexSource,
  limitGroups,
  parsePortRange,
  sanitizeGroupReferences,
  toMihomoGroup,
  toMihomoGroups,
} from '../../../src/emitter/groups';

function group(overrides: Partial<ProxyGroup> & Pick<ProxyGroup, 'name' | 'type' | 'members'>): ProxyGroup {
  return { ...overrides };
}

function spec(overrides: Partial<GroupSpec> & Pick<GroupSpec, 'name' | 'type' | 'matchers'>): GroupSpec {
  return { ...overrides };
}

const nodes = [
  { name: 'HK 01', kind: 'ss', server: '1.1.1.1', port: 8388, sourceGroup: 'tag-a' },
  { name: 'HK 02', kind: 'vmess', server: '2.2.2.2', port: 443, sourceGroup: 'tag-b' },
  { name: 'US 01', kind: 'ss', server: '1.2.3.4', port: 9000, sourceGroup: 'tag-a' },
  { name: 'SSR 01', kind: 'ssr', server: '9.9.9.9', port: 8443, sourceGroup: 'tag-b' },
];

describe('toMihomoGroup', () => {
  it('emits a select group without health-check fields', () => {
    const out = toMihomoGroup(group({ name: 'PROXY', type: 'select', members: ['a', 'b', 'DIRECT'] }));
    expect(out).toEqual({ name: 'PROXY', type: 'select', proxies: ['a', 'b', 'DIRECT'] });
  });

  it('applies url-test defaults', () => {
    const out = toMihomoGroup(group({ name: 'AUTO', type: 'url-test', members: ['a'] }));
    expect(out).toEqual({
      name: 'AUTO',
      type: 'url-test',
      url: 'https://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
      proxies: ['a'],
    });
  });

  it('keeps explicit url/interval/tolerance for url-test', () => {
    const out = toMihomoGroup(group({
      name: 'AUTO',
      type: 'url-test',
      members: ['a'],
      url: 'https://example.com/204',
      interval: 120,
      tolerance: 10,
    }));
    expect(out.url).toBe('https://example.com/204');
    expect(out.interval).toBe(120);
    expect(out.tolerance).toBe(10);
  });

  it('emits fallback without tolerance', () => {
    const out = toMihomoGroup(group({
      name: 'FB',
      type: 'fallback',
      members: ['a'],
      tolerance: 10,
    }));
    expect(out).not.toHaveProperty('tolerance');
    expect(out.url).toBe('https://www.gstatic.com/generate_204');
    expect(out.interval).toBe(300);
  });

  it('emits a valid load-balance strategy and ignores invalid values', () => {
    const roundRobin = toMihomoGroup(group({
      name: 'LB',
      type: 'load-balance',
      members: ['a'],
      strategy: 'round-robin',
    }));
    expect(roundRobin.strategy).toBe('round-robin');

    const invalid = group({ name: 'LB2', type: 'load-balance', members: ['a'] });
    invalid.strategy = 'random' as ProxyGroup['strategy'];
    expect(toMihomoGroup(invalid)).not.toHaveProperty('strategy');
  });

  it('de-duplicates members and drops self references', () => {
    const out = toMihomoGroup(group({
      name: 'PROXY',
      type: 'select',
      members: ['a', 'a', 'PROXY', 'b', 'a'],
    }));
    expect(out.proxies).toEqual(['a', 'b']);
  });

  it('falls back to DIRECT for an empty group and warns', () => {
    const warnings: Warning[] = [];
    const out = toMihomoGroup(group({ name: 'EMPTY', type: 'select', members: [] }), warnings);
    expect(out.proxies).toEqual(['DIRECT']);
    expect(warnings.map((warning) => warning.code)).toContain('W_GROUP_EMPTY');
    expect(warnings[0]?.stage).toBe('groups');
  });

  it('rejects unsupported group types and empty names', () => {
    const relay = { name: 'R', type: 'relay', members: ['DIRECT'] } as unknown as ProxyGroup;
    expect(() => toMihomoGroup(relay)).toThrowError(/unsupported type/);
    expect(() => toMihomoGroup(group({ name: '', type: 'select', members: [] }))).toThrowError(/empty name/);
  });

  it('maps groups in order', () => {
    const out = toMihomoGroups([
      group({ name: 'A', type: 'select', members: ['DIRECT'] }),
      group({ name: 'B', type: 'select', members: ['DIRECT'] }),
    ]);
    expect(out.map((entry) => entry.name)).toEqual(['A', 'B']);
  });
});

describe('buildGroup filters by name include/exclude', () => {
  it('applies include and exclude regexes with OR semantics', () => {
    const included = buildGroup({
      name: 'HK',
      type: 'select',
      nodes,
      include: ['^HK'],
      exclude: ['02'],
    });
    expect(included.members).toEqual(['HK 01']);

    const union = buildGroup({
      name: 'ALL-EXCEPT-US',
      type: 'select',
      nodes,
      include: ['^HK', '^SSR'],
      exclude: ['US'],
    });
    expect(union.members).toEqual(['HK 01', 'HK 02', 'SSR 01']);

    const everything = buildGroup({ name: 'ALL', type: 'select', nodes });
    expect(everything.members).toEqual(['HK 01', 'HK 02', 'US 01', 'SSR 01']);
  });

  it('adds literal members before filtered nodes and de-duplicates', () => {
    const out = buildGroup({
      name: 'PROXY',
      type: 'select',
      nodes,
      members: ['DIRECT', 'HK 01'],
      include: ['^HK 01$'],
    });
    expect(out.members).toEqual(['DIRECT', 'HK 01']);
  });

  it('ignores invalid include/exclude regexes and warns', () => {
    const warnings: Warning[] = [];
    const out = buildGroup({
      name: 'BAD',
      type: 'select',
      nodes,
      include: ['(a+)+$'],
      members: [],
    }, warnings);
    expect(warnings.map((warning) => warning.code)).toContain('W_GROUP_MATCHER_INVALID');
    expect(out.members).toEqual(['DIRECT']);
  });

  it('fills url-test defaults', () => {
    const out = buildGroup({ name: 'AUTO', type: 'url-test', nodes, include: ['^HK'] });
    expect(out.url).toBe('https://www.gstatic.com/generate_204');
    expect(out.interval).toBe(300);
    expect(out.tolerance).toBe(50);
    expect(out.members).toEqual(['HK 01', 'HK 02']);
  });
});

describe('expandGroupSpec matchers', () => {
  it('expands literal, regex, type, group, server and port matchers in order', () => {
    const expanded = expandGroupSpec(spec({
      name: 'EXPANDED',
      type: 'select',
      matchers: [
        { kind: 'literal', value: 'DIRECT' },
        { kind: 'name-regex', pattern: '^HK' },
        { kind: 'node-type', pattern: 'SS' },
        { kind: 'source-group', pattern: 'tag-a' },
        { kind: 'server', pattern: '^1\\.' },
        { kind: 'port-range', range: '8000-9000' },
      ],
    }), nodes);
    expect(expanded.members).toEqual(['DIRECT', 'HK 01', 'HK 02', 'US 01', 'SSR 01']);
  });

  it('does not treat a node-type regex as a prefix', () => {
    const expanded = expandGroupSpec(spec({
      name: 'SS-ONLY',
      type: 'select',
      matchers: [{ kind: 'node-type', pattern: 'SS' }],
    }), nodes);
    expect(expanded.members).toEqual(['HK 01', 'US 01']);
  });

  it('warns on invalid matchers and skips them', () => {
    const warnings: Warning[] = [];
    const expanded = expandGroupSpec(spec({
      name: 'BAD',
      type: 'select',
      matchers: [
        { kind: 'name-regex', pattern: '(a+)+$' },
        { kind: 'server', pattern: '[' },
        { kind: 'port-range', range: 'nope' },
        { kind: 'literal', value: 'DIRECT' },
      ],
    }), nodes, warnings);
    expect(expanded.members).toEqual(['DIRECT']);
    expect(warnings.every((warning) => warning.code === 'W_GROUP_MATCHER_INVALID')).toBe(true);
    expect(warnings).toHaveLength(3);
  });
});

describe('group reference sanitation', () => {
  it('drops unknown and self references', () => {
    const warnings: Warning[] = [];
    const cleaned = sanitizeGroupReferences([
      group({ name: 'A', type: 'select', members: ['node1', 'DIRECT', 'MISSING', 'A'] }),
      group({ name: 'B', type: 'select', members: ['A'] }),
    ], { nodeNames: ['node1'], warnings });
    expect(cleaned[0]?.members).toEqual(['node1', 'DIRECT']);
    expect(cleaned[1]?.members).toEqual(['A']);
    expect(warnings.map((warning) => warning.code)).toContain('E_RULE_TARGET_NOT_FOUND');
  });

  it('breaks group-to-group cycles deterministically', () => {
    const warnings: Warning[] = [];
    const cleaned = sanitizeGroupReferences([
      group({ name: 'X', type: 'select', members: ['Y'] }),
      group({ name: 'Y', type: 'select', members: ['X'] }),
    ], { nodeNames: [], warnings });
    const x = cleaned.find((entry) => entry.name === 'X');
    const y = cleaned.find((entry) => entry.name === 'Y');
    expect(x?.members).toEqual(['Y']);
    expect(y?.members).toEqual([]);
    expect(warnings.map((warning) => warning.code)).toContain('W_GROUP_MATCHER_INVALID');
  });

  it('keeps acyclic group chains', () => {
    const cleaned = sanitizeGroupReferences([
      group({ name: 'A', type: 'select', members: ['DIRECT'] }),
      group({ name: 'B', type: 'select', members: ['A'] }),
      group({ name: 'C', type: 'url-test', members: ['B'] }),
    ], { nodeNames: [], warnings: [] });
    expect(cleaned.map((entry) => entry.members)).toEqual([['DIRECT'], ['A'], ['B']]);
  });

  it('limits the group count to 128', () => {
    const warnings: Warning[] = [];
    const many = Array.from({ length: 130 }, (_, index) => group({
      name: `G${index}`,
      type: 'select',
      members: ['DIRECT'],
    }));
    const limited = limitGroups(many, warnings);
    expect(limited).toHaveLength(128);
    expect(warnings[0]?.code).toBe('W_GROUP_LIMIT');
  });
});

describe('defaultGroups', () => {
  it('builds PROXY and AUTO', () => {
    const warnings: Warning[] = [];
    const groups = defaultGroups(['a', 'b'], warnings);
    expect(groups.map((entry) => entry.name)).toEqual(['PROXY', 'AUTO']);
    expect(groups[0]?.members).toEqual(['a', 'b', 'DIRECT']);
    expect(groups[1]?.members).toEqual(['a', 'b']);
    expect(groups[1]?.type).toBe('url-test');
    expect(warnings[0]?.code).toBe('W_GROUP_DEFAULT_ADDED');
  });

  it('keeps DIRECT as the only member when there are no nodes', () => {
    const groups = defaultGroups([], []);
    expect(groups[0]?.members).toEqual(['DIRECT']);
    expect(groups[1]?.members).toEqual(['DIRECT']);
  });
});

describe('matcher primitives', () => {
  it('parses the !!PORT range syntax', () => {
    expect(parsePortRange('1000-2000')).toEqual({ min: 1000, max: 2000 });
    expect(parsePortRange('443')).toEqual({ min: 443, max: 443 });
    expect(parsePortRange('8000+')).toEqual({ min: 8000, max: 65535 });
    expect(parsePortRange('9000-')).toEqual({ min: 0, max: 9000 });
    expect(parsePortRange('2000-1000')).toBeNull();
    expect(parsePortRange('70000')).toBeNull();
    expect(parsePortRange('abc')).toBeNull();
  });

  it('flags unsafe regular expressions', () => {
    expect(isUnsafeRegexSource('(a+)+$')).not.toBeNull();
    expect(isUnsafeRegexSource('(\\d{1,3})+')).not.toBeNull();
    expect(isUnsafeRegexSource('(a)\\1')).not.toBeNull();
    expect(isUnsafeRegexSource('a{2000}')).not.toBeNull();
    expect(isUnsafeRegexSource('^HK [0-9]+$')).toBeNull();
    expect(compileMatcherRegex('[', 'u').ok).toBe(false);
  });
});
