/**
 * VMess URI parser (SPEC §3.4.3).
 *
 * Supported shapes:
 * - base64 JSON v2 (`{v,ps,add,port,id,aid,net,type,host,path,tls,sni,...}`)
 * - Shadowrocket-style base64 JSON plus query overrides (`?remarks=&obfs=&path=`)
 * - standard URI form (`vmess://uuid@host:port?type=ws&security=tls&...#name`)
 *
 * Transports are limited to tcp/ws/grpc; h2/http/kcp/quic are rejected instead
 * of emitting half-supported options.
 */

import type { Transport, UriParseResult, VmessProxy } from '../contracts';
import { decodeBase64Text } from '../base64';
import {
  decodeComponentSafe,
  getParam,
  normalizeServer,
  normalizeUuid,
  parseAlterIdValue,
  parseAuthority,
  parsePortValue,
  parseQueryParams,
  parseTransportValue,
  parseBooleanParam,
  splitFragment,
  splitQuery,
  splitUriScheme,
} from '../protocols';

type Obj = Record<string, unknown>;

function fail(code: string, message: string): UriParseResult {
  return { ok: false, code, message };
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return ['1', 'true', 'tls', 'yes', 'on'].includes(normalized);
  }
  return false;
}

function firstComma(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const index = value.indexOf(',');
  return (index >= 0 ? value.slice(0, index) : value).trim() || undefined;
}

function buildTransport(
  net: string | undefined,
): { transport: Transport; ws?: { path?: string; host?: string }; grpc?: { serviceName?: string } } | null {
  const transport = parseTransportValue(net);
  if (transport === null) return null;
  return { transport };
}

function parseVmessUri(
  fragment: string,
  queryRaw: string,
  authorityText: string,
): UriParseResult {
  const authority = parseAuthority(authorityText);
  if (!authority) {
    return fail('E_NODE_LINE', 'vmess URI authority could not be parsed');
  }
  const uuid = normalizeUuid(decodeComponentSafe(authority.userinfo));
  if (!uuid) {
    return fail('E_NODE_UUID', 'vmess uuid is invalid');
  }
  const server = normalizeServer(authority.host);
  if (!server) {
    return fail('E_NODE_SERVER', 'vmess server address is invalid');
  }
  const port = parsePortValue(authority.port);
  if (port === null) {
    return fail('E_NODE_PORT', 'vmess port is not an integer in 1..65535');
  }

  const params = parseQueryParams(queryRaw);
  const aidRaw = getParam(params, 'aid', 'alterId', 'alterid');
  const alterId = parseAlterIdValue(aidRaw);
  if (alterId === null) {
    return fail('E_NODE_LINE', 'vmess alterId is invalid');
  }

  const netRaw = getParam(params, 'type', 'network', 'net');
  const built = buildTransport(netRaw);
  if (!built) {
    return fail('E_NODE_TRANSPORT', `unsupported vmess transport: ${netRaw ?? ''}`);
  }
  const transport = built.transport;

  const security = (getParam(params, 'security') ?? '').trim().toLowerCase();
  const tls =
    security === 'tls' ||
    security === 'xtls' ||
    security === 'reality' ||
    parseBooleanParam(getParam(params, 'tls')) === true;

  const sni = getParam(params, 'sni', 'peer', 'servername');
  const hostHeader = firstComma(getParam(params, 'host'));
  const path = getParam(params, 'path');
  const serviceNameRaw = getParam(params, 'serviceName', 'service-name');

  const node: VmessProxy = {
    kind: 'vmess',
    name: decodeComponentSafe(fragment),
    server,
    port,
    uuid,
    alterId,
    cipher: 'auto',
    tls,
    network: transport,
  };
  if (sni !== undefined && sni !== '') node.servername = sni;
  if (transport === 'ws' && ((path !== undefined && path !== '') || hostHeader !== undefined)) {
    node.ws = {};
    if (path !== undefined && path !== '') node.ws.path = path;
    if (hostHeader !== undefined) node.ws.host = hostHeader;
  }
  if (transport === 'grpc') {
    const serviceName =
      serviceNameRaw ??
      (path !== undefined && path !== ''
        ? path.replace(/^\/+/, '')
        : undefined);
    if (serviceName !== undefined && serviceName !== '') node.grpc = { serviceName };
  }
  const insecure =
    parseBooleanParam(getParam(params, 'allowInsecure', 'allowinsecure', 'insecure', 'skip-cert-verify')) === true;
  if (insecure) node.skipCertVerify = true;

  return { ok: true, node };
}

function parseVmessJson(
  jsonText: string,
  fragment: string,
  extra: URLSearchParams,
): UriParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return fail('E_NODE_LINE', 'vmess JSON could not be parsed');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('E_NODE_LINE', 'vmess JSON is not an object');
  }
  const obj = parsed as Obj;

  const server = normalizeServer(asString(obj.add) ?? asString(obj.server) ?? asString(obj.address));
  if (!server) {
    return fail('E_NODE_SERVER', 'vmess server address is invalid');
  }
  const port = parsePortValue(obj.port);
  if (port === null) {
    return fail('E_NODE_PORT', 'vmess port is not an integer in 1..65535');
  }
  const uuid = normalizeUuid(obj.id ?? obj.uuid);
  if (!uuid) {
    return fail('E_NODE_UUID', 'vmess uuid is invalid');
  }
  const alterId = parseAlterIdValue(obj.aid ?? obj.alterId);
  if (alterId === null) {
    return fail('E_NODE_LINE', 'vmess alterId is invalid');
  }

  let netRaw = asString(obj.net) ?? asString(obj.network) ?? 'tcp';
  let hostHeader = firstComma(asString(obj.host));
  let path = asString(obj.path);
  let sni = asString(obj.sni) ?? asString(obj.servername);
  let tls = toBoolean(obj.tls);
  let name = asString(obj.ps) ?? '';

  // Query overrides used by Shadowrocket-style `vmess://<b64>?remarks=...`.
  const remarks = getParam(extra, 'remarks', 'ps');
  if (remarks !== undefined && remarks !== '') name = remarks;
  const obfs = getParam(extra, 'obfs');
  if (obfs !== undefined && obfs !== '' && obfs.toLowerCase() !== 'none') netRaw = obfs;
  const queryPath = getParam(extra, 'path');
  if (queryPath !== undefined && queryPath !== '') path = queryPath;
  const queryHost = firstComma(getParam(extra, 'host'));
  if (queryHost !== undefined) hostHeader = queryHost;
  const querySni = getParam(extra, 'sni', 'peer', 'servername');
  if (querySni !== undefined && querySni !== '') sni = querySni;
  const queryTls = parseBooleanParam(getParam(extra, 'tls'));
  if (queryTls === true) tls = true;
  const queryAid = getParam(extra, 'aid', 'alterId', 'alterid');
  const finalAlterId = queryAid !== undefined ? parseAlterIdValue(queryAid) : alterId;
  if (finalAlterId === null) {
    return fail('E_NODE_LINE', 'vmess alterId is invalid');
  }

  // JSON v1 encoded `host` as `host;path`, JSON v2 uses separate fields.
  if ((netRaw ?? '').toLowerCase() === 'ws' && (path === undefined || path === '') && hostHeader?.includes(';')) {
    const index = hostHeader.indexOf(';');
    path = hostHeader.slice(index + 1);
    hostHeader = hostHeader.slice(0, index) || undefined;
  }

  const built = buildTransport(netRaw);
  if (!built) {
    return fail('E_NODE_TRANSPORT', `unsupported vmess transport: ${netRaw ?? ''}`);
  }
  const transport = built.transport;

  const node: VmessProxy = {
    kind: 'vmess',
    name: name !== '' ? name : decodeComponentSafe(fragment),
    server,
    port,
    uuid,
    alterId: finalAlterId,
    cipher: 'auto',
    tls,
    network: transport,
  };
  if (sni !== undefined && sni !== '') node.servername = sni;
  if (transport === 'ws' && ((path !== undefined && path !== '') || hostHeader !== undefined)) {
    node.ws = {};
    if (path !== undefined && path !== '') node.ws.path = path;
    if (hostHeader !== undefined) node.ws.host = hostHeader;
  }
  if (transport === 'grpc') {
    const serviceNameRaw = asString(obj.serviceName);
    const serviceName =
      serviceNameRaw ??
      (path !== undefined && path !== '' ? path.replace(/^\/+/, '') : undefined);
    if (serviceName !== undefined && serviceName !== '') node.grpc = { serviceName };
  }
  const insecure = toBoolean(obj['skip-cert-verify'] ?? obj.allowInsecure ?? obj.insecure);
  if (insecure) node.skipCertVerify = true;

  return { ok: true, node };
}

export function parseVmess(uri: string): UriParseResult {
  const parts = splitUriScheme(uri);
  if (!parts || parts.scheme !== 'vmess') {
    return fail('E_NODE_LINE', 'not a vmess:// URI');
  }

  const fragmentSplit = splitFragment(parts.rest);
  const querySplit = splitQuery(fragmentSplit.main);
  const body = querySplit.main.trim();

  if (body.includes('@')) {
    // Some clients append an empty path before the query (`...:443/?...`).
    return parseVmessUri(
      fragmentSplit.fragment,
      querySplit.query,
      querySplit.main.replace(/\/+$/, ''),
    );
  }

  let decoded = decodeBase64Text(body);
  if (!decoded.ok) {
    const percentDecoded = decodeComponentSafe(body);
    if (percentDecoded !== body) decoded = decodeBase64Text(percentDecoded);
  }
  if (!decoded.ok) {
    return fail('E_BASE64_INVALID', 'vmess payload is not valid base64');
  }
  return parseVmessJson(decoded.text, fragmentSplit.fragment, parseQueryParams(querySplit.query));
}
