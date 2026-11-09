import { describe, expect, it } from 'vitest';
import type {
  Proxy,
  SsProxy,
  SsrProxy,
  TrojanProxy,
  VlessProxy,
  VmessProxy,
} from '../../../src/types';
import {
  EmitterError,
  isEmitterError,
  parseForReadback,
  stringifyConfig,
} from '../../../src/emitter/serialize';
import { toMihomoProxies, toMihomoProxy } from '../../../src/emitter/nodes';

function ss(overrides: Partial<SsProxy> = {}): SsProxy {
  return {
    kind: 'ss',
    name: 'node-ss',
    server: '1.2.3.4',
    port: 8388,
    cipher: 'aes-256-gcm',
    password: 'secret',
    ...overrides,
  };
}

function ssr(overrides: Partial<SsrProxy> = {}): SsrProxy {
  return {
    kind: 'ssr',
    name: 'node-ssr',
    server: '5.6.7.8',
    port: 8389,
    cipher: 'aes-256-cfb',
    password: 'secret',
    protocol: 'origin',
    obfs: 'plain',
    ...overrides,
  };
}

function vmess(overrides: Partial<VmessProxy> = {}): VmessProxy {
  return {
    kind: 'vmess',
    name: 'node-vmess',
    server: 'vmess.example.com',
    port: 443,
    uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    alterId: 0,
    cipher: 'auto',
    tls: true,
    network: 'tcp',
    ...overrides,
  };
}

function trojan(overrides: Partial<TrojanProxy> = {}): TrojanProxy {
  return {
    kind: 'trojan',
    name: 'node-trojan',
    server: 'trojan.example.com',
    port: 443,
    password: 'secret',
    network: 'tcp',
    ...overrides,
  };
}

function vless(overrides: Partial<VlessProxy> = {}): VlessProxy {
  return {
    kind: 'vless',
    name: 'node-vless',
    server: 'vless.example.com',
    port: 443,
    uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
    tls: true,
    network: 'tcp',
    ...overrides,
  };
}

function assertNoUndefined(value: unknown, path = 'root'): void {
  expect(value, path).not.toBeUndefined();
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoUndefined(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      expect(entry, `${path}.${key}`).not.toBeUndefined();
      assertNoUndefined(entry, `${path}.${key}`);
    }
  }
}

describe('toMihomoProxy: ss', () => {
  it('maps the required fields in stable order', () => {
    const out = toMihomoProxy(ss());
    expect(out).toEqual({
      name: 'node-ss',
      type: 'ss',
      server: '1.2.3.4',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'secret',
    });
    expect(Object.keys(out)).toEqual(['name', 'type', 'server', 'port', 'cipher', 'password']);
    assertNoUndefined(out);
  });

  it('emits plugin and whitelisted plugin-opts only', () => {
    const out = toMihomoProxy(ss({
      plugin: 'v2ray-plugin',
      pluginOpts: {
        mode: 'websocket',
        host: 'cdn.example.com',
        path: '/ws',
        tls: true,
        mux: false,
        unknown: 'dropped',
        empty: '',
      },
    }));
    expect(out.plugin).toBe('v2ray-plugin');
    expect(out['plugin-opts']).toEqual({
      mode: 'websocket',
      host: 'cdn.example.com',
      path: '/ws',
      tls: true,
      mux: false,
    });
  });

  it('drops plugin-opts when the plugin is absent', () => {
    const out = toMihomoProxy(ss({ pluginOpts: { mode: 'websocket' } }));
    expect(out).not.toHaveProperty('plugin');
    expect(out).not.toHaveProperty('plugin-opts');
  });

  it('does not emit skip-cert-verify for ss', () => {
    const out = toMihomoProxy(ss({ skipCertVerify: true }), { scv: true });
    expect(out).not.toHaveProperty('skip-cert-verify');
    expect(out.udp).toBeUndefined();
  });
});

describe('toMihomoProxy: ssr', () => {
  it('maps the SSR fields and converts the none cipher to dummy', () => {
    const out = toMihomoProxy(ssr({
      cipher: 'none',
      protocolParam: 'auth-param',
      obfsParam: 'obfs-param',
    }));
    expect(out).toEqual({
      name: 'node-ssr',
      type: 'ssr',
      server: '5.6.7.8',
      port: 8389,
      cipher: 'dummy',
      password: 'secret',
      protocol: 'origin',
      'protocol-param': 'auth-param',
      obfs: 'plain',
      'obfs-param': 'obfs-param',
    });
  });

  it('omits empty optional params', () => {
    const out = toMihomoProxy(ssr({ protocolParam: '', obfsParam: undefined }));
    expect(out).not.toHaveProperty('protocol-param');
    expect(out).not.toHaveProperty('obfs-param');
  });
});

describe('toMihomoProxy: vmess', () => {
  it('emits tls, servername, network and ws-opts with a Host header', () => {
    const out = toMihomoProxy(vmess({
      servername: 'sni.example.com',
      network: 'ws',
      ws: { path: '/ws', host: 'cdn.example.com' },
    }));
    expect(out).toEqual({
      name: 'node-vmess',
      type: 'vmess',
      server: 'vmess.example.com',
      port: 443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      alterId: 0,
      cipher: 'auto',
      tls: true,
      servername: 'sni.example.com',
      network: 'ws',
      'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
    });
  });

  it('emits grpc-opts for grpc transport', () => {
    const out = toMihomoProxy(vmess({ network: 'grpc', grpc: { serviceName: 'grpc-svc' } }));
    expect(out['grpc-opts']).toEqual({ 'grpc-service-name': 'grpc-svc' });
    expect(out).not.toHaveProperty('ws-opts');
  });

  it('keeps tls:false and emits no transport opts for tcp', () => {
    const out = toMihomoProxy(vmess({ tls: false, network: 'tcp' }));
    expect(out.tls).toBe(false);
    expect(out.network).toBe('tcp');
    expect(out).not.toHaveProperty('ws-opts');
    expect(out).not.toHaveProperty('grpc-opts');
  });

  it('omits empty ws-opts and grpc-opts', () => {
    expect(toMihomoProxy(vmess({ network: 'ws', ws: {} }))).not.toHaveProperty('ws-opts');
    expect(toMihomoProxy(vmess({ network: 'grpc', grpc: {} }))).not.toHaveProperty('grpc-opts');
  });
});

describe('toMihomoProxy: trojan', () => {
  it('maps sni, filtered alpn and ws-opts', () => {
    const out = toMihomoProxy(trojan({
      sni: 'trojan.example.com',
      alpn: ['h2', '', 'http/1.1'],
      network: 'ws',
      ws: { path: '/t', host: 'front.example.com' },
    }));
    expect(out).toEqual({
      name: 'node-trojan',
      type: 'trojan',
      server: 'trojan.example.com',
      port: 443,
      password: 'secret',
      sni: 'trojan.example.com',
      alpn: ['h2', 'http/1.1'],
      network: 'ws',
      'ws-opts': { path: '/t', headers: { Host: 'front.example.com' } },
    });
  });

  it('omits empty alpn', () => {
    expect(toMihomoProxy(trojan({ alpn: [] }))).not.toHaveProperty('alpn');
  });
});

describe('toMihomoProxy: vless', () => {
  it('maps reality, flow, fingerprint and grpc opts', () => {
    const out = toMihomoProxy(vless({
      servername: 'sni.example.com',
      network: 'grpc',
      grpc: { serviceName: 'svc' },
      flow: 'xtls-rprx-vision',
      clientFingerprint: 'chrome',
      reality: { publicKey: 'PUBLIC_KEY', shortId: 'abcd' },
    }));
    expect(out).toEqual({
      name: 'node-vless',
      type: 'vless',
      server: 'vless.example.com',
      port: 443,
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      tls: true,
      servername: 'sni.example.com',
      network: 'grpc',
      flow: 'xtls-rprx-vision',
      'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': 'PUBLIC_KEY', 'short-id': 'abcd' },
      'grpc-opts': { 'grpc-service-name': 'svc' },
    });
  });

  it('omits reality-opts when no reality config is present', () => {
    const out = toMihomoProxy(vless({ tls: false }));
    expect(out.tls).toBe(false);
    expect(out).not.toHaveProperty('reality-opts');
  });

  it('rejects reality without a public key', () => {
    expect(() => toMihomoProxy(vless({
      reality: { publicKey: '' },
    }))).toThrowError(/reality without public key/);
  });
});

describe('node emit options', () => {
  it('applies udp/tfo/scv request flags to TLS protocols', () => {
    const out = toMihomoProxy(vmess(), { udp: true, tfo: true, scv: true });
    expect(out.udp).toBe(true);
    expect(out.tfo).toBe(true);
    expect(out['skip-cert-verify']).toBe(true);
  });

  it('keeps node-level flags when request flags are absent', () => {
    const out = toMihomoProxy(vmess({ udp: true, tfo: true, skipCertVerify: true }));
    expect(out.udp).toBe(true);
    expect(out.tfo).toBe(true);
    expect(out['skip-cert-verify']).toBe(true);
  });

  it('does not emit false flags', () => {
    const out = toMihomoProxy(vmess({ udp: false, tfo: false, skipCertVerify: false }), {
      udp: false,
      tfo: false,
      scv: false,
    });
    expect(out).not.toHaveProperty('udp');
    expect(out).not.toHaveProperty('tfo');
    expect(out).not.toHaveProperty('skip-cert-verify');
  });
});

describe('special characters and YAML round-trip', () => {
  it('preserves quotes, colons, hashes and spaces through YAML', () => {
    const node = ss({
      name: '节点 "#1": true',
      password: "p@ss: w#o'rd",
      server: 'node.example.com',
    });
    const out = toMihomoProxy(node);
    const yaml = stringifyConfig({ proxies: [out] });
    const readback = parseForReadback(yaml);
    expect(readback.ok).toBe(true);
    if (!readback.ok) return;
    const value = readback.value as { proxies: Array<Record<string, unknown>> };
    expect(value.proxies).toEqual([out]);
    expect(value.proxies[0]?.name).toBe('节点 "#1": true');
    expect(value.proxies[0]?.password).toBe("p@ss: w#o'rd");
  });

  it('quotes names that look like YAML scalars', () => {
    const names = ['true', '123', 'null', '~'];
    const yaml = stringifyConfig({ proxies: names.map((name) => toMihomoProxy(ss({ name }))) });
    const readback = parseForReadback(yaml);
    expect(readback.ok).toBe(true);
    if (!readback.ok) return;
    const value = readback.value as { proxies: Array<Record<string, unknown>> };
    expect(value.proxies.map((proxy) => proxy.name)).toEqual(names);
  });
});

describe('invalid IR is rejected', () => {
  it.each([
    ['port 0', () => ss({ port: 0 })],
    ['port 65536', () => ss({ port: 65536 })],
    ['fractional port', () => ss({ port: 8388.5 })],
    ['NaN port', () => ss({ port: Number.NaN })],
    ['empty name', () => ss({ name: '' })],
    ['control characters in name', () => ss({ name: 'bad\nname' })],
    ['empty server', () => ss({ server: '' })],
  ])('rejects %s', (_label, make) => {
    try {
      toMihomoProxy(make());
      expect.unreachable('expected an EmitterError');
    } catch (error) {
      expect(isEmitterError(error)).toBe(true);
      expect((error as EmitterError).code).toBe('E_EMIT_INVALID');
    }
  });

  it('rejects unsupported proxy kinds', () => {
    const bad = {
      kind: 'hysteria2',
      name: 'x',
      server: '1.1.1.1',
      port: 443,
    } as unknown as Proxy;
    expect(() => toMihomoProxy(bad)).toThrowError(/unsupported proxy kind/);
  });

  it('rejects unsupported plugins and transports', () => {
    const plugin = ss({ plugin: 'shadow-tls' as SsProxy['plugin'] });
    expect(() => toMihomoProxy(plugin)).toThrowError(/unsupported plugin/);

    const transport = vmess({ network: 'kcp' as VmessProxy['network'] });
    expect(() => toMihomoProxy(transport)).toThrowError(/unsupported transport/);

    const alterId = vmess({ alterId: -1 });
    expect(() => toMihomoProxy(alterId)).toThrowError(/invalid alterId/);
  });

  it('maps arrays in order', () => {
    const out = toMihomoProxies([ss({ name: 'a' }), ss({ name: 'b' })]);
    expect(out.map((proxy) => proxy.name)).toEqual(['a', 'b']);
  });
});
