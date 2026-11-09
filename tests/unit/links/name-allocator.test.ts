import { describe, expect, it } from 'vitest';
import type { ProxyNode } from '../../../src/links/contracts';
import { allocateNames } from '../../../src/links/name-allocator';

function node(name: string, server = 'node.example.com', port = 443): ProxyNode {
  return {
    kind: 'ss',
    name,
    server,
    port,
    cipher: 'aes-256-gcm',
    password: 'secret',
  };
}

function allocate(nodes: ProxyNode[], reserved: string[] = []) {
  const warnings: import('../../../src/links/contracts').Warning[] = [];
  allocateNames(nodes, new Set(reserved), warnings);
  return warnings;
}

describe('allocateNames', () => {
  it('leaves unique names untouched', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const warnings = allocate(nodes);
    expect(nodes.map((item) => item.name)).toEqual(['a', 'b', 'c']);
    expect(warnings).toEqual([]);
  });

  it('replaces empty names with server:port', () => {
    const nodes = [node('', '1.2.3.4', 8388)];
    const warnings = allocate(nodes);
    expect(nodes[0].name).toBe('1.2.3.4:8388');
    expect(warnings.map((warning) => warning.code)).toEqual(['W_NODE_NAME_EMPTY']);
    expect(warnings[0].severity).toBe('info');
    expect(warnings[0].stage).toBe('nodes');
  });

  it('appends suffixes for duplicates, case-insensitively', () => {
    const nodes = [node('node'), node('node'), node('NODE'), node('node 2')];
    const warnings = allocate(nodes);
    expect(nodes.map((item) => item.name)).toEqual([
      'node',
      'node 2',
      'NODE 3',
      'node 2 2',
    ]);
    expect(warnings.filter((warning) => warning.code === 'W_NODE_NAME_DUPLICATE')).toHaveLength(3);
  });

  it('avoids reserved names and group names', () => {
    const nodes = [node('PROXY'), node('proxy'), node('DIRECT')];
    const warnings = allocate(nodes, ['PROXY', 'DIRECT']);
    expect(nodes.map((item) => item.name)).toEqual(['PROXY 2', 'proxy 3', 'DIRECT 2']);
    expect(warnings.map((warning) => warning.code)).toEqual([
      'W_NODE_NAME_RESERVED',
      'W_NODE_NAME_RESERVED',
      'W_NODE_NAME_RESERVED',
    ]);
  });

  it('strips control characters before allocating', () => {
    const nodes = [node('a\nb\tc\u0000d')];
    const warnings = allocate(nodes);
    expect(nodes[0].name).toBe('abcd');
    expect(warnings).toEqual([]);
  });

  it('truncates names over 128 code points', () => {
    const nodes = [node('x'.repeat(130))];
    const warnings = allocate(nodes);
    expect(Array.from(nodes[0].name)).toHaveLength(128);
    expect(warnings.map((warning) => warning.code)).toEqual(['W_NODE_NAME_TRUNCATED']);
  });

  it('keeps suffixed duplicate names within the length limit', () => {
    const nodes = [node('y'.repeat(130)), node('y'.repeat(130))];
    const warnings = allocate(nodes);
    expect(Array.from(nodes[0].name)).toHaveLength(128);
    expect(Array.from(nodes[1].name)).toHaveLength(128);
    expect(nodes[1].name.endsWith(' 2')).toBe(true);
    expect(warnings.map((warning) => warning.code)).toEqual([
      'W_NODE_NAME_TRUNCATED',
      'W_NODE_NAME_TRUNCATED',
      'W_NODE_NAME_DUPLICATE',
    ]);
  });

  it('treats control-only names as empty', () => {
    const nodes = [node('\u0000\u0001', '5.6.7.8', 80)];
    const warnings = allocate(nodes);
    expect(nodes[0].name).toBe('5.6.7.8:80');
    expect(warnings.map((warning) => warning.code)).toEqual(['W_NODE_NAME_EMPTY']);
  });
});
