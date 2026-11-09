/**
 * Node filters, renames, source-group tagging and sorting (SPEC §3.6).
 *
 * Filter/rename regexes are user input: invalid or unsafe patterns throw
 * `InvalidRegexError` (`.code === 'invalid_regex'`) so the integration layer can
 * return HTTP 400 instead of silently changing behavior (AC-26).
 */

import type { ProxyNode, Warning } from './contracts';
import { InvalidRegexError, compileUserRegex } from './protocols';

export interface RenameRule {
  pattern: string;
  replacement: string;
}

function compileOrThrow(pattern: string, context: string, global = false): RegExp {
  const compiled = compileUserRegex(pattern, context, { global });
  if (!compiled.ok) {
    throw new InvalidRegexError(compiled.reason);
  }
  return compiled.regex;
}

/**
 * Apply `include` then `exclude` to the original node names.
 * Multiple include/exclude patterns are OR-ed; names are matched case-sensitively.
 */
export function applyFilters(
  nodes: ProxyNode[],
  include: string[],
  exclude: string[],
  warnings: Warning[],
): ProxyNode[] {
  void warnings;
  const includeRegexes = include.map((pattern, index) =>
    compileOrThrow(pattern, `include[${index}]`),
  );
  const excludeRegexes = exclude.map((pattern, index) =>
    compileOrThrow(pattern, `exclude[${index}]`),
  );

  return nodes.filter((node) => {
    if (includeRegexes.length > 0 && !includeRegexes.some((regex) => regex.test(node.name))) {
      return false;
    }
    if (excludeRegexes.some((regex) => regex.test(node.name))) return false;
    return true;
  });
}

/** Apply rename rules in order; every rule is a global replacement. */
export function applyRenames(
  nodes: ProxyNode[],
  renames: RenameRule[],
  warnings: Warning[],
): ProxyNode[] {
  void warnings;
  const compiled = renames.map((rule, index) => ({
    regex: compileOrThrow(rule.pattern, `rename[${index}]`, true),
    replacement: rule.replacement,
  }));

  for (const node of nodes) {
    for (const rule of compiled) {
      node.name = node.name.replace(rule.regex, rule.replacement);
    }
  }
  return nodes;
}

/** Override `sourceGroup` on every node (`group` query parameter). */
export function applySourceGroup(nodes: ProxyNode[], group?: string): void {
  if (group === undefined || group === '') return;
  for (const node of nodes) node.sourceGroup = group;
}

/** Stable sort by final name using UTF-16 code-unit order (SPEC §3.6 step 6). */
export function sortNodes(nodes: ProxyNode[]): ProxyNode[] {
  return [...nodes].sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
}
