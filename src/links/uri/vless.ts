/**
 * VLESS URI parser (SPEC §3.4.5).
 *
 * Preserves the mihomo-relevant reality/XTLS fields:
 * `security=reality`, `pbk`, `sid`, `fp`, `flow=xtls-rprx-vision`.
 */

import type { UriParseResult, VlessProxy } from '../contracts';
import {
  decodeComponentSafe,
  getParam,
  normalizeServer,
  normalizeUuid,
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

export function parseVless(uri: string): UriParseResult {
  const parts = splitUriScheme(uri);
  if (!parts || parts.scheme !== 'vless') {
    return fail('E_NODE_LINE', 'not a vless:// URI');
  }

  const fragmentSplit = splitFragment(parts.rest);
  const querySplit = splitQuery(fragmentSplit.main);
  const authority = parseAuthority(querySplit.main.replace(/\/+$/, ''));
  if (!authority) {
    return fail('E_NODE_LINE', 'vless URI authority could not be parsed');
  }

  const uuid = normalizeUuid(decodeComponentSafe(authority.userinfo));
  if (!uuid) {
    return fail('E_NODE_UUID', 'vless uuid is invalid');
  }
  const server = normalizeServer(authority.host);
  if (!server) {
    return fail('E_NODE_SERVER', 'vless server address is invalid');
  }
  const port = parsePortValue(authority.port);
  if (port === null) {
    return fail('E_NODE_PORT', 'vless port is not an integer in 1..65535');
  }

  const params = parseQueryParams(querySplit.query);
  const encryption = getParam(params, 'encryption');
  if (encryption !== undefined && encryption.trim() !== '' && encryption.trim().toLowerCase() !== 'none') {
    return fail('E_NODE_ENCRYPTION', 'vless encryption must be "none"');
  }

  const security = (getParam(params, 'security') ?? '').trim().toLowerCase();
  if (security !== '' && security !== 'none' && security !== 'tls' && security !== 'xtls' && security !== 'reality') {
    return fail('E_NODE_LINE', `unsupported vless security: ${security}`);
  }
  const tls = security === 'tls' || security === 'xtls' || security === 'reality';

  const flow = getParam(params, 'flow');
  if (flow !== undefined && flow !== '' && flow !== 'xtls-rprx-vision') {
    return fail('E_NODE_FLOW', `unsupported vless flow: ${flow}`);
  }

  const netRaw = getParam(params, 'type', 'network', 'net');
  const transport = parseTransportValue(netRaw);
  if (transport === null) {
    return fail('E_NODE_TRANSPORT', `unsupported vless transport: ${netRaw ?? ''}`);
  }

  let reality: VlessProxy['reality'];
  if (security === 'reality') {
    const publicKey = getParam(params, 'pbk');
    if (publicKey === undefined || publicKey.trim() === '') {
      return fail('E_NODE_REALITY', 'vless reality requires a pbk public key');
    }
    reality = { publicKey: publicKey.trim() };
    const shortId = getParam(params, 'sid');
    if (shortId !== undefined && shortId !== '') reality.shortId = shortId;
  }

  const sni = getParam(params, 'sni', 'peer', 'servername');
  const hostHeader = getParam(params, 'host');
  const path = getParam(params, 'path');
  const serviceNameRaw = getParam(params, 'serviceName', 'service-name');
  const fingerprint = getParam(params, 'fp', 'fingerprint');

  const node: VlessProxy = {
    kind: 'vless',
    name: decodeComponentSafe(fragmentSplit.fragment),
    server,
    port,
    uuid,
    tls,
    network: transport,
  };
  if (sni !== undefined && sni !== '') node.servername = sni;
  if (flow === 'xtls-rprx-vision') node.flow = flow;
  if (fingerprint !== undefined && fingerprint !== '') node.clientFingerprint = fingerprint;
  if (reality !== undefined) node.reality = reality;
  if (transport === 'ws' && ((path !== undefined && path !== '') || (hostHeader !== undefined && hostHeader !== ''))) {
    node.ws = {};
    if (path !== undefined && path !== '') node.ws.path = path;
    if (hostHeader !== undefined && hostHeader !== '') node.ws.host = hostHeader;
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
