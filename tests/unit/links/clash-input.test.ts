/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import clashFixture from '../../fixtures/links/clash-input.yaml?raw';
import { parseClashNodes } from '../../../src/links/clash-input';
import type { ProxyNode } from '../../../src/links/contracts';
import { parseYamlSingle } from '../../../src/links/yaml';

const UUIDS = '11111111-2222-3333-4444-555555555555';

function parseFixture() {
  const yaml = parseYamlSingle(clashFixture, 8 * 1024 * 1024);
  expect(yaml.ok).toBe(true);
  if (!yaml.ok) throw new Error(yaml.message);
  return parseClashNodes(yaml.value, 'url#1');
}

function byName(nodes: ProxyNode[], name: string): ProxyNode {
  const node = nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`missing node: ${name}`);
  return node;
}

function singleProxy(proxy: Record<string, unknown>) {
  return parseClashNodes({ proxies: [proxy] }, 'url#1');
}

function codesOf(result: ReturnType<typeof parseClashNodes>): string[] {
  return result.warnings.map((warning) => warning.code);
}

describe('parseClashNodes: fixture', () => {
  it('maps all five supported protocols and skips the rest', () => {
    const result = parseFixture();
    expect(result.stats).toEqual({ lines: 7, accepted: 6, dropped: 1 });
    expect(result.nodes.map((node) => node.kind)).toEqual([
      'ss',
      'ssr',
      'vmess',
      'trojan',
      'vless',
      'ss',
    ]);
    expect(codesOf(result)).toContain('W_CLASH_SECTION_IGNORED');
    expect(codesOf(result)).toContain('W_NODE_UNSUPPORTED_PROTOCOL');
    expect(codesOf(result)).toContain('W_NODE_FIELDS_IGNORED');
  });

  it('maps common and protocol-specific fields', () => {
    const result = parseFixture();

    const ss = byName(result.nodes, 'ss-clash');
    expect(ss).toMatchObject({
      kind: 'ss',
      server: '1.2.3.4',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'ss-pass',
      udp: true,
    });

    const ssr = byName(result.nodes, 'ssr-clash');
    expect(ssr).toMatchObject({
      kind: 'ssr',
      cipher: 'dummy',
      protocol: 'origin',
      obfs: 'plain',
    });

    const vmess = byName(result.nodes, 'vmess-clash');
    expect(vmess).toMatchObject({
      kind: 'vmess',
      uuid: UUIDS,
      alterId: 0,
      cipher: 'auto',
      tls: true,
      network: 'ws',
      servername: 'vm.example.com',
      ws: { path: '/ws', host: 'cdn.example.com' },
    });

    const trojan = byName(result.nodes, 'trojan-clash');
    expect(trojan).toMatchObject({
      kind: 'trojan',
      password: 'tj-pass',
      alpn: ['h2', 'http/1.1'],
      network: 'grpc',
      grpc: { serviceName: 'gun' },
      skipCertVerify: true,
    });

    const vless = byName(result.nodes, 'vless-clash');
    expect(vless).toMatchObject({
      kind: 'vless',
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      tls: true,
      flow: 'xtls-rprx-vision',
      reality: { publicKey: 'PUBKEY', shortId: 'abcd' },
    });
  });
});

describe('parseClashNodes: top-level shape', () => {
  it('prefers proxies and warns when Proxy also exists', () => {
    const result = parseClashNodes(
      {
        proxies: [
          { name: 'a', type: 'ss', server: '1.2.3.4', port: 8388, cipher: 'aes-256-gcm', password: 'p' },
        ],
        Proxy: [
          { name: 'b', type: 'trojan', server: '5.6.7.8', port: 443, password: 'p' },
        ],
      },
      'url#1',
    );
    expect(codesOf(result)).toContain('W_CLASH_DUPLICATE_PROXY_KEY');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].name).toBe('a');
  });

  it('accepts the legacy Proxy key alone', () => {
    const result = parseClashNodes(
      {
        Proxy: [
          { name: 'b', type: 'trojan', server: '5.6.7.8', port: 443, password: 'p' },
        ],
      },
      'url#1',
    );
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].kind).toBe('trojan');
  });

  it('rejects unsupported JSON config shapes', () => {
    for (const value of [{ outbounds: [] }, { servers: [] }, { airport: 'x' }]) {
      const result = parseClashNodes(value, 'url#1');
      expect(codesOf(result)).toEqual(['E_UNSUPPORTED_INPUT_FORMAT']);
      expect(result.nodes).toHaveLength(0);
    }
  });

  it('rejects non-objects, missing and non-array proxies', () => {
    expect(codesOf(parseClashNodes([], 'url#1'))).toEqual(['E_YAML_PARSE']);
    expect(codesOf(parseClashNodes('text', 'url#1'))).toEqual(['E_YAML_PARSE']);
    expect(codesOf(parseClashNodes({ rules: [] }, 'url#1'))).toEqual(['E_UNSUPPORTED_INPUT_FORMAT']);
    expect(codesOf(parseClashNodes({ proxies: {} }, 'url#1'))).toEqual(['E_YAML_PARSE']);
  });

  it('drops non-object entries and entries without a string type', () => {
    const result = parseClashNodes({ proxies: ['x', { server: '1.2.3.4', port: 1 }] }, 'url#1');
    expect(result.nodes).toHaveLength(0);
    expect(result.stats.dropped).toBe(2);
    expect(result.warnings.map((warning) => warning.line)).toEqual([1, 2]);
    expect(codesOf(result)).toEqual(['E_NODE_LINE', 'E_NODE_LINE']);
  });
});

describe('parseClashNodes: per-node validation', () => {
  it('rejects bad ports and servers', () => {
    expect(
      codesOf(
        singleProxy({ name: 'p', type: 'ss', server: '1.2.3.4', port: 0, cipher: 'aes-256-gcm', password: 'p' }),
      ),
    ).toEqual(['E_NODE_PORT']);
    expect(
      codesOf(
        singleProxy({ name: 'p', type: 'ss', server: 'bad host', port: 8388, cipher: 'aes-256-gcm', password: 'p' }),
      ),
    ).toEqual(['E_NODE_SERVER']);
    expect(
      codesOf(
        singleProxy({ name: 'p', type: 'trojan', server: '1.2.3.4', port: 70000, password: 'p' }),
      ),
    ).toEqual(['E_NODE_PORT']);
  });

  it('rejects invalid protocol fields', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'ss', server: '1.2.3.4', port: 1, cipher: 'rot13', password: 'p' }, 'E_NODE_CIPHER'],
      [{ type: 'ss', server: '1.2.3.4', port: 1, cipher: 'aes-256-gcm', password: 'p', plugin: 'kcptun' }, 'E_NODE_PLUGIN'],
      [{ type: 'ssr', server: '1.2.3.4', port: 1, cipher: 'aes-256-cfb', password: 'p', protocol: 'nope', obfs: 'plain' }, 'E_NODE_CIPHER'],
      [{ type: 'vmess', server: 'h', port: 1, uuid: 'nope', alterId: 0, network: 'tcp' }, 'E_NODE_UUID'],
      [{ type: 'vmess', server: 'h', port: 1, uuid: UUIDS, alterId: 0, network: 'h2' }, 'E_NODE_TRANSPORT'],
      [{ type: 'vmess', server: 'h', port: 1, uuid: UUIDS, alterId: 'x', network: 'tcp' }, 'E_NODE_LINE'],
      [{ type: 'trojan', server: 'h', port: 1, password: '' }, 'E_NODE_LINE'],
      [{ type: 'trojan', server: 'h', port: 1, password: 'p', network: 'quic' }, 'E_NODE_TRANSPORT'],
      [{ type: 'vless', server: 'h', port: 1, uuid: UUIDS, network: 'tcp', 'reality-opts': {} }, 'E_NODE_REALITY'],
      [{ type: 'vless', server: 'h', port: 1, uuid: UUIDS, network: 'tcp', flow: 'bad' }, 'E_NODE_FLOW'],
      [{ type: 'vless', server: 'h', port: 1, uuid: UUIDS, network: 'kcp' }, 'E_NODE_TRANSPORT'],
    ];
    for (const [proxy, code] of cases) {
      expect(codesOf(singleProxy({ name: 'p', ...proxy })), code).toEqual([code]);
    }
  });

  it('maps Clash SS plugins and common flags', () => {
    const result = singleProxy({
      name: 'plugin',
      type: 'ss',
      server: '1.2.3.4',
      port: 8388,
      cipher: 'chacha20-ietf-poly1305',
      password: 'p',
      plugin: 'obfs',
      'plugin-opts': { mode: 'http', host: 'bing.com' },
      udp: true,
      tfo: true,
    });
    expect(result.warnings).toEqual([]);
    const node = result.nodes[0];
    expect(node.kind).toBe('ss');
    if (node.kind !== 'ss') return;
    expect(node.plugin).toBe('obfs');
    expect(node.pluginOpts).toEqual({ mode: 'http', host: 'bing.com' });
    expect(node.udp).toBe(true);
    expect(node.tfo).toBe(true);
  });

  it('forces tls when Clash Vless reality-opts are present', () => {
    const result = singleProxy({
      name: 'r',
      type: 'vless',
      server: 'h',
      port: 443,
      uuid: UUIDS,
      network: 'tcp',
      'reality-opts': { 'public-key': 'KEY', 'short-id': 'sid' },
    });
    const node = result.nodes[0];
    expect(node.kind).toBe('vless');
    if (node.kind !== 'vless') return;
    expect(node.tls).toBe(true);
    expect(node.reality).toEqual({ publicKey: 'KEY', shortId: 'sid' });
  });
});

describe('parseYamlSingle', () => {
  it('rejects multi-document input', () => {
    expect(parseYamlSingle('a: 1\n---\nb: 2\n', 1000)).toMatchObject({
      ok: false,
      code: 'E_YAML_MULTI_DOC',
    });
  });

  it('rejects custom tags', () => {
    expect(parseYamlSingle('x: !!js/function "y"\n', 1000)).toMatchObject({
      ok: false,
      code: 'E_YAML_TAG',
    });
  });

  it('rejects duplicate keys and oversized input', () => {
    expect(parseYamlSingle('a: 1\na: 2\n', 1000)).toMatchObject({ ok: false, code: 'E_YAML_PARSE' });
    expect(parseYamlSingle('a: 1\n', 2)).toMatchObject({ ok: false, code: 'E_YAML_PARSE' });
  });

  it('returns null for empty input', () => {
    expect(parseYamlSingle('', 1000)).toEqual({ ok: true, value: null });
  });
});
