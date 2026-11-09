/**
 * Shadowsocks URI parser (SPEC §3.4.1).
 *
 * Supported forms:
 * - SIP002: `ss://base64(method:password)@host:port[/?plugin=...]#name`
 * - plaintext userinfo: `ss://method:password@host:port#name`
 * - legacy: `ss://base64(method:password@host:port)#name`
 *
 * Only `obfs`/`obfs-local` and `v2ray-plugin` plugins are accepted; dropping an
 * unknown plugin silently would change the connection, so it is an error.
 */

import type { SsProxy } from '../contracts';
import { decodeBase64Text } from '../base64';
import {
  decodeComponentSafe,
  isSupportedSsCipher,
  normalizeServer,
  parseAuthority,
  parsePluginSpec,
  parsePortValue,
  parseQueryParams,
  splitFragment,
  splitQuery,
  splitUriScheme,
} from '../protocols';
import type { UriParseResult } from '../contracts';

function fail(code: string, message: string): UriParseResult {
  return { ok: false, code, message };
}

export function parseSs(uri: string): UriParseResult {
  const parts = splitUriScheme(uri);
  if (!parts || parts.scheme !== 'ss') {
    return fail('E_NODE_LINE', 'not an ss:// URI');
  }

  const fragmentSplit = splitFragment(parts.rest);
  const querySplit = splitQuery(fragmentSplit.main);
  const params = parseQueryParams(querySplit.query);
  const body = querySplit.main;

  let credentials: string;
  let authorityText: string;

  const at = body.lastIndexOf('@');
  if (at >= 0) {
    const userinfo = decodeComponentSafe(body.slice(0, at));
    // SIP002 permits an empty path before the query (`...:443/?plugin=...`).
    authorityText = body.slice(at + 1).replace(/\/+$/, '');
    if (userinfo.includes(':')) {
      credentials = userinfo;
    } else {
      const decoded = decodeBase64Text(userinfo);
      if (!decoded.ok) {
        return fail('E_BASE64_INVALID', 'ss userinfo is not valid base64');
      }
      credentials = decoded.text;
    }
  } else {
    const decoded = decodeBase64Text(body);
    if (!decoded.ok) {
      return fail('E_BASE64_INVALID', 'ss payload is not valid base64');
    }
    const payload = decoded.text.replace(/\/+$/, '');
    const payloadAt = payload.lastIndexOf('@');
    if (payloadAt < 0) {
      return fail('E_NODE_LINE', 'ss payload has no server part');
    }
    credentials = payload.slice(0, payloadAt);
    authorityText = payload.slice(payloadAt + 1);
  }

  const authority = parseAuthority(authorityText);
  if (!authority) {
    return fail('E_NODE_LINE', 'ss server authority could not be parsed');
  }
  const server = normalizeServer(authority.host);
  if (!server) {
    return fail('E_NODE_SERVER', 'ss server address is invalid');
  }
  const port = parsePortValue(authority.port);
  if (port === null) {
    return fail('E_NODE_PORT', 'ss port is not an integer in 1..65535');
  }

  const colon = credentials.indexOf(':');
  if (colon < 0) {
    return fail('E_NODE_LINE', 'ss credentials are missing a colon');
  }
  const cipher = credentials.slice(0, colon).trim().toLowerCase();
  const password = credentials.slice(colon + 1);
  if (cipher === '') {
    return fail('E_NODE_CIPHER', 'ss cipher is empty');
  }
  if (!isSupportedSsCipher(cipher)) {
    return fail('E_NODE_CIPHER', `unsupported ss cipher: ${cipher}`);
  }
  if (password === '') {
    return fail('E_NODE_LINE', 'ss password is empty');
  }

  const pluginValue = params.get('plugin');
  let plugin: SsProxy['plugin'];
  let pluginOpts: SsProxy['pluginOpts'];
  if (pluginValue !== null && pluginValue.trim() !== '') {
    const parsed = parsePluginSpec(pluginValue);
    if (!parsed.ok) {
      return fail('E_NODE_PLUGIN', parsed.message);
    }
    plugin = parsed.plugin;
    if (Object.keys(parsed.opts).length > 0) pluginOpts = parsed.opts;
  }

  const name = decodeComponentSafe(fragmentSplit.fragment);
  const node: SsProxy = {
    kind: 'ss',
    name,
    server,
    port,
    cipher,
    password,
  };
  if (plugin !== undefined) node.plugin = plugin;
  if (pluginOpts !== undefined) node.pluginOpts = pluginOpts;

  return { ok: true, node };
}
