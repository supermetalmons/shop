export type VerifiedSolanaAuthProfileFlowDeps<TLegacyResponse> = {
  invalidSessionMergeError(): Error;
  establishSession(): Promise<unknown>;
  loadProfile(): Promise<{ exists: boolean; data: any }>;
  mergeStripeDeliveryOrders(): Promise<void>;
  buildLegacyResponse(profileData: any): Promise<TLegacyResponse>;
};

export async function runVerifiedSolanaAuthProfileFlow<TLegacyResponse>(
  params: {
    wallet: string;
    responseMode?: 'session';
    mergeStripeDeliveryOrders?: boolean;
  },
  deps: VerifiedSolanaAuthProfileFlowDeps<TLegacyResponse>,
): Promise<{ wallet: string } | TLegacyResponse> {
  if (params.responseMode === 'session' && params.mergeStripeDeliveryOrders === true) {
    throw deps.invalidSessionMergeError();
  }

  await deps.establishSession();
  if (params.responseMode === 'session') return { wallet: params.wallet };

  const profile = await deps.loadProfile();
  if (params.mergeStripeDeliveryOrders === true) await deps.mergeStripeDeliveryOrders();
  return deps.buildLegacyResponse(profile.data);
}

export async function runProfileStateReconciliationFlow<Recovery>(
  options: {
    mergeStripeDeliveryOrders?: boolean;
    includeDeliveryRecovery?: boolean;
  },
  deps: {
    mergeStripeDeliveryOrders(): Promise<number>;
    loadDeliveryRecovery(): Promise<Recovery>;
  },
): Promise<{ mergedStripeDeliveryOrders: number; deliveryRecovery: Recovery | null }> {
  const mergedStripeDeliveryOrders = options.mergeStripeDeliveryOrders === true
    ? await deps.mergeStripeDeliveryOrders()
    : 0;
  const deliveryRecovery = options.includeDeliveryRecovery !== false
    ? await deps.loadDeliveryRecovery()
    : null;
  return { mergedStripeDeliveryOrders, deliveryRecovery };
}
