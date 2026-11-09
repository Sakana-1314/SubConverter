/**
 * Clash / mihomo YAML input: map `proxies` (or legacy `Proxy`) entries onto the
 * unified `ProxyNode` model (SPEC §3.3, §3.4).
 *
 * Only per-node data is read. Groups, rules, providers and scripts are ignored
 * with one aggregated warning; unsupported v2ray/sing-box/SSD/SIP008 shapes
 * fail the whole source.
 */

import type {
  GrpcOptions,
  ParseNodesResult,
  ProxyNode,
  RealityOptions,
  SsProxy,
  SsrProxy,
  TrojanProxy,
  VlessProxy,
  VmessProxy,
  Warning,
  WsOptions,
} from './contracts';
import {
  isSupportedSsCipher,
  normalizeServer,
  normalizeSsrCipher,
  normalizeUuid,
  parseAlterIdValue,
  parsePortValue,
  parseTransportValue,
} from './protocols';
import { makeWarning, truncateForWarning } from './text';

export type { ParseNodesResult } from './contracts';

type Obj = Record<string, unknown>;

interface BuildContext {
  ignored: Set<string>;
}

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function toBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return undefined;
}

function optionalString(obj: Obj, key: string, ctx: BuildContext): string | undefined {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = toText(obj[key]);
  if (value === null) {
    ctx.ignored.add(key);
    return undefined;
  }
  return value;
}

function optionalBool(obj: Obj, key: string, ctx: BuildContext): boolean | undefined {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) return undefined;
  const value = toBool(obj[key]);
  if (value === undefined) {
    ctx.ignored.add(key);
    return undefined;
  }
  return value;
}

function readWsOptions(value: unknown): WsOptions | undefined {
  if (!isObj(value)) return undefined;
  const opts: WsOptions = {};
  const path = toText(value.path);
  if (path !== null && path !== '') opts.path = path;
  if (isObj(value.headers)) {
    for (const [key, headerValue] of Object.entries(value.headers)) {
      if (key.toLowerCase() === 'host') {
        const host = toText(headerValue);
        if (host !== null && host !== '') opts.host = host;
      }
    }
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}

function readGrpcOptions(value: unknown): GrpcOptions | undefined {
  if (!isObj(value)) return undefined;
  for (const key of ['grpc-service-name', 'serviceName', 'service-name']) {
    const name = toText(value[key]);
    if (name !== null && name !== '') return { serviceName: name };
  }
  return undefined;
}

function readRealityOptions(value: unknown): RealityOptions | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObj(value)) return null;
  const publicKey = toText(value['public-key'] ?? value.publicKey ?? value.pbk);
  if (publicKey === null || publicKey.trim() === '') return null;
  const reality: RealityOptions = { publicKey: publicKey.trim() };
  const shortId = toText(value['short-id'] ?? value.shortId ?? value.sid);
  if (shortId !== null && shortId !== '') reality.shortId = shortId;
  return reality;
}

function readAlpn(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    return parts.length > 0 ? parts : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === 'string' && item !== '');
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

function readPluginOpts(value: unknown): Record<string, string | boolean> | undefined {
  if (!isObj(value)) return undefined;
  const opts: Record<string, string | boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') opts[key] = raw;
    else if (typeof raw === 'boolean') opts[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) {
      opts[key] = ['tls', 'mux', 'skip-cert-verify'].includes(key) ? raw !== 0 : String(raw);
    }
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}

type BuildResult =
  | { ok: true; node: ProxyNode }
  | { ok: false; code: string; message: string };

function fail(code: string, message: string): BuildResult {
  return { ok: false, code, message };
}

function commonBase(obj: Obj, ctx: BuildContext): { name: string; server: string; port: number } | BuildResult {
  if (obj.name !== undefined && obj.name !== null && toText(obj.name) === null) {
    return fail('E_NODE_LINE', 'node name is not a string');
  }
  const name = toText(obj.name) ?? '';
  const server = normalizeServer(obj.server);
  if (!server) return fail('E_NODE_SERVER', 'node server address is invalid');
  const port = parsePortValue(obj.port);
  if (port === null) return fail('E_NODE_PORT', 'node port is not an integer in 1..65535');
  void ctx;
  return { name, server, port };
}

function applyCommon(node: ProxyNode, obj: Obj, ctx: BuildContext): void {
  const udp = optionalBool(obj, 'udp', ctx);
  if (udp === true) node.udp = true;
  const tfo = optionalBool(obj, 'tfo', ctx);
  if (tfo === true) node.tfo = true;
  const skip = optionalBool(obj, 'skip-cert-verify', ctx);
  if (skip === true) node.skipCertVerify = true;
}

function buildSs(obj: Obj, ctx: BuildContext): BuildResult {
  const base = commonBase(obj, ctx);
  if ('ok' in base) return base;

  const cipherRaw = toText(obj.cipher);
  if (cipherRaw === null) return fail('E_NODE_CIPHER', 'ss cipher is missing');
  const cipher = cipherRaw.trim().toLowerCase();
  if (!isSupportedSsCipher(cipher)) {
    return fail('E_NODE_CIPHER', `unsupported ss cipher: ${cipher || '(empty)'}`);
  }
  const password = toText(obj.password);
  if (password === null || password === '') {
    return fail('E_NODE_LINE', 'ss password is empty');
  }

  let plugin: SsProxy['plugin'];
  let pluginOpts: SsProxy['pluginOpts'];
  const pluginRaw = toText(obj.plugin);
  if (obj.plugin !== undefined && obj.plugin !== null) {
    if (pluginRaw === null) return fail('E_NODE_PLUGIN', 'ss plugin is not a string');
    const normalized = pluginRaw.trim().toLowerCase();
    if (normalized !== '') {
      if (normalized === 'obfs' || normalized === 'obfs-local' || normalized === 'simple-obfs') {
        plugin = 'obfs';
      } else if (normalized === 'v2ray-plugin') {
        plugin = 'v2ray-plugin';
      } else {
        return fail('E_NODE_PLUGIN', `unsupported ss plugin: ${normalized}`);
      }
    }
  }
  if (obj['plugin-opts'] !== undefined && obj['plugin-opts'] !== null) {
    pluginOpts = readPluginOpts(obj['plugin-opts']);
    if (pluginOpts === undefined && plugin !== undefined) {
      return fail('E_NODE_PLUGIN', 'ss plugin-opts is not an object');
    }
  }

  const node: SsProxy = {
    kind: 'ss',
    name: base.name,
    server: base.server,
    port: base.port,
    cipher,
    password,
  };
  if (plugin !== undefined) node.plugin = plugin;
  if (plugin !== undefined && pluginOpts !== undefined) node.pluginOpts = pluginOpts;
  applyCommon(node, obj, ctx);
  return { ok: true, node };
}

function buildSsr(obj: Obj, ctx: BuildContext): BuildResult {
  const base = commonBase(obj, ctx);
  if ('ok' in base) return base;

  const cipherRaw = toText(obj.cipher);
  if (cipherRaw === null) return fail('E_NODE_CIPHER', 'ssr cipher is missing');
  const cipher = normalizeSsrCipher(cipherRaw);
  if (cipher === null) return fail('E_NODE_CIPHER', `unsupported ssr cipher: ${cipherRaw}`);
  const password = toText(obj.password);
  if (password === null || password === '') {
    return fail('E_NODE_LINE', 'ssr password is empty');
  }
  const protocolRaw = toText(obj.protocol);
  const protocol = (protocolRaw ?? '').trim().toLowerCase();
  if (!['origin', 'auth_sha1_v4', 'auth_aes128_md5', 'auth_aes128_sha1', 'auth_chain_a', 'auth_chain_b'].includes(protocol)) {
    return fail('E_NODE_CIPHER', `unsupported ssr protocol: ${protocol || '(empty)'}`);
  }
  const obfsRaw = toText(obj.obfs);
  const obfs = (obfsRaw ?? '').trim().toLowerCase();
  if (!['plain', 'http_simple', 'http_post', 'random_head', 'tls1.2_ticket_auth'].includes(obfs)) {
    return fail('E_NODE_CIPHER', `unsupported ssr obfs: ${obfs || '(empty)'}`);
  }

  const protocolParam =
    optionalString(obj, 'protocol-param', ctx) ?? optionalString(obj, 'protocolparam', ctx);
  const obfsParam = optionalString(obj, 'obfs-param', ctx) ?? optionalString(obj, 'obfsparam', ctx);

  const node: SsrProxy = {
    kind: 'ssr',
    name: base.name,
    server: base.server,
    port: base.port,
    cipher,
    password,
    protocol,
    obfs,
  };
  if (protocolParam !== undefined && protocolParam !== '') node.protocolParam = protocolParam;
  if (obfsParam !== undefined && obfsParam !== '') node.obfsParam = obfsParam;
  applyCommon(node, obj, ctx);
  return { ok: true, node };
}

function buildVmess(obj: Obj, ctx: BuildContext): BuildResult {
  const base = commonBase(obj, ctx);
  if ('ok' in base) return base;
  const uuid = normalizeUuid(obj.uuid);
  if (!uuid) return fail('E_NODE_UUID', 'vmess uuid is invalid');
  const alterId = parseAlterIdValue(obj.alterId);
  if (alterId === null) return fail('E_NODE_LINE', 'vmess alterId is invalid');

  const netRaw = optionalString(obj, 'network', ctx) ?? 'tcp';
  const network = parseTransportValue(netRaw);
  if (network === null) return fail('E_NODE_TRANSPORT', `unsupported vmess transport: ${netRaw}`);
  const tls = optionalBool(obj, 'tls', ctx) ?? false;
  const servername = optionalString(obj, 'servername', ctx) ?? optionalString(obj, 'sni', ctx);

  const node: VmessProxy = {
    kind: 'vmess',
    name: base.name,
    server: base.server,
    port: base.port,
    uuid,
    alterId,
    cipher: 'auto',
    tls,
    network,
  };
  if (servername !== undefined && servername !== '') node.servername = servername;
  if (network === 'ws') {
    const ws = readWsOptions(obj['ws-opts']);
    if (ws) node.ws = ws;
  }
  if (network === 'grpc') {
    const grpc = readGrpcOptions(obj['grpc-opts']);
    if (grpc) node.grpc = grpc;
  }
  applyCommon(node, obj, ctx);
  return { ok: true, node };
}

function buildTrojan(obj: Obj, ctx: BuildContext): BuildResult {
  const base = commonBase(obj, ctx);
  if ('ok' in base) return base;
  const password = toText(obj.password);
  if (password === null || password === '') {
    return fail('E_NODE_LINE', 'trojan password is empty');
  }
  const netRaw = optionalString(obj, 'network', ctx) ?? 'tcp';
  const network = parseTransportValue(netRaw);
  if (network === null) return fail('E_NODE_TRANSPORT', `unsupported trojan transport: ${netRaw}`);
  const sni = optionalString(obj, 'sni', ctx) ?? optionalString(obj, 'servername', ctx);

  const node: TrojanProxy = {
    kind: 'trojan',
    name: base.name,
    server: base.server,
    port: base.port,
    password,
    network,
  };
  if (sni !== undefined && sni !== '') node.sni = sni;
  if (obj.alpn !== undefined) {
    const alpn = readAlpn(obj.alpn);
    if (alpn !== undefined) node.alpn = alpn;
  }
  if (network === 'ws') {
    const ws = readWsOptions(obj['ws-opts']);
    if (ws) node.ws = ws;
  }
  if (network === 'grpc') {
    const grpc = readGrpcOptions(obj['grpc-opts']);
    if (grpc) node.grpc = grpc;
  }
  applyCommon(node, obj, ctx);
  return { ok: true, node };
}

function buildVless(obj: Obj, ctx: BuildContext): BuildResult {
  const base = commonBase(obj, ctx);
  if ('ok' in base) return base;
  const uuid = normalizeUuid(obj.uuid);
  if (!uuid) return fail('E_NODE_UUID', 'vless uuid is invalid');

  const netRaw = optionalString(obj, 'network', ctx) ?? 'tcp';
  const network = parseTransportValue(netRaw);
  if (network === null) return fail('E_NODE_TRANSPORT', `unsupported vless transport: ${netRaw}`);

  const flow = optionalString(obj, 'flow', ctx);
  if (flow !== undefined && flow !== '' && flow !== 'xtls-rprx-vision') {
    return fail('E_NODE_FLOW', `unsupported vless flow: ${flow}`);
  }
  const reality = readRealityOptions(obj['reality-opts']);
  if (reality === null) {
    return fail('E_NODE_REALITY', 'vless reality-opts is missing a public-key');
  }

  let tls = optionalBool(obj, 'tls', ctx) ?? false;
  if (reality !== undefined) tls = true;
  const servername = optionalString(obj, 'servername', ctx) ?? optionalString(obj, 'sni', ctx);
  const fingerprint = optionalString(obj, 'client-fingerprint', ctx);

  const node: VlessProxy = {
    kind: 'vless',
    name: base.name,
    server: base.server,
    port: base.port,
    uuid,
    tls,
    network,
  };
  if (servername !== undefined && servername !== '') node.servername = servername;
  if (flow === 'xtls-rprx-vision') node.flow = flow;
  if (fingerprint !== undefined && fingerprint !== '') node.clientFingerprint = fingerprint;
  if (reality !== undefined) node.reality = reality;
  if (network === 'ws') {
    const ws = readWsOptions(obj['ws-opts']);
    if (ws) node.ws = ws;
  }
  if (network === 'grpc') {
    const grpc = readGrpcOptions(obj['grpc-opts']);
    if (grpc) node.grpc = grpc;
  }
  applyCommon(node, obj, ctx);
  return { ok: true, node };
}

const COMMON_FIELDS = ['name', 'server', 'port', 'udp', 'tfo', 'skip-cert-verify'];

const ALLOWED_FIELDS: Record<string, ReadonlySet<string>> = {
  ss: new Set([
    'type',
    ...COMMON_FIELDS,
    'cipher',
    'password',
    'plugin',
    'plugin-opts',
  ]),
  ssr: new Set([
    'type',
    ...COMMON_FIELDS,
    'cipher',
    'password',
    'protocol',
    'protocol-param',
    'protocolparam',
    'obfs',
    'obfs-param',
    'obfsparam',
  ]),
  vmess: new Set([
    'type',
    ...COMMON_FIELDS,
    'uuid',
    'alterId',
    'cipher',
    'tls',
    'servername',
    'sni',
    'network',
    'ws-opts',
    'grpc-opts',
  ]),
  trojan: new Set([
    'type',
    ...COMMON_FIELDS,
    'password',
    'sni',
    'servername',
    'alpn',
    'network',
    'ws-opts',
    'grpc-opts',
  ]),
  vless: new Set([
    'type',
    ...COMMON_FIELDS,
    'uuid',
    'tls',
    'servername',
    'sni',
    'network',
    'flow',
    'client-fingerprint',
    'reality-opts',
    'ws-opts',
    'grpc-opts',
  ]),
};

const BUILDERS: Record<string, (obj: Obj, ctx: BuildContext) => BuildResult> = {
  ss: buildSs,
  ssr: buildSsr,
  vmess: buildVmess,
  trojan: buildTrojan,
  vless: buildVless,
};

const IGNORED_SECTIONS = [
  'proxy-groups',
  'Proxy Group',
  'rules',
  'Rule',
  'rule-providers',
  'proxy-providers',
  'script',
];

function safeNodeFragment(obj: Obj, type: string): string {
  const server = toText(obj.server) ?? '';
  const port = toText(obj.port) ?? '';
  return truncateForWarning(`type=${type} server=${server} port=${port}`, 120);
}

/**
 * Cheap pre-parse guard for Clash YAML.
 *
 * `parseAllDocuments` builds the whole AST before `parseClashNodes` can stop at
 * MAX_NODES; a 3.6 MB / 40k-node document can exhaust a 128 MB isolate. This
 * helper truncates a block `proxies:`/`Proxy:` sequence at an entry boundary
 * before YAML parsing. Flow-style/inline proxy lists with too many `type:`
 * occurrences are rejected (returned as an empty `proxies` document) because
 * they cannot be cut safely.
 */
export interface ClashInputLimit {
  text: string;
  truncated: boolean;
  reason?: 'entries' | 'flow';
  /** True when non-proxy top-level content was dropped before parsing. */
  sectionsStripped?: boolean;
}

const EMPTY_CLASH_INPUT = 'proxies: []\n';

function countTypeKeysUpTo(text: string, limit: number): number {
  let count = 0;
  let index = text.indexOf('type:');
  while (index !== -1) {
    count += 1;
    if (count > limit) return count;
    index = text.indexOf('type:', index + 5);
  }
  return count;
}

export function limitClashInput(text: string, maxNodes: number): ClashInputLimit {
  if (!Number.isFinite(maxNodes)) return { text, truncated: false };
  if (maxNodes <= 0) return { text: EMPTY_CLASH_INPUT, truncated: true, reason: 'entries' };

  const keyMatch = /^[ \t]*(proxies|Proxy)[ \t]*:/m.exec(text);
  if (keyMatch === null) {
    // No proxy section at all. Reject a huge unrelated document instead of
    // letting parseAllDocuments build an AST for it.
    if (countTypeKeysUpTo(text, maxNodes) > maxNodes) {
      return { text: EMPTY_CLASH_INPUT, truncated: true, reason: 'entries' };
    }
    return { text, truncated: false };
  }
  const keyIndent = (keyMatch[0].match(/^[ \t]*/)?.[0].length ?? 0);
  const keyLineEnd = text.indexOf('\n', keyMatch.index);
  const keyLine = text.slice(
    keyMatch.index,
    keyLineEnd === -1 ? text.length : keyLineEnd,
  );
  const afterColon = text
    .slice(keyMatch.index + keyMatch[0].length, keyLineEnd === -1 ? text.length : keyLineEnd)
    .trim();
  if (afterColon !== '' && !afterColon.startsWith('#')) {
    // Flow-style or inline value: cannot be cut safely. Keep only this key so
    // other (possibly huge) top-level sections are not parsed.
    if (countTypeKeysUpTo(text, maxNodes) > maxNodes) {
      return { text: EMPTY_CLASH_INPUT, truncated: true, reason: 'flow' };
    }
    return {
      text: `${keyLine}\n`,
      truncated: false,
      ...(keyMatch.index > 0 ||
      (keyLineEnd !== -1 && text.slice(keyLineEnd + 1).trim() !== '')
        ? { sectionsStripped: true }
        : {}),
    };
  }

  let entryIndent = -1;
  let count = 0;
  let cut = -1;
  let sectionEnd = text.length;
  let lineStart = keyLineEnd === -1 ? text.length : keyLineEnd + 1;
  for (;;) {
    if (lineStart >= text.length) break;
    const newline = text.indexOf('\n', lineStart);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, end);
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      if (newline === -1) break;
      lineStart = newline + 1;
      continue;
    }
    const indent = (line.match(/^[ \t]*/)?.[0].length ?? 0);
    const isEntry = /^[ \t]*-[ \t]/.test(line);
    if (isEntry && (entryIndent === -1 || indent === entryIndent)) {
      if (entryIndent === -1) entryIndent = indent;
      count += 1;
      if (count > maxNodes) {
        cut = lineStart;
        break;
      }
    } else if (!isEntry && indent <= keyIndent) {
      // Next top-level key: keep only the proxies section.
      sectionEnd = lineStart;
      break;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  if (cut !== -1) {
    return {
      text: text.slice(keyMatch.index, cut),
      truncated: true,
      reason: 'entries',
      ...(keyMatch.index > 0 ? { sectionsStripped: true } : {}),
    };
  }
  // Keep only the proxy section: other top-level sections are ignored by the
  // converter and must not be materialized before MAX_NODES truncation.
  const sectionsStripped = keyMatch.index > 0 || sectionEnd < text.length;
  return {
    text: text.slice(keyMatch.index, sectionEnd),
    truncated: false,
    ...(sectionsStripped ? { sectionsStripped: true } : {}),
  };
}

/**
 * Map an already-parsed YAML value to nodes. YAML syntax errors are handled by
 * `yaml.ts`; this function only validates the `proxies`/`Proxy` shape.
 */
export function parseClashNodes(
  value: unknown,
  sourceId: string,
  maxNodes = Number.POSITIVE_INFINITY,
): ParseNodesResult {
  const warnings: Warning[] = [];

  if (!isObj(value)) {
    return {
      nodes: [],
      warnings: [
        makeWarning('E_YAML_PARSE', 'Clash input is not a YAML object', { source: sourceId }),
      ],
      stats: { lines: 0, accepted: 0, dropped: 0 },
    };
  }

  const obj = value;
  if ('outbounds' in obj || 'servers' in obj || 'airport' in obj) {
    return {
      nodes: [],
      warnings: [
        makeWarning('E_UNSUPPORTED_INPUT_FORMAT', 'input looks like a v2ray/sing-box/SSD/SIP008 config', {
          source: sourceId,
        }),
      ],
      stats: { lines: 0, accepted: 0, dropped: 0 },
    };
  }

  const hasProxies = Object.prototype.hasOwnProperty.call(obj, 'proxies');
  const hasLegacyProxy = Object.prototype.hasOwnProperty.call(obj, 'Proxy');
  if (hasProxies && hasLegacyProxy) {
    warnings.push(
      makeWarning('W_CLASH_DUPLICATE_PROXY_KEY', 'both "proxies" and "Proxy" exist; using "proxies"', {
        source: sourceId,
      }),
    );
  }

  const key = hasProxies ? 'proxies' : hasLegacyProxy ? 'Proxy' : null;
  if (key === null) {
    return {
      nodes: [],
      warnings: [
        makeWarning('E_UNSUPPORTED_INPUT_FORMAT', 'Clash input has no proxies/Proxy section', {
          source: sourceId,
        }),
      ],
      stats: { lines: 0, accepted: 0, dropped: 0 },
    };
  }

  const list = obj[key];
  if (!Array.isArray(list)) {
    return {
      nodes: [],
      warnings: [
        makeWarning('E_YAML_PARSE', `Clash "${key}" section is not an array`, { source: sourceId }),
      ],
      stats: { lines: 0, accepted: 0, dropped: 0 },
    };
  }

  const ignoredSections = IGNORED_SECTIONS.filter((section) => section in obj);
  if (ignoredSections.length > 0) {
    warnings.push(
      makeWarning(
        'W_CLASH_SECTION_IGNORED',
        `ignored Clash sections: ${ignoredSections.join(', ')}`,
        { source: sourceId, raw: ignoredSections.join(', ') },
      ),
    );
  }

  const nodes: ProxyNode[] = [];
  const ignoredFields = new Set<string>();
  let dropped = 0;
  let nodeLimitWarned = false;

  for (let index = 0; index < list.length; index++) {
    if (nodes.length >= maxNodes) {
      if (!nodeLimitWarned) {
        nodeLimitWarned = true;
        warnings.push(
          makeWarning('W_NODE_LIMIT', `Clash input exceeds ${maxNodes} nodes; extra entries were ignored`, {
            source: sourceId,
          }),
        );
      }
      break;
    }
    const line = index + 1;
    const element = list[index];
    if (!isObj(element)) {
      warnings.push(
        makeWarning('E_NODE_LINE', 'Clash proxy entry is not an object', {
          source: sourceId,
          line,
        }),
      );
      dropped++;
      continue;
    }

    const typeRaw = element.type;
    if (typeof typeRaw !== 'string' || typeRaw.trim() === '') {
      warnings.push(
        makeWarning('E_NODE_LINE', 'Clash proxy has no string "type"', {
          source: sourceId,
          line,
        }),
      );
      dropped++;
      continue;
    }
    const type = typeRaw.trim().toLowerCase();
    const builder = BUILDERS[type];
    if (!builder) {
      warnings.push(
        makeWarning('W_NODE_UNSUPPORTED_PROTOCOL', `unsupported Clash proxy type: ${type}`, {
          source: sourceId,
          line,
          raw: `type=${type}`,
        }),
      );
      dropped++;
      continue;
    }

    const ctx: BuildContext = { ignored: new Set() };
    const built = builder(element, ctx);
    if (!built.ok) {
      warnings.push(
        makeWarning(built.code, built.message, {
          source: sourceId,
          line,
          raw: safeNodeFragment(element, type),
        }),
      );
      dropped++;
      continue;
    }

    const allowed = ALLOWED_FIELDS[type];
    for (const fieldName of Object.keys(element)) {
      if (!allowed.has(fieldName)) ctx.ignored.add(fieldName);
    }
    for (const fieldName of ctx.ignored) ignoredFields.add(fieldName);

    nodes.push(built.node);
  }

  if (ignoredFields.size > 0) {
    const listText = [...ignoredFields].sort().join(', ');
    warnings.push(
      makeWarning('W_NODE_FIELDS_IGNORED', `ignored node fields: ${listText}`, {
        source: sourceId,
        raw: listText,
      }),
    );
  }

  return {
    nodes,
    warnings,
    stats: { lines: list.length, accepted: nodes.length, dropped },
  };
}
