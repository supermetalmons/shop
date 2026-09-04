import type { z } from 'zod';
import type { ProfileAddress } from '../../../../shared/contracts.js';
import type { verifyRequestIdentity } from './requestIdentity.js';
import type { ProfileProviderFetch } from './boundedResponse.js';
import { readBoundedRequestJson } from './boundedRequest.js';
import { ProfileReadError } from './dataAccess.js';
import { type DeferredWork } from './deferredWork.js';
import {
  type CommerceWriteCommon,
  type ProfileWriteCommerceRepository,
} from './profileWriteCommerce.js';
import type { saveD1ProfileAddress } from './profileD1.js';
import type { resolveD1AuthWalletBinding } from './authWalletBindingD1.js';

export type ProfileWriteDependencies = {
  autoId: () => string;
  createCommerceRepository: (db: D1Database) => ProfileWriteCommerceRepository;
  createNotificationJobId: () => string;
  defer: DeferredWork;
  error: (entry: Record<string, unknown>) => void;
  log: (entry: Record<string, unknown>) => void;
  nowMs: () => number;
  pauseForRatePoll: (signal: AbortSignal, delayMs: number) => Promise<void>;
  providerFetch: ProfileProviderFetch;
  resolveD1AuthWalletBinding: (
    db: D1Database | undefined,
    uid: string,
    signal: AbortSignal,
  ) => ReturnType<typeof resolveD1AuthWalletBinding>;
  saveProfileAddress: (
    db: D1Database | undefined,
    address: Parameters<typeof saveD1ProfileAddress>[1],
    signal: AbortSignal,
  ) => Promise<ProfileAddress>;
  timeoutMs: number;
  verifyIdentity: typeof verifyRequestIdentity;
  warn: (entry: Record<string, unknown>) => void;
};

export type ProfileWriteEnv = Pick<Env, 'COMMERCE_DB'> & Partial<Pick<Env,
  'ADDRESS_DECRYPTION_SECRET' | 'NOTIFICATION_EMAIL_QUEUE' | 'OPS_DB' | 'SHIPSTATION_API_KEY' | 'SHIPSTATION_SHIP_FROM'
>>;

export type ProfileWriteOperationContext = CommerceWriteCommon & {
  requestSignal: AbortSignal;
};

type ProfileWriteHandlerContext = {
  common: ProfileWriteOperationContext;
  dependencies: ProfileWriteDependencies;
  env: ProfileWriteEnv;
  wallet: string;
};

export function defineProfileWriteOperation<const Path extends string, Schema extends z.ZodType>(definition: {
  path: Path;
  schema: Schema;
  maxBytes: number;
  timeoutMs: number;
  handler: (body: z.output<Schema>, context: ProfileWriteHandlerContext) => Promise<unknown>;
}) {
  return {
    path: definition.path,
    timeoutMs: definition.timeoutMs,
    async prepare(request: Request, signal: AbortSignal) {
      const raw = await readBoundedRequestJson(request, {
        maxBytes: definition.maxBytes,
        signal,
        createError: () => new ProfileReadError('invalid-argument', 400, 'Invalid request.'),
      });
      const parsed = definition.schema.safeParse(raw);
      if (!parsed.success) throw new ProfileReadError('invalid-argument', 400, 'Invalid request.');
      return (context: ProfileWriteHandlerContext) => definition.handler(parsed.data, context);
    },
  };
}
