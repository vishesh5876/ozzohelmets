import type { DeviceCategory } from '@helmet/types';

const BOT =
  /bot\b|bot\/|crawl|spider|slurp|curl\/|wget\/|python-requests|httpclient|okhttp|go-http-client|headless|monitor|uptime|pingdom|preview|facebookexternalhit|whatsapp|telegrambot/i;

/**
 * Coarse device class from the User-Agent, for analytics only. No fingerprinting: the raw string
 * is not stored (only this category and a "Browser on OS" summary).
 */
export function deviceCategory(ua: string | null | undefined): DeviceCategory | null {
  if (!ua) return null;
  if (BOT.test(ua)) return 'BOT';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)))
    return 'TABLET';
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return 'MOBILE';
  if (/Windows NT|Macintosh|X11|CrOS|Linux/i.test(ua)) return 'DESKTOP';
  return 'OTHER';
}
