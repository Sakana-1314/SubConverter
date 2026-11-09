import { describe, expect, it } from 'vitest';
import {
  allocateGroupNames,
  compileUserRegex,
  defaultGroups,
  expandGroups,
  parseCustomGroupLine,
  parseGroupsParam,
} from '../../../src/rules/groups';
import type { GroupSpec, ProxyNode, Warning } from '../../../src/types';

function mkNode(overrides: Partial<ProxyNode> & { name: string }): ProxyNode {
  return {
    kind: 'ss',
    server: '1.2.3.4',
    port: 443,
    cipher: 'aes-256-gcm',
    password: 'p',
    ...overrides,
  } as ProxyNode;
}

function parse(line: string): { spec: GroupSpec | null; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const spec = parseCustomGroupLine(line, { warnings });
  return { spec, warnings };
}

function codes(warnings: ReadonlyArray<{ code: string }>): string[] {
  return warnings.map((warning) => warning.code);
}

describe('groups: custom_proxy_group parsing (SPEC §8.3)', () => {
  it('parses a select group with literal and typed elements', () => {
    const { spec, warnings } = parse('PROXY`select`[]DIRECT`!!TYPE=SS');
    expect(warnings).toEqual([]);
    expect(spec).toEqual({
      name: 'PROXY',
      type: 'select',
      matchers: [
        { kind: 'literal', value: 'DIRECT' },
        { kind: 'node-type', pattern: 'SS' },
      ],
    });
  });

  it('parses url-test/fallback/load-balance fields', () => {
    const auto = parse(
      'AUTO`url-test`!!TYPE=SS|SSR`https://www.gstatic.com/generate_204`300,50',
    );
    expect(auto.warnings).toEqual([]);
    expect(auto.spec).toMatchObject({
      name: 'AUTO',
      type: 'url-test',
      url: 'https://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
    });
    expect(auto.spec?.matchers).toEqual([{ kind: 'node-type', pattern: 'SS|SSR' }]);

    const fallback = parse('FALLBACK`fallback`[]n1`https://x.test/204`600');
    expect(fallback.spec).toMatchObject({
      type: 'fallback',
      interval: 600,
      tolerance: 50,
    });

    const balance = parse('BALANCE`load-balance`[]n1`https://x.test/204`600,0');
    expect(balance.spec).toMatchObject({ type: 'load-balance', interval: 600, tolerance: 0 });
  });

  it('rejects unsupported types and malformed lines', () => {
    for (const type of ['relay', 'ssid', 'smart', 'url-test-ish']) {
      const result = parse(`G\`${type}\`[]DIRECT`);
      expect(result.spec, type).toBeNull();
      expect(codes(result.warnings)).toContain('W_GROUP_UNSUPPORTED_TYPE');
    }
    expect(parse('G`select').spec).toBeNull();
    expect(parse('G`url-test`[]n`http://x').spec).toBeNull();
    expect(parse('`select`[]DIRECT').spec).toBeNull();
  });

  it('falls back to defaults for invalid URLs and intervals', () => {
    const badUrl = parse('A`url-test`[]n`ftp://x.test/204`300');
    expect(badUrl.spec?.url).toBe('https://www.gstatic.com/generate_204');
    expect(codes(badUrl.warnings)).toContain('W_GROUP_MATCHER_INVALID');

    const badTimes = parse('A`url-test`[]n`https://x.test/204`abc');
    expect(badTimes.spec?.interval).toBe(300);
    expect(badTimes.spec?.tolerance).toBe(50);
    expect(codes(badTimes.warnings)).toContain('W_GROUP_MATCHER_INVALID');
  });

  it('parses all matcher kinds and rejects unsupported directives', () => {
    const { spec, warnings } = parse(
      'G`select`!!GROUP=HK`!!SERVER=1\\.2\\.3\\.`!!PORT=80-90`!!PORT=100+`!!PORT=443`!!PORT=70000',
    );
    expect(spec?.matchers).toEqual([
      { kind: 'source-group', pattern: 'HK' },
      { kind: 'server', pattern: '1\\.2\\.3\\.' },
      { kind: 'port-range', range: '80-90' },
      { kind: 'port-range', range: '100-65535' },
      { kind: 'port-range', range: '443' },
    ]);
    expect(codes(warnings)).toEqual(['W_GROUP_MATCHER_INVALID']);

    const directives = parse('G`select`!!PROVIDER=x`!!GROUPID=3`!!INSERT=x`script:foo.js');
    expect(directives.spec?.matchers).toEqual([]);
    expect(codes(directives.warnings)).toEqual([
      'W_GROUP_DIRECTIVE_UNSUPPORTED',
      'W_GROUP_DIRECTIVE_UNSUPPORTED',
      'W_GROUP_DIRECTIVE_UNSUPPORTED',
      'W_GROUP_DIRECTIVE_UNSUPPORTED',
    ]);
  });

  it('rejects unsafe and invalid matcher regexes (AC-26)', () => {
    for (const pattern of ['(a+)+$', '(a*)*', '\\1', '[']) {
      const { spec } = parse(`G\`select\`${pattern}`);
      expect(spec?.matchers, pattern).toEqual([]);
    }
  });
});

describe('groups: group names', () => {
  it('de-duplicates case-insensitively and moves reserved names', () => {
    const warnings: Warning[] = [];
    const specs = parseGroupsParam(
      '\uFEFF# comment\r\nG`select`[]DIRECT\r\nG`select`[]DIRECT\r\ng`select`[]REJECT\r\nDIRECT`select`[]REJECT\r\n',
      warnings,
    );
    expect(specs.map((spec) => spec.name)).toEqual(['G', 'G 2', 'g 3', 'DIRECT 2']);
    expect(codes(warnings)).toEqual([
      'W_GROUP_NAME_DUPLICATE',
      'W_GROUP_NAME_DUPLICATE',
      'W_GROUP_NAME_DUPLICATE',
    ]);
  });

  it('allocates against caller-reserved names', () => {
    const warnings: Warning[] = [];
    const specs: GroupSpec[] = [
      { name: 'PROXY', type: 'select', matchers: [] },
      { name: 'AUTO', type: 'select', matchers: [] },
    ];
    const allocated = allocateGroupNames(specs, {
      warnings,
      reserved: new Set(['PROXY']),
    });
    expect(allocated.map((spec) => spec.name)).toEqual(['PROXY 2', 'AUTO']);
    expect(codes(warnings)).toEqual(['W_GROUP_NAME_DUPLICATE']);
  });

  it('rejects empty/over-long names through the parser', () => {
    expect(parse('`select`[]DIRECT').spec).toBeNull();
    expect(parse(`${'x'.repeat(65)}\`select\`[]DIRECT`).spec).toBeNull();
  });
});

describe('groups: expansion (SPEC §7.3)', () => {
  const nodes: ProxyNode[] = [
    mkNode({ name: 'HK1', kind: 'ss', server: '1.2.3.4', port: 443, sourceGroup: 'HK' }),
    mkNode({ name: 'HK2', kind: 'vmess', server: '1.2.3.5', port: 8443, sourceGroup: 'HK' }),
    mkNode({ name: 'US1', kind: 'trojan', server: '5.6.7.8', port: 443, sourceGroup: 'US' }),
    mkNode({ name: 'JP1', kind: 'vless', server: '9.9.9.9', port: 1080, sourceGroup: 'JP' }),
  ];

  it('expands matchers in order with de-duplication', () => {
    const warnings: Warning[] = [];
    const specs: GroupSpec[] = [
      {
        name: 'G',
        type: 'select',
        matchers: [
          { kind: 'literal', value: 'DIRECT' },
          { kind: 'name-regex', pattern: '^HK' },
          { kind: 'node-type', pattern: 'VMESS' },
          { kind: 'port-range', range: '443' },
          { kind: 'server', pattern: '1\\.2\\.3\\.' },
          { kind: 'source-group', pattern: 'HK' },
        ],
      },
    ];
    const groups = expandGroups(specs, nodes, warnings);
    expect(groups).toEqual([
      { name: 'G', type: 'select', members: ['DIRECT', 'HK1', 'HK2', 'US1'] },
    ]);
    expect(warnings).toEqual([]);
  });

  it('keeps group type metadata', () => {
    const warnings: Warning[] = [];
    const specs: GroupSpec[] = [
      {
        name: 'AUTO',
        type: 'url-test',
        matchers: [{ kind: 'name-regex', pattern: '^HK' }],
        url: 'https://x.test/204',
        interval: 120,
        tolerance: 20,
      },
    ];
    expect(expandGroups(specs, nodes, warnings)[0]).toEqual({
      name: 'AUTO',
      type: 'url-test',
      members: ['HK1', 'HK2'],
      url: 'https://x.test/204',
      interval: 120,
      tolerance: 20,
    });
  });

  it('adds DIRECT to empty groups and warns', () => {
    const warnings: Warning[] = [];
    const groups = expandGroups(
      [{ name: 'EMPTY', type: 'select', matchers: [{ kind: 'name-regex', pattern: '^NOPE' }] }],
      nodes,
      warnings,
    );
    expect(groups[0].members).toEqual(['DIRECT']);
    expect(codes(warnings)).toEqual(['W_GROUP_EMPTY']);
  });

  it('drops self-references and unknown literal members', () => {
    const warnings: Warning[] = [];
    const groups = expandGroups(
      [
        {
          name: 'G',
          type: 'select',
          matchers: [
            { kind: 'literal', value: 'G' },
            { kind: 'literal', value: 'GHOST' },
          ],
        },
      ],
      nodes,
      warnings,
    );
    expect(groups[0].members).toEqual(['DIRECT']);
    expect(codes(warnings)).toEqual([
      'W_GROUP_MATCHER_INVALID',
      'W_GROUP_MATCHER_INVALID',
      'W_GROUP_EMPTY',
    ]);
  });

  it('enforces MAX_GROUPS', () => {
    const warnings: Warning[] = [];
    const specs: GroupSpec[] = Array.from({ length: 4 }, (_, index) => ({
      name: `G${index}`,
      type: 'select' as const,
      matchers: [{ kind: 'literal' as const, value: 'DIRECT' }],
    }));
    const groups = expandGroups(specs, nodes, warnings, { maxGroups: 2 });
    expect(groups.map((group) => group.name)).toEqual(['G0', 'G1']);
    expect(codes(warnings)).toEqual(['W_GROUP_LIMIT']);
  });
});

describe('groups: default groups', () => {
  const nodes: ProxyNode[] = [mkNode({ name: 'n1' }), mkNode({ name: 'n2' })];

  it('creates PROXY (select) and AUTO (url-test)', () => {
    const warnings: Warning[] = [];
    const groups = defaultGroups(nodes, warnings);
    expect(groups).toEqual([
      { name: 'PROXY', type: 'select', members: ['n1', 'n2', 'DIRECT'] },
      {
        name: 'AUTO',
        type: 'url-test',
        members: ['n1', 'n2'],
        url: 'https://www.gstatic.com/generate_204',
        interval: 300,
        tolerance: 50,
      },
    ]);
    expect(codes(warnings)).toEqual(['W_GROUP_DEFAULT_ADDED']);
  });

  it('falls back to DIRECT with no nodes', () => {
    const warnings: Warning[] = [];
    const groups = defaultGroups([], warnings);
    expect(groups[0].members).toEqual(['DIRECT']);
    expect(groups[1].members).toEqual(['DIRECT']);
    expect(codes(warnings)).toEqual(['W_GROUP_DEFAULT_ADDED', 'W_GROUP_EMPTY']);
  });
});

describe('groups: user regex safety', () => {
  it('accepts ordinary regexes and rejects catastrophic ones', () => {
    expect(compileUserRegex('^HK|^TW').ok).toBe(true);
    expect(compileUserRegex('(a+)+$').ok).toBe(false);
    expect(compileUserRegex('(a|aa)+$').ok).toBe(true);
    expect(compileUserRegex('x'.repeat(257)).ok).toBe(false);
  });
});
