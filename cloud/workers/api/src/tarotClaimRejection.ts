import type { ApiErrorCode } from './dataAccess.js';
import type { TarotClaimScope } from './tarotClaimRelayer.js';

export type TarotClaimFailure = { code: ApiErrorCode; message: string; details?: unknown };
export type TarotClaimRejectionInput = TarotClaimScope & {
  requestId: string; codeHash: string; failure: TarotClaimFailure;
};
export type TarotClaimRejection = { rejection: TarotClaimFailure };

export class TarotClaimRejected extends Error {
  constructor(readonly rejection: TarotClaimFailure) {
    super(rejection.message);
    this.name = 'TarotClaimRejected';
  }
}
