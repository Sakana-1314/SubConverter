/**
 * Subscription input classification (SPEC §3.1).
 *
 * Order matters: a payload that already looks like Clash YAML or a plain URI
 * list is never passed through a decoder (tindy's unconditional "loose base64"
 * step is intentionally not reproduced).
 *
 * Sources:
 * - docs/ARCHITECTURE.md §7.1.9 (detect.ts contract)
 * - docs/SPEC.md §3.1 (detection pipeline), §2.5 (base64 strictness)
 */

import { decodeBase64Text, isProbablyBase64 } from './base64';
import type { DetectedInput, InputKind, InputRejectReason } from './contracts';
import { hasNul, stripBom } from './text';

const CLASH_KEY_RE = /^[ \t]*(?:proxies|Proxy)[ \t]*:/m;
const LINK_SCHEME_RE = /\b(?:ss|ssr|vmess|trojan|vless):\/\//i;

function isPrintableEnough(text: string): boolean {
  if (text === '') return false;
  let total = 0;
  let printable = 0;
  for (const ch of text) {
    total++;
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      printable++;
    } else if (cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f)) {
      printable++;
    }
  }
  return total > 0 && printable / total >= 0.9;
}

function classifyPlain(text: string): InputKind | null {
  if (CLASH_KEY_RE.test(text)) return 'clash-yaml';
  if (LINK_SCHEME_RE.test(text)) return 'plain-links';
  return null;
}

function detectInternal(text: string, depth: number, allowBase64: boolean): DetectedInput {
  if (hasNul(text)) return { kind: 'unsupported', reason: 'nul' };
  if (text.trim() === '') return { kind: 'unsupported', reason: 'empty' };

  const plain = classifyPlain(text);
  if (plain !== null) return { kind: plain };

  if (!allowBase64) {
    return { kind: 'unsupported', reason: isProbablyBase64(text.trim()) ? 'nested-base64' : 'unknown' };
  }

  const candidate = text.trim();
  if (!isProbablyBase64(candidate)) return { kind: 'unsupported', reason: 'not-base64' };

  const decoded = decodeBase64Text(candidate);
  if (!decoded.ok) {
    return { kind: 'unsupported', reason: decoded.reason === 'utf8' ? 'binary' : 'not-base64' };
  }
  if (!isPrintableEnough(decoded.text)) {
    return { kind: 'unsupported', reason: 'binary' };
  }

  // At most one base64 layer (SPEC §3.1). The inner payload is classified but
  // never decoded again, so a double-encoded body is reported as unsupported.
  const inner = detectInternal(decoded.text, depth + 1, false);
  return {
    kind: 'base64',
    decoded: decoded.text,
    innerKind: inner.kind,
    ...(inner.kind === 'unsupported' && inner.reason !== undefined ? { innerReason: inner.reason } : {}),
  };
}

/**
 * Detailed classification used inside the links module (adds `innerKind` and
 * rejection reasons). The public `detectInput` below exposes only the
 * ARCHITECTURE §7.1.9 shape.
 */
export function detectInputDetailed(text: string): DetectedInput {
  if (typeof text !== 'string') return { kind: 'unsupported', reason: 'empty' };
  return detectInternal(stripBom(text), 0, true);
}

/** Classify a subscription body. Does not throw on malformed input. */
export function detectInput(text: string): { kind: InputKind; decoded?: string } {
  const detected = detectInputDetailed(text);
  return detected.decoded !== undefined
    ? { kind: detected.kind, decoded: detected.decoded }
    : { kind: detected.kind };
}

/** Human-readable reason used by the subscription warning. */
export function describeRejectReason(reason: InputRejectReason | undefined): string {
  switch (reason) {
    case 'nul':
      return 'input contains a NUL character';
    case 'empty':
      return 'input is empty';
    case 'binary':
      return 'base64 payload is not valid UTF-8 text';
    case 'nested-base64':
      return 'nested base64 is not supported (only one layer)';
    case 'not-base64':
      return 'input is neither Clash YAML, a URI list nor base64 text';
    default:
      return 'input format is not supported';
  }
}
