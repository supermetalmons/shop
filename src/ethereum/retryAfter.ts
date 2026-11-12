export function ethereumRetryAfterMs(header: string | null, bodyHint?: unknown, nowMs = Date.now()): number | null {
  const value = header?.trim();
  const parsed = !value ? NaN : /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1_000
    : /^[A-Za-z]/.test(value) ? Date.parse(value) - nowMs : NaN;
  const valid = (delay: unknown): delay is number => typeof delay === 'number' && Number.isFinite(delay) && delay >= 0 &&
    Number.isSafeInteger(Math.ceil(delay)) && Number.isSafeInteger(nowMs + Math.ceil(delay));
  const hints = [parsed, bodyHint].filter(valid).map(Math.ceil);
  return hints.length ? Math.max(...hints) : null;
}
