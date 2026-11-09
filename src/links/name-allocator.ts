/**
 * Node-name allocation (SPEC §3.5).
 *
 * Group names are allocated before node names, so `reserved` must contain the
 * final group names plus `DIRECT`/`REJECT`/`REJECT-DROP`/`PASS`. Comparison is
 * case-insensitive and appends `" 2"`, `" 3"`, ... in encounter order.
 */

import type { ProxyNode, Warning } from './contracts';
import { MAX_NODE_NAME_LENGTH } from './contracts';
import { makeWarning, stripControlChars, truncateForWarning } from './text';

function truncateCodePoints(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

function fitWithSuffix(base: string, suffix: string, max: number): string {
  const suffixChars = Array.from(suffix);
  const room = Math.max(0, max - suffixChars.length);
  const head = Array.from(base).slice(0, room).join('').trimEnd();
  return `${head}${suffix}`;
}

function pushWarning(
  warnings: Warning[],
  code: string,
  message: string,
  raw: string,
): void {
  warnings.push(
    makeWarning(code, message, {
      raw: truncateForWarning(raw, 160),
    }),
  );
}

/**
 * Assign unique, sanitized names in place.
 *
 * Rules:
 * - control characters removed, surrounding whitespace trimmed;
 * - empty result becomes `server:port` (`W_NODE_NAME_EMPTY`);
 * - names longer than 128 code points are truncated (`W_NODE_NAME_TRUNCATED`);
 * - collisions with reserved/previous names get `" 2"`, `" 3"`, ...
 *   (`W_NODE_NAME_RESERVED` for reserved names, `W_NODE_NAME_DUPLICATE` otherwise).
 */
export function allocateNames(
  nodes: ProxyNode[],
  reserved: Set<string>,
  warnings: Warning[],
): void {
  const reservedLower = new Set<string>();
  for (const name of reserved) reservedLower.add(name.toLowerCase());

  const used = new Set<string>(reservedLower);

  for (const node of nodes) {
    const original = typeof node.name === 'string' ? node.name : '';
    let name = stripControlChars(original).trim();

    if (name === '') {
      name = `${node.server}:${node.port}`;
      pushWarning(warnings, 'W_NODE_NAME_EMPTY', 'node name is empty; using server:port', name);
    }

    const truncated = truncateCodePoints(name, MAX_NODE_NAME_LENGTH);
    if (truncated !== name) {
      pushWarning(
        warnings,
        'W_NODE_NAME_TRUNCATED',
        `node name exceeds ${MAX_NODE_NAME_LENGTH} characters`,
        original,
      );
      name = truncated;
    }

    const baseName = name;
    const baseKey = baseName.toLowerCase();
    let finalName = baseName;

    if (used.has(baseKey)) {
      const reservedCollision = reservedLower.has(baseKey);
      let counter = 2;
      do {
        finalName = fitWithSuffix(baseName, ` ${counter}`, MAX_NODE_NAME_LENGTH);
        counter++;
      } while (used.has(finalName.toLowerCase()));

      if (reservedCollision) {
        pushWarning(
          warnings,
          'W_NODE_NAME_RESERVED',
          'node name conflicts with a reserved/group name; suffix added',
          baseName,
        );
      } else {
        pushWarning(
          warnings,
          'W_NODE_NAME_DUPLICATE',
          'duplicate node name; suffix added',
          baseName,
        );
      }
    }

    used.add(finalName.toLowerCase());
    node.name = finalName;
  }
}
