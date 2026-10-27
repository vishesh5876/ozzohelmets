/**
 * Emergency page helpers for the person at the scene, shared by the server-rendered page and the
 * client fallback (browser-safe, no dependencies).
 */

/**
 * Short bystander steps. Standard first-aid guidance for a rider: keep it to what a stranger can
 * do safely in the first minutes. Wording should be reviewed by a medical advisor before launch.
 */
export function sceneSteps(emergencyNumber: string): string[] {
  return [
    `Call ${emergencyNumber} now (red button below).`,
    'Do not remove the helmet unless they are not breathing.',
    'Do not move them unless they are in danger (traffic, fire).',
    'Check they are breathing. Keep them warm and talk to them.',
    'Show this page to the paramedics.',
  ];
}

/** The message a bystander sends to the rider's emergency contact. */
export function sceneMessage(name: string | undefined, mapsUrl?: string): string {
  const who = name ? name : 'the rider whose Safety ID I scanned';
  return (
    `EMERGENCY: I'm with ${who} (scanned their OZZO Safety ID). Please call me back.` +
    (mapsUrl ? ` Location: ${mapsUrl}` : '')
  );
}

export const mapsUrl = (lat: number, lng: number) =>
  `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`;

/** Digits with a leading + kept (E.164 as stored). */
const dialable = (phone: string) => phone.replace(/[^\d+]/g, '');

/** `sms:` with a prefilled body; `?&body=` works on both Android and iOS. */
export const smsHref = (phone: string, body: string) =>
  `sms:${dialable(phone)}?&body=${encodeURIComponent(body)}`;

/** WhatsApp click-to-chat (international number without +). */
export const whatsappHref = (phone: string, body: string) =>
  `https://wa.me/${dialable(phone).replace(/^\+/, '')}?text=${encodeURIComponent(body)}`;
