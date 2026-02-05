import * as dns from 'dns';
import net from 'net';

type AssertOptions = {
  allowPrivate?: boolean;
};

const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const parseIpv4 = (ip: string): number[] | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => Number(p));
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  return bytes;
};

const isIpv4InRange = (ip: string, a: number, b: number, c: number, dStart: number, dEnd: number): boolean => {
  const bytes = parseIpv4(ip);
  if (!bytes) return false;
  const b0 = bytes[0];
  const b1 = bytes[1];
  const b2 = bytes[2];
  const b3 = bytes[3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return false;
  if (b0 !== a || b1 !== b || b2 !== c) return false;
  return b3 >= dStart && b3 <= dEnd;
};

const isPrivateOrReservedIp = (ip: string): boolean => {
  const family = net.isIP(ip);
  if (family === 4) {
    const b = parseIpv4(ip);
    if (!b) return true;
    const a0 = b[0];
    const a1 = b[1];
    if (a0 === undefined || a1 === undefined) return true;

    // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8
    if (a0 === 0 || a0 === 10 || a0 === 127) return true;
    // 169.254.0.0/16 (link-local)
    if (a0 === 169 && a1 === 254) return true;
    // 172.16.0.0/12
    if (a0 === 172 && a1 >= 16 && a1 <= 31) return true;
    // 192.168.0.0/16
    if (a0 === 192 && a1 === 168) return true;
    // 100.64.0.0/10 (CGNAT)
    if (a0 === 100 && a1 >= 64 && a1 <= 127) return true;
    // 198.18.0.0/15 (benchmark)
    if (a0 === 198 && (a1 === 18 || a1 === 19)) return true;
    // TEST-NET ranges 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
    if (isIpv4InRange(ip, 192, 0, 2, 0, 255)) return true;
    if (isIpv4InRange(ip, 198, 51, 100, 0, 255)) return true;
    if (isIpv4InRange(ip, 203, 0, 113, 0, 255)) return true;
    // Multicast/reserved
    if (a0 >= 224) return true;

    return false;
  }

  if (family === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('fe80:')) return true; // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA fc00::/7
    if (v.startsWith('ff')) return true; // multicast
    return false;
  }

  // Not an IP literal.
  return false;
};

const isForbiddenHostname = (hostname: string): boolean => {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return true;

  if (host === 'localhost') return true;
  if (host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  if (host.endsWith('.lan')) return true;
  return false;
};

const assertSafeOutboundUrl = async (rawUrl: string, options?: AssertOptions): Promise<URL> => {
  const allowPrivate =
    options?.allowPrivate === true || process.env.ALLOW_PRIVATE_URLS === 'true';

  if (!isHttpUrl(rawUrl)) {
    throw new Error('URL must be http(s)');
  }

  const url = new URL(rawUrl);

  // Avoid credentials-in-URL footguns.
  if (url.username || url.password) {
    throw new Error('URL must not include credentials');
  }

  if (allowPrivate) {
    return url;
  }

  const hostname = url.hostname;
  if (isForbiddenHostname(hostname)) {
    throw new Error('URL hostname is not allowed');
  }

  // If hostname is an IP literal, reject private/reserved ranges.
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error('URL resolves to a private or reserved IP address');
    }
    return url;
  }

  // DNS lookup to prevent obvious internal resolution.
  const resolved = await dns.promises.lookup(hostname, { all: true });
  for (const entry of resolved) {
    if (isPrivateOrReservedIp(entry.address)) {
      throw new Error('URL resolves to a private or reserved IP address');
    }
  }
  return url;
};

module.exports = {
  isHttpUrl,
  isPrivateOrReservedIp,
  assertSafeOutboundUrl
};

export {};
