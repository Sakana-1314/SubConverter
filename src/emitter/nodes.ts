/**
 * ProxyNode -> mihomo `proxies[]` entry (SPEC §3.4, §7.2).
 *
 * Only whitelisted fields are emitted, `port` is always an integer and
 * `undefined`/`null`/empty-string values never reach the YAML emitter.
 * String escaping is deliberately left to the YAML serializer (SPEC §7.2).
 */

import type {
  Proxy,
  SsProxy,
  SsrProxy,
  TrojanProxy,
  VlessProxy,
  VmessProxy,
  WsOptions,
} from '../types';
import { EmitterError } from './serialize';

export interface NodeEmitOptions {
  /** Query parameter `udp`: emit `udp: true` for every supported node. */
  udp?: boolean;
  /** Query parameter `tfo`: emit `tfo: true` for every supported node. */
  tfo?: boolean;
  /** Query parameter `scv`: emit `skip-cert-verify: true` for TLS protocols. */
  scv?: boolean;
}

/** mihomo keys accepted inside `plugin-opts` for the two supported plugins. */
const PLUGIN_OPT_KEYS = new Set(['mode', 'host', 'path', 'tls', 'mux', 'skip-cert-verify']);

/** Protocols where `skip-cert-verify` is meaningful. */
function supportsSkipCertVerify(kind: Proxy['kind']): boolean {
  return kind === 'vmess' || kind === 'trojan' || kind === 'vless';
}

function putString(out: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value !== 'string' || value === '') return;
  out[key] = value;
}

function putNumber(out: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  out[key] = value;
}

function putBoolean(out: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value !== 'boolean') return;
  out[key] = value;
}

function assertNode(node: Proxy): void {
  if (typeof node.name !== 'string' || node.name === '') {
    throw new EmitterError('E_EMIT_INVALID', 'proxy node has an empty name');
  }
  if (/[\u0000-\u001f\u007f]/.test(node.name)) {
    throw new EmitterError('E_EMIT_INVALID', `proxy node "${node.name}" contains control characters`);
  }
  if (typeof node.server !== 'string' || node.server === '') {
    throw new EmitterError('E_EMIT_INVALID', `proxy node "${node.name}" has an empty server`);
  }
  if (typeof node.port !== 'number' || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) {
    throw new EmitterError('E_EMIT_INVALID', `proxy node "${node.name}" has an invalid port`);
  }
}

function baseProxy(node: Proxy): Record<string, unknown> {
  assertNode(node);
  return {
    name: node.name,
    type: node.kind,
    server: node.server,
    port: node.port,
  };
}

function applyCommonOptions(out: Record<string, unknown>, node: Proxy, options: NodeEmitOptions): void {
  if (node.udp === true || options.udp === true) out.udp = true;
  if (node.tfo === true || options.tfo === true) out.tfo = true;
  if (supportsSkipCertVerify(node.kind) && (node.skipCertVerify === true || options.scv === true)) {
    out['skip-cert-verify'] = true;
  }
}

function pluginOptions(value: Record<string, string | boolean>): Record<string, unknown> | undefined {
  const opts: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (!PLUGIN_OPT_KEYS.has(key)) continue;
    const option = value[key];
    if (typeof option === 'string') {
      if (option !== '') opts[key] = option;
    } else if (typeof option === 'boolean') {
      opts[key] = option;
    }
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}

function wsOptions(ws: WsOptions | undefined): Record<string, unknown> | undefined {
  if (ws === undefined) return undefined;
  const opts: Record<string, unknown> = {};
  if (typeof ws.path === 'string' && ws.path !== '') opts.path = ws.path;
  if (typeof ws.host === 'string' && ws.host !== '') {
    opts.headers = { Host: ws.host };
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}

function grpcOptions(grpc: { serviceName?: string } | undefined): Record<string, unknown> | undefined {
  if (grpc === undefined) return undefined;
  if (typeof grpc.serviceName !== 'string' || grpc.serviceName === '') return undefined;
  return { 'grpc-service-name': grpc.serviceName };
}

/** Protocol transports accepted by mihomo (SPEC §3.4.3-3.4.5). */
const NETWORKS = new Set(['tcp', 'ws', 'grpc']);

function assertNetwork(node: VmessProxy | TrojanProxy | VlessProxy): void {
  if (!NETWORKS.has(node.network)) {
    throw new EmitterError(
      'E_EMIT_INVALID',
      `proxy node "${node.name}" has unsupported transport "${String(node.network)}"`,
    );
  }
}

function ssProxy(node: SsProxy): Record<string, unknown> {
  const out = baseProxy(node);
  putString(out, 'cipher', node.cipher);
  putString(out, 'password', node.password);
  if (node.plugin !== undefined) {
    if (node.plugin !== 'obfs' && node.plugin !== 'v2ray-plugin') {
      throw new EmitterError(
        'E_EMIT_INVALID',
        `ss node "${node.name}" has unsupported plugin "${String(node.plugin)}"`,
      );
    }
    out.plugin = node.plugin;
    if (node.pluginOpts !== undefined) {
      const opts = pluginOptions(node.pluginOpts);
      if (opts !== undefined) out['plugin-opts'] = opts;
    }
  }
  return out;
}

function ssrProxy(node: SsrProxy): Record<string, unknown> {
  const out = baseProxy(node);
  // mihomo represents the SSR "none" cipher as `dummy` (SPEC §3.4.2).
  putString(out, 'cipher', node.cipher === 'none' ? 'dummy' : node.cipher);
  putString(out, 'password', node.password);
  putString(out, 'protocol', node.protocol);
  putString(out, 'protocol-param', node.protocolParam);
  putString(out, 'obfs', node.obfs);
  putString(out, 'obfs-param', node.obfsParam);
  return out;
}

function vmessProxy(node: VmessProxy): Record<string, unknown> {
  assertNetwork(node);
  if (typeof node.alterId !== 'number' || !Number.isInteger(node.alterId) || node.alterId < 0 || node.alterId > 65535) {
    throw new EmitterError('E_EMIT_INVALID', `vmess node "${node.name}" has an invalid alterId`);
  }
  const out = baseProxy(node);
  putString(out, 'uuid', node.uuid);
  putNumber(out, 'alterId', node.alterId);
  out.cipher = 'auto';
  putBoolean(out, 'tls', node.tls);
  putString(out, 'servername', node.servername);
  putString(out, 'network', node.network);
  if (node.network === 'ws') {
    const opts = wsOptions(node.ws);
    if (opts !== undefined) out['ws-opts'] = opts;
  } else if (node.network === 'grpc') {
    const opts = grpcOptions(node.grpc);
    if (opts !== undefined) out['grpc-opts'] = opts;
  }
  return out;
}

function trojanProxy(node: TrojanProxy): Record<string, unknown> {
  assertNetwork(node);
  const out = baseProxy(node);
  putString(out, 'password', node.password);
  putString(out, 'sni', node.sni);
  if (Array.isArray(node.alpn) && node.alpn.length > 0) {
    const alpn = node.alpn.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
    if (alpn.length > 0) out.alpn = alpn;
  }
  putString(out, 'network', node.network);
  if (node.network === 'ws') {
    const opts = wsOptions(node.ws);
    if (opts !== undefined) out['ws-opts'] = opts;
  } else if (node.network === 'grpc') {
    const opts = grpcOptions(node.grpc);
    if (opts !== undefined) out['grpc-opts'] = opts;
  }
  return out;
}

function vlessProxy(node: VlessProxy): Record<string, unknown> {
  assertNetwork(node);
  const out = baseProxy(node);
  putString(out, 'uuid', node.uuid);
  putBoolean(out, 'tls', node.tls);
  putString(out, 'servername', node.servername);
  putString(out, 'network', node.network);
  putString(out, 'flow', node.flow);
  putString(out, 'client-fingerprint', node.clientFingerprint);
  if (node.reality !== undefined) {
    if (typeof node.reality.publicKey !== 'string' || node.reality.publicKey === '') {
      throw new EmitterError('E_EMIT_INVALID', `vless node "${node.name}" has reality without public key`);
    }
    const reality: Record<string, unknown> = { 'public-key': node.reality.publicKey };
    putString(reality, 'short-id', node.reality.shortId);
    out['reality-opts'] = reality;
  }
  if (node.network === 'ws') {
    const opts = wsOptions(node.ws);
    if (opts !== undefined) out['ws-opts'] = opts;
  } else if (node.network === 'grpc') {
    const opts = grpcOptions(node.grpc);
    if (opts !== undefined) out['grpc-opts'] = opts;
  }
  return out;
}

/**
 * Map one validated proxy to its mihomo representation. The result is a fresh
 * plain object with a stable key order; undefined values are never inserted.
 */
export function toMihomoProxy(node: Proxy, options: NodeEmitOptions = {}): Record<string, unknown> {
  let out: Record<string, unknown>;
  switch (node.kind) {
    case 'ss':
      out = ssProxy(node);
      break;
    case 'ssr':
      out = ssrProxy(node);
      break;
    case 'vmess':
      out = vmessProxy(node);
      break;
    case 'trojan':
      out = trojanProxy(node);
      break;
    case 'vless':
      out = vlessProxy(node);
      break;
    default: {
      const exhaustive: never = node;
      throw new EmitterError('E_EMIT_INVALID', `unsupported proxy kind: ${String(exhaustive)}`);
    }
  }
  applyCommonOptions(out, node, options);
  return out;
}

/** Map every node in order (stable, no sorting). */
export function toMihomoProxies(
  nodes: readonly Proxy[],
  options: NodeEmitOptions = {},
): Array<Record<string, unknown>> {
  return nodes.map((node) => toMihomoProxy(node, options));
}
