/**
 * Trojan URI parser (SPEC §3.4.4).
 *
 * `trojan://password@host:port?security=tls&sni=&alpn=&allowInsecure=1&type=ws&path=&host=#name`
 *
 * TLS is always on for mihomo trojan nodes; only tcp/ws/grpc transports are
 * emitted.
 */

import type { TrojanProxy, UriParseResult } from '../contracts';
import {
  decodeComponentSafe,
  getParam,
  normalizeServer,
  parseAlpnParam,
  parseAuthority,
  parseBooleanParam,
  parsePortValue,
  parseQueryParams,
  parseTransportValue,
  splitFragment,
  splitQuery,
  splitUriScheme,
} from '../protocols';

function fail(code: string, message: string): UriParseResult {
  return { ok: false, code, message };
}

function firstComma(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const index = value.indexOf(',');
  return (index >= 0 ? value.slice(0, index) : value).trim() || undefined;
}

export function parseTrojan(uri: string): UriParseResult {
  const parts = splitUriScheme(uri);
  if (!parts || parts.scheme !== 'trojan') {
    return fail('E_NODE_LINE', 'not a trojan:// URI');
  }

  const fragmentSplit = splitFragment(parts.rest);
  const querySplit = splitQuery(fragmentSplit.main);
  const authorityText = querySplit.main.replace(/\/+$/, '');
  const authority = parseAuthority(authorityText);
  if (!authority) {
    return fail('E_NODE_LINE', 'trojan URI authority could not be parsed');
  }

  const password = decodeComponentSafe(authority.userinfo);
  if (password === '') {
    return fail('E_NODE_LINE', 'trojan password is empty');
  }
  const server = normalizeServer(authority.host);
  if (!server) {
    return fail('E_NODE_SERVER', 'trojan server address is invalid');
  }
  const port = parsePortValue(authority.port);
  if (port === null) {
    return fail('E_NODE_PORT', 'trojan port is not an integer in 1..65535');
  }

  const params = parseQueryParams(querySplit.query);
  const netRaw = getParam(params, 'type', 'network', 'net');
  const transport = parseTransportValue(netRaw);
  if (transport === null) {
    return fail('E_NODE_TRANSPORT', `unsupported trojan transport: ${netRaw ?? ''}`);
  }

  const sni = getParam(params, 'sni', 'peer', 'servername');
  const hostHeader = firstComma(getParam(params, 'host'));
  const path = getParam(params, 'path');
  const serviceNameRaw = getParam(params, 'serviceName', 'service-name');
  const alpn = parseAlpnParam(params);

  const node: TrojanProxy = {
    kind: 'trojan',
    name: decodeComponentSafe(fragmentSplit.fragment),
    server,
    port,
    password,
    network: transport,
  };
  if (sni !== undefined && sni !== '') node.sni = sni;
  if (alpn !== undefined) node.alpn = alpn;
  if (transport === 'ws' && ((path !== undefined && path !== '') || hostHeader !== undefined)) {
    node.ws = {};
    if (path !== undefined && path !== '') node.ws.path = path;
    if (hostHeader !== undefined) node.ws.host = hostHeader;
  }
  if (transport === 'grpc') {
    const serviceName =
      serviceNameRaw ??
      (path !== undefined && path !== '' ? path.replace(/^\/+/, '') : undefined);
    if (serviceName !== undefined && serviceName !== '') node.grpc = { serviceName };
  }
  const insecure =
    parseBooleanParam(getParam(params, 'allowInsecure', 'allowinsecure', 'insecure', 'skip-cert-verify')) === true;
  if (insecure) node.skipCertVerify = true;

  return { ok: true, node };
}
