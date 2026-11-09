/**
 * YAML serialization and read-back for the emitter.
 *
 * SPEC §7.6: `yaml` 2.9.x, `lineWidth: 0`, `indent: 2`, `sortMapEntries: false`,
 * rules emitted as double-quoted scalars, file ends with exactly one `\n`.
 * SPEC §6.3: the generated document must be parsed back with the same library
 * using `schema: 'core'` and `maxAliasCount: 50`.
 */

import { parseAllDocuments, stringify } from 'yaml';

/** Fatal emitter conditions. Integration maps these to HTTP 500 / 400. */
export type EmitterErrorCode =
  | 'E_EMIT_INVALID'
  | 'E_OUTPUT_TOO_LARGE'
  | 'invalid_template'
  | 'invalid_config';

export class EmitterError extends Error {
  readonly code: EmitterErrorCode;

  constructor(code: EmitterErrorCode, message: string) {
    super(message);
    this.name = 'EmitterError';
    this.code = code;
  }
}

export function isEmitterError(value: unknown): value is EmitterError {
  return value instanceof EmitterError;
}

/** Plain data object (not array/null/class instance). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Keys that must never be copied from untrusted YAML into a live object. */
const UNSAFE_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isUnsafeMapKey(key: string): boolean {
  return UNSAFE_MAP_KEYS.has(key);
}

export interface StringifyOptions {
  /**
   * Optional single-line header comment (without the leading `#`). Newlines
   * and control characters are stripped so callers cannot inject YAML.
   */
  header?: string;
}

/**
 * Serialize a top-level config map. Undefined object properties are skipped by
 * `yaml`; callers should still avoid building them (the emitter only emits
 * defined values).
 */
export function stringifyConfig(
  doc: Record<string, unknown>,
  options: StringifyOptions = {},
): string {
  if (!isPlainObject(doc)) {
    throw new EmitterError('E_EMIT_INVALID', 'config document must be a plain object');
  }

  const body = stringify(doc, {
    indent: 2,
    lineWidth: 0,
    sortMapEntries: false,
    aliasDuplicateObjects: false,
  });

  // `stringify` terminates arrays/maps with a single newline; normalize anyway
  // so the contract (exactly one trailing `\n`) is explicit.
  const normalizedBody = `${body.replace(/\n+$/, '')}\n`;

  if (!options.header) return normalizedBody;

  const header = options.header
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (header === '') return normalizedBody;
  return `# ${header}\n${normalizedBody}`;
}

export type ParseForReadbackResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/**
 * Parse generated YAML back into a JS value. Rejects empty output, multi-doc
 * output, YAML parse errors and unresolved custom tags (SPEC §7.1/§7.6).
 */
export function parseForReadback(text: string): ParseForReadbackResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, message: 'output is empty' };
  }

  let docs;
  try {
    docs = parseAllDocuments(text, {
      schema: 'core',
      merge: false,
      uniqueKeys: true,
      customTags: [],
    });
  } catch (error) {
    return { ok: false, message: `YAML parse error: ${errorMessage(error)}` };
  }

  if (docs.length !== 1) {
    return { ok: false, message: `expected exactly one YAML document, got ${docs.length}` };
  }

  const doc = docs[0];
  if (doc === undefined) return { ok: false, message: 'no YAML document' };
  if (doc.errors.length > 0) {
    return { ok: false, message: `YAML errors: ${doc.errors[0]?.message ?? 'unknown'}` };
  }
  const customTag = doc.warnings.find((warning) => /Unresolved tag/i.test(warning.message));
  if (customTag) {
    return { ok: false, message: `custom YAML tag is not allowed: ${customTag.message}` };
  }

  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 50 });
  } catch (error) {
    return { ok: false, message: `YAML read-back failed: ${errorMessage(error)}` };
  }
  return { ok: true, value };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** UTF-8 byte length, used for `bytesOut`. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
