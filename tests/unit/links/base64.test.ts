import { describe, expect, it } from 'vitest';
import {
  decodeBase64Strict,
  decodeBase64Text,
  encodeBase64,
  encodeBase64Url,
  isProbablyBase64,
  isValidUtf8,
} from '../../../src/links/base64';

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('decodeBase64Strict', () => {
  it('decodes standard base64 with padding', () => {
    const result = decodeBase64Strict('aGVsbG8=');
    expect(result.ok).toBe(true);
    if (result.ok) expect(new TextDecoder().decode(result.bytes)).toBe('hello');
  });

  it('accepts URL-safe characters', () => {
    // bytes 0xfb 0xff -> standard "+/8=", url-safe "-_8"
    const standard = decodeBase64Strict('+/8=');
    const urlSafe = decodeBase64Strict('-_8');
    expect(standard.ok).toBe(true);
    expect(urlSafe.ok).toBe(true);
    if (standard.ok && urlSafe.ok) {
      expect([...standard.bytes]).toEqual([0xfb, 0xff]);
      expect([...urlSafe.bytes]).toEqual([0xfb, 0xff]);
    }
  });

  it('supports missing padding', () => {
    expect(decodeBase64Strict('aGVsbG8').ok).toBe(true);
    expect(decodeBase64Strict('YQ').ok).toBe(true);
  });

  it('decodes an empty string to zero bytes', () => {
    const result = decodeBase64Strict('');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.length).toBe(0);
  });

  it('rejects characters outside the alphabet (no loose copying)', () => {
    expect(decodeBase64Strict('aGVs bG8=')).toEqual({ ok: false, reason: 'charset' });
    expect(decodeBase64Strict('aGVsbG8=\n')).toEqual({ ok: false, reason: 'charset' });
    expect(decodeBase64Strict('aGVsbG8$')).toEqual({ ok: false, reason: 'charset' });
  });

  it('rejects impossible lengths', () => {
    expect(decodeBase64Strict('abcde')).toEqual({ ok: false, reason: 'length' });
    expect(decodeBase64Strict('a')).toEqual({ ok: false, reason: 'length' });
  });

  it('rejects malformed padding', () => {
    expect(decodeBase64Strict('YQ=')).toEqual({ ok: false, reason: 'padding' });
    expect(decodeBase64Strict('YQ===')).toEqual({ ok: false, reason: 'padding' });
    expect(decodeBase64Strict('YQ==YQ==')).toEqual({ ok: false, reason: 'padding' });
    expect(decodeBase64Strict('YWJj=')).toEqual({ ok: false, reason: 'padding' });
  });
});

describe('decodeBase64Text', () => {
  it('round-trips UTF-8 text', () => {
    for (const value of ['hello', '中文 😀', 'line1\nline2', 'a=b+c/d']) {
      const encoded = encodeBase64(value);
      const decoded = decodeBase64Text(encoded);
      expect(decoded).toEqual({ ok: true, text: value });
    }
  });

  it('reports invalid UTF-8', () => {
    expect(decodeBase64Text('/w==')).toEqual({ ok: false, reason: 'utf8' });
  });

  it('propagates charset and padding failures', () => {
    expect(decodeBase64Text('***')).toEqual({ ok: false, reason: 'charset' });
    expect(decodeBase64Text('a')).toEqual({ ok: false, reason: 'length' });
  });
});

describe('encoding', () => {
  it('encodeBase64Url emits URL-safe, unpadded output', () => {
    const encoded = encodeBase64Url('ss://中文.example:443#节点');
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeBase64Text(encoded)).toEqual({ ok: true, text: 'ss://中文.example:443#节点' });
  });

  it('encodeBase64 emits standard padded output', () => {
    expect(encodeBase64('hello')).toBe('aGVsbG8=');
    expect(encodeBase64('a')).toBe('YQ==');
  });
});

describe('isProbablyBase64', () => {
  it('rejects plain URIs and plain words that cannot be base64', () => {
    expect(isProbablyBase64('ss://aes-256-gcm:pass@1.2.3.4:8388#n')).toBe(false);
    expect(isProbablyBase64('example.com')).toBe(false);
    expect(isProbablyBase64('hello')).toBe(false); // length % 4 == 1
    expect(isProbablyBase64('')).toBe(false);
  });

  it('accepts real base64 payloads', () => {
    expect(isProbablyBase64(encodeBase64Url('ss://aes-256-gcm:pass@1.2.3.4:8388'))).toBe(true);
    expect(isProbablyBase64(encodeBase64('hello world'))).toBe(true);
  });
});

describe('isValidUtf8', () => {
  it('distinguishes valid and invalid byte sequences', () => {
    expect(isValidUtf8(bytesOf('中文'))).toBe(true);
    expect(isValidUtf8(new Uint8Array([0xff, 0xfe]))).toBe(false);
  });
});
