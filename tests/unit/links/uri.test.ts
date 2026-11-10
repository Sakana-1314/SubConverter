/// <reference types="vite/client" />

import { describe, expect, it } from 'vitest';
import urisFixture from '../../fixtures/links/uris.txt?raw';
import { encodeBase64, encodeBase64Url } from '../../../src/links/base64';
import { parseUri } from '../../../src/links/uri';
import type { UriParseResult } from '../../../src/links/contracts';

const UUID = '11111111-2222-3333-4444-555555555555';

function ok(result: UriParseResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.node;
}

function failCode(result: UriParseResult): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a failure');
  return result.code;
}

describe('URI dispatcher', () => {
  it('parses every protocol in the fixture', () => {
    const lines = urisFixture
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));

    expect(lines).toHaveLength(5);
    const nodes = lines.map((line) => ok(parseUri(line)));
    expect(nodes.map((node) => node.kind)).toEqual(['ss', 'ssr', 'vmess', 'trojan', 'vless']);
  });

  it('is case-insensitive for schemes', () => {
    const node = ok(parseUri(`SS://${encodeBase64Url('aes-256-gcm:p')}@1.2.3.4:8388#n`));
    expect(node.kind).toBe('ss');
  });

  it('rejects unknown schemes and non-URIs', () => {
    expect(failCode(parseUri('socks://1.2.3.4:1080'))).toBe('E_NODE_SCHEME_UNSUPPORTED');
    expect(failCode(parseUri('http://example.com/sub'))).toBe('E_NODE_SCHEME_UNSUPPORTED');
    expect(failCode(parseUri('hysteria2://x@example.com:443'))).toBe('E_NODE_SCHEME_UNSUPPORTED');
    expect(failCode(parseUri('just some text'))).toBe('E_NODE_LINE');
    expect(failCode(parseUri('   '))).toBe('E_NODE_LINE');
  });

  it('does not throw on malformed input', () => {
    const inputs = [
      'ss://',
      'ssr://',
      'vmess://',
      'trojan://',
      'vless://',
      'ss://@@@',
      'vmess://%%%',
      'trojan://pass@[::]:0',
      'vless://uuid@host:port?security=reality',
      'ssr://!!!!',
    ];
    for (const input of inputs) {
      expect(() => parseUri(input)).not.toThrow();
      expect(parseUri(input).ok).toBe(false);
    }
  });
});

describe('ss://', () => {
  it('parses SIP002 with obfs plugin', () => {
    const userinfo = encodeBase64Url('aes-256-gcm:pass');
    const plugin = encodeURIComponent('obfs-local;obfs=http;obfs-host=bing.com');
    const node = ok(parseUri(`ss://${userinfo}@1.2.3.4:8388/?plugin=${plugin}#SS%20Obfs`));
    expect(node.kind).toBe('ss');
    if (node.kind !== 'ss') return;
    expect(node).toMatchObject({
      name: 'SS Obfs',
      server: '1.2.3.4',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'pass',
      plugin: 'obfs',
    });
    expect(node.pluginOpts).toEqual({ mode: 'http', host: 'bing.com' });
  });

  it('parses v2ray-plugin options', () => {
    const userinfo = encodeBase64Url('chacha20-ietf-poly1305:p');
    const plugin = encodeURIComponent('v2ray-plugin;mode=websocket;tls;host=cdn.example.com;path=/ws');
    const node = ok(parseUri(`ss://${userinfo}@5.6.7.8:8443?plugin=${plugin}#v2`));
    if (node.kind !== 'ss') throw new Error('expected ss');
    expect(node.plugin).toBe('v2ray-plugin');
    expect(node.pluginOpts).toEqual({
      mode: 'websocket',
      tls: true,
      host: 'cdn.example.com',
      path: '/ws',
    });
  });

  it('parses the legacy whole-payload form', () => {
    const legacy = `ss://${encodeBase64('aes-128-gcm:legacy-pass@9.9.9.9:8389')}#Legacy`;
    const node = ok(parseUri(legacy));
    if (node.kind !== 'ss') throw new Error('expected ss');
    expect(node).toMatchObject({
      server: '9.9.9.9',
      port: 8389,
      cipher: 'aes-128-gcm',
      password: 'legacy-pass',
      name: 'Legacy',
    });
  });

  it('parses plaintext userinfo and percent-decodes the password', () => {
    const node = ok(parseUri('ss://chacha20-ietf-poly1305:p%40ss@ss.example.com:443#plain'));
    if (node.kind !== 'ss') throw new Error('expected ss');
    expect(node.password).toBe('p@ss');
    expect(node.server).toBe('ss.example.com');
  });

  it('parses bracketed IPv6 servers', () => {
    const node = ok(parseUri(`ss://${encodeBase64Url('aes-256-gcm:p')}@[2001:db8::1]:8388#v6`));
    expect(node.server).toBe('2001:db8::1');
  });

  it('rejects unsupported ciphers, plugins and bad ports', () => {
    expect(failCode(parseUri(`ss://${encodeBase64Url('rot13:p')}@1.2.3.4:8388`))).toBe('E_NODE_CIPHER');
    expect(
      failCode(parseUri(`ss://${encodeBase64Url('aes-256-gcm:p')}@1.2.3.4:8388?plugin=kcptun`)),
    ).toBe('E_NODE_PLUGIN');
    expect(failCode(parseUri(`ss://${encodeBase64Url('aes-256-gcm:p')}@1.2.3.4:0`))).toBe('E_NODE_PORT');
    expect(failCode(parseUri('ss://%%%'))).toBe('E_BASE64_INVALID');
  });
});

describe('ssr://', () => {
  it('parses the fixture with remarks/params', () => {
    const line = urisFixture
      .split(/\r?\n/)
      .find((value) => value.startsWith('ssr://'));
    expect(line).toBeDefined();
    const node = ok(parseUri(line!));
    if (node.kind !== 'ssr') throw new Error('expected ssr');
    expect(node).toMatchObject({
      name: 'SSR Node',
      server: 'ssr.example.com',
      port: 8388,
      protocol: 'auth_chain_a',
      obfs: 'http_simple',
      cipher: 'aes-256-cfb',
      password: 'ssr-pass',
      protocolParam: '32',
      obfsParam: 'www.example.com',
    });
  });

  it('maps cipher none to dummy', () => {
    const payload = `h.example.com:8388:origin:none:plain:${encodeBase64Url('p')}/?remarks=${encodeBase64Url('n')}`;
    const node = ok(parseUri(`ssr://${encodeBase64Url(payload)}`));
    if (node.kind !== 'ssr') throw new Error('expected ssr');
    expect(node.cipher).toBe('dummy');
  });

  it('supports IPv6 hosts by splitting the last five colons', () => {
    const payload = `[2001:db8::1]:8388:origin:aes-256-cfb:plain:${encodeBase64Url('pw')}/?remarks=${encodeBase64Url('v6')}`;
    const node = ok(parseUri(`ssr://${encodeBase64Url(payload)}`));
    expect(node.server).toBe('2001:db8::1');
    expect(node.port).toBe(8388);
  });

  it('rejects unknown protocol/obfs and malformed base64', () => {
    const badProtocol = `h:1:unknown:aes-256-cfb:plain:${encodeBase64Url('p')}`;
    expect(failCode(parseUri(`ssr://${encodeBase64Url(badProtocol)}`))).toBe('E_NODE_CIPHER');
    const badObfs = `h:1:origin:aes-256-cfb:unknown:${encodeBase64Url('p')}`;
    expect(failCode(parseUri(`ssr://${encodeBase64Url(badObfs)}`))).toBe('E_NODE_CIPHER');
    expect(failCode(parseUri('ssr://***'))).toBe('E_BASE64_INVALID');
  });
});

describe('vmess://', () => {
  function jsonVmess(overrides: Record<string, unknown> = {}): string {
    const payload = {
      v: '2',
      ps: 'VM',
      add: 'vm.example.com',
      port: '443',
      id: UUID,
      aid: '0',
      net: 'ws',
      type: 'none',
      host: 'cdn.example.com',
      path: '/ws',
      tls: 'tls',
      sni: 'vm.example.com',
      ...overrides,
    };
    return `vmess://${encodeBase64(JSON.stringify(payload))}`;
  }

  it('parses base64 JSON v2', () => {
    const node = ok(parseUri(jsonVmess()));
    if (node.kind !== 'vmess') throw new Error('expected vmess');
    expect(node).toMatchObject({
      name: 'VM',
      server: 'vm.example.com',
      port: 443,
      uuid: UUID,
      alterId: 0,
      cipher: 'auto',
      tls: true,
      network: 'ws',
      servername: 'vm.example.com',
      ws: { path: '/ws', host: 'cdn.example.com' },
    });
  });

  it('parses the standard URI form with grpc', () => {
    const uri = `vmess://${UUID}@vm2.example.com:8443?type=grpc&security=tls&serviceName=gun&sni=vm2.example.com&aid=7#VMess%20gRPC`;
    const node = ok(parseUri(uri));
    if (node.kind !== 'vmess') throw new Error('expected vmess');
    expect(node).toMatchObject({
      name: 'VMess gRPC',
      port: 8443,
      alterId: 7,
      tls: true,
      network: 'grpc',
      grpc: { serviceName: 'gun' },
    });
  });

  it('supports the Shadowrocket base64+query variant', () => {
    const base = encodeBase64(
      JSON.stringify({ v: '2', ps: 'ignored', add: 'vm3.example.com', port: 443, id: UUID, aid: 0, net: 'tcp' }),
    );
    const uri = `vmess://${base}?remarks=${encodeURIComponent('VMess SR')}&obfs=ws&path=%2Fsr&host=sr.example.com&tls=1`;
    const node = ok(parseUri(uri));
    if (node.kind !== 'vmess') throw new Error('expected vmess');
    expect(node.name).toBe('VMess SR');
    expect(node.network).toBe('ws');
    expect(node.tls).toBe(true);
    expect(node.ws).toEqual({ path: '/sr', host: 'sr.example.com' });
  });

  it('splits JSON v1 host;path', () => {
    const node = ok(parseUri(jsonVmess({ host: 'cdn.example.com;/v1', path: undefined })));
    if (node.kind !== 'vmess') throw new Error('expected vmess');
    expect(node.ws).toEqual({ path: '/v1', host: 'cdn.example.com' });
  });

  it('rejects invalid uuid, port, transport and alterId', () => {
    expect(failCode(parseUri(jsonVmess({ id: 'not-a-uuid' })))).toBe('E_NODE_UUID');
    expect(failCode(parseUri(jsonVmess({ port: 'abc' })))).toBe('E_NODE_PORT');
    expect(failCode(parseUri(jsonVmess({ port: 0 })))).toBe('E_NODE_PORT');
    expect(failCode(parseUri(jsonVmess({ net: 'h2' })))).toBe('E_NODE_TRANSPORT');
    expect(failCode(parseUri(jsonVmess({ aid: 'x' })))).toBe('E_NODE_LINE');
  });
});

describe('trojan://', () => {
  it('parses ws/tls fields and decodes the password', () => {
    const uri =
      'trojan://tr0jan%40pass@tj.example.com:443?security=tls&sni=tj.example.com&type=ws&path=%2Fws&host=cdn.example.com&allowInsecure=1#Trojan%20WS';
    const node = ok(parseUri(uri));
    if (node.kind !== 'trojan') throw new Error('expected trojan');
    expect(node).toMatchObject({
      name: 'Trojan WS',
      password: 'tr0jan@pass',
      server: 'tj.example.com',
      port: 443,
      sni: 'tj.example.com',
      network: 'ws',
      ws: { path: '/ws', host: 'cdn.example.com' },
      skipCertVerify: true,
    });
  });

  it('parses alpn arrays', () => {
    const node = ok(parseUri('trojan://p@tj.example.com:443?alpn=h2,http/1.1#alpn'));
    if (node.kind !== 'trojan') throw new Error('expected trojan');
    expect(node.alpn).toEqual(['h2', 'http/1.1']);
  });

  it('rejects empty passwords and unsupported transports', () => {
    expect(failCode(parseUri('trojan://@tj.example.com:443'))).toBe('E_NODE_LINE');
    expect(failCode(parseUri('trojan://p@tj.example.com:443?type=kcp'))).toBe('E_NODE_TRANSPORT');
    expect(failCode(parseUri('trojan://p@tj.example.com:0'))).toBe('E_NODE_PORT');
  });
});

describe('vless://', () => {
  const realty =
    'vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@vl.example.com:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=PUBKEY&sid=abcd&type=tcp&flow=xtls-rprx-vision#VLESS%20Reality';

  it('parses reality and XTLS fields', () => {
    const node = ok(parseUri(realty));
    if (node.kind !== 'vless') throw new Error('expected vless');
    expect(node).toMatchObject({
      name: 'VLESS Reality',
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      tls: true,
      network: 'tcp',
      servername: 'www.microsoft.com',
      flow: 'xtls-rprx-vision',
      clientFingerprint: 'chrome',
      reality: { publicKey: 'PUBKEY', shortId: 'abcd' },
    });
  });

  it('parses ws transport', () => {
    const node = ok(
      parseUri(
        'vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@v.example.com:8443?encryption=none&security=tls&type=ws&path=%2Fws&host=cdn.example.com&sni=v.example.com#VLESS%20WS',
      ),
    );
    if (node.kind !== 'vless') throw new Error('expected vless');
    expect(node.ws).toEqual({ path: '/ws', host: 'cdn.example.com' });
  });

  it('rejects bad encryption, missing reality key, bad flow and transport', () => {
    const base = 'vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@v.example.com:443';
    expect(failCode(parseUri(`${base}?encryption=aes-128-gcm`))).toBe('E_NODE_ENCRYPTION');
    expect(failCode(parseUri(`${base}?security=reality`))).toBe('E_NODE_REALITY');
    expect(failCode(parseUri(`${base}?security=reality&pbk=`))).toBe('E_NODE_REALITY');
    expect(failCode(parseUri(`${base}?flow=xtls-rprx-direct`))).toBe('E_NODE_FLOW');
    expect(failCode(parseUri(`${base}?type=quic`))).toBe('E_NODE_TRANSPORT');
    expect(failCode(parseUri('vless://not-a-uuid@v.example.com:443'))).toBe('E_NODE_UUID');
  });
});
