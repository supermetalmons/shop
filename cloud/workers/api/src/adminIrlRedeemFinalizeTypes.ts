import type { AdminIrlRedeemFinalizeWorkflowPayload } from './adminIrlRedeemFinalizeWorkflowState.js';
import type { buildRuntime as buildAdminIrlRedeemRuntime } from './adminIrlRedeemOnchain.js';
import type { AdminIrlRedeemFinalizeResponse, FinalizeRequest } from './adminIrlRedeemRequestState.js';
import type { CommerceRepositoryContext } from './commerceTransactions.js';
import type { fetchOnchainConfig as fetchDeliveryOnchainConfig } from './deliveryReceiptOnchain.js';

export type AdminIrlRedeemFinalizeRequest = FinalizeRequest;

export type CommerceContext = CommerceRepositoryContext & {
  dataDb?: D1Database;
  providerFetch: typeof fetch;
  [key: string]: unknown;
};

export type Runtime = ReturnType<typeof buildAdminIrlRedeemRuntime>;

export type OnchainConfig = Awaited<ReturnType<typeof fetchDeliveryOnchainConfig>>;

export type AdminIrlRedeemFinalizeWorkflowPhaseResult = Readonly<{
  status: 'ready' | 'drafted' | 'complete';
}>;

type AdminIrlRedeemFinalizeWorkflowEnv = Pick<
  Env,
  'COMMERCE_DB' | 'COSIGNER_SECRET' | 'HELIUS_API_KEY'
> & Partial<Pick<Env, 'DATA_DB'>>;

export type AdminIrlRedeemFinalizeWorkflowStageArgs = Readonly<{
  env: AdminIrlRedeemFinalizeWorkflowEnv;
  operationId: string;
  payload: AdminIrlRedeemFinalizeWorkflowPayload;
  signal: AbortSignal;
}>;

export type AdminIrlRedeemFinalizeWorkflowReservation =
  | Readonly<{ status: 'complete'; result: AdminIrlRedeemFinalizeResponse }>
  | Readonly<{ status: 'reserved'; payload: AdminIrlRedeemFinalizeWorkflowPayload }>;
