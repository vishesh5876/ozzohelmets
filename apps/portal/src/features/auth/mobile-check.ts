export const MOBILE_HINT =
  'So we can reach you about your Safety ID, warranty or support. Not shown on your public emergency page and not used to sign in. India (+91) is assumed if you leave out the country code.';

/** Client-side shape check (the server validates the number and stores it in E.164). */
export function mobileClientProblem(mobile: string): string | null {
  const v = mobile.trim();
  if (!v) return 'Enter your mobile number.';
  const digits = v.replace(/\D/g, '').length;
  return /^[+\d\s().-]+$/.test(v) && digits >= 8 && digits <= 15
    ? null
    : 'Enter a valid mobile number.';
}
