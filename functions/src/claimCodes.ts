export const IRL_CLAIM_CODE_DIGITS = 10;
export const IRL_CLAIM_CODE_NAMESPACE = 'irl_v2';

export function normalizeIrlClaimCode(code: unknown): string {
  const raw = String(code || '');
  if (/[A-Za-z]/.test(raw)) return '';
  return raw.replace(/\D/g, '');
}
