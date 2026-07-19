export function normalizeCallableErrorCode(code: unknown): string {
  const value = typeof code === 'string' ? code : '';
  return value.startsWith('functions/')
    ? value.slice('functions/'.length)
    : value;
}
