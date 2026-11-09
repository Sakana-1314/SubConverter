/**
 * Subscription body parser.
 *
 * Detects the input format, then either delegates to Clash YAML mapping or
 * parses each URI line independently. One bad line only drops that line; the
 * rest of the subscription continues (SPEC §3.1, §3.2).
 *
 * Sources:
 * - docs/ARCHITECTURE.md §7.1.10 (subscription.ts contract)
 * - docs/SPEC.md §3.1 (detection), §3.2 (plain link list), §3.3 (Clash YAML)
 */

import type { ParseNodesResult, ProxyNode, Warning } from './contracts';
import { MAX_NODE_LINE_LENGTH, MAX_SOURCE_BYTES } from './contracts';
import { limitClashInput, parseClashNodes } from './clash-input';
import { describeRejectReason, detectInputDetailed } from './detect';
import { makeWarning, normalizeNewlines, redactUri, stripBom, hasNul } from './text';
import { parseUri } from './uri';
import { parseYamlSingle } from './yaml';

export type { ParseNodesResult } from './contracts';

export interface ParseSubscriptionOptions {
  /**
   * Safety budget applied before/while parsing. Integration passes a bounded
   * value so a huge Clash YAML or URI list cannot materialize more nodes than
   * the isolate can hold (SPEC §9.4 MAX_NODES).
   */
  maxNodes?: number;
}

function* iterateLines(text: string): Generator<{ line: string; lineNo: number }> {
  let start = 0;
  let lineNo = 1;
  for (;;) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      yield { line: text.slice(start), lineNo };
      return;
    }
    yield { line: text.slice(start, newline), lineNo };
    start = newline + 1;
    lineNo += 1;
  }
}

function emptyStats(): { lines: number; accepted: number; dropped: number } {
  return { lines: 0, accepted: 0, dropped: 0 };
}

function isComment(line: string): boolean {
  return line.startsWith('#') || line.startsWith(';') || line.startsWith('//');
}

function nodeLimitWarning(sourceId: string, maxNodes: number): Warning {
  return makeWarning(
    'W_NODE_LIMIT',
    `subscription exceeds ${maxNodes} nodes; extra entries were ignored`,
    { source: sourceId },
  );
}

function parsePlainLinks(
  text: string,
  sourceId: string,
  maxNodes = Number.POSITIVE_INFINITY,
): ParseNodesResult {
  const warnings: Warning[] = [];
  const nodes: ProxyNode[] = [];
  const maxLines = Number.isFinite(maxNodes) ? Math.max(0, maxNodes * 2) : Number.POSITIVE_INFINITY;
  let linesCount = 0;
  let dropped = 0;
  let limitWarned = false;
  const warnLimit = (): void => {
    if (limitWarned) return;
    limitWarned = true;
    warnings.push(nodeLimitWarning(sourceId, maxNodes));
  };

  for (const { line: rawLine, lineNo } of iterateLines(normalizeNewlines(text))) {
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;
    if (isComment(trimmed)) continue;
    if (linesCount >= maxLines || nodes.length >= maxNodes) {
      warnLimit();
      break;
    }
    linesCount++;

    if (trimmed.length > MAX_NODE_LINE_LENGTH) {
      warnings.push(
        makeWarning('E_NODE_LINE_TOO_LONG', `line exceeds ${MAX_NODE_LINE_LENGTH} characters`, {
          source: sourceId,
          line: lineNo,
          raw: redactUri(trimmed),
        }),
      );
      dropped++;
      continue;
    }

    let result;
    try {
      result = parseUri(trimmed);
    } catch {
      result = { ok: false as const, code: 'E_NODE_LINE', message: 'line could not be parsed' };
    }

    if (result.ok) {
      nodes.push(result.node);
    } else {
      warnings.push(
        makeWarning(result.code, result.message, {
          source: sourceId,
          line: lineNo,
          raw: redactUri(trimmed),
        }),
      );
      dropped++;
    }
  }

  return {
    nodes,
    warnings,
    stats: { lines: linesCount, accepted: nodes.length, dropped },
  };
}

function parseClashText(
  text: string,
  sourceId: string,
  maxNodes = Number.POSITIVE_INFINITY,
): ParseNodesResult {
  const limited = limitClashInput(text, maxNodes);
  const limitWarnings: Warning[] = limited.truncated
    ? [nodeLimitWarning(sourceId, maxNodes)]
    : [];
  if (limited.sectionsStripped === true) {
    limitWarnings.push(
      makeWarning(
        'W_CLASH_SECTION_IGNORED',
        'only the proxies section was parsed; other Clash sections were ignored',
        { source: sourceId },
      ),
    );
  }
  const parsed = parseYamlSingle(limited.text, MAX_SOURCE_BYTES);
  if (!parsed.ok) {
    return {
      nodes: [],
      warnings: [...limitWarnings, makeWarning(parsed.code, parsed.message, { source: sourceId })],
      stats: emptyStats(),
    };
  }
  const result = parseClashNodes(parsed.value, sourceId, maxNodes);
  return limitWarnings.length === 0
    ? result
    : { ...result, warnings: [...limitWarnings, ...result.warnings] };
}

/**
 * Parse one subscription body. Never throws for malformed content; callers get
 * nodes plus structured warnings.
 */
export function parseSubscriptionText(
  text: string,
  sourceId: string,
  options: ParseSubscriptionOptions = {},
): ParseNodesResult {
  const maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY;
  const clean = stripBom(text);

  if (hasNul(clean)) {
    return {
      nodes: [],
      warnings: [
        makeWarning('E_UNSUPPORTED_INPUT_FORMAT', 'input contains a NUL character', {
          source: sourceId,
        }),
      ],
      stats: emptyStats(),
    };
  }

  const detected = detectInputDetailed(clean);

  if (detected.kind === 'plain-links') {
    return parsePlainLinks(clean, sourceId, maxNodes);
  }
  if (detected.kind === 'clash-yaml') {
    return parseClashText(clean, sourceId, maxNodes);
  }

  if (detected.kind === 'base64' && detected.decoded !== undefined) {
    const detectedWarning = makeWarning(
      'W_INPUT_BASE64_DETECTED',
      'source was auto-detected as base64',
      { source: sourceId },
    );

    if (detected.innerKind === 'clash-yaml') {
      const inner = parseClashText(detected.decoded, sourceId, maxNodes);
      return { ...inner, warnings: [detectedWarning, ...inner.warnings] };
    }
    if (detected.innerKind === 'plain-links') {
      const inner = parsePlainLinks(detected.decoded, sourceId, maxNodes);
      return { ...inner, warnings: [detectedWarning, ...inner.warnings] };
    }

    return {
      nodes: [],
      warnings: [
        detectedWarning,
        makeWarning(
          'E_UNSUPPORTED_INPUT_FORMAT',
          `base64 content is not a supported subscription: ${describeRejectReason(detected.innerReason)}`,
          { source: sourceId },
        ),
      ],
      stats: emptyStats(),
    };
  }

  return {
    nodes: [],
    warnings: [
      makeWarning('E_UNSUPPORTED_INPUT_FORMAT', describeRejectReason(detected.reason), {
        source: sourceId,
      }),
    ],
    stats: emptyStats(),
  };
}
