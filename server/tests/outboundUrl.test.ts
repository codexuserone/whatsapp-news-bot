import { describe, expect, it } from '@jest/globals';

const { assertSafeOutboundUrl, isPrivateOrReservedIp } = require('../src/utils/outboundUrl');

describe('outbound URL safety', () => {
  it('blocks IPv4-mapped IPv6 loopback literals', async () => {
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    await expect(assertSafeOutboundUrl('http://[::ffff:127.0.0.1]/feed')).rejects.toThrow(
      /private or reserved/i
    );
  });

  it('blocks hexadecimal IPv4-mapped IPv6 loopback literals', async () => {
    expect(isPrivateOrReservedIp('::ffff:7f00:1')).toBe(true);
    await expect(assertSafeOutboundUrl('http://[::ffff:7f00:1]/feed')).rejects.toThrow(
      /private or reserved/i
    );
  });

  it('blocks IPv4-mapped IPv6 metadata service literals', async () => {
    expect(isPrivateOrReservedIp('::ffff:169.254.169.254')).toBe(true);
    await expect(assertSafeOutboundUrl('http://[::ffff:169.254.169.254]/latest/meta-data')).rejects.toThrow(
      /private or reserved/i
    );
  });
});
