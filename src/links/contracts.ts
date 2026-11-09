/**
 * Shared types and constants for the `links` module.
 *
 * The canonical node/warning data model lives in `src/types.ts` (owned by the
 * integration module). This file re-exports the pieces `links` needs and adds
 * the module-local result types from docs/ARCHITECTURE.md §7.1.
 *
 * Sources:
 * - docs/ARCHITECTURE.md §6 (core data model), §7.1 (links contracts)
 * - docs/SPEC.md §3 (input detection, URI parsing), §10 (warnings)
 */

import type { ProxyNode, Warning } from '../types';

export type {
  BuiltinTarget,
  ConversionOptions,
  GrpcOptions,
  NodeKind,
  Proxy,
  ProxyBase,
  ProxyNode,
  ProxyType,
  RealityOptions,
  Severity,
  SourceRef,
  SsPlugin,
  SsProxy,
  SsrProxy,
  Stage,
  Transport,
  TrojanProxy,
  VlessProxy,
  VmessProxy,
  Warning,
  WarningCode,
  WsOptions,
} from '../types';

export {
  APP_NAME,
  BUILTIN_TARGETS,
  PROXY_TYPES,
  SUPPORTED_TARGETS,
  VERSION,
} from '../types';

// ---------------------------------------------------------------------------
// Limits used by the links module (SPEC §3 / §9.4)
// ---------------------------------------------------------------------------

/** Maximum length of a single plain-text subscription line (SPEC §3.2). */
export const MAX_NODE_LINE_LENGTH = 4096;

/** Maximum node display name length (SPEC §3.5). */
export const MAX_NODE_NAME_LENGTH = 128;

/** Maximum server hostname length (SPEC §3.5). */
export const MAX_SERVER_NAME_LENGTH = 253;

/** Default maximum bytes for one upstream/source payload (SPEC §9.4). */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** URL schemes handled by `uri/index.ts`. */
export const SUPPORTED_URI_SCHEMES = ['ss', 'ssr', 'vmess', 'trojan', 'vless'] as const;
export type SupportedUriScheme = (typeof SUPPORTED_URI_SCHEMES)[number];

// ---------------------------------------------------------------------------
// Result types (ARCHITECTURE §7.1.9 - §7.1.12)
// ---------------------------------------------------------------------------

/**
 * A single URI/node parse result. Parsers never throw; `uri/index.ts` catches
 * unexpected exceptions and converts them to `E_NODE_LINE`.
 */
export type UriParseResult =
  | { ok: true; node: ProxyNode }
  | { ok: false; code: string; message: string };

export type InputKind = 'base64' | 'plain-links' | 'clash-yaml' | 'unsupported';

/** Why `detectInput` classified a payload as unsupported. */
export type InputRejectReason = 'nul' | 'empty' | 'not-base64' | 'binary' | 'nested-base64' | 'unknown';

export interface DetectedInput {
  kind: InputKind;
  /** Decoded text when `kind === 'base64'` and decoding produced valid UTF-8. */
  decoded?: string;
  /**
   * Classification of `decoded` (one base64 layer deep). Not part of the
   * minimal architecture contract, but it lets callers avoid decoding twice.
   */
  innerKind?: InputKind;
  reason?: InputRejectReason;
  /** Why `decoded` was classified as unsupported, when applicable. */
  innerReason?: InputRejectReason;
}

/** Per-source statistics returned by `parseSubscriptionText`. */
export interface ParseNodeStats {
  /** Non-empty, non-comment lines (or proxies entries for Clash input). */
  lines: number;
  accepted: number;
  dropped: number;
}

export interface ParseNodesResult {
  nodes: ProxyNode[];
  warnings: Warning[];
  stats: ParseNodeStats;
}

/** Convenience re-export so tests can build warnings without importing types. */
export type LinkWarning = Warning;
