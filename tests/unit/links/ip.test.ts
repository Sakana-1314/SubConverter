import { describe, expect, it } from 'vitest';
import {
  formatIp,
  isIpInCidr,
  isPublicIp,
  parseCidr,
  parseIpLiteral,
} from '../../../src/links/ip';

function ip(value: string) {
  const parsed = parseIpLiteral(value);
  if (!parsed) throw new Error(`expected IP literal: ${value}`);
  return parsed;
}

describe('parseIpLiteral', () => {
  it('parses IPv4', () => {
    expect(ip('1.2.3.4')).toEqual({ version: 4, bytes: [1, 2, 3, 4] });
    expect(ip('0.0.0.0')).toEqual({ version: 4, bytes: [0, 0, 0, 0] });
  });

  it('rejects invalid / ambiguous IPv4', () => {
    expect(parseIpLiteral('256.1.1.1')).toBeNull();
    expect(parseIpLiteral('1.2.3')).toBeNull();
    expect(parseIpLiteral('1.2.3.4.5')).toBeNull();
    expect(parseIpLiteral('0177.0.0.1')).toBeNull();
    expect(parseIpLiteral('1.2.3.-1')).toBeNull();
  });

  it('parses compressed IPv6 and brackets', () => {
    expect(formatIp(ip('2001:0db8:0000:0000:0000:ff00:0042:8329'))).toBe('2001:db8::ff00:42:8329');
    expect(formatIp(ip('[::1]'))).toBe('::1');
    expect(formatIp(ip('::'))).toBe('::');
    expect(formatIp(ip('fe80::1'))).toBe('fe80::1');
  });

  it('parses embedded IPv4 and IPv4-mapped addresses', () => {
    const mapped = ip('::ffff:127.0.0.1');
    expect(mapped.version).toBe(6);
    expect(formatIp(mapped)).toBe('::ffff:7f00:1');
    expect(formatIp(ip('::ffff:8.8.8.8'))).toBe('::ffff:808:808');
  });

  it('rejects malformed IPv6', () => {
    expect(parseIpLiteral('::gg')).toBeNull();
    expect(parseIpLiteral('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIpLiteral('1::2::3')).toBeNull();
    expect(parseIpLiteral(':::')).toBeNull();
    expect(parseIpLiteral('fe80::1%eth0')).toBeNull();
    expect(parseIpLiteral('example.com')).toBeNull();
  });
});

describe('parseCidr', () => {
  it('parses IPv4 and IPv6 CIDRs', () => {
    expect(parseCidr('1.2.3.0/24')?.canonical).toBe('1.2.3.0/24');
    expect(parseCidr('1.2.3.4/24')?.canonical).toBe('1.2.3.0/24');
    expect(parseCidr('2001:0db8::/32')?.canonical).toBe('2001:db8::/32');
    expect(parseCidr('0.0.0.0/0')?.prefix).toBe(0);
    expect(parseCidr('::/0')?.prefix).toBe(0);
  });

  it('rejects out-of-range or malformed prefixes', () => {
    expect(parseCidr('1.2.3.0/33')).toBeNull();
    expect(parseCidr('2001:db8::/129')).toBeNull();
    expect(parseCidr('1.2.3.0')).toBeNull();
    expect(parseCidr('1.2.3.0/')).toBeNull();
    expect(parseCidr('/24')).toBeNull();
    expect(parseCidr('1.2.3.0/24/8')).toBeNull();
  });
});

describe('isIpInCidr', () => {
  it('matches IPv4 ranges', () => {
    expect(isIpInCidr(ip('10.1.2.3'), '10.0.0.0/8')).toBe(true);
    expect(isIpInCidr(ip('11.1.2.3'), '10.0.0.0/8')).toBe(false);
    expect(isIpInCidr(ip('192.168.1.5'), '192.168.0.0/16')).toBe(true);
  });

  it('matches IPv6 ranges and rejects family mismatch', () => {
    expect(isIpInCidr(ip('2001:db8:1::1'), '2001:db8::/32')).toBe(true);
    expect(isIpInCidr(ip('2001:db9::1'), '2001:db8::/32')).toBe(false);
    expect(isIpInCidr(ip('1.2.3.4'), '::/0')).toBe(false);
  });
});

describe('isPublicIp', () => {
  it('rejects every IPv4 reject range from SPEC §9.2', () => {
    const blocked = [
      '0.1.2.3',
      '10.0.0.1',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
    ];
    for (const address of blocked) {
      expect(isPublicIp(ip(address)), address).toBe(false);
    }
  });

  it('accepts ordinary public IPv4', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '198.20.0.1']) {
      expect(isPublicIp(ip(address)), address).toBe(true);
    }
  });

  it('rejects every IPv6 reject range from SPEC §9.2', () => {
    const blocked = [
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:8.8.8.8',
      '64:ff9b::1',
      '100::1',
      '2001:2::1',
      '2001:10::1',
      '2001:1f::1',
      '2001:db8::1',
      '2002::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'fec0::1',
      'ff02::1',
    ];
    for (const address of blocked) {
      expect(isPublicIp(ip(address)), address).toBe(false);
    }
  });

  it('accepts ordinary public IPv6', () => {
    for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888', '2001:20::1']) {
      expect(isPublicIp(ip(address)), address).toBe(true);
    }
  });
});
