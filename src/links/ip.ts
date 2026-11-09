/**
 * Pure-TypeScript IP address / CIDR helpers.
 *
 * Used by the SSRF guard (`url-guard.ts`) and by rule payload validation.
 * `node:net` is intentionally not used: workerd exposes `isIP`, but a pure
 * implementation is portable and unit-testable in Node.
 *
 * Sources:
 * - docs/ARCHITECTURE.md §7.1.4 (ip.ts contract)
 * - docs/SPEC.md §9.2 (private/reserved ranges)
 */

export type IpAddress =
  | { version: 4; bytes: [number, number, number, number] }
  | { version: 6; bytes: Uint8Array };

function parseIpv4Bytes(input: string): number[] | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // Reject ambiguous leading zeros (0177 is octal for Node's URL parser).
    if (part.length > 1 && part[0] === '0') return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    out.push(value);
  }
  return out;
}

function parseIpv6Bytes(input: string): Uint8Array | null {
  if (input.includes('%')) return null; // zone identifiers are not accepted
  if (input.length === 0) return null;

  const firstDouble = input.indexOf('::');
  if (firstDouble >= 0 && input.indexOf('::', firstDouble + 2) >= 0) return null;

  let head: string[];
  let tail: string[];
  if (firstDouble >= 0) {
    const left = input.slice(0, firstDouble);
    const right = input.slice(firstDouble + 2);
    head = left === '' ? [] : left.split(':');
    tail = right === '' ? [] : right.split(':');
  } else {
    head = input.split(':');
    tail = [];
  }

  if (head.some((part) => part === '') || tail.some((part) => part === '')) return null;

  const groups: number[] = [];
  const combined = [...head, ...tail];
  for (let i = 0; i < combined.length; i++) {
    const part = combined[i];
    if (part.includes('.')) {
      // Embedded IPv4 is only valid as the final component.
      if (i !== combined.length - 1) return null;
      const v4 = parseIpv4Bytes(part);
      if (!v4) return null;
      groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }

  const hasDouble = firstDouble >= 0;
  if (hasDouble ? groups.length >= 8 : groups.length !== 8) return null;

  const full = new Array<number>(8).fill(0);
  if (hasDouble) {
    for (let i = 0; i < head.length; i++) full[i] = groups[i];
    const tailGroups = groups.slice(head.length);
    for (let i = 0; i < tailGroups.length; i++) {
      full[8 - tailGroups.length + i] = tailGroups[i];
    }
  } else {
    for (let i = 0; i < 8; i++) full[i] = groups[i];
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (full[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = full[i] & 0xff;
  }
  return bytes;
}

function stripBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

/** Parse an IPv4/IPv6 literal. Brackets around IPv6 are accepted. */
export function parseIpLiteral(host: string): IpAddress | null {
  if (typeof host !== 'string') return null;
  const value = stripBrackets(host.trim());
  if (value === '') return null;

  if (value.includes(':')) {
    const bytes = parseIpv6Bytes(value);
    return bytes ? { version: 6, bytes } : null;
  }

  const v4 = parseIpv4Bytes(value);
  if (!v4) return null;
  return { version: 4, bytes: [v4[0], v4[1], v4[2], v4[3]] };
}

/** Serialize an IP address in a stable, lowercase canonical form. */
export function formatIp(ip: IpAddress): string {
  if (ip.version === 4) return ip.bytes.join('.');
  const bytes = ip.bytes;
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);

  // RFC 5952: compress the longest run (>= 2) of zero groups, first on tie.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }

  const toHex = (n: number): string => n.toString(16);
  if (bestStart < 0) return groups.map(toHex).join(':');
  const left = groups.slice(0, bestStart).map(toHex).join(':');
  const right = groups.slice(bestStart + bestLen).map(toHex).join(':');
  return `${left}::${right}`;
}

function bytePrefixEqual(a: Uint8Array, b: Uint8Array, prefix: number): boolean {
  const whole = Math.floor(prefix / 8);
  for (let i = 0; i < whole; i++) {
    if (a[i] !== b[i]) return false;
  }
  const rest = prefix % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (a[whole] & mask) === (b[whole] & mask);
}

function ipBytes(ip: IpAddress): Uint8Array {
  return ip.version === 4 ? Uint8Array.from(ip.bytes) : ip.bytes;
}

/**
 * Parse `addr/prefix`. Host bits are preserved (canonical form only lowercases
 * Prefix text and `canonical` are normalized; the canonical address has host
 * bits masked off (e.g. `1.2.3.4/24` -> `1.2.3.0/24`), matching the rules
 * module's CIDR normalization.
 */
export function parseCidr(s: string): { ip: IpAddress; prefix: number; canonical: string } | null {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || trimmed.indexOf('/', slash + 1) >= 0) return null;
  const addr = trimmed.slice(0, slash);
  const prefixText = trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const ip = parseIpLiteral(addr);
  if (!ip) return null;
  const prefix = Number(prefixText);
  const max = ip.version === 4 ? 32 : 128;
  if (prefix < 0 || prefix > max) return null;

  const source = ipBytes(ip);
  const masked = new Uint8Array(source.length);
  const whole = Math.floor(prefix / 8);
  const restBits = prefix % 8;
  masked.set(source.subarray(0, whole));
  if (restBits > 0 && whole < source.length) {
    const mask = (0xff << (8 - restBits)) & 0xff;
    masked[whole] = source[whole] & mask;
  }

  const canonicalIp: IpAddress =
    ip.version === 4
      ? { version: 4, bytes: [masked[0], masked[1], masked[2], masked[3]] }
      : { version: 6, bytes: masked };
  return { ip, prefix, canonical: `${formatIp(canonicalIp)}/${prefix}` };
}

/** True when `ip` is inside `cidr` (same address family). */
export function isIpInCidr(ip: IpAddress, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed || parsed.ip.version !== ip.version) return false;
  return bytePrefixEqual(ipBytes(ip), ipBytes(parsed.ip), parsed.prefix);
}

// SPEC §9.2 step 6: exact reject lists.
const REJECT_V4: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, 0, 0, 0, 8],
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 0, 0, 0, 24],
  [192, 0, 2, 0, 24],
  [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15],
  [198, 51, 100, 0, 24],
  [203, 0, 113, 0, 24],
  [224, 0, 0, 0, 4],
  [240, 0, 0, 0, 4],
  [255, 255, 255, 255, 32],
];

const REJECT_V6: ReadonlyArray<string> = [
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '100::/64',
  '2001:2::/48',
  '2001:10::/28',
  '2001:db8::/32',
  '2002::/16',
  'fc00::/7',
  'fe80::/10',
  'fec0::/10',
  'ff00::/8',
];

/**
 * SPEC §9.2 step 6: true only for globally routable addresses.
 * IPv4-mapped IPv6 (`::ffff:0:0/96`) is rejected outright (the reject list
 * contains the whole /96), which is the fail-closed choice.
 */
export function isPublicIp(ip: IpAddress): boolean {
  if (ip.version === 4) {
    const [a, b, c, d] = ip.bytes;
    for (const [ra, rb, rc, rd, prefix] of REJECT_V4) {
      const match =
        prefix === 32
          ? a === ra && b === rb && c === rc && d === rd
          : prefix === 24
            ? a === ra && b === rb && c === rc
            : prefix === 16
              ? a === ra && b === rb
              : prefix === 15
                ? a === ra && (b & 0xfe) === rb
                : prefix === 12
                  ? a === ra && (b & 0xf0) === rb
                  : prefix === 10
                    ? a === ra && (b & 0xc0) === rb
                    : prefix === 8
                      ? a === ra
                      : prefix === 4
                        ? (a & 0xf0) === ra
                        : false;
      if (match) return false;
    }
    return true;
  }

  for (const cidr of REJECT_V6) {
    const parsed = parseCidr(cidr);
    if (parsed && bytePrefixEqual(ip.bytes, parsed.ip.bytes as Uint8Array, parsed.prefix)) return false;
  }
  return true;
}
