import { HttpsError } from 'firebase-functions/v2/https';
import type { ZodType } from 'zod';

export function parseRequest<T>(schema: ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
      .join('; ');
    throw new HttpsError('invalid-argument', details || 'Invalid request payload');
  }
  return parsed.data;
}
