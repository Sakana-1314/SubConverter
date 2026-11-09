/**
 * Safe YAML parsing wrapper.
 *
 * One parser configuration is shared by Clash input, ruleset YAML and
 * templates: core schema, no merge keys, alias limits, unique keys, no custom
 * tags and a byte cap. Multi-document streams and custom tags are rejected.
 *
 * Sources:
 * - docs/ARCHITECTURE.md §7.1.8 (yaml.ts contract)
 * - docs/SPEC.md §3.3 (Clash YAML), §7.1 (templates), §9.4 (limits)
 */

import { parseAllDocuments } from 'yaml';

export type YamlErrorCode = 'E_YAML_PARSE' | 'E_YAML_MULTI_DOC' | 'E_YAML_TAG';

export type YamlParseResult =
  | { ok: true; value: unknown }
  | { ok: false; code: YamlErrorCode; message: string };

/**
 * Parse exactly one YAML document.
 *
 * `maxBytes` is a cheap pre-check on the UTF-8 size; the caller is still
 * responsible for enforcing the per-source byte budget while downloading.
 *
 * Custom-tag detection intentionally relies on the parser's "Unresolved tag"
 * warning instead of walking the whole AST: the previous traversal allocated a
 * Set entry for every AST node and roughly doubled peak memory on large Clash
 * subscriptions (review finding #2).
 */
export function parseYamlSingle(text: string, maxBytes: number): YamlParseResult {
  if (typeof text !== 'string') {
    return { ok: false, code: 'E_YAML_PARSE', message: 'YAML input is not a string' };
  }
  const byteLength = new TextEncoder().encode(text).length;
  if (maxBytes >= 0 && byteLength > maxBytes) {
    return { ok: false, code: 'E_YAML_PARSE', message: 'YAML input exceeds the byte limit' };
  }

  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(text, {
      schema: 'core',
      merge: false,
      uniqueKeys: true,
      customTags: [],
    });
  } catch {
    return { ok: false, code: 'E_YAML_PARSE', message: 'YAML could not be parsed' };
  }

  if (docs.length > 1) {
    return { ok: false, code: 'E_YAML_MULTI_DOC', message: 'multiple YAML documents are not accepted' };
  }
  if (docs.length === 0) {
    return { ok: true, value: null };
  }

  const doc = docs[0];

  for (const warning of doc.warnings) {
    if (typeof warning.message === 'string' && warning.message.includes('Unresolved tag')) {
      return { ok: false, code: 'E_YAML_TAG', message: 'unresolved YAML tag' };
    }
  }
  if (doc.errors.length > 0) {
    return { ok: false, code: 'E_YAML_PARSE', message: 'YAML contains syntax errors' };
  }

  try {
    return { ok: true, value: doc.toJS({ maxAliasCount: 50, mapAsMap: false }) };
  } catch {
    return { ok: false, code: 'E_YAML_PARSE', message: 'YAML alias expansion was rejected' };
  }
}
