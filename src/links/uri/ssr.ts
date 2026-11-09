/**
 * ShadowsocksR URI parser (SPEC §3.4.2).
 *
 * Payload shape:
 *   base64url(host:port:protocol:method:obfs:base64(password)/?remarks=&group=&obfsparam=&protoparam=)
 *
 * The host is split from the last five colon fields so IPv6 literals survive.
 */

import type { SsrProxy, UriParseResult } from '../contracts';
import { decodeBase64Text } from '../base64';
import {
  SSR_OBFS,
  SSR_PROTOCOLS,
  decodeComponentSafe,
  getParam,
  normalizeServer,
  normalizeSsrCipher,
  parsePortValue,
  parseQueryParams,
  splitFragment,
  splitUriScheme,
} from '../protocols';

function fail(code: string, message: string): UriParseResult {
  return { ok: false, code, message };
}

function decodeSsrParam(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '') return '';
  // `URLSearchParams` turns '+' into a space; SSR params are base64, so a
  // space may really be a standard-base64 plus sign.
  const decoded = decodeBase64Text(value) ?? decodeBase64Text(value.replace(/ /g, '+'));
  if (decoded?.ok) return decoded.text;
  return decodeComponentSafe(value);
}

export function parseSsr(uri: string): UriParseResult {
  const parts = splitUriScheme(uri);
  if (!parts || parts.scheme !== 'ssr') {
    return fail('E_NODE_LINE', 'not an ssr:// URI');
  }

  const fragmentSplit = splitFragment(parts.rest);
  let decoded = decodeBase64Text(fragmentSplit.main.trim());
  if (!decoded.ok) {
    // Some generators percent-encode the base64 body (`%3D` padding).
    const percentDecoded = decodeComponentSafe(fragmentSplit.main.trim());
    if (percentDecoded !== fragmentSplit.main.trim()) {
      decoded = decodeBase64Text(percentDecoded);
    }
  }
  if (!decoded.ok) {
    return fail('E_BASE64_INVALID', 'ssr payload is not valid base64');
  }
  const payloadText = decoded.text;

  let payload = payloadText;
  let query = '';
  const slashQuery = payloadText.indexOf('/?');
  if (slashQuery >= 0) {
    payload = payloadText.slice(0, slashQuery);
    query = payloadText.slice(slashQuery + 2);
  } else {
    const question = payloadText.indexOf('?');
    if (question >= 0) {
      payload = payloadText.slice(0, question);
      query = payloadText.slice(question + 1);
    }
  }
  payload = payload.replace(/\/+$/, '');

  const fields: string[] = [];
  let end = payload.length;
  for (let i = 0; i < 5; i++) {
    const index = payload.lastIndexOf(':', end - 1);
    if (index < 0) {
      return fail('E_NODE_LINE', 'ssr payload has fewer than six fields');
    }
    fields.unshift(payload.slice(index + 1, end));
    end = index;
  }
  const hostRaw = payload.slice(0, end);
  const [portRaw, protocolRaw, methodRaw, obfsRaw, passwordRaw] = fields;

  const server = normalizeServer(hostRaw);
  if (!server) {
    return fail('E_NODE_SERVER', 'ssr server address is invalid');
  }
  const port = parsePortValue(portRaw);
  if (port === null) {
    return fail('E_NODE_PORT', 'ssr port is not an integer in 1..65535');
  }

  const protocol = protocolRaw.trim().toLowerCase();
  if (!SSR_PROTOCOLS.has(protocol)) {
    return fail('E_NODE_CIPHER', `unsupported ssr protocol: ${protocol || '(empty)'}`);
  }
  const obfs = obfsRaw.trim().toLowerCase();
  if (!SSR_OBFS.has(obfs)) {
    return fail('E_NODE_CIPHER', `unsupported ssr obfs: ${obfs || '(empty)'}`);
  }
  const cipher = normalizeSsrCipher(methodRaw);
  if (cipher === null) {
    return fail('E_NODE_CIPHER', `unsupported ssr cipher: ${methodRaw.trim() || '(empty)'}`);
  }

  const password = decodeBase64Text(passwordRaw.trim());
  if (!password.ok) {
    return fail('E_BASE64_INVALID', 'ssr password is not valid base64');
  }
  if (password.text === '') {
    return fail('E_NODE_LINE', 'ssr password is empty');
  }

  const params = parseQueryParams(query);
  const name = decodeSsrParam(getParam(params, 'remarks')) ?? '';
  const group = decodeSsrParam(getParam(params, 'group'));
  const obfsParam = decodeSsrParam(getParam(params, 'obfsparam'));
  const protocolParam = decodeSsrParam(getParam(params, 'protoparam'));

  const node: SsrProxy = {
    kind: 'ssr',
    name,
    server,
    port,
    cipher,
    password: password.text,
    protocol,
    obfs,
  };
  if (protocolParam !== undefined && protocolParam !== '') node.protocolParam = protocolParam;
  if (obfsParam !== undefined && obfsParam !== '') node.obfsParam = obfsParam;
  if (group !== undefined && group !== '') node.sourceGroup = group;

  return { ok: true, node };
}
