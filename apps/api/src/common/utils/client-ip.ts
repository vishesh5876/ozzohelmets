import type { Request } from 'express';

/**
 * Resolves the client IP. With TRUST_CLOUDFLARE, CF-Connecting-IP is authoritative (Cloudflare
 * overwrites it); otherwise Express' `req.ip`, which honours the configured `trust proxy`.
 * Only enable TRUST_CLOUDFLARE when the origin is reachable exclusively through Cloudflare.
 */
export function getClientIp(req: Request, trustCloudflare: boolean): string {
  if (trustCloudflare) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.length > 0 && cf.length <= 45) return cf;
  }
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

export function getCountryCode(req: Request, trustCloudflare: boolean): string | null {
  if (!trustCloudflare) return null;
  const cc = req.headers['cf-ipcountry'];
  return typeof cc === 'string' && /^[A-Z]{2}$/.test(cc) && cc !== 'XX' && cc !== 'T1' ? cc : null;
}

export function truncateUserAgent(req: Request, max = 255): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' && ua.length > 0 ? ua.slice(0, max) : null;
}
