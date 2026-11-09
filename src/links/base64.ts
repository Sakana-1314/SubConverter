/**
 * Strict, UTF-8 safe base64 / base64url helpers.
 *
 * Cloudflare Workers has no `Buffer`, so encoding/decoding is implemented with
 * plain arithmetic plus `TextEncoder` / `TextDecoder`. The decoder deliberately
 * diverges from tindy's permissive decoder: unknown characters are rejected
 * instead of being copied through (docs/research/original-subconverter.md:327-339).
 *
 * Sources:
 * - docs/ARCHITECTURE.md §7.1.2 (base64.ts contract)
 * - docs/SPEC.md §3.1 (strict alphabet, optional padding, fatal UTF-8)
 */

export type Base64FailureReason = 'charset' | 'length' | 'padding';
export type Base64TextFailureReason = Base64FailureReason | 'utf8';

export type Base64DecodeResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: Base64FailureReason };

export type Base64TextResult =
  | { ok: true; text: string }
  | { ok: false; reason: Base64TextFailureReason };

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const DECODE_TABLE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
  DECODE_TABLE[ALPHABET.charCodeAt(i)] = i;
}
// URL-safe alphabet shares indices with '+' and '/'.
DECODE_TABLE['-'.charCodeAt(0)] = 62;
DECODE_TABLE['_'.charCodeAt(0)] = 63;

function decodeChar(code: number): number {
  if (code < 0 || code > 127) return -1;
  return DECODE_TABLE[code];
}

/** Decode base64/base64url with strict charset and padding validation. */
export function decodeBase64Strict(input: string): Base64DecodeResult {
  if (typeof input !== 'string') return { ok: false, reason: 'charset' };

  let padCount = 0;
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 0x3d /* '=' */) {
    padCount++;
    end--;
  }
  if (padCount > 2) return { ok: false, reason: 'padding' };
  const body = input.slice(0, end);

  // Charset errors take precedence over padding-shape errors (a trailing
  // newline must be reported as whitespace, not as "bad padding").
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 0x3d) continue;
    if (decodeChar(code) < 0) return { ok: false, reason: 'charset' };
  }

  const values = new Int16Array(body.length);
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code === 0x3d) return { ok: false, reason: 'padding' }; // '=' before the end
    values[i] = decodeChar(code);
  }

  const remainder = body.length % 4;
  if (remainder === 1) return { ok: false, reason: 'length' };

  const expectedPadding = remainder === 0 ? 0 : 4 - remainder;
  if (padCount !== 0 && padCount !== expectedPadding) {
    return { ok: false, reason: 'padding' };
  }

  const byteLength = Math.floor(body.length / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
  const bytes = new Uint8Array(byteLength);
  let out = 0;
  let i = 0;
  for (; i + 4 <= body.length; i += 4) {
    const chunk =
      (values[i] << 18) | (values[i + 1] << 12) | (values[i + 2] << 6) | values[i + 3];
    bytes[out++] = (chunk >> 16) & 0xff;
    bytes[out++] = (chunk >> 8) & 0xff;
    bytes[out++] = chunk & 0xff;
  }
  const rest = body.length - i;
  if (rest === 2) {
    bytes[out++] = ((values[i] << 2) | (values[i + 1] >> 4)) & 0xff;
  } else if (rest === 3) {
    bytes[out++] = ((values[i] << 2) | (values[i + 1] >> 4)) & 0xff;
    bytes[out++] = ((values[i + 1] << 4) | (values[i + 2] >> 2)) & 0xff;
  }
  return { ok: true, bytes };
}

/**
 * Decode base64/base64url and require the bytes to be valid UTF-8.
 * Used for URI payloads and subscription bodies (SPEC §3.1).
 */
export function decodeBase64Text(input: string): Base64TextResult {
  const result = decodeBase64Strict(input);
  if (!result.ok) return result;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(result.bytes);
    return { ok: true, text };
  } catch {
    return { ok: false, reason: 'utf8' };
  }
}

function bytesToBase64(bytes: Uint8Array, urlSafe: boolean, pad: boolean): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(chunk >> 18) & 63];
    out += ALPHABET[(chunk >> 12) & 63];
    out += ALPHABET[(chunk >> 6) & 63];
    out += ALPHABET[chunk & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const chunk = bytes[i] << 16;
    out += ALPHABET[(chunk >> 18) & 63];
    out += ALPHABET[(chunk >> 12) & 63];
    if (pad) out += '==';
  } else if (rest === 2) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[(chunk >> 18) & 63];
    out += ALPHABET[(chunk >> 12) & 63];
    out += ALPHABET[(chunk >> 6) & 63];
    if (pad) out += '=';
  }
  if (urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_');
  return out;
}

/** Standard base64 with `=` padding, UTF-8 aware. */
export function encodeBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text), false, true);
}

/** URL-safe base64 without padding, UTF-8 aware. */
export function encodeBase64Url(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text), true, false);
}

/**
 * Cheap heuristic used before attempting a strict decode. It only checks the
 * alphabet/length/padding shape; `detect.ts` still validates UTF-8 and the
 * printable ratio after decoding.
 */
export function isProbablyBase64(input: string): boolean {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (trimmed.length < 4) return false;
  let end = trimmed.length;
  let pad = 0;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 0x3d) {
    end--;
    pad++;
  }
  if (pad > 2) return false;
  const bodyLength = end;
  if (bodyLength === 0 || bodyLength % 4 === 1) return false;
  const expected = bodyLength % 4 === 0 ? 0 : 4 - (bodyLength % 4);
  if (pad !== 0 && pad !== expected) return false;
  for (let i = 0; i < bodyLength; i++) {
    const value = decodeChar(trimmed.charCodeAt(i));
    if (value < 0) return false;
  }
  return true;
}

/** True when `bytes` are a valid UTF-8 sequence (fatal decoder). */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
