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

export type LegacyGetProfileFlowDeps<TResponse> = {
  loadProfile(): Promise<{ exists: boolean; data: any }>;
  ensureProfile(): Promise<unknown>;
  mergeStripeDeliveryOrders(): Promise<unknown>;
  buildResponse(profileData: any): Promise<TResponse>;
};

export async function runLegacyGetProfileFlow<TResponse>(
  params: {
    callerWallet: string;
    profileWallet: string;
    mergeStripeDeliveryOrders?: boolean;
  },
  deps: LegacyGetProfileFlowDeps<TResponse>,
): Promise<TResponse> {
  const profile = await deps.loadProfile();
  const isOwnProfile = params.profileWallet === params.callerWallet;
  if (!profile.exists && isOwnProfile) await deps.ensureProfile();
  if (isOwnProfile && params.mergeStripeDeliveryOrders === true) {
    await deps.mergeStripeDeliveryOrders();
  }
  return deps.buildResponse(profile.data);
}

export async function runProfileShipmentsResponseFlow<TOrder>(
  params: {
    sessionWallet: string;
    rawOwnerWallet?: string;
    mergeStripeDeliveryOrders?: boolean;
  },
  deps: {
    invalidMergeError(): Error;
    missingOwnerError(): Error;
    sessionMismatchError(): Error;
    normalizeWallet(wallet: string): string;
    loadOrders(wallet: string): Promise<TOrder[]>;
  },
): Promise<{ responseMode: 'shipments'; wallet: string; orders: TOrder[] }> {
  if (params.mergeStripeDeliveryOrders === true) throw deps.invalidMergeError();
  const requestedWallet = params.rawOwnerWallet?.trim();
  if (!requestedWallet) throw deps.missingOwnerError();
  const wallet = deps.normalizeWallet(requestedWallet);
  if (wallet !== params.sessionWallet) throw deps.sessionMismatchError();
  return {
    responseMode: 'shipments',
    wallet,
    orders: await deps.loadOrders(wallet),
  };
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
