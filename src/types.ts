/**
 * Shared domain types and constants for subconverter-worker.
 *
 * This module intentionally contains **no business logic**. Runtime validation,
 * parsing, emission and HTTP handling live in their own modules.
 *
 * Sources:
 * - docs/ARCHITECTURE.md §6 (core data model)
 * - docs/SPEC.md §2 (HTTP API/params), §3 (nodes), §4 (rulesets), §5 (rules),
 *   §7 (output), §8 (INI), §9 (limits), §10 (warnings)
 */

// ---------------------------------------------------------------------------
// Application identity
// ---------------------------------------------------------------------------

export const APP_NAME = 'subconverter-worker';
export const VERSION = '1.0.0';

/** v1 only serves mihomo/Clash output. */
export const SUPPORTED_TARGETS = ['clash'] as const;
export type Target = (typeof SUPPORTED_TARGETS)[number];
export const DEFAULT_TARGET: Target = 'clash';

// ---------------------------------------------------------------------------
// Structured warnings (SPEC §10)
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'warning' | 'error';

export type Stage =
  | 'request'
  | 'fetch'
  | 'decode'
  | 'yaml'
  | 'nodes'
  | 'rules'
  | 'groups'
  | 'template'
  | 'emit';

/**
 * Stable warning/error reason code. The authoritative table is SPEC §10.2;
 * it is kept as `string` here so adding a code never requires a type change.
 */
export type WarningCode = string;

export interface Warning {
  code: WarningCode;
  severity: Severity;
  stage: Stage;
  /** Short English message. Must not contain secrets or URLs with tokens. */
  message: string;
  /** e.g. "url#1", "config", "template", "inline#2". */
  source?: string;
  /** 1-based line number. */
  line?: number;
  /** At most 160 characters, control characters escaped. */
  raw?: string;
  hint?: string;
}

export const MAX_WARNINGS = 200;

// ---------------------------------------------------------------------------
// Proxies / nodes (SPEC §3.4, ARCHITECTURE §6)
// ---------------------------------------------------------------------------

export const PROXY_TYPES = ['ss', 'ssr', 'vmess', 'trojan', 'vless'] as const;
export type ProxyType = (typeof PROXY_TYPES)[number];

/** Alias used by the architecture document. */
export type NodeKind = ProxyType;

export type Transport = 'tcp' | 'ws' | 'grpc';
export type SsPlugin = 'obfs' | 'v2ray-plugin';

export interface ProxyBase {
  /** Discriminator. The emitter maps this to the YAML `type` field. */
  kind: ProxyType;
  name: string;
  server: string;
  /** Integer in 1..65535. */
  port: number;
  sourceGroup?: string;
  udp?: boolean;
  tfo?: boolean;
  skipCertVerify?: boolean;
}

export interface SsProxy extends ProxyBase {
  kind: 'ss';
  cipher: string;
  password: string;
  plugin?: SsPlugin;
  pluginOpts?: Record<string, string | boolean>;
}

export interface SsrProxy extends ProxyBase {
  kind: 'ssr';
  cipher: string;
  password: string;
  protocol: string;
  protocolParam?: string;
  obfs: string;
  obfsParam?: string;
}

export interface WsOptions {
  path?: string;
  host?: string;
}

export interface GrpcOptions {
  serviceName?: string;
}

export interface VmessProxy extends ProxyBase {
  kind: 'vmess';
  uuid: string;
  alterId: number;
  cipher: 'auto';
  tls: boolean;
  servername?: string;
  network: Transport;
  ws?: WsOptions;
  grpc?: GrpcOptions;
}

export interface TrojanProxy extends ProxyBase {
  kind: 'trojan';
  password: string;
  sni?: string;
  alpn?: string[];
  network: Transport;
  ws?: WsOptions;
  grpc?: GrpcOptions;
}

export interface RealityOptions {
  publicKey: string;
  shortId?: string;
}

export interface VlessProxy extends ProxyBase {
  kind: 'vless';
  uuid: string;
  tls: boolean;
  servername?: string;
  network: Transport;
  flow?: 'xtls-rprx-vision';
  clientFingerprint?: string;
  reality?: RealityOptions;
  ws?: WsOptions;
  grpc?: GrpcOptions;
}

/** A fully parsed and validated proxy node. */
export type Proxy = SsProxy | SsrProxy | VmessProxy | TrojanProxy | VlessProxy;

/** Alias used by the architecture document. */
export type ProxyNode = Proxy;

// ---------------------------------------------------------------------------
// Rules (SPEC §5)
// ---------------------------------------------------------------------------

/** The 37 exact mihomo rule types. Matching must be exact, never prefix-based. */
export const RULE_TYPES = [
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'DOMAIN-WILDCARD',
  'GEOSITE',
  'GEOIP',
  'SRC-GEOIP',
  'IP-ASN',
  'SRC-IP-ASN',
  'IP-CIDR',
  'IP-CIDR6',
  'SRC-IP-CIDR',
  'IP-SUFFIX',
  'SRC-IP-SUFFIX',
  'SRC-PORT',
  'DST-PORT',
  'IN-PORT',
  'DSCP',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX',
  'PROCESS-NAME-WILDCARD',
  'PROCESS-PATH-WILDCARD',
  'NETWORK',
  'UID',
  'IN-TYPE',
  'IN-USER',
  'IN-NAME',
  'REMATCH-NAME',
  'SUB-RULE',
  'AND',
  'OR',
  'NOT',
  'RULE-SET',
  'MATCH',
] as const;

export type RuleType = (typeof RULE_TYPES)[number];

/** The only extra field allowed on IP-family rules. */
export type RuleParam = 'no-resolve';

export interface Rule {
  /** Normalized exact mihomo type (aliases already translated). */
  type: RuleType;
  payload: string;
  /** Empty only in the `/getruleset` provider context. */
  target: string;
  params: RuleParam[];
  raw: string;
  /** 1-based line number in the source. */
  line: number;
  /** Stable identifier such as "url#1" / "config" / "inline#2". */
  sourceId: string;
}

/**
 * Target name: a resolved group/proxy name or one of `BUILTIN_TARGETS`.
 * Membership cannot be expressed structurally, so this stays `string` and is
 * enforced by the rules validator (SPEC §5.4).
 */
export type RuleTarget = string;

/** Built-in mihomo targets (SPEC §3.5 / §5.4). */
export const BUILTIN_TARGETS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'] as const;
export type BuiltinTarget = (typeof BUILTIN_TARGETS)[number];

export const MAX_RULE_LINE_LENGTH = 4096;
export const MAX_RULE_NAME_LENGTH = 256;

// ---------------------------------------------------------------------------
// Rule sources / dialects / provider formats (SPEC §4, §2.7)
// ---------------------------------------------------------------------------

/** Dialects after normalization. `clash-classic` is normalized before this type. */
export const SUPPORTED_DIALECTS = [
  'clash-classical',
  'clash-domain',
  'clash-ipcidr',
  'surge',
  'domain',
  'base64',
] as const;

export type SupportedDialect = (typeof SUPPORTED_DIALECTS)[number];

/** Dialect value accepted from user input, including the tindy alias and auto. */
export type DialectInput = 'auto' | 'clash-classic' | SupportedDialect;

export const RULESET_FORMATS = ['domain', 'ipcidr', 'classical'] as const;

/** mihomo rule-provider behavior; also the `/getruleset` type family. */
export type RulesetFormat = (typeof RULESET_FORMATS)[number];

export const RULESET_TYPE_BY_FORMAT = {
  domain: 3,
  ipcidr: 4,
  classical: 6,
} as const satisfies Record<RulesetFormat, number>;

/** `/getruleset?type=` values supported by v1: 3, 4 or 6. */
export type RulesetType = (typeof RULESET_TYPE_BY_FORMAT)[RulesetFormat];

/** A `ruleset=GROUP,SOURCE[,INTERVAL]` parameter after parsing. */
export interface RulesetSourceSpec {
  group: string;
  source: SourceRef;
  dialect?: SupportedDialect;
  /** Provider refresh interval in seconds (60..604800). */
  interval?: number;
}

export interface RuleProviderSpec {
  name: string;
  behavior: RulesetFormat;
  source: { raw: string; dialect: SupportedDialect };
  interval: number;
  /** Filled in by integration once the canonical origin is known. */
  url?: string;
}

/** A provider entry as emitted under `rule-providers`. */
export interface RuleProvider {
  type: 'http';
  behavior: RulesetFormat;
  format: 'yaml';
  url: string;
  path: string;
  interval: number;
}

export const DEFAULT_PROVIDER_INTERVAL = 86400;

// ---------------------------------------------------------------------------
// Sources (SPEC §2.5)
// ---------------------------------------------------------------------------

export type SourceRef =
  | {
      kind: 'inline';
      /** Decoded text; never a URL. */
      value: string;
      label: string;
      bytes: number;
    }
  | {
      kind: 'http';
      value: string;
      label: string;
      sourceGroup?: string;
    };

export const MAX_SOURCES = 8;
export const MAX_RULESETS = 8;
export const MAX_INCLUDE_PATTERNS = 16;
export const MAX_EXCLUDE_PATTERNS = 16;
export const MAX_RENAME_RULES = 32;

// ---------------------------------------------------------------------------
// Proxy groups (SPEC §7.3, §8.3)
// ---------------------------------------------------------------------------

export const GROUP_TYPES = ['select', 'url-test', 'fallback', 'load-balance'] as const;

export type GroupType = (typeof GROUP_TYPES)[number];

export type LoadBalanceStrategy = 'round-robin' | 'consistent-hashing';

export type Matcher =
  | { kind: 'literal'; value: string }
  | { kind: 'name-regex'; pattern: string }
  | { kind: 'node-type'; pattern: string }
  | { kind: 'source-group'; pattern: string }
  | { kind: 'server'; pattern: string }
  | { kind: 'port-range'; range: string };

/** A group as declared by config/groups, before members are expanded. */
export interface GroupSpec {
  name: string;
  type: GroupType;
  matchers: Matcher[];
  url?: string;
  interval?: number;
  tolerance?: number;
  strategy?: LoadBalanceStrategy;
}

/** A group with its member names resolved. */
export interface ProxyGroup {
  name: string;
  type: GroupType;
  members: string[];
  url?: string;
  interval?: number;
  tolerance?: number;
  strategy?: LoadBalanceStrategy;
}

/** Alias used by the architecture document. */
export type ResolvedGroup = ProxyGroup;

export const DEFAULT_GROUP_URL = 'https://www.gstatic.com/generate_204';
export const DEFAULT_GROUP_INTERVAL = 300;
export const DEFAULT_GROUP_TOLERANCE = 50;

// ---------------------------------------------------------------------------
// ACL4SSR-style INI config (SPEC §8)
// ---------------------------------------------------------------------------

export interface Acl4ssrConfig {
  /** Raw `custom_proxy_group` lines, in source order. */
  customProxyGroups: string[];
  /** Raw `ruleset` / `surge_ruleset` lines, in source order. */
  rulesets: string[];
  enableRuleGenerator: boolean;
  /** Defaults to true in this project (intentional difference from tindy). */
  overwriteOriginalRules: boolean;
  rename: string[];
  includeRemarks: string[];
  excludeRemarks: string[];
  clashRuleBase?: string;
  ignoredSections: string[];
  unsupportedKeys: string[];
}

// ---------------------------------------------------------------------------
// Conversion options (SPEC §2.4)
// ---------------------------------------------------------------------------

export type RulesMode = 'inline' | 'providers';
export type DiagnosticsMode = 'none' | 'json';

export interface RenameSpec {
  /** JavaScript regular expression source. */
  pattern: string;
  /** Replacement string; supports `$1`..`$9`. */
  replacement: string;
}

export interface ConversionOptions {
  target: Target;
  rulesMode: RulesMode;
  diagnostics: DiagnosticsMode;
  include: string[];
  exclude: string[];
  rename: RenameSpec[];
  sort: boolean;
  udp: boolean;
  tfo: boolean;
  /** `scv` query parameter: emit `skip-cert-verify: true`. */
  skipCertVerify: boolean;
  /** Overrides `sourceGroup` on every node. */
  sourceGroup?: string;
  /** Seconds; only used for the `profile-update-interval` response header. */
  interval: number;
  appendInfo: boolean;
  filename?: string;
}

export const DEFAULT_RULES_MODE: RulesMode = 'inline';
export const DEFAULT_DIAGNOSTICS: DiagnosticsMode = 'none';
export const DEFAULT_INTERVAL = 0;
export const DEFAULT_APPEND_INFO = true;

// ---------------------------------------------------------------------------
// Clash output config (SPEC §7)
// ---------------------------------------------------------------------------

export interface ClashConfig {
  proxies: Proxy[];
  'proxy-groups': ProxyGroup[];
  'rule-providers'?: Record<string, RuleProvider>;
  rules: string[];
  /** Template-provided top-level keys (dns, tun, mixed-port, ...). */
  [key: string]: unknown;
}

export interface EmitInput {
  template: Record<string, unknown>;
  nodes: Proxy[];
  groups: ProxyGroup[];
  rules: Rule[];
  providers: RuleProviderSpec[];
  origin: string;
  version: string;
  options: Pick<ConversionOptions, 'rulesMode'> & { defaultGroup: string };
}

export interface EmitResult {
  yaml: string;
  stats: ConversionStats;
  warnings: Warning[];
}

// ---------------------------------------------------------------------------
// Diagnostics (SPEC §2.8, §2.9)
// ---------------------------------------------------------------------------

export interface ConversionStats {
  nodes: number;
  groups: number;
  rules: number;
  providers: number;
  sources: number;
  bytesIn: number;
  bytesOut: number;
  warnings: number;
  warningCodes: string[];
}

export type ErrorCode =
  | 'invalid_request'
  | 'invalid_boolean'
  | 'invalid_regex'
  | 'invalid_source'
  | 'blocked_upstream'
  | 'unsupported_target'
  | 'unsupported_ruleset_type'
  | 'conflicting_params'
  | 'invalid_config'
  | 'invalid_template'
  | 'too_many_sources'
  | 'upstream_too_large'
  | 'no_nodes'
  | 'upstream_status'
  | 'upstream_network'
  | 'upstream_timeout'
  | 'internal_error';

export interface ErrorBody {
  code: ErrorCode;
  message: string;
}

export interface DiagnosticsSuccess {
  ok: true;
  version: string;
  target: Target;
  contentType: string;
  output: string;
  stats: ConversionStats;
  warnings: Warning[];
}

export interface DiagnosticsFailure {
  ok: false;
  error: ErrorBody;
  warnings: Warning[];
}

export type DiagnosticsEnvelope = DiagnosticsSuccess | DiagnosticsFailure;

// ---------------------------------------------------------------------------
// Worker environment (ARCHITECTURE §2.2)
// ---------------------------------------------------------------------------

/**
 * Cloudflare Workers vars are always strings, even when they represent numbers
 * or booleans. `src/integration/env.ts` parses them once at module scope.
 */
export interface Env {
  UPSTREAM_TIMEOUT_MS: string;
  REQUEST_DEADLINE_MS: string;
  PER_HOP_TIMEOUT_MS: string;
  MAX_UPSTREAM_BYTES: string;
  MAX_TOTAL_UPSTREAM_BYTES: string;
  MAX_INLINE_BYTES: string;
  MAX_INLINE_SOURCE_CHARS: string;
  MAX_NODES: string;
  MAX_RULES: string;
  MAX_GROUPS: string;
  MAX_REDIRECTS: string;
  ALLOW_HTTP_UPSTREAM: string;
  UPSTREAM_ALLOWED_PORTS: string;
  PUBLIC_SUBSCRIPTION_CACHE: string;
  SUBSCRIPTION_CACHE_TTL: string;
  RULESET_CACHE_TTL: string;
  PUBLIC_ORIGIN: string;
  ENVIRONMENT: string;
  ALLOW_TEST_UPSTREAM_HOSTS: string;
}

// ---------------------------------------------------------------------------
// Misc shared limits/constants
// ---------------------------------------------------------------------------

export const MAX_NODE_NAME_LENGTH = 128;
export const MAX_SERVER_NAME_LENGTH = 253;
export const MAX_SOURCE_URL_LENGTH = 4096;
export const MAX_INLINE_SOURCE_CHARS = 12000;
export const MAX_PROVIDER_URL_LENGTH = 12000;
