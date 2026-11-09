import { describe, expect, it } from 'vitest';
import type { ProxyNode, Warning } from '../../../src/links/contracts';
import {
  applyFilters,
  applyRenames,
  applySourceGroup,
  sortNodes,
} from '../../../src/links/node-ops';

function node(name: string, password = 'p'): ProxyNode {
  return {
    kind: 'ss',
    name,
    server: 'node.example.com',
    port: 443,
    cipher: 'aes-256-gcm',
    password,
  };
}

function warnings(): Warning[] {
  return [];
}

describe('applyFilters', () => {
  const nodes = [node('HK 01'), node('US 01'), node('HK 02'), node('JP 01')];

  it('OR-s include patterns and preserves order', () => {
    const result = applyFilters(nodes, ['^HK', '^JP'], [], warnings());
    expect(result.map((item) => item.name)).toEqual(['HK 01', 'HK 02', 'JP 01']);
  });

  it('applies include before exclude', () => {
    const result = applyFilters(nodes, ['^HK'], ['02$'], warnings());
    expect(result.map((item) => item.name)).toEqual(['HK 01']);
  });

  it('keeps everything when include is empty', () => {
    expect(applyFilters(nodes, [], [], warnings())).toHaveLength(4);
  });

  it('throws invalid_regex for unsafe patterns', () => {
    for (const pattern of ['(a+)+$', '(.*)*', '\\1', 'a{1,100000}']) {
      try {
        applyFilters(nodes, [pattern], [], warnings());
        throw new Error('expected applyFilters to throw');
      } catch (error) {
        expect((error as { code?: string }).code).toBe('invalid_regex');
      }
    }
  });

  it('throws for syntactically invalid patterns', () => {
    expect(() => applyFilters(nodes, ['('], [], warnings())).toThrow();
  });
});

describe('applyRenames', () => {
  it('applies rules in order with global replacement and $1', () => {
    const nodes = [node('HK 01 HK'), node('US 02')];
    applyRenames(
      nodes,
      [
        { pattern: 'HK', replacement: 'Hong Kong' },
        { pattern: '^Hong Kong (\\d+)$', replacement: 'HK-$1' },
      ],
      warnings(),
    );
    expect(nodes.map((item) => item.name)).toEqual(['Hong Kong 01 Hong Kong', 'US 02']);
  });

  it('supports capture replacements', () => {
    const nodes = [node('HK 01')];
    applyRenames(nodes, [{ pattern: '^(\\w+) (\\d+)$', replacement: '$2-$1' }], warnings());
    expect(nodes[0].name).toBe('01-HK');
  });

  it('throws invalid_regex for unsafe patterns', () => {
    expect(() =>
      applyRenames([node('a')], [{ pattern: '(a+)+$', replacement: 'x' }], warnings()),
    ).toThrow();
  });
});

describe('applySourceGroup', () => {
  it('overrides sourceGroup on every node', () => {
    const nodes = [node('a'), node('b')];
    applySourceGroup(nodes, 'airport');
    expect(nodes.map((item) => item.sourceGroup)).toEqual(['airport', 'airport']);
  });

  it('does nothing for undefined or empty group', () => {
    const nodes = [node('a'), node('b')];
    applySourceGroup(nodes, undefined);
    applySourceGroup(nodes, '');
    expect(nodes.map((item) => item.sourceGroup)).toEqual([undefined, undefined]);
  });
});

describe('sortNodes', () => {
  it('sorts by UTF-16 code unit order and is stable', () => {
    const nodes = [node('b', 'b1'), node('a', 'a1'), node('b', 'b2'), node('A', 'A1')];
    const sorted = sortNodes(nodes);
    expect(
      sorted.map((item) => `${item.name}:${(item as { password?: string }).password}`),
    ).toEqual(['A:A1', 'a:a1', 'b:b1', 'b:b2']);
    // The input array is left untouched.
    expect(nodes.map((item) => item.name)).toEqual(['b', 'a', 'b', 'A']);
  });
});
